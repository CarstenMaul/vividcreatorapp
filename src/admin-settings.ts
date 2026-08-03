import fs from "fs/promises";
import { atomicWriteJson } from "./fs-utils.js";
import { adminPaths } from "./paths.js";
import { UNCHANGED_SECRET_SENTINEL } from "./auth-config.js";

/**
 * Deployment-wide Settings (LLM provider + key, DevOps PAT, theme, lang …)
 * persisted at admin/vca-settings.json. Reads are mtime-cached so hot paths
 * (`getCachedVcaSettings()` from chat-session creation) stay synchronous.
 *
 * Mutation is admin-only (gated at the route layer). The PUT path accepts
 * the UNCHANGED_SECRET_SENTINEL from auth-config so the redacted GET view
 * can round-trip back without leaking the real secret to the client.
 */

export interface VcaSettings {
  // LLM (any provider)
  apiKey: string;
  llmProvider: string;
  llmModelId: string;
  llmEndpoint: string;
  llmApiVersion: string;
  // Context/output overrides for the active model, in tokens. 0 = auto-detect
  // from pi's builtin catalog (falling back to a per-provider default). Set
  // these when a custom deployment name (e.g. an Azure AI Foundry deployment)
  // isn't in pi's catalog, so its true context window / max output can't be
  // inferred from the model id — otherwise a 1M-context model is capped at the
  // 200K/128K fallback, triggering premature compaction and a wrong context %.
  llmContextWindow: number;
  llmMaxTokens: number;

  // Image generation (Google Gemini, OpenAI DALL·E, …)
  imageProvider: string;
  imageModelId: string;
  imageApiKey: string;
  // When true, image generation authenticates with the LLM `apiKey` above and
  // `imageApiKey` is ignored (useful when both point at the same provider).
  imageUseLlmKey: boolean;

  // Web tools (web_search / web_fetch agent tools). The provider used is
  // derived from the LLM provider above (OpenAI / Azure OpenAI / OpenRouter
  // have native web tooling); these fields tune that behavior.
  webSearchEnabled: boolean;
  webFetchEnabled: boolean;
  // Model used for the provider-side search call. "" = use llmModelId.
  webSearchModelId: string;
  // "" = provider default, else "low" | "medium" | "high".
  webSearchContextSize: string;
  // OpenRouter only: search engine ("" = auto, native, exa, firecrawl, parallel, perplexity).
  webSearchEngine: string;
  // OpenRouter only: per-search result cap (0 = provider default, else 1-25).
  webSearchMaxResults: number;
  // OpenRouter only: fetch engine ("" = auto, native, openrouter, exa, parallel).
  webFetchEngine: string;

  // Network: when false, TLS certificate verification is globally disabled
  // (NODE_TLS_REJECT_UNAUTHORIZED=0) for the server's outbound connections and
  // the child processes it spawns. Default true (verification enabled).
  tlsVerificationEnabled: boolean;

  // Audit
  updatedAt: string;
  updatedByUserId: string | null;
}

const SECRET_KEYS = new Set<keyof VcaSettings>([
  "apiKey",
  "imageApiKey",
]);

const DEFAULTS: VcaSettings = {
  apiKey: "",
  llmProvider: "",
  llmModelId: "",
  llmEndpoint: "",
  llmApiVersion: "",
  llmContextWindow: 0,
  llmMaxTokens: 0,
  imageProvider: "google",
  imageModelId: "gemini-3.1-flash-image-preview",
  imageApiKey: "",
  imageUseLlmKey: false,
  webSearchEnabled: true,
  webFetchEnabled: true,
  webSearchModelId: "",
  webSearchContextSize: "",
  webSearchEngine: "",
  webSearchMaxResults: 0,
  webFetchEngine: "",
  tlsVerificationEnabled: true,
  updatedAt: "",
  updatedByUserId: null,
};

let cached: VcaSettings = { ...DEFAULTS };
let cachedMtimeMs = 0;
let writeMutex: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeMutex.then(fn, fn);
  writeMutex = next.catch(() => undefined);
  return next;
}

