import fs from "fs/promises";
import path from "path";
import { stringify as yamlStringify } from "yaml";
import { adminPaths } from "./paths.js";
import { parseSkillFrontmatter, validateSkillInput, SkillValidationError } from "./agent-manager.js";

/**
 * Admin-authored system skills, stored at admin/skills/<name>/SKILL.md.
 *
 * Frontmatter carries `system: true` so the user-dir prune logic in
 * default-skills.ts can identify these as system skills (vs user-authored)
 * after they're seeded into each user's skills directory.
 */

function buildAdminSkillMd(name: string, description: string, content: string): string {
  const fm = yamlStringify({ name, description: description.trim(), system: true });
  return `---\n${fm}---\n${content}`;
}

function skillDir(name: string): string {
  return path.join(adminPaths.skillsDir(), name);
}

export async function listAdminSkills(): Promise<{ name: string; description: string; dirName: string }[]> {
  try {
    const entries = await fs.readdir(adminPaths.skillsDir(), { withFileTypes: true });
    const out: { name: string; description: string; dirName: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const content = await fs.readFile(path.join(skillDir(entry.name), "SKILL.md"), "utf-8");
        const { name, description } = parseSkillFrontmatter(content);
        out.push({ name: name || entry.name, description, dirName: entry.name });
      } catch { /* unreadable, skip */ }
    }
    return out;
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export async function getAdminSkill(name: string): Promise<{ name: string; description: string; content: string } | null> {
  try {
    const raw = await fs.readFile(path.join(skillDir(name), "SKILL.md"), "utf-8");
    const { name: parsedName, description, body } = parseSkillFrontmatter(raw);
    return { name: parsedName || name, description, content: body };
  } catch {
    return null;
  }
}

export async function createAdminSkill(name: string, description: string, content: string): Promise<void> {
  validateSkillInput(name, description);
  const dir = skillDir(name);
  try {
    await fs.access(dir);
    throw new SkillValidationError("name", `Skill "${name}" already exists`);
  } catch (err: any) {
    if (err instanceof SkillValidationError) throw err;
    // ENOENT is the expected/happy path: dir doesn't exist yet.
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), buildAdminSkillMd(name, description, content));
}

export async function updateAdminSkill(name: string, description: string, content: string): Promise<void> {
  validateSkillInput(name, description);
  const file = path.join(skillDir(name), "SKILL.md");
  try {
    await fs.access(file);
  } catch {
    throw new SkillValidationError("name", `Skill "${name}" not found`);
  }
  await fs.writeFile(file, buildAdminSkillMd(name, description, content));
}

export async function deleteAdminSkill(name: string): Promise<void> {
  await fs.rm(skillDir(name), { recursive: true, force: true });
}
