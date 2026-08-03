import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { ZIP_JUNK, extractZipTo, stripSymlinks } from "./zip-utils.js";
import { copyDir } from "./fs-utils.js";
import { userPaths, adminPaths } from "./paths.js";
import { parseSkillFrontmatter, validateSkillInput } from "./agent-manager.js";
import { repoToSkillName, buildAuthUrl } from "./skill-repo-sync.js";
import { findLatestVersionTag, tagToVersion } from "./git-tag-utils.js";
import { getSystemSkillNames } from "./default-skills.js";
import { getUserSkillRepos, setUserSkillRepo } from "./user-skill-repos.js";

const execFileAsync = promisify(execFile);

/**
 * One-shot skill installers shared by user skills and admin (system) skills:
 * from an uploaded zip archive, or — for user skills — from a git repository
 * cloned once and imported as a normal editable skill (no repo tracking; the
 * tracked flow for system skills lives in skill-repo-sync.ts).
 */

/** Thrown when the target skill already exists and replace was not requested. */
export class SkillExistsError extends Error {
  code = "exists" as const;
  constructor(public skillName: string) {
    super(`A skill named "${skillName}" already exists`);
  }
}

export type SkillInstallErrorCode =
  | "no-skill-md"
  | "system-collision"
  | "invalid-url"
  | "clone-failed"
  | "no-version-tag"
  | "offline"
  | "empty-zip";

export class SkillInstallError extends Error {
  constructor(
    message: string,
    public code: SkillInstallErrorCode,
  ) {
    super(message);
  }
}

export type SkillTier = "user" | "admin";

// Stricter than the app-template slugify (no dots/underscores) so the result
// always satisfies validateSkillInput's [a-z0-9-] rule.
function slugifySkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Normalize an imported SKILL.md's frontmatter in place. Regex line edits
 * (same technique as injectVersion in skill-repo-sync.ts) so unknown fields
 * like allowed-tools survive:
 *  - name: is set to the final (slugified) skill name
 *  - admin tier: ensure a `system: true` marker (mirrors buildAdminSkillMd)
 *  - user tier: REMOVE any version:/system: lines — seedDefaultSkills prunes
 *    user-dir skills carrying those markers that aren't in the system set,
 *    so keeping them would silently delete the skill on the next reseed.
 */
async function rewriteFrontmatter(skillMdPath: string, opts: { name: string; tier: SkillTier }): Promise<void> {
  // Normalize to LF first: Windows-authored zips and autocrlf checkouts carry
  // \r\n, which would leave stray \r on the edited lines below.
  const content = (await fs.readFile(skillMdPath, "utf-8")).replace(/\r\n/g, "\n");
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n)([\s\S]*)$/);
  if (!fmMatch) return; // no frontmatter — validation already rejected this upstream
  const [, open, frontmatter, close, body] = fmMatch;

  let fm = frontmatter;
  if (/^name:/m.test(fm)) {
    fm = fm.replace(/^name:.*$/m, `name: ${opts.name}`);
  } else {
    fm = `name: ${opts.name}\n` + fm;
  }
  if (opts.tier === "admin") {
    if (/^system:/m.test(fm)) {
      fm = fm.replace(/^system:.*$/m, "system: true");
    } else {
      fm = fm.trimEnd() + "\nsystem: true";
    }
  } else {
    fm = fm
      .split("\n")
      .filter((line) => !/^(version|system):/.test(line))
      .join("\n");
  }
  await fs.writeFile(skillMdPath, open + fm + close + body);
}

function skillDestDir(tier: SkillTier, userId: string | undefined, name: string): string {
  return tier === "user"
    ? path.join(userPaths.skillsDir(userId!), name)
    : path.join(adminPaths.skillsDir(), name);
}

