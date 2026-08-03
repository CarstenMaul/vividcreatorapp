import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { adminPaths } from "./paths.js";
import { copyDir } from "./fs-utils.js";
import { ZIP_JUNK, extractZipTo, stripSymlinks } from "./zip-utils.js";
import type { DeploymentOption } from "./agent-manager.js";

/**
 * Admin-managed app templates. Each template is a directory under
 * admin/app-templates/<name>/. An optional template.yaml at the root supplies
 * the display name and description shown in the picker; when it's missing the
 * directory name doubles as the template name. The bootstrap copies
 * defaults/templates/<name>/ into this dir on first run.
 */

/**
 * What kind of app a template produces. "node" is the classic full-stack
 * Node/Express shape; "web" is a pure client-side app (static files in
 * public/, server.js is only a preview dev-harness). The flag gates the
 * "web-export" deployment option — it is declared in template.yaml and
 * stamped into each project's project.yaml at creation.
 */
export type TemplateAppType = "node" | "web";

/**
 * Default deployment target a template stamps into new projects, optionally
 * differing by server runtime (container/Docker vs packaged Electron desktop).
 * A scalar applies to both runtimes. Values mirror DeploymentOption; an
 * explicit "" suppresses any preset from the template's bundled project.yaml.
 */
export interface TemplateDeploymentDefaults {
  container?: DeploymentOption;
  electron?: DeploymentOption;
}
export type TemplateDeploymentOptionField = DeploymentOption | TemplateDeploymentDefaults;

export interface TemplateMetadata {
  name: string;
  description?: string;
  appType?: TemplateAppType;
  deploymentOption?: TemplateDeploymentOptionField;
}

export interface LocalTemplate {
  name: string;
  description: string;
  appType: TemplateAppType;
  /** Raw manifest value (scalar or per-runtime map) — resolved per runtime in app-templates-sync. */
  deploymentOption?: TemplateDeploymentOptionField;
  dirName: string;
  dir: string;
}

const asDeploymentOption = (v: unknown): DeploymentOption | undefined =>
  v === "" || v === "electron" || v === "git-tag" || v === "web-export" ? v : undefined;

/**
 * Parse a deploymentOption value from template.yaml or an API body. Accepts a
 * scalar DeploymentOption or a per-runtime { container?, electron? } map;
 * invalid shapes and values are silently ignored (same policy as appType).
 */
export function parseTemplateDeploymentOption(raw: unknown): TemplateDeploymentOptionField | undefined {
  if (typeof raw === "string") return asDeploymentOption(raw);
  if (raw && typeof raw === "object") {
    const container = asDeploymentOption((raw as { container?: unknown }).container);
    const electron = asDeploymentOption((raw as { electron?: unknown }).electron);
    if (container !== undefined || electron !== undefined) {
      return {
        ...(container !== undefined ? { container } : {}),
        ...(electron !== undefined ? { electron } : {}),
      };
    }
  }
  return undefined;
}

/** Normalize for persistence: a map whose runtimes agree collapses to a scalar. */
function collapseDeploymentOption(
  value: TemplateDeploymentOptionField,
): TemplateDeploymentOptionField | undefined {
  if (typeof value === "string") return value;
  const { container, electron } = value;
  if (container === undefined && electron === undefined) return undefined;
  if (container !== undefined && container === electron) return container;
  return {
    ...(container !== undefined ? { container } : {}),
    ...(electron !== undefined ? { electron } : {}),
  };
}

const TEMPLATE_META_FILE = "template.yaml";

