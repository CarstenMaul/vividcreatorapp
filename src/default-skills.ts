import fs from "fs/promises";
import path from "path";
import { adminPaths } from "./paths.js";

interface ResolvedSkill {
  name: string;
  srcDir: string;
  source: "admin" | "git";
}

let _systemSkills: ResolvedSkill[] | null = null;
let _gitSrcDir: string | null = null;

export function setSkillsSrcDir(dir: string | null): void {
  _gitSrcDir = dir;
  _systemSkills = null;
}

async function listSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function resolveSystemSkills(): Promise<ResolvedSkill[]> {
  if (_systemSkills) return _systemSkills;

  const adminDir = adminPaths.skillsDir();
  const resolved: ResolvedSkill[] = [];
  const seen = new Set<string>();

  // Admin-authored skills come first; on name collision the git copy loses
  // and we log a warning so the misconfiguration is visible.
  for (const name of await listSkillDirs(adminDir)) {
    resolved.push({ name, srcDir: path.join(adminDir, name), source: "admin" });
    seen.add(name);
  }

  if (_gitSrcDir) {
    for (const name of await listSkillDirs(_gitSrcDir)) {
      if (seen.has(name)) {
        console.warn(`[skills] Name collision: "${name}" exists in admin/skills and the git-sourced repos; admin copy wins`);
        continue;
      }
      resolved.push({ name, srcDir: path.join(_gitSrcDir, name), source: "git" });
      seen.add(name);
    }
  }

  _systemSkills = resolved;
  console.log("[skills] Resolved system skills:", resolved.map(s => `${s.name} (${s.source})`));
  return resolved;
}

export async function getSystemSkillNames(): Promise<string[]> {
  return (await resolveSystemSkills()).map(s => s.name);
}

/**
 * For a given system skill name, return where it came from. Used by callers
 * that need to know whether a skill is editable (admin-authored) or read-only
 * (git-sourced).
 */
export async function getSystemSkillSource(name: string): Promise<"admin" | "git" | null> {
  const resolved = await resolveSystemSkills();
  return resolved.find(s => s.name === name)?.source ?? null;
}

export async function seedDefaultSkills(skillsDir: string): Promise<void> {
  const resolved = await resolveSystemSkills();
  if (resolved.length === 0) {
    console.log("[skills] seedDefaultSkills: no system skills resolved, nothing to seed");
  }

  const expectedNames = new Set(resolved.map(s => s.name));

  // Prune previously-seeded system skills no longer in the active list.
  // Detection: system-seeded dirs have a "version:" field injected for git-sourced
  // skills, OR a "system: true" marker for admin-authored skills. User-created
  // skills carry neither.
  try {
    const existing = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of existing) {
      if (!entry.isDirectory() || expectedNames.has(entry.name)) continue;
      try {
        const content = await fs.readFile(path.join(skillsDir, entry.name, "SKILL.md"), "utf-8");
        if (/^version:/m.test(content) || /^system:\s*true/m.test(content)) {
          console.log(`[skills] Removing stale system skill: ${entry.name}`);
          await fs.rm(path.join(skillsDir, entry.name), { recursive: true, force: true });
        }
      } catch { /* unreadable or no SKILL.md, skip */ }
    }
  } catch { /* skillsDir not yet readable, skip */ }

  for (const skill of resolved) {
    const destDir = path.join(skillsDir, skill.name);
    const destSkillMd = path.join(destDir, "SKILL.md");
    const srcSkillMd = path.join(skill.srcDir, "SKILL.md");
    try {
      const [srcStat, destStat] = await Promise.all([
        fs.stat(srcSkillMd).catch(() => null),
        fs.stat(destSkillMd).catch(() => null),
      ]);
      if (!srcStat) { console.log(`[skills]   ${skill.name}: src SKILL.md not found, skipping`); continue; }
      if (!destStat || srcStat.mtimeMs > destStat.mtimeMs) {
        await fs.cp(skill.srcDir, destDir, { recursive: true });
        console.log(`[skills]   ${skill.name} (${skill.source}): copied (${!destStat ? 'new' : 'updated'})`);
      } else {
        console.log(`[skills]   ${skill.name} (${skill.source}): up to date`);
      }
    } catch (err) {
      console.warn(`[skills] Failed to seed skill "${skill.name}":`, err);
    }
  }
}

/**
 * Drop the cached resolution so the next call re-scans both source dirs.
 * Call after admins create/update/delete an admin skill, or after a git sync.
 */
export function invalidateSystemSkillsCache(): void {
  _systemSkills = null;
}
