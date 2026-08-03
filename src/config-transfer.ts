import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { readFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadVcaSettings,
  writeVcaSettings,
  type VcaSettings,
} from "./admin-settings.js";
import {
  listLlmProfiles,
  replaceLlmProfiles,
  setActiveLlmProfileId,
} from "./llm-profiles.js";
import { collectVcsProfilesDecrypted, replaceVcsProfiles } from "./vcs-profiles.js";
import { getAuthConfig, saveAuthConfig } from "./auth-config.js";
import { readMcpServers, replaceMcpServers } from "./mcp-servers.js";
import {
  loadEnvVars,
  getDeployEnvSpec,
  writeEnvVars,
  applyEnvVarsToProcess,
  isValidEnvKey,
  RESERVED_ENV_KEYS,
  type ClientEnvVar,
} from "./env-vars-store.js";
import {
  getLocalSystemPrompt,
  setLocalSystemPrompt,
  getSystemPromptRepoConfig,
  setSystemPromptRepoConfig,
} from "./admin-system-prompt.js";
import {
  listAllUserRecords,
  importUserRecords,
  loadPublicUser,
} from "./user-store.js";
import {
  getAllVcaGroups,
  replaceVcaGroups,
  ensureUserInAdminGroup,
} from "./vca-groups.js";
import { adminPaths } from "./paths.js";

/**
 * Encrypted export/import of admin configuration (Settings > Config
 * Export/Import).
 *
 * Files are portable across deployments, so the AES-256-GCM key is derived from
 * an admin-chosen password via scrypt (NOT the machine-local master key used by
 * secret-crypto.ts). The envelope (format id, KDF params, salt) is plaintext;
 * everything sensitive lives inside `data`, packed as base64(iv|authTag|ct) —
 * the same convention as secret-crypto.ts.
 *
 * Categories are an open, extensible set: each is described by a handler in
 * CATEGORY_HANDLERS with collect/coerce/summarize/apply. Real secrets only ever
 * exist inside the encrypted payload; collection and apply stay server-side.
 * Unknown category keys (a file from a future version) are surfaced in the
 * preview and skipped on apply.
 *
 * The openai-codex sign-in and the machine-local env-var master key are the two
 * things that can't ride along: a codex config imports fine but needs a fresh
 * sign-in, and env-var secrets are decrypted on export and re-encrypted under
 * the target's own key on import.
 */

export const CONFIG_EXPORT_FORMAT = "vca-config-export";
export const CONFIG_EXPORT_VERSION = 1;

export const CONFIG_CATEGORIES = [
  "aiModelConfig",
  "profiles",
  "authentication",
  "vcsProfiles",
  "network",
  "mcpServers",
  "usersGroups",
  "systemPrompt",
  "appTemplates",
  "skills",
  "environment",
] as const;
export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

export function isConfigCategory(v: unknown): v is ConfigCategory {
  return typeof v === "string" && (CONFIG_CATEGORIES as readonly string[]).includes(v);
}

export class ConfigTransferError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ConfigTransferError";
    this.code = code;
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
// 128·N·r = 16 MiB — stays well under Node's default scrypt maxmem (32 MiB).
const KDF_DEFAULTS = { N: 16384, r: 8, p: 1, keyLen: 32 };
// Guard the JSON payload size (app-template/skill trees carry file content).
const MAX_PAYLOAD_BYTES = 40 * 1024 * 1024;

export interface ConfigEnvelope {
  format: string;
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; keyLen: number };
  salt: string;
  cipher: "aes-256-gcm";
  data: string;
}

export interface ConfigPayload {
  categories: Record<string, unknown>;
}

export interface DecryptedConfig {
  payload: ConfigPayload;
  meta: { exportedAt: string; appVersion: string };
}

/** Non-secret summary of one category, rendered by the import preview UI. */
export interface CategorySummary {
  key: ConfigCategory;
  count?: number;
  names?: string[];
  params?: Record<string, string>;
  secretCount?: number;
  warn?: string[];
  note?: string[];
}

