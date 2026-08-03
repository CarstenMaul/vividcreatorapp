import fs from "fs/promises";
import path from "path";

/**
 * Per-app version handling. Every app VCA builds carries a `main.minor.build`
 * version stored in its workspace `package.json` `version` field — the single
 * source of truth consumed downstream (electron-builder installer name,
 * `readProjectDeployInfo.packageVersion`, the git-tag release action).
 *
 * The owner sets `main`/`minor` manually in Project Settings; VCA auto-bumps
 * `build` (the third component) on every committed agent change. Changing
 * `main` or `minor` manually resets `build` to 0 (standard semver behaviour).
 *
 * Self-contained (fs/path only) so it can be imported from both
 * `agent-manager.ts` and `platform-release-runner.ts` without an import cycle.
 */

export const DEFAULT_APP_VERSION = "0.1.0";

export interface ParsedVersion {
  main: number;
  minor: number;
  build: number;
}

/**
 * Parses the leading `X.Y.Z` of a version string. Returns null when the input
 * is not a string or doesn't start with three dot-separated integers, so
 * callers can gracefully skip versioning for apps without a usable version.
 */
export function parseVersion(version: unknown): ParsedVersion | null {
  if (typeof version !== "string") return null;
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    main: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    build: parseInt(m[3], 10),
  };
}

export function formatVersion(main: number, minor: number, build: number): string {
  return `${main}.${minor}.${build}`;
}

/**
 * Reads the workspace's `package.json` `version`. Returns null when there is no
 * package.json or its version isn't a parseable `X.Y.Z` — versioning is then
 * skipped for that app.
 */
export async function readAppVersion(workspacePath: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(workspacePath, "package.json"), "utf-8");
    const pkg = JSON.parse(text) as { version?: unknown };
    if (typeof pkg.version === "string" && parseVersion(pkg.version)) return pkg.version;
    return null;
  } catch {
    return null;
  }
}

/**
 * Read-modify-writes the workspace `package.json` `version`, preserving the
 * rest of the file (and its 2-space formatting + trailing newline, matching how
 * platform-release-runner writes it). Throws only if package.json is missing or
 * unparseable — callers guard with `readAppVersion` first.
 */
export async function writeAppVersion(workspacePath: string, version: string): Promise<void> {
  const pkgPath = path.join(workspacePath, "package.json");
  const text = await fs.readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(text) as Record<string, unknown>;
  pkg.version = version;
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

/** Increments the build (third) component, leaving main/minor untouched. */
export function bumpBuild(version: string): string {
  const p = parseVersion(version);
  if (!p) throw new Error(`Cannot parse version: ${version}`);
  return formatVersion(p.main, p.minor, p.build + 1);
}

/** Composes a version from main/minor with build reset to 0 (standard semver
 * when the user changes main/minor manually). */
export function withMainMinor(main: number, minor: number): string {
  return formatVersion(main, minor, 0);
}
