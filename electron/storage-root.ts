// Desktop-only physical workspace-root management.
//
// The server resolves every data path from process.env.WORKSPACES_ROOT once at
// module load (see src/paths.ts) — it is frozen for the life of the process.
// So relocating the data root cannot happen live; instead the Settings UI stages
// a *pending* change and this module applies it at the NEXT boot, before the
// server bundle is imported (when nothing holds file handles).
//
// The pointer lives in Electron userData (e.g. %APPDATA%\VCA\workspace-root.json)
// — deliberately OUTSIDE the movable data root (%APPDATA%\vca), which would
// otherwise move out from under the very file that records where it went.
//
// This module takes base directories as arguments and never imports electron, so
// the resolve/move logic stays pure and unit-testable.

import { promises as fs } from "fs";
import path from "path";

export type RootChangeMode = "move" | "new" | "existing";

export interface PendingRootChange {
  /** Absolute path of the folder to switch to. */
  newRoot: string;
  /**
   * "move" relocates existing data into newRoot; "new" starts fresh there;
   * "existing" points at a folder that already holds a VCA workspace, copying
   * nothing and leaving the old root untouched.
   */
  mode: RootChangeMode;
  /** ISO timestamp the change was staged (informational). */
  requestedAt?: string;
}

export interface RootConfig {
  /** Committed active root. Absent → caller's default. */
  root?: string;
  /** A change staged from Settings, consumed on the next boot. */
  pending?: PendingRootChange;
}

export interface ResolveResult {
  /** The root to hand to the server this boot. */
  root: string;
  /** Set when a staged change failed to apply; the old root is kept. */
  error?: string;
  /** True when a pending change was applied this boot. */
  applied?: boolean;
  /** The mode that was applied (for splash/log messaging). */
  appliedMode?: RootChangeMode;
}

/**
 * Non-blocking hazards the user must acknowledge before a root is staged.
 *  - networkDrive: a mapped network drive. Builds and installs are much slower,
 *    and node_modules cannot be moved off the share (no junctions over SMB).
 *  - cloudSync: OneDrive/Dropbox. Works, and node_modules is diverted to a local
 *    cache so the sync engine isn't handed tens of thousands of files.
 */
export type RootWarning = "networkDrive" | "cloudSync";

/**
 * Subset of src/volume-info.ts's VolumeInfo. Declared structurally rather than
 * imported: electron/tsconfig.json sets rootDir to electron/, so this module
 * cannot reference src/. The classifier is injected instead (see `classify`).
 */
export interface RootVolumeInfo {
  kind: "local" | "cloudSync" | "networkMapped" | "networkUnc" | "unknown";
  uncTarget?: string;
  driveLetterPath?: string;
  syncProvider?: string;
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
  /**
   * Absolute, normalized target path (present when ok). For a UNC path that is
   * already mapped to a drive letter this is the drive-letter spelling, not what
   * the user picked — see validateRootChange.
   */
  normalized?: string;
  /** Hazards the UI must show and the caller must echo back to stage. */
  warnings?: RootWarning[];
  /** What the target volume turned out to be, for messaging. */
  volume?: RootVolumeInfo;
}

const IS_WIN = process.platform === "win32";

/** Top-level names that mark an existing VCA data layout under a root. */
const VCA_LAYOUT_MARKERS: ReadonlySet<string> = new Set([
  "admin",
  "_system",
  ".vca-sessions",
]);

export function rootConfigPath(userDataDir: string): string {
  return path.join(userDataDir, "workspace-root.json");
}

/** Case-insensitive on Windows; resolved+trailing-slash-stripped everywhere. */
function norm(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, "");
  return IS_WIN ? r.toLowerCase() : r;
}

function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

/** True when `child` is `parent` itself or lives inside it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `{ entries: null }` means "doesn't exist yet", which is a perfectly good
 * target. `{ unreadable: true }` means it exists but we can't look inside —
 * a disconnected share, a permission-denied folder, a dead drive letter.
 *
 * This used to rethrow anything that wasn't ENOENT, so pointing at an
 * unreachable network path escaped validateRootChange as a raw EPERM and
 * surfaced in the UI as an unhandled stack trace instead of an explanation.
 */