export interface ConfigImportPreview {
  categories: ConfigCategory[];
  unknownCategories: string[];
  exportedAt: string;
  appVersion: string;
  entries: CategorySummary[];
}

interface ApplyContext {
  actorUserId: string | null;
}

interface CategoryHandler {
  key: ConfigCategory;
  /** Read real (secret-carrying) data from the store for export. */
  collect(): Promise<unknown>;
  /** Defensive parse of a decrypted (possibly hostile) payload; null = absent. */
  coerce(raw: unknown): unknown | null;
  /** Non-secret preview summary. */
  summarize(data: unknown): CategorySummary;
  /** Write the data back to the store. */
  apply(data: unknown, ctx: ApplyContext): Promise<void>;
}

let cachedAppVersion: string | null = null;
function getAppVersion(): string {
  if (cachedAppVersion !== null) return cachedAppVersion;
  let version = process.env.APP_VERSION || "";
  if (!version) {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf-8"));
      if (typeof pkg.version === "string") version = pkg.version;
    } catch {
      // Leave version as "" if package.json can't be read.
    }
  }
  cachedAppVersion = version;
  return version;
}

// ─── small coercion helpers ──────────────────────────────────────────

function asObj(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}
function pickStr(r: Record<string, unknown>, k: string): string {
  return typeof r[k] === "string" ? (r[k] as string) : "";
}
function pickNum(r: Record<string, unknown>, k: string): number {
  const n = Number(r[k]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
function dash(s: string): string {
  return s && s.trim() ? s : "—";
}
function capNames(names: string[], cap = 25): string[] {
  return names.slice(0, cap);
}

// ─── directory-tree serialization (app templates + skills) ───────────

const TREE_SKIP = new Set([".git", "node_modules"]);

function isSafeSegment(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 128 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".")
  );
}

function safeJoinTree(root: string, rel: unknown): string | null {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  const abs = path.resolve(root, ...parts);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

async function serializeDir(root: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e: any) {
      if (e?.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      if (TREE_SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) out.push({ path: r, content: (await fs.readFile(abs)).toString("base64") });
    }
  }
  await walk(root, "");
  return out;
}

async function collectTrees(root: string): Promise<Array<{ dirName: string; files: Array<{ path: string; content: string }> }>> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out: Array<{ dirName: string; files: Array<{ path: string; content: string }> }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    out.push({ dirName: e.name, files: await serializeDir(path.join(root, e.name)) });
  }
  return out;
}

async function writeDirTree(root: string, files: unknown): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  if (!Array.isArray(files)) return;
  for (const f of files) {
    const o = asObj(f);
    if (!o) continue;
    const abs = safeJoinTree(root, o.path);
    if (!abs) continue;
    const content = typeof o.content === "string" ? o.content : "";
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from(content, "base64"));
  }
}

/** Upsert directory-tree items under `root` by dirName; existing dirs kept. */
async function applyTrees(root: string, items: unknown): Promise<void> {
  if (!Array.isArray(items)) return;
  await fs.mkdir(root, { recursive: true });
  for (const it of items) {
    const o = asObj(it);
    if (!o || !isSafeSegment(o.dirName)) continue;
    await writeDirTree(path.join(root, o.dirName), o.files);
  }
}

function summarizeTrees(key: ConfigCategory, items: unknown): CategorySummary {
  const list = Array.isArray(items) ? items : [];
  const names = list
    .map((it) => asObj(it))
    .filter((o): o is Record<string, unknown> => !!o && isSafeSegment(o.dirName))
    .map((o) => o.dirName as string);
  return { key, count: names.length, names: capNames(names), note: ["upsert"] };
}

// ─── the AI-model-config field slice (shared shape) ──────────────────

