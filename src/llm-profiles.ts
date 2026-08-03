import fs from "fs/promises";
import { randomUUID } from "crypto";
import { atomicWriteJson } from "./fs-utils.js";
import { adminPaths } from "./paths.js";
import { UNCHANGED_SECRET_SENTINEL } from "./auth-config.js";

/**
 * Named configuration profiles for Settings > AI Model Config. A profile
 * bundles the LLM provider config and the image-generation config (web
 * search/fetch follow the provider automatically, so nothing to store for
 * them). Persisted at admin/llm-profiles.json; applying a profile copies its
 * fields into vca-settings.json server-side so secrets never round-trip
 * through the browser.
 *
 * The openai-codex provider carries no apiKey: its ChatGPT OAuth credential is
 * deployment-wide (admin/codex-auth.json, see src/codex-auth.ts) and
 * profile-independent — applying a codex profile only switches provider/model,
 * the sign-in state carries over.
 */

export interface LlmProfile {
  id: string;
  name: string;
  apiKey: string;
  llmProvider: string;
  llmModelId: string;
  llmEndpoint: string;
  llmApiVersion: string;
  // Context/output overrides in tokens; 0 = auto-detect from pi's catalog.
  llmContextWindow: number;
  llmMaxTokens: number;
  imageProvider: string;
  imageModelId: string;
  imageApiKey: string;
  imageUseLlmKey: boolean;
}

const SECRET_KEYS: Array<keyof LlmProfile> = ["apiKey", "imageApiKey"];

let writeMutex: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeMutex.then(fn, fn);
  writeMutex = next.catch(() => undefined);
  return next;
}

function coerceProfile(raw: unknown): LlmProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pickStr = (k: string) => (typeof r[k] === "string" ? r[k] as string : "");
  const pickNum = (k: string) => {
    const n = Number(r[k]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  const id = pickStr("id");
  const name = pickStr("name").trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    apiKey: pickStr("apiKey"),
    llmProvider: pickStr("llmProvider"),
    llmModelId: pickStr("llmModelId"),
    llmEndpoint: pickStr("llmEndpoint"),
    llmApiVersion: pickStr("llmApiVersion"),
    llmContextWindow: pickNum("llmContextWindow"),
    llmMaxTokens: pickNum("llmMaxTokens"),
    imageProvider: pickStr("imageProvider"),
    imageModelId: pickStr("imageModelId"),
    imageApiKey: pickStr("imageApiKey"),
    imageUseLlmKey: r.imageUseLlmKey === true,
  };
}

export interface ProfilesFile {
  profiles: LlmProfile[];
  // The profile currently applied to vca-settings.json (set on apply/create).
  // Bookkeeping for the Settings UI selection; "" when none.
  activeProfileId: string;
}

async function readFile(): Promise<ProfilesFile> {
  try {
    const text = await fs.readFile(adminPaths.llmProfiles(), "utf-8");
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    const profiles: LlmProfile[] = list.map(coerceProfile).filter((p: LlmProfile | null): p is LlmProfile => p !== null);
    const activeRaw = typeof parsed?.activeProfileId === "string" ? parsed.activeProfileId : "";
    return {
      profiles,
      activeProfileId: profiles.some((p) => p.id === activeRaw) ? activeRaw : "",
    };
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn("[llm-profiles] failed to read:", err);
    return { profiles: [], activeProfileId: "" };
  }
}

async function writeFile(data: ProfilesFile): Promise<void> {
  await fs.mkdir(adminPaths.dir(), { recursive: true });
  await atomicWriteJson(adminPaths.llmProfiles(), data, 2);
}

export async function listLlmProfiles(): Promise<ProfilesFile> {
  return readFile();
}

export async function getLlmProfile(id: string): Promise<LlmProfile | null> {
  const { profiles } = await readFile();
  return profiles.find((p) => p.id === id) ?? null;
}