export async function readTemplateMetadata(templateDir: string): Promise<TemplateMetadata | null> {
  try {
    const text = await fs.readFile(path.join(templateDir, TEMPLATE_META_FILE), "utf-8");
    const parsed = yamlParse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const name = (parsed as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return null;
    const description = (parsed as { description?: unknown }).description;
    const appType = (parsed as { appType?: unknown }).appType;
    return {
      name: name.trim(),
      description: typeof description === "string" ? description : undefined,
      appType: appType === "web" ? "web" : undefined,
      deploymentOption: parseTemplateDeploymentOption((parsed as { deploymentOption?: unknown }).deploymentOption),
    };
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[admin-app-templates] failed to read ${templateDir}/${TEMPLATE_META_FILE}:`, err);
    }
    return null;
  }
}

async function writeTemplateMetadata(templateDir: string, meta: TemplateMetadata): Promise<void> {
  const deploymentOption =
    meta.deploymentOption !== undefined ? collapseDeploymentOption(meta.deploymentOption) : undefined;
  // "node" is the implicit default — only the web flag is persisted.
  const yaml = yamlStringify({
    name: meta.name,
    description: meta.description ?? "",
    ...(meta.appType === "web" ? { appType: "web" } : {}),
    ...(deploymentOption !== undefined ? { deploymentOption } : {}),
  });
  await fs.writeFile(path.join(templateDir, TEMPLATE_META_FILE), yaml, "utf-8");
}

// Directory name must be filesystem-safe; we slugify the template name so the
// admin UI can use a friendly display name while the on-disk dir stays clean.
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64) || "template";
}

export async function listLocalTemplates(): Promise<LocalTemplate[]> {
  const root = adminPaths.appTemplatesDir();
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn("[admin-app-templates] failed to read templates dir:", err);
    }
    return [];
  }
  const out: LocalTemplate[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const meta = await readTemplateMetadata(dir);
    out.push({
      name: meta?.name || e.name,
      description: meta?.description ?? "",
      appType: meta?.appType === "web" ? "web" : "node",
      deploymentOption: meta?.deploymentOption,
      dirName: e.name,
      dir,
    });
  }
  return out;
}

export async function createLocalTemplate(
  name: string,
  description: string,
  appType: TemplateAppType = "node",
  deploymentOption?: TemplateDeploymentOptionField,
): Promise<LocalTemplate> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Template name is required");
  const dirName = slugify(cleanName);
  const dir = path.join(adminPaths.appTemplatesDir(), dirName);
  try {
    await fs.access(dir);
    throw new Error(`Template directory already exists: ${dirName}`);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  await fs.mkdir(dir, { recursive: true });
  await writeTemplateMetadata(dir, { name: cleanName, description, appType, deploymentOption });
  // Stub package.json so initializeProject's copy step finds something runnable.
  // Admins are expected to fill in real content via the filesystem.
  const pkg = {
    name: dirName,
    version: "0.1.0",
    private: true,
    scripts: { start: "echo \"Replace this template with real content\"" },
  };
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  return { name: cleanName, description, appType, deploymentOption, dirName, dir };
}

export async function updateLocalTemplate(
  dirName: string,
  description: string,
  appType?: TemplateAppType,
  // undefined = keep the stored value, null = clear it, value = replace it.
  deploymentOption?: TemplateDeploymentOptionField | null,
): Promise<void> {
  const dir = path.join(adminPaths.appTemplatesDir(), dirName);
  const meta = await readTemplateMetadata(dir);
  const name = meta?.name || dirName;
  const nextDeployment =
    deploymentOption === undefined
      ? meta?.deploymentOption
      : deploymentOption === null
        ? undefined
        : deploymentOption;
  // Preserve the stored app type unless the caller explicitly changes it.
  await writeTemplateMetadata(dir, {
    name,
    description,
    appType: appType ?? meta?.appType,
    deploymentOption: nextDeployment,
  });
}

export async function deleteLocalTemplate(dirName: string): Promise<void> {
  const dir = path.join(adminPaths.appTemplatesDir(), dirName);
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── Zip install ────────────────────────────────────────────────

/** Thrown when the target template already exists and replace was not requested. */
export class TemplateExistsError extends Error {
  code = "exists" as const;
  constructor(
    public dirName: string,
    public templateName: string,
  ) {
    super(`A template named "${templateName}" already exists`);
  }
}

/**
 * Install an app template from an uploaded zip. The template name comes from
 * template.yaml inside the archive, falling back to the zip's filename. The
 * archive is extracted to a local temp dir first (never directly into the
 * admin store, which may live on a network share) and copied over as a whole.
 */
export async function installTemplateFromZip(
  zipBuffer: Buffer,
  opts: { fallbackName: string; replace?: boolean },
): Promise<LocalTemplate> {
  const stamp = crypto.randomBytes(8).toString("hex");
  const zipPath = path.join(os.tmpdir(), `vca-tpl-${stamp}.zip`);
  const extractDir = path.join(os.tmpdir(), `vca-tpl-${stamp}`);
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
    if (entries.length === 1 && entries[0].isDirectory()) {
      root = path.join(extractDir, entries[0].name);
    }
    if ((await fs.readdir(root)).filter((n) => !ZIP_JUNK.has(n)).length === 0) {
      throw new Error("Zip archive is empty");
    }

    const meta = await readTemplateMetadata(root);
    const name = meta?.name || opts.fallbackName.trim() || "template";
    const description = meta?.description ?? "";
    const dirName = slugify(name);
    const dest = path.join(adminPaths.appTemplatesDir(), dirName);

    const exists = await fs.access(dest).then(
      () => true,
      () => false,
    );
    if (exists) {
      if (!opts.replace) throw new TemplateExistsError(dirName, name);
      await fs.rm(dest, { recursive: true, force: true });
    }
    await fs.mkdir(dest, { recursive: true });
    await copyDir(root, dest);
    // Ensure the picker shows a friendly name even for metadata-less archives.
    if (!meta) await writeTemplateMetadata(dest, { name, description });
    return {
      name,
      description,
      appType: meta?.appType === "web" ? "web" : "node",
      deploymentOption: meta?.deploymentOption,
      dirName,
      dir: dest,
    };
  } finally {
    await fs.rm(zipPath, { force: true }).catch(() => {});
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}