type AiModelFields = Pick<VcaSettings,
  | "apiKey" | "llmProvider" | "llmModelId" | "llmEndpoint" | "llmApiVersion"
  | "llmContextWindow" | "llmMaxTokens"
  | "imageProvider" | "imageModelId" | "imageApiKey" | "imageUseLlmKey">;

function coerceAiModel(raw: unknown): AiModelFields | null {
  const r = asObj(raw);
  if (!r) return null;
  const llmProvider = pickStr(r, "llmProvider").trim();
  return {
    apiKey: pickStr(r, "apiKey"),
    llmProvider,
    llmModelId: pickStr(r, "llmModelId").trim(),
    llmEndpoint: pickStr(r, "llmEndpoint").trim(),
    llmApiVersion: pickStr(r, "llmApiVersion").trim(),
    llmContextWindow: pickNum(r, "llmContextWindow"),
    llmMaxTokens: pickNum(r, "llmMaxTokens"),
    imageProvider: pickStr(r, "imageProvider").trim(),
    imageModelId: pickStr(r, "imageModelId").trim(),
    imageApiKey: pickStr(r, "imageApiKey"),
    imageUseLlmKey: r.imageUseLlmKey === true && llmProvider !== "openai-codex",
  };
}

// ─── category handlers ───────────────────────────────────────────────

const WEB_TOOL_RESET = {
  webSearchEnabled: true,
  webFetchEnabled: true,
  webSearchModelId: "",
  webSearchContextSize: "",
  webSearchEngine: "",
  webSearchMaxResults: 0,
  webFetchEngine: "",
} satisfies Partial<VcaSettings>;