/** Record which profile is applied to vca-settings.json. */
export async function setActiveLlmProfileId(id: string): Promise<void> {
  await withWriteLock(async () => {
    const data = await readFile();
    data.activeProfileId = data.profiles.some((p) => p.id === id) ? id : "";
    await writeFile(data);
  });
}

/**
 * Create a profile from client-supplied fields. Secrets carrying the
 * UNCHANGED sentinel (the redacted GET view of the current settings) resolve
 * to `fallbackSecrets` — the currently stored settings values.
 */
export async function createLlmProfile(
  input: Omit<LlmProfile, "id">,
  fallbackSecrets: { apiKey: string; imageApiKey: string },
): Promise<ProfilesFile> {
  const name = input.name.trim();
  if (!name) throw new Error("Profile name is required");
  if (name.length > 64) throw new Error("Profile name must be 64 characters or fewer");
  const profile: LlmProfile = {
    ...input,
    id: randomUUID(),
    name,
    apiKey: input.apiKey === UNCHANGED_SECRET_SENTINEL ? fallbackSecrets.apiKey : input.apiKey,
    imageApiKey: input.imageApiKey === UNCHANGED_SECRET_SENTINEL ? fallbackSecrets.imageApiKey : input.imageApiKey,
  };
  return withWriteLock(async () => {
    const data = await readFile();
    data.profiles.push(profile);
    // A newly created profile snapshots the on-screen configuration — it is
    // the selection from now on.
    data.activeProfileId = profile.id;
    await writeFile(data);
    return data;
  });
}

/**
 * Update a profile with client-supplied fields. Secrets carrying the
 * UNCHANGED sentinel keep the profile's own stored value.
 */
export async function updateLlmProfile(
  id: string,
  updates: Partial<Omit<LlmProfile, "id">>,
): Promise<ProfilesFile> {
  return withWriteLock(async () => {
    const data = await readFile();
    const existing = data.profiles.find((p) => p.id === id);
    if (!existing) throw new Error("Profile not found");
    const merged: LlmProfile = { ...existing };
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined) continue;
      const key = k as keyof LlmProfile;
      if (key === "id") continue;
      if (SECRET_KEYS.includes(key) && v === UNCHANGED_SECRET_SENTINEL) continue;
      (merged as any)[key] = v;
    }
    merged.name = merged.name.trim();
    if (!merged.name) throw new Error("Profile name is required");
    const idx = data.profiles.findIndex((p) => p.id === id);
    data.profiles[idx] = merged;
    await writeFile(data);
    return data;
  });
}

export async function deleteLlmProfile(id: string): Promise<ProfilesFile> {
  return withWriteLock(async () => {
    const data = await readFile();
    const next = data.profiles.filter((p) => p.id !== id);
    if (next.length === data.profiles.length) throw new Error("Profile not found");
    data.profiles = next;
    if (data.activeProfileId === id) data.activeProfileId = "";
    await writeFile(data);
    return data;
  });
}

/**
 * Wholesale replacement of the profile store (encrypted config-file import).
 * Every entry passes through coerceProfile; entries without id/name are
 * dropped. The activeProfileId is kept only when it matches an imported id.
 */
export async function replaceLlmProfiles(input: {
  profiles: unknown[];
  activeProfileId: string;
}): Promise<ProfilesFile> {
  return withWriteLock(async () => {
    const profiles = input.profiles
      .map(coerceProfile)
      .filter((p): p is LlmProfile => p !== null);
    const data: ProfilesFile = {
      profiles,
      activeProfileId: profiles.some((p) => p.id === input.activeProfileId)
        ? input.activeProfileId
        : "",
    };
    await writeFile(data);
    return data;
  });
}

/** Mask secret fields with the stable placeholder before returning to clients. */
export function redactLlmProfile(p: LlmProfile): LlmProfile {
  const out = { ...p };
  for (const k of SECRET_KEYS) {
    if (out[k]) (out as any)[k] = UNCHANGED_SECRET_SENTINEL;
  }
  return out;
}
