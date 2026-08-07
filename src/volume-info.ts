import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
// fs/promises has no realpath.native — only the callback API exposes it, and the
// native variant is the one that resolves a mapped drive to its UNC target.
const realpathNative = promisify(fs.realpath.native);

/**
 * Classifies where a path physically lives: local disk, a cloud-synced folder
 * (OneDrive/Dropbox), a mapped network drive, or a raw UNC share.
 *
 * This exists because a WORKSPACES_ROOT on Windows network storage breaks the
 * toolchain in three distinct ways, and each needs a different response:
 *
 *  - **UNC root** (`\\server\share`) is unusable. cmd.exe refuses a UNC current
 *    directory (so `npm run build` lands in C:\Windows), and even with a
 *    shell-free spawn, vite resolves its root through
 *    `path.posix.normalize(slash(cwd))`, which collapses the leading `\\` and
 *    destroys the server component. See validateRootChange's `uncPath` block.
 *  - **Mapped drive** (`Y:` -> `\\server\share`) works, but vite bundles the
 *    project's vite.config.js with rolldown, which canonicalises the config path
 *    via realpath — yielding the UNC spelling, which then hits the same
 *    normalizePath bug. See maybeRunProjectBuild's `--configLoader native`.
 *  - **Cloud-synced folder** is local NTFS and builds fine, but a real
 *    node_modules inside it means tens of thousands of files for the sync engine.
 *    See node-modules-store, which junctions node_modules out to a local cache.
 *
 * Deliberately dependency-free (only node builtins) and free of any import from
 * ./paths.js: electron/main.ts dynamically imports this from ../dist to validate
 * a storage root, which happens before/independently of WORKSPACES_ROOT being
 * set, and paths.ts throws when that env var is missing.
 */

const IS_WINDOWS = process.platform === "win32";

export type VolumeKind =
  /** Ordinary local disk. Everything works. */
  | "local"
  /** Local disk, but inside a cloud-sync folder (OneDrive, Dropbox). */
  | "cloudSync"
  /** A drive letter that resolves to a `\\server\share` target. */
  | "networkMapped"
  /** A raw `\\server\share` path. Unusable as a workspace root. */
  | "networkUnc"
  /** Classification failed (path unreadable, unexpected platform). */
  | "unknown";

export type SyncProvider = "onedrive" | "dropbox";

export interface VolumeInfo {
  kind: VolumeKind;
  /** The input, path.resolve'd and stripped of any `\\?\` prefix. */
  path: string;
  /** realpath of the path (or its nearest existing ancestor); `path` on failure. */
  realPath: string;
  /** `\\server\share` — set for networkUnc and networkMapped. */
  uncTarget?: string;
  /** The mapped-drive spelling of a networkUnc path, when a mapping exists. */
  driveLetterPath?: string;
  /** Which sync client owns the folder — set for cloudSync. */
  syncProvider?: SyncProvider;
  /**
   * Whether a junction (reparse point) can be created here. False on SMB: the
   * redirector does not support FSCTL_SET_REPARSE_POINT, which is why project
   * sharing is metadata-only (see cleanupLegacyShareJunctions in agent-manager).
   */
  supportsJunctions: boolean;
}

/** True for anything that is not plain local disk. */
export function isNonLocalVolume(v: VolumeInfo): boolean {
  return v.kind !== "local";
}

/** True when the volume is reached over the network (mapped drive or UNC). */
export function isNetworkVolume(v: VolumeInfo): boolean {
  return v.kind === "networkMapped" || v.kind === "networkUnc";
}

/**
 * Strip the Win32 long-path prefix. `\\?\UNC\server\share` is a UNC path;
 * `\\?\C:\dir` is a drive path. Both must lose the prefix before any
 * `startsWith("\\\\")` test, or a long-path drive would look like a share.
 */
function stripLongPathPrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return "\\\\" + p.slice("\\\\?\\UNC\\".length);
  if (p.startsWith("\\\\?\\")) return p.slice("\\\\?\\".length);
  return p;
}

function isUncPath(p: string): boolean {
  return IS_WINDOWS && /^\\\\[^\\]/.test(p);
}

