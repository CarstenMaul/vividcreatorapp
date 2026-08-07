import fs from "fs/promises";
import path from "path";
import { findLatestVersionTag, tagToVersion, buildAuthUrl } from "./git-tag-utils.js";
import { git, tryGit, secretsInUrl } from "./exec-utils.js";
import { withGitLock } from "./git-lock.js";
import { systemPaths } from "./paths.js";

const SYSTEM_DIR = systemPaths.dir();
const CACHE_DIR = systemPaths.skillRepoCache();
const ACTIVE_DIR = systemPaths.skillsActive();

interface SkillRepoConfig {
  url: string;
}

interface CloneResult {
  ok: boolean;
  tag: string | null;
}

/**
 * Extract skill name from repo URL (last path segment, strip .git suffix).
 */
export function repoToSkillName(url: string): string {
  const segments = url.replace(/\/+$/, "").split("/");
  const last = segments[segments.length - 1];
  return last.replace(/\.git$/, "");
}

// Re-exported for skill-install.ts. The implementation moved to git-tag-utils so
// this module and system-prompt-sync stop carrying separate copies — the old
// local one did a naive `url.replace("https://", …)` with no percent-encoding,
// which corrupted the URL for any PAT containing `@`, `:`, `/` or `#`.
export { buildAuthUrl };

/**
 * Get the current checked-out tag in a repo directory.
 */
async function getCurrentTag(repoDir: string): Promise<string | null> {
  const res = await tryGit(["describe", "--tags", "--exact-match", "HEAD"], {
    cwd: repoDir,
    timeout: 5000,
  });
  return res.code === 0 ? res.stdout.trim() || null : null;
}

/**
 * Clone a skill repo at its latest version tag.
 * Returns { ok, tag } where tag is the version tag name or null.
 */
async function cloneAtTag(
  repo: SkillRepoConfig,
  pat: string,
  cacheDir: string,
): Promise<CloneResult> {
  const skillName = repoToSkillName(repo.url);
  const repoDir = path.join(cacheDir, skillName);
  const authUrl = buildAuthUrl(repo.url, pat);

  // Find latest version tag
  let latestTag: string | null;
  try {
    latestTag = await findLatestVersionTag(authUrl);
  } catch (err) {
    console.warn(`[skill-sync] ${skillName}: failed to list remote tags:`, err);
    latestTag = null;
  }

  if (!latestTag) {
    console.warn(`[skill-sync] ${skillName}: no version tags (vX.X.X) found, skipping`);
    return { ok: false, tag: null };
  }

  console.log(`[skill-sync] ${skillName}: latest version tag: ${latestTag}`);

  // Check if already at the right tag
  try {
    await fs.access(path.join(repoDir, ".git"));
    const currentTag = await getCurrentTag(repoDir);
    if (currentTag === latestTag) {
      console.log(`[skill-sync] ${skillName}: already at ${latestTag}, skipping clone`);
      return { ok: true, tag: latestTag };
    }
  } catch { /* not cloned yet */ }

  // Clone at the specific tag
  try {
    console.log(`[skill-sync] ${skillName}: cloning at ${latestTag}...`);
    await fs.rm(repoDir, { recursive: true, force: true });
    await git(
      ["clone", "--depth", "1", "--branch", latestTag, "--", authUrl, repoDir],
      { cwd: cacheDir, timeout: 30000, redact: secretsInUrl(authUrl) },
    );
    console.log(`[skill-sync] ${skillName}: cloned at ${latestTag}`);
    return { ok: true, tag: latestTag };
  } catch (err) {
    console.warn(`[skill-sync] ${skillName}: failed to clone:`, err);
    // Check stale cache
    try {
      await fs.access(path.join(repoDir, "SKILL.md"));
      console.warn(`[skill-sync] ${skillName}: using stale cache`);
      const cachedTag = await getCurrentTag(repoDir);
      return { ok: true, tag: cachedTag };
    } catch {
      return { ok: false, tag: null };
    }
  }
}

/**
 * Inject or update the version field in a SKILL.md frontmatter block.
 */
