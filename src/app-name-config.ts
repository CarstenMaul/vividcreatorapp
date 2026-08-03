import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export interface AppNameConfig {
  name: string;
  shortcut: string;
}

const DEFAULTS: AppNameConfig = { name: "VCA", shortcut: "VCA" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "..", "app-config.json");

let cached: AppNameConfig | null = null;

export function getAppNameConfig(): AppNameConfig {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    cached = {
      name: typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name : DEFAULTS.name,
      shortcut: typeof parsed?.shortcut === "string" && parsed.shortcut.trim() ? parsed.shortcut : DEFAULTS.shortcut,
    };
  } catch {
    cached = DEFAULTS;
  }
  return cached;
}

export function applyAppNamePlaceholders(input: string): string {
  const { name, shortcut } = getAppNameConfig();
  return input
    .replace(/__APP_NAME__/g, name)
    .replace(/__APP_SHORTCUT__/g, shortcut);
}