const CATEGORY_HANDLERS: CategoryHandler[] = [
  {
    key: "aiModelConfig",
    async collect() {
      const s = await loadVcaSettings();
      return {
        apiKey: s.apiKey,
        llmProvider: s.llmProvider,
        llmModelId: s.llmModelId,
        llmEndpoint: s.llmEndpoint,
        llmApiVersion: s.llmApiVersion,
        llmContextWindow: s.llmContextWindow,
        llmMaxTokens: s.llmMaxTokens,
        imageProvider: s.imageProvider,
        imageModelId: s.imageModelId,
        imageApiKey: s.imageApiKey,
        imageUseLlmKey: s.imageUseLlmKey,
      } satisfies AiModelFields;
    },
    coerce: coerceAiModel,
    summarize(data) {
      const d = data as AiModelFields;
      return {
        key: "aiModelConfig",
        params: { provider: dash(d.llmProvider), model: dash(d.llmModelId) },
        secretCount: (d.apiKey ? 1 : 0) + (d.imageApiKey ? 1 : 0),
        note: d.llmProvider === "openai-codex" ? ["codex"] : [],
      };
    },
    async apply(data, ctx) {
      const d = data as AiModelFields;
      await writeVcaSettings({ ...d, ...WEB_TOOL_RESET }, ctx.actorUserId);
    },
  },

  {
    key: "profiles",
    async collect() {
      const data = await listLlmProfiles();
      return { profiles: data.profiles, activeProfileId: data.activeProfileId };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r || !Array.isArray(r.profiles)) return null;
      return { profiles: r.profiles, activeProfileId: pickStr(r, "activeProfileId") };
    },
    summarize(data) {
      const d = data as { profiles: unknown[] };
      const valid = d.profiles
        .map((p) => asObj(p))
        .filter((o): o is Record<string, unknown> => !!o && !!pickStr(o, "id") && !!pickStr(o, "name").trim());
      return {
        key: "profiles",
        count: valid.length,
        names: capNames(valid.map((o) => pickStr(o, "name").trim())),
        secretCount: valid.filter((o) => pickStr(o, "apiKey") || pickStr(o, "imageApiKey")).length,
        warn: ["replacesAll"],
        note: valid.some((o) => pickStr(o, "llmProvider") === "openai-codex") ? ["codex"] : [],
      };
    },
    async apply(data) {
      const d = data as { profiles: unknown[]; activeProfileId: string };
      await replaceLlmProfiles(d);
    },
  },

  {
    key: "authentication",
    async collect() {
      const a = await getAuthConfig();
      return {
        enabled: a.enabled,
        tenantId: a.tenantId,
        clientId: a.clientId,
        clientSecret: a.clientSecret,
        scopes: a.scopes,
      };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r) return null;
      return {
        enabled: r.enabled === true,
        tenantId: pickStr(r, "tenantId").trim(),
        clientId: pickStr(r, "clientId").trim(),
        clientSecret: pickStr(r, "clientSecret"),
        scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [],
      };
    },
    summarize(data) {
      const d = data as { enabled: boolean; tenantId: string; clientId: string; clientSecret: string };
      return {
        key: "authentication",
        params: { tenant: dash(d.tenantId), client: dash(d.clientId) },
        secretCount: d.clientSecret ? 1 : 0,
        note: [d.enabled && d.clientSecret ? "authEnabled" : "authDisabled"],
      };
    },
    async apply(data, ctx) {
      const d = data as { enabled: boolean; tenantId: string; clientId: string; clientSecret: string; scopes: string[] };
      // Can't enable OAuth without a secret — degrade to disabled rather than
      // failing the whole import.
      const enabled = d.enabled && !!d.clientSecret;
      await saveAuthConfig(
        { enabled, tenantId: d.tenantId, clientId: d.clientId, clientSecret: d.clientSecret, scopes: d.scopes },
        ctx.actorUserId,
      );
    },
  },

  {
    key: "vcsProfiles",
    async collect() {
      // Decrypt each profile's PAT into the (already scrypt-encrypted) envelope.
      return collectVcsProfilesDecrypted();
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r || !Array.isArray(r.profiles)) return null;
      return { profiles: r.profiles };
    },
    summarize(data) {
      const d = data as { profiles: unknown[] };
      const valid = d.profiles
        .map((p) => asObj(p))
        .filter((o): o is Record<string, unknown> => !!o && !!pickStr(o, "name").trim());
      return {
        key: "vcsProfiles",
        count: valid.length,
        names: capNames(valid.map((o) => pickStr(o, "name").trim())),
        secretCount: valid.filter((o) => pickStr(o, "pat")).length,
        warn: ["replacesAll"],
        note: ["reEncrypted"],
      };
    },
    async apply(data) {
      // Re-encrypt each PAT under this instance's own key.
      await replaceVcsProfiles(data as { profiles: unknown[] });
    },
  },

  {
    key: "network",
    async collect() {
      const s = await loadVcaSettings();
      return { tlsVerificationEnabled: s.tlsVerificationEnabled };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r || typeof r.tlsVerificationEnabled !== "boolean") return null;
      return { tlsVerificationEnabled: r.tlsVerificationEnabled };
    },
    summarize(data) {
      const d = data as { tlsVerificationEnabled: boolean };
      return { key: "network", note: [d.tlsVerificationEnabled ? "tlsOn" : "tlsOff"] };
    },
    async apply(data, ctx) {
      await writeVcaSettings(data as Partial<VcaSettings>, ctx.actorUserId);
    },
  },

  {
    key: "mcpServers",
    async collect() {
      return { servers: await readMcpServers() };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r || !Array.isArray(r.servers)) return null;
      return { servers: r.servers };
    },
    summarize(data) {
      const d = data as { servers: unknown[] };
      const valid = d.servers
        .map((s) => asObj(s))
        .filter((o): o is Record<string, unknown> => !!o && !!pickStr(o, "name").trim() && !!pickStr(o, "url").trim());
      return {
        key: "mcpServers",
        count: valid.length,
        names: capNames(valid.map((o) => pickStr(o, "name").trim())),
        secretCount: valid.filter((o) => o.authType === "apiKey" && pickStr(o, "apiKey")).length,
        warn: ["replacesAll"],
      };
    },
    async apply(data) {
      const d = data as { servers: unknown[] };
      await replaceMcpServers(d.servers);
    },
  },

  {
    key: "usersGroups",
    async collect() {
      return { users: await listAllUserRecords(), groups: await getAllVcaGroups() };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r || (!Array.isArray(r.users) && !Array.isArray(r.groups))) return null;
      return {
        users: Array.isArray(r.users) ? r.users : [],
        groups: Array.isArray(r.groups) ? r.groups : [],
      };
    },
    summarize(data) {
      const d = data as { users: unknown[]; groups: unknown[] };
      const users = d.users.map((u) => asObj(u)).filter((o): o is Record<string, unknown> => !!o && !!pickStr(o, "userId"));
      const groups = d.groups.map((g) => asObj(g)).filter((o): o is Record<string, unknown> => !!o);
      const crossTenant =
        users.some((u) => u.authType === "entra") || groups.some((g) => !!pickStr(g, "linkedGraphGroupId"));
      const note = ["selfLockout"];
      if (crossTenant) note.push("crossTenant");
      return {
        key: "usersGroups",
        params: { users: String(users.length), groups: String(groups.length) },
        names: capNames(groups.map((g) => pickStr(g, "name").trim()).filter(Boolean)),
        secretCount: users.filter((u) => pickStr(u, "passwordHash")).length,
        warn: ["replacesAll"],
        note,
      };
    },
    async apply(data, ctx) {
      const d = data as { users: unknown[]; groups: unknown[] };
      await importUserRecords(d.users);
      await replaceVcaGroups(d.groups);
      // Never let the operator lock themselves out of the instance they just
      // imported into.
      if (ctx.actorUserId) {
        const pub = await loadPublicUser(ctx.actorUserId);
        await ensureUserInAdminGroup(ctx.actorUserId, pub?.displayName || "", pub?.email || "");
      }
    },
  },

  {
    key: "systemPrompt",
    async collect() {
      const content = await getLocalSystemPrompt();
      const repo = await getSystemPromptRepoConfig();
      return { content, repoUrl: repo?.url ?? null };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r) return null;
      const content = typeof r.content === "string" ? r.content : null;
      const repoUrl = typeof r.repoUrl === "string" && r.repoUrl.trim() ? r.repoUrl.trim() : null;
      if (content === null && repoUrl === null) return null;
      return { content, repoUrl };
    },
    summarize(data) {
      const d = data as { content: string | null; repoUrl: string | null };
      const note: string[] = [];
      if (d.repoUrl) note.push("promptRepo");
      return { key: "systemPrompt", params: { chars: String(d.content ? d.content.length : 0) }, note };
    },
    async apply(data) {
      const d = data as { content: string | null; repoUrl: string | null };
      // Only ever set — never delete — so an import can't brick a target that
      // has no other prompt source.
      if (typeof d.content === "string" && d.content.length > 0) await setLocalSystemPrompt(d.content);
      if (d.repoUrl) await setSystemPromptRepoConfig({ url: d.repoUrl });
    },
  },

  {
    key: "appTemplates",
    async collect() {
      return { templates: await collectTrees(adminPaths.appTemplatesDir()) };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r || !Array.isArray(r.templates)) return null;
      return { templates: r.templates };
    },
    summarize(data) {
      return summarizeTrees("appTemplates", (data as { templates: unknown }).templates);
    },
    async apply(data) {
      await applyTrees(adminPaths.appTemplatesDir(), (data as { templates: unknown }).templates);
    },
  },

  {
    key: "skills",
    async collect() {
      return { skills: await collectTrees(adminPaths.skillsDir()) };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r || !Array.isArray(r.skills)) return null;
      return { skills: r.skills };
    },
    summarize(data) {
      return summarizeTrees("skills", (data as { skills: unknown }).skills);
    },
    async apply(data) {
      await applyTrees(adminPaths.skillsDir(), (data as { skills: unknown }).skills);
    },
  },

  {
    key: "environment",
    async collect() {
      const spec = await getDeployEnvSpec(await loadEnvVars());
      const vars: ClientEnvVar[] = [
        ...Object.entries(spec.plain).map(([key, value]) => ({ key, secret: false, value })),
        ...Object.entries(spec.secrets).map(([key, value]) => ({ key, secret: true, value })),
      ];
      return { vars };
    },
    coerce(raw) {
      const r = asObj(raw);
      if (!r || !Array.isArray(r.vars)) return null;
      const vars: ClientEnvVar[] = [];
      for (const v of r.vars) {
        const o = asObj(v);
        if (!o) continue;
        const key = pickStr(o, "key").trim();
        if (!key || !isValidEnvKey(key) || RESERVED_ENV_KEYS.has(key)) continue;
        vars.push({ key, secret: o.secret === true, value: pickStr(o, "value") });
      }
      return vars.length > 0 ? { vars } : null;
    },
    summarize(data) {
      const d = data as { vars: ClientEnvVar[] };
      return {
        key: "environment",
        count: d.vars.length,
        names: capNames(d.vars.map((v) => v.key)),
        secretCount: d.vars.filter((v) => v.secret).length,
        warn: ["replacesAll"],
        note: ["reEncrypted"],
      };
    },
    async apply(data, ctx) {
      const d = data as { vars: ClientEnvVar[] };
      await writeEnvVars(d.vars, ctx.actorUserId);
      await applyEnvVarsToProcess();
    },
  },
];

