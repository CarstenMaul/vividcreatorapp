import path from "path";
import fs from "fs";

/**
 * Self-contained toolchain for the packaged desktop app.
 *
 * The Windows installer ships a private Node + Git under
 * `resources/runtime/{node,git}` (see scripts/bundle-runtime.mjs and the
 * `extraResources` entry in electron-builder.yml). This module locates them
 * and makes VCA use them for every child process it spawns — npm install,
 * `npm run build`, and the ~40 git plumbing calls — so the machine needs no
 * system Node or Git.
 *
 * It is deliberately a no-op when nothing is bundled:
 *   - `npm run electron:dev` (unpackaged) → falls back to the developer's PATH.
 *   - Containerized VCA / VCA apps → the image (node:24-slim + git) provides
 *     both on PATH, and `process.resourcesPath` isn't an Electron resources dir.
 */

const IS_WINDOWS = process.platform === "win32";

function resourcesPath(): string | null {
  const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return rp || null;
}

function runtimeRoot(): string | null {
  const rp = resourcesPath();
  return rp ? path.join(rp, "runtime") : null;
}

/** Absolute path to the bundled `node` executable, or null if not bundled. */
export function bundledNodeExe(): string | null {
  const root = runtimeRoot();
  if (!root) return null;
  const exe = path.join(root, "node", IS_WINDOWS ? "node.exe" : path.join("bin", "node"));
  return fs.existsSync(exe) ? exe : null;
}

/** Directory holding the bundled node/npm/npx, to prepend to PATH, or null. */
export function bundledNodeDir(): string | null {
  const exe = bundledNodeExe();
  return exe ? path.dirname(exe) : null;
}

/** Directory holding the bundled `git`, to prepend to PATH, or null. */
export function bundledGitDir(): string | null {
  const root = runtimeRoot();
  if (!root) return null;
  // PortableGit (Windows) exposes git at git/cmd/git.exe; a POSIX layout would
  // use git/bin/git.
  const dir = IS_WINDOWS ? path.join(root, "git", "cmd") : path.join(root, "git", "bin");
  const exe = path.join(dir, IS_WINDOWS ? "git.exe" : "git");
  return fs.existsSync(exe) ? dir : null;
}

/**
 * Absolute path to the bundled Git Bash, or null if not bundled. This is the
 * git-bash wrapper (git/bin/bash.exe) that sets up the unix environment — pass
 * it to pi's `settingsManager.setShellPath()` so the agent's bash tool works
 * without a system Git install. In dev/containers this returns null and pi
 * falls back to the system bash (the container image provides one).
 */
export function bundledBashExe(): string | null {
  const root = runtimeRoot();
  if (!root) return null;
  const exe = IS_WINDOWS
    ? path.join(root, "git", "bin", "bash.exe")
    : path.join(root, "git", "bin", "bash");
  return fs.existsSync(exe) ? exe : null;
}

/** Absolute path to the bundled `git` executable, or null if not bundled. */
export function bundledGitExe(): string | null {
  const dir = bundledGitDir();
  if (!dir) return null;
  return path.join(dir, IS_WINDOWS ? "git.exe" : "git");
}

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** Absolute path to the bundled npm's CLI entry script, or null if not bundled. */
export function bundledNpmCli(): string | null {
  const root = runtimeRoot();
  if (!root) return null;
  return firstExisting([
    // Windows zip layout (scripts/bundle-runtime.mjs extracts node-vXX-win-x64.zip).
    path.join(root, "node", "node_modules", "npm", "bin", "npm-cli.js"),
    // POSIX tarball layout.
    path.join(root, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]);
}

export interface NpmInvocation {
  /** Executable to spawn. */
  exe: string;
  /** Args to place before the caller's npm args (the npm CLI script, usually). */
  prefixArgs: string[];
  /**
   * True only for the last-resort `npm.cmd` fallback, which needs a shell and
   * therefore cannot run with a UNC cwd. Callers may warn on this.
   */
  viaShell: boolean;
}

let npmFallbackWarned = false;

/**
 * How to invoke npm as a real process.
 *
 * npm ships as `npm.cmd` on Windows, and since the fix for CVE-2024-27980 Node
 * refuses to spawn a `.cmd` without `shell: true` (it throws EINVAL). A shell
 * means cmd.exe, and cmd.exe cannot hold a UNC working directory — it prints
 * "UNC paths are not supported" and silently drops to C:\Windows, which is how
 * a workspace root on `\\server\share` turns into
 * "ENOENT: open 'C:\Windows\package.json'". Running npm's CLI script with a real
 * node executable avoids the shell entirely.
 */
export function resolveNpm(): NpmInvocation {
  const bundledCli = bundledNpmCli();
  const bundledNode = bundledNodeExe();
  if (bundledCli && bundledNode) {
    return { exe: bundledNode, prefixArgs: [bundledCli], viaShell: false };
  }

  // Unpackaged dev / container: derive npm from whichever node is running us.
  const nodeDir = path.dirname(process.execPath);
  const localCli = firstExisting([
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]);
  if (localCli) {
    const { exe, electronAsNode } = resolveAppNode();
    // Electron-as-node would need ELECTRON_RUN_AS_NODE plumbed into every call
    // site; prefer the plain node we already found next to the CLI script.
    return { exe: electronAsNode ? process.execPath : exe, prefixArgs: [localCli], viaShell: false };
  }

  if (!npmFallbackWarned) {
    npmFallbackWarned = true;
    console.warn(
      "[bundled-runtime] No npm-cli.js found next to the bundled or running node; " +
      "falling back to the npm shim via a shell. This cannot run with a UNC working " +
      "directory — a packaging regression, if this appears in a shipped build.",
    );
  }
  return { exe: IS_WINDOWS ? "npm.cmd" : "npm", prefixArgs: [], viaShell: true };
}

let applied = false;

/**
 * Prepend the bundled node + git dirs to process.env.PATH so every child
 * process VCA spawns resolves the bundled tools first. Idempotent; no-op when
 * nothing is bundled. Call this once, early, before the server starts spawning.
 */
export function applyBundledRuntime(): { node: string | null; git: string | null } {
  const nodeDir = bundledNodeDir();
  const gitDir = bundledGitDir();
  if (!applied && (nodeDir || gitDir)) {
    const sep = path.delimiter;
    const prefix = [nodeDir, gitDir].filter(Boolean).join(sep);
    process.env.PATH = prefix + sep + (process.env.PATH || "");
    applied = true;
  }
  return { node: nodeDir, git: gitDir };
}

/**
 * The Node executable to run a user app's `server.js` with.
 *  - Packaged desktop: the bundled node.exe (a real Node, no Electron quirks).
 *  - Container/dev: `process.execPath` is already `node`.
 *  - Packaged desktop with no bundle found (shouldn't happen): fall back to the
 *    Electron binary, and the caller sets ELECTRON_RUN_AS_NODE=1 so it boots as
 *    plain Node.
 */
export function resolveAppNode(): { exe: string; electronAsNode: boolean } {
  const bundled = bundledNodeExe();
  if (bundled) return { exe: bundled, electronAsNode: false };
  const packaged = process.env.VCA_PACKAGED === "1";
  return { exe: process.execPath, electronAsNode: packaged };
}