async function ensureInstallable(
  tier: SkillTier,
  userId: string | undefined,
  name: string,
  replace: boolean,
): Promise<string> {
  if (tier === "user") {
    // A user skill shadowing a system skill would be overwritten/pruned by
    // seeding — reject outright, replace can't help here. Admin-tier installs
    // MAY collide with a git-sourced system skill: admin wins the merge in
    // resolveSystemSkills, same as manual createAdminSkill.
    const systemNames = await getSystemSkillNames();
    if (systemNames.includes(name)) {
      throw new SkillInstallError(
        `"${name}" is a system skill and cannot be replaced by a user skill`,
        "system-collision",
      );
    }
  }
  const dest = skillDestDir(tier, userId, name);
  const exists = await fs.access(dest).then(() => true, () => false);
  if (exists) {
    if (!replace) throw new SkillExistsError(name);
    await fs.rm(dest, { recursive: true, force: true });
  }
  return dest;
}

/**
 * Validate the extracted/cloned skill root, then copy the WHOLE tree
 * (every file and subdirectory, minus .git/node_modules) into place.
 * Returns the final name and description. `forceName` pins the target
 * dir name regardless of the frontmatter (used by refresh, where the
 * skill must stay under its original name even if the repo renames it).
 */
async function installSkillDir(
  root: string,
  opts: { tier: SkillTier; userId?: string; fallbackName: string; replace?: boolean; forceName?: string },
): Promise<{ name: string; description: string }> {
  const skillMdPath = path.join(root, "SKILL.md");
  let raw: string;
  try {
    raw = await fs.readFile(skillMdPath, "utf-8");
  } catch {
    throw new SkillInstallError(
      "No SKILL.md found — the skill must contain a SKILL.md at its root",
      "no-skill-md",
    );
  }
  const { name: fmName, description } = parseSkillFrontmatter(raw);
  const name = opts.forceName || slugifySkillName(fmName || opts.fallbackName);
  validateSkillInput(name, description);

  const dest = await ensureInstallable(opts.tier, opts.userId, name, !!opts.replace);
  await fs.mkdir(dest, { recursive: true });
  await copyDir(root, dest);
  await rewriteFrontmatter(path.join(dest, "SKILL.md"), { name, tier: opts.tier });
  return { name, description };
}

/**
 * Install a skill from an uploaded zip. The archive must contain a SKILL.md
 * at its root or inside a single wrapping top-level folder. Extracted to a
 * local temp dir first (never directly into the store, which may live on a
 * network share) and copied over as a whole — same shape as
 * installTemplateFromZip in admin-app-templates.ts.
 */