const HANDLERS_BY_KEY = new Map<ConfigCategory, CategoryHandler>(CATEGORY_HANDLERS.map((h) => [h.key, h]));

// ─── crypto ──────────────────────────────────────────────────────────

function deriveKey(password: string, salt: Buffer, p: { N: number; r: number; p: number; keyLen: number }): Buffer {
  return scryptSync(password, salt, p.keyLen, { N: p.N, r: p.r, p: p.p, maxmem: 128 * p.N * p.r * 2 });
}

export async function buildConfigExport(
  categories: ConfigCategory[],
  password: string,
): Promise<{ filename: string; envelope: ConfigEnvelope }> {
  const payload: ConfigPayload = { categories: {} };
  // Iterate in registry order for deterministic output.
  for (const key of CONFIG_CATEGORIES) {
    if (!categories.includes(key)) continue;
    const handler = HANDLERS_BY_KEY.get(key);
    if (handler) payload.categories[key] = await handler.collect();
  }
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf-8") > MAX_PAYLOAD_BYTES) {
    throw new ConfigTransferError(
      "Configuration is too large to export — deselect app templates or skills with heavy content",
      "CONFIG_EXPORT_TOO_LARGE",
    );
  }
  const salt = randomBytes(SALT_BYTES);
  const key = deriveKey(password, salt, KDF_DEFAULTS);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(json, "utf-8"), cipher.final()]);
  const envelope: ConfigEnvelope = {
    format: CONFIG_EXPORT_FORMAT,
    formatVersion: CONFIG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: getAppVersion(),
    kdf: "scrypt",
    kdfParams: { ...KDF_DEFAULTS },
    salt: salt.toString("base64"),
    cipher: "aes-256-gcm",
    data: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64"),
  };
  return { filename: `vca-config-${envelope.exportedAt.slice(0, 10)}.json`, envelope };
}

