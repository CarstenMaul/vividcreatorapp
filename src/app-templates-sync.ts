import {
  listLocalTemplates,
  type TemplateAppType,
  type TemplateDeploymentOptionField,
} from "./admin-app-templates.js";
import { isElectronRuntime } from "./runtime-mode.js";
import type { DeploymentOption } from "./agent-manager.js";

export interface ResolvedAppTemplate {
  name: string;
  description: string;
  /** "node" (full-stack, default) or "web" (pure client-side app). */
  appType: TemplateAppType;
  /**
   * Manifest deploymentOption resolved for THIS process's runtime
   * (container vs Electron); undefined = the template sets no default.
   */
  defaultDeploymentOption?: DeploymentOption;
  slug: string;
  /** Absolute directory to copy from when initializing a new project. */
  dir: string;
}

/**
 * Pick the deployment default that applies to the current runtime. The raw
 * manifest value stays on disk untouched — templates travel across runtimes
 * (zip export/install, config transfer), so only the in-memory registry may
 * hold a resolved value.
 */
function resolveDefaultDeployment(
  raw: TemplateDeploymentOptionField | undefined,
): DeploymentOption | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  return isElectronRuntime() ? raw.electron : raw.container;
}

/**
 * Build the list of available app templates from admin/app-templates/<name>/.
 * Templates are pure filesystem entries — no JSON manifests, no cloning.
 */
export async function syncAppTemplates(): Promise<ResolvedAppTemplate[]> {
  const locals = await listLocalTemplates();
  const resolved: ResolvedAppTemplate[] = locals.map((lt) => ({
    name: lt.name,
    description: lt.description,
    appType: lt.appType,
    defaultDeploymentOption: resolveDefaultDeployment(lt.deploymentOption),
    slug: lt.dirName,
    dir: lt.dir,
  }));
  // The first entry is the fallback template for new projects
  // (getDefaultAppTemplate) and the picker's preselection — keep that the
  // shipped full-stack template regardless of readdir/alphabetical order.
  resolved.sort((a, b) => {
    if (a.slug === "default-app-template") return -1;
    if (b.slug === "default-app-template") return 1;
    return a.slug.localeCompare(b.slug);
  });
  console.log(
    "[app-templates] Resolved templates:",
    resolved.map((t) => (t.defaultDeploymentOption ? `${t.name} (deploy: ${t.defaultDeploymentOption})` : t.name)),
  );
  return resolved;
}