function coerce(raw: unknown): VcaSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const pickStr = (k: string, def = "") => (typeof r[k] === "string" ? r[k] as string : def);
  const pickNum = (k: string, def = 0) => {
    const n = Number(r[k]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
  };
  // Migration: older vca-settings.json files stored a `googleApiKey` field.
  // Map it onto `imageApiKey` when the new key isn't present yet.
  const legacyGoogleKey = typeof r.googleApiKey === "string" ? r.googleApiKey as string : "";
  return {
    apiKey: pickStr("apiKey"),
    llmProvider: pickStr("llmProvider"),
    llmModelId: pickStr("llmModelId"),
    llmEndpoint: pickStr("llmEndpoint"),
    llmApiVersion: pickStr("llmApiVersion"),
    llmContextWindow: pickNum("llmContextWindow"),
    llmMaxTokens: pickNum("llmMaxTokens"),
    imageProvider: pickStr("imageProvider", DEFAULTS.imageProvider),
    imageModelId: pickStr("imageModelId", DEFAULTS.imageModelId),
    imageApiKey: pickStr("imageApiKey", legacyGoogleKey),
    imageUseLlmKey: r.imageUseLlmKey === true,
    // Default ON: web tools are only skipped when explicitly stored false.
    webSearchEnabled: r.webSearchEnabled !== false,
    webFetchEnabled: r.webFetchEnabled !== false,
    webSearchModelId: pickStr("webSearchModelId"),
    webSearchContextSize: pickStr("webSearchContextSize"),
    webSearchEngine: pickStr("webSearchEngine"),
    webSearchMaxResults: (() => {
      const n = Number(r.webSearchMaxResults);
      return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 25) : 0;
    })(),
    webFetchEngine: pickStr("webFetchEngine"),
    // Default ON: verification is only disabled when explicitly stored false.
    tlsVerificationEnabled: r.tlsVerificationEnabled !== false,
    updatedAt: pickStr("updatedAt"),
    updatedByUserId: typeof r.updatedByUserId === "string" ? r.updatedByUserId : null,
  };
}

async function readFromDisk(): Promise<{ settings: VcaSettings; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(adminPaths.vcaSettings());
    const text = await fs.readFile(adminPaths.vcaSettings(), "utf-8");
    const parsed = JSON.parse(text);
    return { settings: coerce(parsed), mtimeMs: stat.mtimeMs };
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    console.warn("[vca-settings] failed to read:", err);
    return null;
  }
}

/** Read fresh from disk (refreshing the cache). Use at startup. */
export async function loadVcaSettings(): Promise<VcaSettings> {
  const result = await readFromDisk();
  if (result) {
    cached = result.settings;
    cachedMtimeMs = result.mtimeMs;
  } else {
    cached = { ...DEFAULTS };
    cachedMtimeMs = 0;
  }
  return cached;
}

/**
 * Synchronous accessor for hot paths. Falls back to the last-loaded value if
 * the file has changed since the last `loadVcaSettings()` call — callers that
 * absolutely need fresh state should await `loadVcaSettings()` first.
 */
export function getCachedVcaSettings(): VcaSettings {
  return cached;
}

/** Mask secret fields with a stable placeholder before returning to clients. */
export function redact(s: VcaSettings): VcaSettings {
  const out = { ...s };
  for (const k of SECRET_KEYS) {
    if (out[k]) (out as any)[k] = UNCHANGED_SECRET_SENTINEL;
  }
  return out;
}

/** Strip secret fields entirely (for endpoints exposed to non-admins). */
export function publicView(s: VcaSettings): Omit<VcaSettings, "apiKey" | "imageApiKey"> {
  const { apiKey: _a, imageApiKey: _i, ...rest } = s;
  return rest;
}

export async function writeVcaSettings(
  updates: Partial<VcaSettings>,
  actorUserId: string | null,
): Promise<VcaSettings> {
  return withWriteLock(async () => {
    // Always read fresh under the lock so a concurrent edit doesn't get clobbered.
    const result = await readFromDisk();
    const current = result?.settings ?? { ...DEFAULTS };

    const merged: VcaSettings = { ...current };
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined) continue;
      const key = k as keyof VcaSettings;
      // UNCHANGED sentinel on a secret means "keep the stored value".
      if (SECRET_KEYS.has(key) && v === UNCHANGED_SECRET_SENTINEL) continue;
      (merged as any)[key] = v;
    }
    merged.updatedAt = new Date().toISOString();
    merged.updatedByUserId = actorUserId;

    await fs.mkdir(adminPaths.dir(), { recursive: true });
    await atomicWriteJson(adminPaths.vcaSettings(), merged, 2);

    cached = merged;
    try {
      const stat = await fs.stat(adminPaths.vcaSettings());
      cachedMtimeMs = stat.mtimeMs;
    } catch { /* ignore — cache mtime is best-effort */ }

    return merged;
  });
}

export { UNCHANGED_SECRET_SENTINEL };
