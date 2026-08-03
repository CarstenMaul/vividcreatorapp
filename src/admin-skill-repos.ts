import fs from "fs/promises";
import { adminPaths } from "./paths.js";

/**
 * Admin-managed list of skill repo URLs. Persisted in admin/skill-repos.json
 * as a JSON array of strings. Missing file → empty list.
 */

async function readRaw(): Promise<string[]> {
  try {
    const text = await fs.readFile(adminPaths.skillRepos(), "utf-8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && !!v.trim());
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    console.warn("[admin-skill-repos] failed to read:", err);
    return [];
  }
}

async function writeRaw(urls: string[]): Promise<void> {
  await fs.mkdir(adminPaths.dir(), { recursive: true });
  await fs.writeFile(adminPaths.skillRepos(), JSON.stringify(urls, null, 2));
}

export async function listAdminSkillRepos(): Promise<string[]> {
  return readRaw();
}

export async function addAdminSkillRepo(url: string): Promise<string[]> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("Repo URL is required");
  const urls = await readRaw();
  if (urls.includes(trimmed)) return urls;
  urls.push(trimmed);
  await writeRaw(urls);
  return urls;
}

export async function removeAdminSkillRepo(url: string): Promise<string[]> {
  const urls = await readRaw();
  const next = urls.filter(u => u !== url);
  if (next.length === urls.length) return urls;
  await writeRaw(next);
  return next;
}
