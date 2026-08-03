import fs from "fs/promises";
import { adminPaths } from "./paths.js";

/**
 * Admin-managed system prompt sources. The active prompt resolves as:
 *   1. admin/systemprompt/SYSTEM_PROMPT.md  — local override (this module)
 *   2. admin/system-prompt-repo.json {url}  — git-sourced fallback (this module)
 *   3. (nothing — startup fails fast inside syncSystemPrompt)
 *
 * Local content wins when both are configured, matching default-skills.ts.
 */

export interface SystemPromptRepoConfig {
  url: string;
}

export async function getLocalSystemPrompt(): Promise<string | null> {
  try {
    return await fs.readFile(adminPaths.systemPromptFile(), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    console.warn("[admin-system-prompt] failed to read local prompt:", err);
    return null;
  }
}

export async function setLocalSystemPrompt(content: string): Promise<void> {
  if (typeof content !== "string") throw new Error("content must be a string");
  await fs.mkdir(adminPaths.systemPromptDir(), { recursive: true });
  await fs.writeFile(adminPaths.systemPromptFile(), content, "utf-8");
}

export async function deleteLocalSystemPrompt(): Promise<void> {
  await fs.rm(adminPaths.systemPromptFile(), { force: true });
}

export async function getSystemPromptRepoConfig(): Promise<SystemPromptRepoConfig | null> {
  try {
    const text = await fs.readFile(adminPaths.systemPromptRepo(), "utf-8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const url = (parsed as { url?: unknown }).url;
    if (typeof url !== "string" || !url.trim()) return null;
    return { url: url.trim() };
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    console.warn("[admin-system-prompt] failed to read repo config:", err);
    return null;
  }
}

export async function setSystemPromptRepoConfig(cfg: SystemPromptRepoConfig): Promise<void> {
  const url = cfg.url?.trim();
  if (!url) throw new Error("Repo URL is required");
  await fs.mkdir(adminPaths.dir(), { recursive: true });
  await fs.writeFile(adminPaths.systemPromptRepo(), JSON.stringify({ url }, null, 2), "utf-8");
}

export async function clearSystemPromptRepoConfig(): Promise<void> {
  await fs.rm(adminPaths.systemPromptRepo(), { force: true });
}