export function decryptConfigEnvelope(raw: unknown, password: string): DecryptedConfig {
  const invalid = () => new ConfigTransferError("Not a valid configuration file", "CONFIG_FILE_INVALID");
  const e = asObj(raw) as Partial<ConfigEnvelope> | null;
  if (!e) throw invalid();
  if (e.format !== CONFIG_EXPORT_FORMAT) throw invalid();
  if (typeof e.formatVersion !== "number" || !Number.isInteger(e.formatVersion) || e.formatVersion < 1) throw invalid();
  if (e.formatVersion > CONFIG_EXPORT_VERSION) {
    throw new ConfigTransferError("Configuration file was created by a newer version", "CONFIG_FILE_VERSION_UNSUPPORTED");
  }
  if (e.kdf !== "scrypt" || e.cipher !== "aes-256-gcm" || typeof e.salt !== "string" || typeof e.data !== "string") {
    throw invalid();
  }
  // Bound the KDF cost so a hostile file can't turn scrypt into a DoS.
  const p = (e.kdfParams || {}) as Record<string, unknown>;
  const N = p.N as number, r = p.r as number, par = p.p as number, keyLen = p.keyLen as number;
  const okN = Number.isInteger(N) && N >= 1024 && N <= 131072 && (N & (N - 1)) === 0;
  const okR = Number.isInteger(r) && r >= 1 && r <= 16;
  const okP = Number.isInteger(par) && par >= 1 && par <= 4;
  if (!okN || !okR || !okP || keyLen !== 32) throw invalid();

  const salt = Buffer.from(e.salt, "base64");
  if (salt.length < 8 || salt.length > 64) throw invalid();
  const buf = Buffer.from(e.data, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) throw invalid();

  const key = deriveKey(password, salt, { N, r, p: par, keyLen });
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    plaintext = Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf-8");
  } catch {
    // GCM auth failure — wrong password or tampered file, indistinguishable.
    throw new ConfigTransferError("Wrong password or corrupted file", "CONFIG_FILE_WRONG_PASSWORD");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw invalid();
  }
  const categories = (parsed as { categories?: unknown })?.categories;
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) throw invalid();
  return {
    payload: { categories: categories as Record<string, unknown> },
    meta: {
      exportedAt: typeof e.exportedAt === "string" ? e.exportedAt : "",
      appVersion: typeof e.appVersion === "string" ? e.appVersion : "",
    },
  };
}

