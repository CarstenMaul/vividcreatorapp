import fs from "fs/promises";
import { userPaths } from "./paths.js";
import { atomicWriteJson } from "./fs-utils.js";

/**
 * Per-user record of which user skills are sourced from a git repository,
 * persisted in <userRoot>/skill-repos.json as { [skillName]: entry }. Unlike
 * the admin list (admin-skill-repos.ts, plain URL array feeding the tracked
 * system sync), these entries back the user-facing "refresh" action: each
 * skill remembers its origin URL and whether the repo publishes vX.X.X
 * version tags (refresh pulls the latest tag) or not (refresh pulls the
 * default branch). Missing file → no tracked skills.
 */

export interface UserSkillRepoEntry {
  url: string;
  /** true → refresh clones the latest vX.X.X tag; false → default branch. */
  useTags: boolean;
  /** Version of the last installed tag (informational, shown as a badge). */
  version?: string | null;
}

async function readRaw(userId: string): Promise<Record<string, UserSkillRepoEntry>> {
  try {
    const text = await fs.readFile(userPaths.skillRepos(userId), "utf-8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, UserSkillRepoEntry> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { url?: unknown; useTags?: unknown; version?: unknown };
      if (typeof entry?.url !== "string" || !entry.url.trim()) continue;
      out[name] = {
        url: entry.url,
        useTags: entry.useTags === true,
        version: typeof entry.version === "string" ? entry.version : null,
      };
    }
    return out;
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn("[user-skill-repos] failed to read:", err);
    return {};
  }
}

export async function getUserSkillRepos(userId: string): Promise<Record<string, UserSkillRepoEntry>> {
  return readRaw(userId);
}

export async function setUserSkillRepo(userId: string, skillName: string, entry: UserSkillRepoEntry): Promise<void> {
  const map = await readRaw(userId);
  map[skillName] = entry;
  await fs.mkdir(userPaths.dir(userId), { recursive: true });
  await atomicWriteJson(userPaths.skillRepos(userId), map, 2);
}

export async function removeUserSkillRepo(userId: string, skillName: string): Promise<void> {
  const map = await readRaw(userId);
  if (!(skillName in map)) return;
  delete map[skillName];
  await atomicWriteJson(userPaths.skillRepos(userId), map, 2);
}