export async function installSkillFromZip(
  zipBuffer: Buffer,
  opts: { tier: SkillTier; userId?: string; fallbackName: string; replace?: boolean },
): Promise<{ name: string; description: string }> {
  const stamp = crypto.randomBytes(8).toString("hex");
  const zipPath = path.join(os.tmpdir(), `vca-skill-${stamp}.zip`);
  const extractDir = path.join(os.tmpdir(), `vca-skill-${stamp}`);
  try {
    await fs.writeFile(zipPath, zipBuffer);
    await fs.mkdir(extractDir, { recursive: true });
    await extractZipTo(zipPath, extractDir);
    await stripSymlinks(extractDir);

    // Zips often wrap their payload in a single top-level folder — unwrap it.
    let root = extractDir;
    const entries = (await fs.readdir(extractDir, { withFileTypes: true })).filter(
      (e) => !ZIP_JUNK.has(e.name),
    );
    if (entries.length === 0) {
      throw new SkillInstallError("Zip archive is empty", "empty-zip");
    }
    if (entries.length === 1 && entries[0].isDirectory()) {
      root = path.join(extractDir, entries[0].name);
    }

    return await installSkillDir(root, {
      ...opts,
      fallbackName: opts.fallbackName.replace(/\.zip$/i, ""),
    });
  } finally {
    await fs.rm(zipPath, { force: true }).catch(() => {});
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Shallow-clone a skill repo into a fresh temp dir the caller must remove.
 * Tag mode: "auto" prefers the latest vX.X.X tag and falls back to the
 * default branch; "tags" requires a version tag; "branch" always clones the
 * default branch (main/master/whatever HEAD points at).
 */
async function cloneSkillRepoToTemp(
  url: string,
  tagMode: "auto" | "tags" | "branch",
): Promise<{ tmpDir: string; tag: string | null }> {
  if (process.env.VCA_OFFLINE === "1") {
    throw new SkillInstallError("Server is in offline mode — git access is disabled", "offline");
  }
  // findLatestVersionTag interpolates the URL into a shell command, so only
  // accept plain https URLs with no whitespace/quote/backslash characters.
  if (!/^https:\/\/[^\s"'\\]+$/.test(url)) {
    throw new SkillInstallError("Repository URL must be a plain https:// URL", "invalid-url");
  }
  // Unlike the tracked system sync (hard PAT requirement), public repos work
  // without AZURE_DEVOPS_PAT here.
  const pat = process.env.AZURE_DEVOPS_PAT || "";
  const authUrl = pat ? buildAuthUrl(url, pat) : url;

  let tag: string | null = null;
  if (tagMode !== "branch") {
    tag = await findLatestVersionTag(authUrl).catch(() => null);
    if (!tag && tagMode === "tags") {
      throw new SkillInstallError(
        "No vX.X.X version tag found in the repository — disable the version-tags setting to pull the default branch instead",
        "no-version-tag",
      );
    }
  }

  const tmpDir = path.join(os.tmpdir(), `vca-skill-clone-${crypto.randomBytes(8).toString("hex")}`);
  try {
    // autocrlf=false: keep skill files byte-exact instead of letting a
    // Windows git config rewrite every text file to CRLF on checkout.
    await execFileAsync(
      "git",
      ["-c", "core.autocrlf=false", "clone", "--depth", "1", ...(tag ? ["--branch", tag] : []), "--", authUrl, tmpDir],
      { timeout: 30_000 },
    );
  } catch {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw new SkillInstallError(
      "Failed to clone the repository — check the URL and that it is reachable (private repos require the server's PAT)",
      "clone-failed",
    );
  }
  return { tmpDir, tag };
}

/**
 * Import a user skill from a git repository: clone (latest vX.X.X tag when
 * present, otherwise the default branch) and copy the FULL repo content into
 * the user's skills dir. The skill stays editable, and its origin is recorded
 * in the per-user skill-repos store so the refresh action can pull updates
 * later (tag mode auto-detected here; toggleable per skill afterwards).
 */
export async function installUserSkillFromRepo(
  userId: string,
  url: string,
  replace?: boolean,
): Promise<{ name: string; description: string; version: string | null; useTags: boolean }> {
  const name = slugifySkillName(repoToSkillName(url));
  if (!name) {
    throw new SkillInstallError("Cannot derive a skill name from this URL", "invalid-url");
  }
  const { tmpDir, tag } = await cloneSkillRepoToTemp(url, "auto");
  try {
    const result = await installSkillDir(tmpDir, { tier: "user", userId, fallbackName: name, replace });
    const version = tag ? tagToVersion(tag) : null;
    await setUserSkillRepo(userId, result.name, { url, useTags: tag != null, version });
    return { ...result, version, useTags: tag != null };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface SkillRefreshResult {
  name: string;
  ok: boolean;
  version: string | null;
  error?: string;
}

/**
 * Re-pull every user skill that is tracked in the per-user skill-repos store:
 * latest vX.X.X tag when the skill's useTags setting is on, default branch
 * otherwise. The skill dir is replaced wholesale with the fresh clone (local
 * edits are overwritten — refresh is an explicit user action). Per-skill
 * failures don't abort the rest.
 */
export async function refreshUserSkillRepos(userId: string): Promise<SkillRefreshResult[]> {
  if (process.env.VCA_OFFLINE === "1") {
    throw new SkillInstallError("Server is in offline mode — git access is disabled", "offline");
  }
  const repos = await getUserSkillRepos(userId);
  const results: SkillRefreshResult[] = [];
  for (const [name, entry] of Object.entries(repos)) {
    let tmpDir: string | null = null;
    try {
      const clone = await cloneSkillRepoToTemp(entry.url, entry.useTags ? "tags" : "branch");
      tmpDir = clone.tmpDir;
      await installSkillDir(clone.tmpDir, { tier: "user", userId, fallbackName: name, forceName: name, replace: true });
      const version = clone.tag ? tagToVersion(clone.tag) : null;
      await setUserSkillRepo(userId, name, { ...entry, version });
      results.push({ name, ok: true, version });
    } catch (err: any) {
      results.push({ name, ok: false, version: entry.version ?? null, error: err?.message || String(err) });
    } finally {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return results;
}