// ─── preview + apply ─────────────────────────────────────────────────

export function summarizeConfigPayload(dec: DecryptedConfig): ConfigImportPreview {
  const cats = dec.payload.categories;
  const preview: ConfigImportPreview = {
    categories: [],
    unknownCategories: Object.keys(cats).filter((k) => !isConfigCategory(k)),
    exportedAt: dec.meta.exportedAt,
    appVersion: dec.meta.appVersion,
    entries: [],
  };
  for (const key of CONFIG_CATEGORIES) {
    if (!(key in cats)) continue;
    const handler = HANDLERS_BY_KEY.get(key)!;
    const coerced = handler.coerce(cats[key]);
    if (coerced === null) continue;
    preview.categories.push(key);
    preview.entries.push(handler.summarize(coerced));
  }
  return preview;
}

export async function applyConfigPayload(
  payload: ConfigPayload,
  actorUserId: string | null,
): Promise<{ applied: ConfigCategory[] }> {
  const cats = payload.categories;
  const ctx: ApplyContext = { actorUserId };
  const applied: ConfigCategory[] = [];
  for (const key of CONFIG_CATEGORIES) {
    if (!(key in cats)) continue;
    const handler = HANDLERS_BY_KEY.get(key)!;
    const coerced = handler.coerce(cats[key]);
    if (coerced === null) continue;
    await handler.apply(coerced, ctx);
    applied.push(key);
  }
  if (applied.length === 0) {
    throw new ConfigTransferError(
      "Configuration file contains no settings supported by this version",
      "CONFIG_FILE_EMPTY",
    );
  }
  // Imported LLM settings no longer correspond to any locally known profile
  // unless the profile list was imported too.
  if (applied.includes("aiModelConfig") && !applied.includes("profiles")) {
    await setActiveLlmProfileId("");
  }
  return { applied };
}
