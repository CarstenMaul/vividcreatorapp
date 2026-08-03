import fs from "fs/promises";
import { atomicWriteJson } from "./fs-utils.js";
import { userPaths } from "./paths.js";

/**
 * Per-user UX preferences persisted at <userId>/user-prefs.json. Stores the
 * fields a user changes outside the (admin-only) Settings dialog — currently
 * theme, language, and thinking level. User-authored skills live elsewhere
 * (<userId>/skills/) and are not represented here.
 *
 * Missing file → defaults. Writes are merge-update so callers don't need to
 * send the full record.
 */

export interface UserPrefs {
  theme: string;
  lang: string;
  thinkingLevel: string;
  updatedAt: string;
}

const DEFAULTS: UserPrefs = {
  theme: "light",
  lang: "en",
  thinkingLevel: "medium",
  updatedAt: "",
};

// Per-user mutex so concurrent PUTs from the same browser don't clobber.
const writeMutexes = new Map<string, Promise<unknown>>();

function withWriteLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeMutexes.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeMutexes.set(userId, next.catch(() => undefined));
  return next;
}

function coerce(raw: unknown): UserPrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const pickStr = (k: string, def: string) => (typeof r[k] === "string" ? r[k] as string : def);
  return {
    theme: pickStr("theme", DEFAULTS.theme),
    lang: pickStr("lang", DEFAULTS.lang),
    thinkingLevel: pickStr("thinkingLevel", DEFAULTS.thinkingLevel),
    updatedAt: pickStr("updatedAt", ""),
  };
}

export async function readUserPrefs(userId: string): Promise<UserPrefs> {
  try {
    const text = await fs.readFile(userPaths.prefs(userId), "utf-8");
    return coerce(JSON.parse(text));
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ...DEFAULTS };
    console.warn(`[user-prefs] failed to read ${userId}:`, err);
    return { ...DEFAULTS };
  }
}

export async function writeUserPrefs(userId: string, updates: Partial<UserPrefs>): Promise<UserPrefs> {
  return withWriteLock(userId, async () => {
    const current = await readUserPrefs(userId);
    const merged: UserPrefs = { ...current };
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined || v === null) continue;
      const key = k as keyof UserPrefs;
      if (key === "updatedAt") continue;
      (merged as any)[key] = v;
    }
    merged.updatedAt = new Date().toISOString();

    await fs.mkdir(userPaths.dir(userId), { recursive: true });
    await atomicWriteJson(userPaths.prefs(userId), merged, 2);
    return merged;
  });
}
