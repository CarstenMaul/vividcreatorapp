import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { adminPaths } from "./paths.js";
import { copyDir } from "./fs-utils.js";

// In packaged Electron, the source-relative `..` path lands inside the asar
// archive where recursive directory reads do not work. electron/main.ts sets
// VCA_PACKAGED=1 and electron-builder unpacks defaults/ via asarUnpack, so
// we resolve via process.resourcesPath in that mode. resourcesPath is added
// by Electron at runtime; Node's process type doesn't declare it.
const REPO_DEFAULTS_DIR = process.env.VCA_PACKAGED === "1"
  ? path.resolve(
      (process as NodeJS.Process & { resourcesPath: string }).resourcesPath,
      "app.asar.unpacked",
      "defaults",
    )
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "defaults",
    );

export interface BootstrapReport {
  seeded: string[];
  skipped: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listChildDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function seedDir(
  srcRoot: string,
  destRoot: string,
  labelPrefix: string,
  report: BootstrapReport,
): Promise<void> {
  const children = await listChildDirs(srcRoot);
  if (!children.length) return;
  await fs.mkdir(destRoot, { recursive: true });
  for (const name of children) {
    const dest = path.join(destRoot, name);
    const label = `${labelPrefix}/${name}`;
    if (await pathExists(dest)) {
      report.skipped.push(label);
      console.log(`[bootstrap] admin/${label}: present, skipping`);
      continue;
    }
    try {
      await fs.mkdir(dest, { recursive: true });
      await copyDir(path.join(srcRoot, name), dest);
      report.seeded.push(label);
      console.log(`[bootstrap] seeded ${label}`);
    } catch (err) {
      console.warn(`[bootstrap] failed to seed ${label}:`, err);
    }
  }
}

async function seedSystemPrompt(report: BootstrapReport): Promise<void> {
  const src = path.join(REPO_DEFAULTS_DIR, "systemprompt", "systemprompt.md");
  if (!(await pathExists(src))) return;
  const dest = adminPaths.systemPromptFile();
  const label = "systemprompt/SYSTEM_PROMPT.md";
  if (await pathExists(dest)) {
    report.skipped.push(label);
    console.log(`[bootstrap] admin/${label}: present, skipping`);
    return;
  }
  try {
    await fs.mkdir(adminPaths.systemPromptDir(), { recursive: true });
    await fs.copyFile(src, dest);
    report.seeded.push(label);
    console.log(`[bootstrap] seeded ${label}`);
  } catch (err) {
    console.warn(`[bootstrap] failed to seed ${label}:`, err);
  }
}

/**
 * Copy starter content from the repo's `defaults/` tree into the admin tree
 * under `WORKSPACES_ROOT/admin/`, but only where the admin destination is
 * absent. Admin UI edits always win on subsequent restarts.
 *
 * Mapping:
 *   defaults/skills/<name>/        -> admin/skills/<name>/
 *   defaults/templates/<name>/     -> admin/app-templates/<name>/
 *   defaults/systemprompt/systemprompt.md -> admin/systemprompt/SYSTEM_PROMPT.md
 */
export async function bootstrapDefaultsFromRepo(): Promise<BootstrapReport> {
  const report: BootstrapReport = { seeded: [], skipped: [] };
  if (!(await pathExists(REPO_DEFAULTS_DIR))) {
    console.warn(`[bootstrap] defaults dir not found at ${REPO_DEFAULTS_DIR} - skipping`);
    return report;
  }
  await seedDir(
    path.join(REPO_DEFAULTS_DIR, "skills"),
    adminPaths.skillsDir(),
    "skills",
    report,
  );
  await seedDir(
    path.join(REPO_DEFAULTS_DIR, "templates"),
    adminPaths.appTemplatesDir(),
    "app-templates",
    report,
  );
  await seedSystemPrompt(report);
  return report;
}
