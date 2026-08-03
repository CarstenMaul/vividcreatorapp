import type { ResolvedAppTemplate } from "./app-templates-sync.js";

let _templates: ResolvedAppTemplate[] = [];

export function setAppTemplates(list: ResolvedAppTemplate[]): void {
  _templates = list;
}

export function getAppTemplates(): ResolvedAppTemplate[] {
  return _templates;
}

export function getAppTemplateByName(name: string): ResolvedAppTemplate | null {
  return _templates.find((t) => t.name === name) ?? null;
}

export function getDefaultAppTemplate(): ResolvedAppTemplate | null {
  return _templates[0] ?? null;
}

export type { ResolvedAppTemplate };