async function injectVersion(skillMdPath: string, version: string): Promise<void> {
  const content = await fs.readFile(skillMdPath, "utf-8");
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!fmMatch) return; // no frontmatter, skip

  const [, open, frontmatter, close, body] = fmMatch;
  let newFrontmatter: string;
  if (/^version:/m.test(frontmatter)) {
    newFrontmatter = frontmatter.replace(/^version:.*$/m, `version: "${version}"`);
  } else {
    newFrontmatter = frontmatter.trimEnd() + `\nversion: "${version}"`;
  }
  await fs.writeFile(skillMdPath, open + newFrontmatter + close + body);
}

/**
 * Main entry point. Syncs all configured skill repos using version tags.
 * Returns the path to the assembled skills directory, or null if not configured.
 */
export async function syncSkillRepos(repoUrls: string[], pat: string): Promise<string | null> {
  if (!pat || !Array.isArray(repoUrls) || repoUrls.length === 0) {
    return null;
  }

  const repos: SkillRepoConfig[] = repoUrls.map((url) => ({ url }));

  // Ensure directories exist
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(ACTIVE_DIR, { recursive: true });

  // Serialize on SYSTEM_DIR so concurrent /api/admin/sync-* calls don't
  // collide on per-repo `git clone` + `fs.rm` or on the ACTIVE_DIR teardown.
  return withGitLock(SYSTEM_DIR, async () => {
    // Clone/update each repo at its latest version tag
    const results = await Promise.all(
      repos.map((repo) => cloneAtTag(repo, pat, CACHE_DIR)),
    );

    // Assemble skills-active from successful repos
    await fs.rm(ACTIVE_DIR, { recursive: true, force: true });
    await fs.mkdir(ACTIVE_DIR, { recursive: true });

    let count = 0;
    for (let i = 0; i < repos.length; i++) {
      if (!results[i].ok) continue;
      const skillName = repoToSkillName(repos[i].url);
      const src = path.join(CACHE_DIR, skillName);
      const dest = path.join(ACTIVE_DIR, skillName);

      // Verify the repo actually has a SKILL.md
      try {
        await fs.access(path.join(src, "SKILL.md"));
      } catch {
        console.warn(`[skill-sync] ${skillName}: no SKILL.md found in repo, skipping`);
        continue;
      }

      // Copy skill directory (excluding .git)
      await copySkillDir(src, dest);

      // Inject version from git tag into the copied SKILL.md
      const tag = results[i].tag;
      if (tag) {
        try {
          await injectVersion(path.join(dest, "SKILL.md"), tagToVersion(tag));
        } catch (err) {
          console.warn(`[skill-sync] ${skillName}: failed to inject version:`, err);
        }
      }

      count++;
    }

    // Remove stale cache entries for repos that are no longer in the configured list.
    // Runs unconditionally (before the count guard) so previously-removed repos are
    // always pruned even when all clones fail.
    const expectedNames = new Set(repos.map(r => repoToSkillName(r.url)));
    try {
      const cacheEntries = await fs.readdir(CACHE_DIR, { withFileTypes: true });
      for (const entry of cacheEntries) {
        if (entry.isDirectory() && !expectedNames.has(entry.name)) {
          console.log(`[skill-sync] Removing stale cache entry: ${entry.name}`);
          await fs.rm(path.join(CACHE_DIR, entry.name), { recursive: true, force: true });
        }
      }
    } catch (err) {
      console.warn("[skill-sync] Failed to prune stale cache entries:", err);
    }

    if (count === 0) {
      console.warn("[skill-sync] No skills assembled from repos");
      return null;
    }

    console.log(`[skill-sync] ${count} skill(s) ready in ${ACTIVE_DIR}`);
    return ACTIVE_DIR;
  });
}

/**
 * Copy a skill directory, excluding .git.
 */

let _skillRepoMap: Record<string, string> = {};

/**
 * Set the skill name → repo URL map. Called by the orchestrator after a
 * successful sync so callers can resolve each skill back to its source repo.
 */
export function setSkillRepoMap(repoUrls: string[]): void {
  const map: Record<string, string> = {};
  for (const url of repoUrls) {
    map[repoToSkillName(url)] = url;
  }
  _skillRepoMap = map;
}

/**
 * Return the skill name → repo URL map populated by the most recent sync.
 */
export function getSkillRepoMap(): Record<string, string> {
  return _skillRepoMap;
}

async function copySkillDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copySkillDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