/** `\\server\share\a\b` -> `\\server\share`; null when the path is shorter. */
function uncShareRoot(p: string): string | null {
  const m = /^(\\\\[^\\]+\\[^\\]+)/.exec(p);
  return m ? m[1] : null;
}

/**
 * realpath the deepest existing ancestor of `p`, then re-append the missing
 * tail. A root being validated usually does not exist yet, and
 * realpath on a missing path throws ENOENT. Mirrors realpathNearestAncestor in
 * src/agent-sandbox.ts (kept local so this module stays builtin-only and can be
 * dynamically imported by the Electron main process).
 */
async function realpathNearestAncestor(p: string): Promise<string> {
  let current = p;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await realpathNative(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p; // hit the root without finding anything
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// `net use` mapping table
// ---------------------------------------------------------------------------

/** Matches vite's own parser (chunks/node.js `parseNetUseRE`): status, letter, UNC. */
const NET_USE_RE = /^\s*\w* +(\w:) +([^ ]+)\s/;

let netUseCache: Map<string, string> | null = null;

/**
 * Map of `\\server\share` (lowercased) -> `X:`, parsed from `net use`.
 * Cached for the process lifetime; mapDriveLetter() invalidates it.
 */
async function netUseMap(): Promise<Map<string, string>> {
  if (netUseCache) return netUseCache;
  const map = new Map<string, string>();
  if (IS_WINDOWS) {
    try {
      // net.exe is a real executable, so this needs no shell and is safe to run
      // with any cwd (unlike anything routed through cmd.exe).
      const { stdout } = await execFileAsync("net", ["use"], {
        timeout: 10_000,
        windowsHide: true,
      });
      for (const line of stdout.split("\n")) {
        const m = NET_USE_RE.exec(line);
        if (m) map.set(m[2].toLowerCase().replace(/[\\/]+$/, ""), m[1].toUpperCase());
      }
    } catch {
      // No mappings, or net.exe unavailable — an empty map is the right answer.
    }
  }
  netUseCache = map;
  return map;
}

/**
 * Rewrite a UNC path to its mapped-drive spelling, e.g.
 * `\\gdepfn5d\vca\haet\x` -> `Y:\haet\x`, or null when the share is not mapped.
 */
export async function toDriveLetterPath(p: string): Promise<string | null> {
  const resolved = stripLongPathPrefix(path.resolve(p));
  if (!isUncPath(resolved)) return null;
  const share = uncShareRoot(resolved);
  if (!share) return null;
  const letter = (await netUseMap()).get(share.toLowerCase());
  if (!letter) return null;
  const tail = resolved.slice(share.length).replace(/^[\\/]+/, "");
  return tail ? path.join(letter + "\\", tail) : letter + "\\";
}

/** Drive letters that are free to use for a new network mapping, Z: first. */
function freeDriveLetters(): string[] {
  const out: string[] = [];
  for (let c = "Z".charCodeAt(0); c >= "E".charCodeAt(0); c--) {
    const letter = String.fromCharCode(c) + ":";
    if (!fs.existsSync(letter + "\\")) out.push(letter);
  }
  return out;
}

/**
 * Map `\\server\share` to a free drive letter via `net use`. Returns the new
 * drive-letter path (e.g. `Y:\`) or null when no mapping could be made.
 *
 * Uses the interactive user's existing credentials, so in a domain environment
 * with a live Kerberos ticket this is silent. Note it binds to the *calling*
 * logon session: a mapping made by an elevated process is invisible to a normal
 * one, and vice versa.
 */
export async function mapDriveLetter(uncShare: string): Promise<string | null> {
  if (!IS_WINDOWS) return null;
  const share = uncShareRoot(stripLongPathPrefix(path.resolve(uncShare)));
  if (!share) return null;

  // Already mapped? Reuse rather than burning a second letter on the same share.
  const existing = (await netUseMap()).get(share.toLowerCase());
  if (existing) return existing + "\\";

  for (const letter of freeDriveLetters()) {
    try {
      await execFileAsync("net", ["use", letter, share, "/persistent:yes"], {
        timeout: 30_000,
        windowsHide: true,
      });
      netUseCache = null; // the table just changed
      return letter + "\\";
    } catch {
      // Letter taken by another session, or access denied — try the next one.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cloud-sync roots
// ---------------------------------------------------------------------------

interface SyncRoot {
  dir: string;
  provider: SyncProvider;
}

let syncRootsCache: SyncRoot[] | null = null;

/**
 * Known cloud-sync folder roots for the current user. OneDrive publishes its
 * roots as environment variables (set by the sync client for every process in
 * the session); Dropbox records them in a JSON file under LOCALAPPDATA.
 */
async function syncRoots(): Promise<SyncRoot[]> {
  if (syncRootsCache) return syncRootsCache;
  const roots: SyncRoot[] = [];

  for (const key of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]) {
    const dir = process.env[key];
    if (dir && dir.trim()) roots.push({ dir: path.resolve(dir.trim()), provider: "onedrive" });
  }

  const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (localAppData) {
    try {
      const info = JSON.parse(await fsp.readFile(path.join(localAppData, "Dropbox", "info.json"), "utf-8"));
      for (const entry of Object.values(info as Record<string, { path?: unknown }>)) {
        if (entry && typeof entry.path === "string" && entry.path.trim()) {
          roots.push({ dir: path.resolve(entry.path), provider: "dropbox" });
        }
      }
    } catch {
      // No Dropbox, or an unreadable/!JSON info file — not a sync root then.
    }
  }

  syncRootsCache = roots;
  return roots;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(
    IS_WINDOWS ? parent.toLowerCase() : parent,
    IS_WINDOWS ? child.toLowerCase() : child,
  );
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify the volume `p` lives on. Never throws: an unreadable or nonsensical
 * path yields kind "unknown", which callers treat as "warn, don't block".
 */
export async function classifyVolume(p: string): Promise<VolumeInfo> {
  const resolved = stripLongPathPrefix(path.resolve(p));

  // Non-Windows: no drive letters, no UNC, no OneDrive story worth modelling.
  // The container root (/mnt/storage) is handled by node-modules-store's
  // existing non-Electron branch, which always uses the overlay store.
  if (!IS_WINDOWS) {
    return { kind: "local", path: resolved, realPath: resolved, supportsJunctions: true };
  }

  if (isUncPath(resolved)) {
    const uncTarget = uncShareRoot(resolved) ?? undefined;
    const driveLetterPath = (await toDriveLetterPath(resolved)) ?? undefined;
    return {
      kind: "networkUnc",
      path: resolved,
      realPath: resolved,
      uncTarget,
      driveLetterPath,
      supportsJunctions: false,
    };
  }

  let realPath = resolved;
  try {
    realPath = await realpathNearestAncestor(resolved);
  } catch {
    return { kind: "unknown", path: resolved, realPath: resolved, supportsJunctions: false };
  }
  realPath = stripLongPathPrefix(realPath);

  // A drive letter whose realpath is a UNC path is a mapped network drive.
  // This is the same probe vite uses in windowsMappedRealpathSync.
  if (isUncPath(realPath)) {
    return {
      kind: "networkMapped",
      path: resolved,
      realPath,
      uncTarget: uncShareRoot(realPath) ?? undefined,
      supportsJunctions: false,
    };
  }

  for (const root of await syncRoots()) {
    if (isInside(resolved, root.dir) || isInside(realPath, root.dir)) {
      return {
        kind: "cloudSync",
        path: resolved,
        realPath,
        syncProvider: root.provider,
        supportsJunctions: true,
      };
    }
  }

  return { kind: "local", path: resolved, realPath, supportsJunctions: true };
}

/** Test seam: drop the `net use` and sync-root caches. */
export function resetVolumeCaches(): void {
  netUseCache = null;
  syncRootsCache = null;
}

/**
 * Default location for machine-local caches that must NOT live on the workspace
 * root (node_modules store, npm cache). Deliberately not os.tmpdir(): corporate
 * cleanup policies and Disk Cleanup wipe %TEMP%, which would silently destroy
 * every project's installed dependencies.
 */
export function defaultLocalCacheDir(): string {
  if (IS_WINDOWS) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "VCA", "cache");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "vca");
}