async function readdirSafe(dir: string): Promise<{ entries: string[] | null; unreadable: boolean }> {
  try {
    return { entries: await fs.readdir(dir), unreadable: false };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { entries: null, unreadable: false };
    return { entries: null, unreadable: true };
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows-friendly recursive delete: the sync filter / AV can hold a handle
 * briefly after a copy, so retry a few times before giving up. Mirrors rmRetry
 * in src/app-process-manager.ts (kept local so this runs before the server
 * bundle loads).
 */
async function rmRetry(target: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await delay(150 * (i + 1));
    }
  }
}

export async function readRootConfig(userDataDir: string): Promise<RootConfig> {
  try {
    const text = await fs.readFile(rootConfigPath(userDataDir), "utf-8");
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object") return {};
    const cfg: RootConfig = {};
    if (typeof raw.root === "string" && raw.root.trim()) cfg.root = raw.root;
    const p = raw.pending;
    if (p && typeof p === "object" && typeof p.newRoot === "string" && (p.mode === "move" || p.mode === "new" || p.mode === "existing")) {
      cfg.pending = {
        newRoot: p.newRoot,
        mode: p.mode,
        requestedAt: typeof p.requestedAt === "string" ? p.requestedAt : undefined,
      };
    }
    return cfg;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    // A corrupt pointer must not brick the app — fall back to the default root.
    return {};
  }
}

export async function writeRootConfig(userDataDir: string, cfg: RootConfig): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  const tmp = rootConfigPath(userDataDir) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  await fs.rename(tmp, rootConfigPath(userDataDir));
}

/**
 * Validate a proposed root change before it is staged. `currentRoot` is the
 * active committed root (process.env.WORKSPACES_ROOT at runtime).
 */
export async function validateRootChange(args: {
  newRoot: string;
  mode: RootChangeMode;
  currentRoot: string;
  /** Injected src/volume-info.ts classifier. Omit to skip volume checks. */
  classify?: (p: string) => Promise<RootVolumeInfo>;
}): Promise<ValidateResult> {
  const raw = typeof args.newRoot === "string" ? args.newRoot.trim() : "";
  if (!raw) return { ok: false, error: "empty" };
  if (args.mode !== "move" && args.mode !== "new" && args.mode !== "existing") return { ok: false, error: "mode" };

  let newRoot = path.resolve(raw);
  if (!path.isAbsolute(newRoot)) return { ok: false, error: "absolute" };

  // Volume checks come first: a UNC root can never work, so there is no point
  // probing its contents or writability and reporting some downstream symptom.
  const warnings: RootWarning[] = [];
  let volume: RootVolumeInfo | undefined;
  if (args.classify) {
    try {
      volume = await args.classify(newRoot);
    } catch {
      volume = undefined; // classification is advisory; never block on its failure
    }
  }
  if (volume) {
    if (volume.kind === "networkUnc") {
      // A `\\server\share` root is unusable: cmd.exe refuses it as a working
      // directory, and vite's normalizePath() collapses the leading `\\` so the
      // build resolves its entry against a path that does not exist. If the same
      // share is already mapped to a drive letter, silently prefer that spelling
      // — same folder, and everything downstream works.
      if (!volume.driveLetterPath) return { ok: false, error: "uncPath", volume };
      newRoot = path.resolve(volume.driveLetterPath);
      warnings.push("networkDrive");
    } else if (volume.kind === "networkMapped") {
      warnings.push("networkDrive");
    } else if (volume.kind === "cloudSync") {
      warnings.push("cloudSync");
    }
  }

  const current = path.resolve(args.currentRoot);
  if (samePath(newRoot, current)) return { ok: false, error: "same" };
  if (isInside(newRoot, current) || isInside(current, newRoot)) return { ok: false, error: "nested" };

  const { entries, unreadable } = await readdirSafe(newRoot);
  // Exists but unlistable (offline share, denied ACL) — nothing below can give a
  // meaningful answer, and "can't be written to" is the accurate advice.
  if (unreadable) return { ok: false, error: "notWritable", warnings, volume };
  const hasVcaData = !!entries && entries.some((name) => VCA_LAYOUT_MARKERS.has(name));
  if (args.mode === "move") {
    if (entries && entries.length > 0) return { ok: false, error: "notEmpty" };
  } else if (args.mode === "existing") {
    // Must already hold a VCA layout — we point at it as-is, copying nothing.
    if (!hasVcaData) return { ok: false, error: "noData" };
  } else {
    if (hasVcaData) return { ok: false, error: "hasData" };
  }

  // Writability probe (also creates the folder the picker's createDirectory may
  // have promised). A failure here is the clearest signal we can give the user.
  try {
    await fs.mkdir(newRoot, { recursive: true });
    const probe = path.join(newRoot, ".vca-write-test");
    await fs.writeFile(probe, "");
    await fs.rm(probe, { force: true });
  } catch {
    return { ok: false, error: "notWritable" };
  }

  return { ok: true, normalized: newRoot, warnings, volume };
}

