import fs from "fs/promises";
import path from "path";
import { findLatestVersionTag, tagToVersion, buildAuthUrl } from "./git-tag-utils.js";
import { git, tryGit, secretsInUrl } from "./exec-utils.js";
import { withGitLock } from "./git-lock.js";
import { systemPaths } from "./paths.js";
import { getLocalSystemPrompt, getSystemPromptRepoConfig } from "./admin-system-prompt.js";

const CACHE_DIR = systemPaths.systemPromptCache();

/** Prompt file names to look for, in priority order. */
const PROMPT_FILES = ["SYSTEM_PROMPT.md", "system-prompt.md", "SYSTEM_PROMPT.txt"];

export interface SystemPromptResult {
  prompt: string;
  version: string;
}

/**
 * Strip YAML frontmatter from markdown content, returning just the body.
 */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

/**
 * Get the current checked-out tag in a repo directory.
 * Returns the tag name or null if HEAD is not at a tag.
 */
async function getCurrentTag(repoDir: string): Promise<string | null> {
  const res = await tryGit(["describe", "--tags", "--exact-match", "HEAD"], {
    cwd: repoDir,
    timeout: 5000,
  });
  return res.code === 0 ? res.stdout.trim() || null : null;
}

/**
 * Clone the repo at a specific version tag.
 * Returns the tag on success, or null on failure.
 */
async function cloneAtTag(
  repoUrl: string,
  pat: string,
): Promise<string | null> {
  const authUrl = buildAuthUrl(repoUrl, pat);

  // Find the latest version tag from the remote
  let latestTag: string | null;
  try {
    latestTag = await findLatestVersionTag(authUrl);
  } catch (err) {
    console.warn("[system-prompt] Failed to list remote tags:", err);
    latestTag = null;
  }

  if (!latestTag) {
    console.warn("[system-prompt] No version tags (vX.X.X) found in repo");
    // Check stale cache
    return checkStaleCache();
  }

  console.log(`[system-prompt] Latest version tag: ${latestTag}`);

  // Check if already at the right tag
  try {
    await fs.access(path.join(CACHE_DIR, ".git"));
    const currentTag = await getCurrentTag(CACHE_DIR);
    if (currentTag === latestTag) {
      console.log(`[system-prompt] Already at ${latestTag}, skipping clone`);
      return latestTag;
    }
  } catch { /* not cloned yet */ }

  // Clone at the specific tag
  try {
    console.log(`[system-prompt] Cloning at ${latestTag}...`);
    await fs.rm(CACHE_DIR, { recursive: true, force: true });
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await git(
      ["clone", "--depth", "1", "--branch", latestTag, "--", authUrl, CACHE_DIR],
      { timeout: 30000, redact: secretsInUrl(authUrl) },
    );
    console.log(`[system-prompt] Cloned at ${latestTag}`);
    return latestTag;
  } catch (err) {
    console.warn("[system-prompt] Failed to clone:", err);
    return checkStaleCache();
  }
}

/**
 * Check if a stale cache exists with a prompt file.
 * Returns the cached tag or "unknown" if cache exists, null otherwise.
 */
async function checkStaleCache(): Promise<string | null> {
  for (const f of PROMPT_FILES) {
    try {
      await fs.access(path.join(CACHE_DIR, f));
      console.warn("[system-prompt] Using stale cache");
      const tag = await getCurrentTag(CACHE_DIR);
      return tag || "unknown";
    } catch { /* continue */ }
  }
  return null;
}

/**
 * Find and read the prompt file from the cached repo.
 */
async function readPromptFile(version: string): Promise<SystemPromptResult | null> {
  for (const f of PROMPT_FILES) {
    try {
      const content = await fs.readFile(path.join(CACHE_DIR, f), { encoding: "utf-8" });
      console.log(`[system-prompt] Loaded from ${f}, version: ${version}`);
      return { prompt: stripFrontmatter(content), version };
    } catch { /* try next */ }
  }
  console.warn(`[system-prompt] No prompt file found (looked for: ${PROMPT_FILES.join(", ")})`);
  return null;
}

let lastRepoUrl: string | null = null;

/**
 * Return the last successfully-synced system prompt repo URL (without PAT), or null.
 */
export function getSystemPromptRepoUrl(): string | null {
  return lastRepoUrl;
}

/**
 * Set the last-synced system prompt repo URL. Called by the orchestrator
 * after a successful sync so /api/config can expose it.
 */
export function setSystemPromptRepoUrl(url: string | null): void {
  lastRepoUrl = url;
}

/**
 * Resolve the active system prompt.
 *
 * Order: (1) admin/systemprompt/SYSTEM_PROMPT.md if present AND non-empty
 * after stripping frontmatter — wins regardless of any configured repo;
 * (2) admin/system-prompt-repo.json {url} synced at latest vX.X.X tag;
 * (3) null when neither source produces content (logged as a warning so
 * the admin sees it at startup, not just when the first chat fails).
 *
 * Returns `{prompt, version}` where `version` is "local" for an
 * admin-authored file, a "vX.Y.Z" tag for git-sourced content, or
 * "unknown" when only a stale cache is available.
 */
export async function syncSystemPrompt(pat: string | undefined): Promise<SystemPromptResult | null> {
  const local = await getLocalSystemPrompt();
  if (local !== null) {
    const body = stripFrontmatter(local);
    if (body.length > 0) {
      setSystemPromptRepoUrl(null);
      return { prompt: body, version: "local" };
    }
    // Empty/whitespace-only local file → treat as "no local override" so
    // a configured repo can still serve. Without this, saving a blank
    // file via the admin UI would silently disable the system prompt.
    console.warn("[system-prompt] Local override is empty — falling through to repo source");
  }

  const repo = await getSystemPromptRepoConfig();
  if (!repo) {
    setSystemPromptRepoUrl(null);
    console.warn(
      "[system-prompt] No source configured — set admin/systemprompt/SYSTEM_PROMPT.md " +
      "or admin/system-prompt-repo.json {url}",
    );
    return null;
  }
  if (!pat) {
    setSystemPromptRepoUrl(null);
    console.warn("[system-prompt] Repo configured but AZURE_DEVOPS_PAT is unset — cannot sync");
    return null;
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });

  // Serialize on CACHE_DIR to prevent concurrent rm/clone collisions.
  const result = await withGitLock(CACHE_DIR, async () => {
    const tag = await cloneAtTag(repo.url, pat);
    if (!tag) return null;

    const version = tag === "unknown" ? "unknown" : tagToVersion(tag);
    return readPromptFile(version);
  });
  setSystemPromptRepoUrl(result ? repo.url : null);
  if (!result) {
    console.warn(`[system-prompt] Repo sync produced no prompt — check ${repo.url}`);
  }
  return result;
}