/**
 * Prepare phase of a staged change: for "new", ensure the (empty) target dir;
 * for "existing", do nothing (the target already holds the workspace we're
 * pointing at); for "move", COPY the old root's tree into the target. No
 * destructive delete happens here — the old data is untouched until the pointer
 * is committed by the resolver, so a failure/crash mid-copy never loses data.
 */
async function prepareRootChange(oldRoot: string, pending: PendingRootChange): Promise<void> {
  await fs.mkdir(pending.newRoot, { recursive: true });
  if (pending.mode === "new" || pending.mode === "existing") return;

  if (!(await pathExists(oldRoot))) return; // nothing to move (brand-new install)

  // fs.cp makes newRoot mirror oldRoot's contents; force:true keeps retries
  // idempotent after a partially-copied earlier attempt.
  await fs.cp(oldRoot, pending.newRoot, { recursive: true, force: true });
}

/**
 * Resolve the workspace root for this boot, applying any pending change first.
 *
 * Commit ordering guarantees no data loss:
 *   1. prepare (copy for move / mkdir for new) — old data untouched
 *   2. write the pointer {root:newRoot} (COMMIT) — pending cleared
 *   3. best-effort delete of the old root (move only) — post-commit cleanup
 * A crash before (2) leaves the old root intact and pending set (safe retry);
 * a crash after (2) at worst orphans the old folder.
 */
export async function resolveWorkspacesRoot(opts: {
  userDataDir: string;
  defaultRoot: string;
  onMoveStart?: () => void;
  log?: (msg: string) => void;
}): Promise<ResolveResult> {
  const { userDataDir, defaultRoot, log } = opts;
  const cfg = await readRootConfig(userDataDir);
  let active = cfg.root && cfg.root.trim() ? cfg.root : defaultRoot;

  if (cfg.pending) {
    const pending = cfg.pending;
    const oldRoot = active;
    try {
      opts.onMoveStart?.();
      log?.(`applying staged workspace root change: mode=${pending.mode} newRoot=${pending.newRoot}`);
      await prepareRootChange(oldRoot, pending);

      // COMMIT — the pointer now names the new root; pending is cleared.
      active = pending.newRoot;
      await writeRootConfig(userDataDir, { root: active });
      log?.(`workspace root committed: ${active}`);

      // Post-commit cleanup: remove the old data only after a "move" succeeds.
      if (pending.mode === "move" && !samePath(oldRoot, active)) {
        try {
          await rmRetry(oldRoot);
          log?.(`removed old workspace root: ${oldRoot}`);
        } catch (err) {
          log?.(`old workspace root left behind (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await fs.mkdir(active, { recursive: true });
      return { root: active, applied: true, appliedMode: pending.mode };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.(`workspace root change FAILED (keeping old root ${oldRoot}): ${message}`);
      // Keep pending + old data intact; start on the old root.
      await fs.mkdir(oldRoot, { recursive: true });
      return { root: oldRoot, error: message };
    }
  }

  await fs.mkdir(active, { recursive: true });
  return { root: active };
}
