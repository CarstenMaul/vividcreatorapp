import fs from "fs/promises";
import type { Dirent } from "fs";
import path from "path";
import os from "os";
import { npm, run } from "./exec-utils.js";
import { classifyVolume, defaultLocalCacheDir } from "./volume-info.js";
import { WORKSPACES_ROOT } from "./paths.js";

// Local copy of rmRetry to avoid a circular import with app-process-manager
// (which itself imports from this module).
async function rmRetry(target: string, opts: { recursive?: boolean; force?: boolean }): Promise<void> {
  const delays = [50, 150, 400, 1000];
  for (let i = 0; i <= delays.length; i++) {
    try {
      await fs.rm(target, opts);
      return;
    } catch (err: any) {
      if (err?.code !== "ENOTEMPTY" && err?.code !== "EBUSY") throw err;
      if (i === delays.length) throw err;
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
}

// Root for per-project node_modules. Overlay rootfs in the container
// (fast local disk, ephemeral, ~13 GB free — see `mount` / `df` inside
// the live Container App). Azure Files NFS at /mnt/storage is avoided
// for anything in the hot path (require resolution, npm install).
//
// In Electron the store is normally bypassed — the workspace is on local disk,
// so node_modules is installed in-place. The exception is a cloud-synced
// workspace root (OneDrive, Dropbox): a real node_modules there is tens of
// thousands of files for the sync engine to chew through, and users reported
// sync simply never converging. See useStore().
//
// os.tmpdir() is deliberately NOT the desktop default: %TEMP% is wiped by Disk
// Cleanup and corporate cleanup policy, which would silently destroy every
// project's installed dependencies.
const STORE_ROOT = process.env.NODE_MODULES_STORE
  || (isDesktop() ? path.join(defaultLocalCacheDir(), "nm") : path.join(os.tmpdir(), "vca-nm"));

function isDesktop(): boolean { return process.env.VCA_PACKAGED === "1"; }

// Shared npm download cache so repeat installs of the same dep across
// different projects become local file copies instead of registry fetches.
const NPM_CACHE_DIR = process.env.NPM_SHARED_CACHE
  || (isDesktop() ? path.join(defaultLocalCacheDir(), "npm") : path.join(os.tmpdir(), "vca-npm-cache"));

let storeModePromise: Promise<boolean> | null = null;

/**
 * Whether `<workspace>/node_modules` should be a junction into STORE_ROOT
 * instead of a real directory.
 *
 * - Container/cloud: always, as before.
 * - Desktop on a cloud-synced root: yes — this is what keeps ~40k dependency
 *   files out of OneDrive's sync scope. Those folders are local NTFS, so a
 *   junction can actually be created there.
 * - Desktop anywhere else: no. On local disk in-place is simpler and faster, and
 *   on an SMB share a junction cannot be created at all — the redirector does
 *   not support setting a mount-point reparse point, which is the same reason
 *   project sharing is metadata-only (see cleanupLegacyShareJunctions).
 */
async function useStore(): Promise<boolean> {
  if (!isDesktop()) return true;
  if (!storeModePromise) {
    storeModePromise = classifyVolume(WORKSPACES_ROOT)
      .then((v) => v.kind === "cloudSync" && v.supportsJunctions)
      .catch(() => false);
  }
  return storeModePromise;
}

// Size cap for STORE_ROOT; when exceeded, LRU eviction kicks in during
// the startup sweep. 10 GB default leaves headroom on a 20 GB overlay.
const STORE_CAP_BYTES = parseInt(process.env.NODE_MODULES_STORE_CAP || String(10 * 1024 * 1024 * 1024), 10);

const INSTALL_TIMEOUT_MS = 300_000;

// --include=dev is mandatory: a generated app's build toolchain (vite, tailwind,
// @vitejs/plugin-react) lives in devDependencies, so `npm run build` can only
// succeed if they're installed. The container image sets NODE_ENV=production,
// under which a bare `npm install` silently omits dev deps — the build then dies
// with "vite: not found". Forcing --include=dev overrides that omission and
// behaves identically in Electron (where NODE_ENV isn't "production" anyway).
//
// --strict-ssl=false is passed per invocation rather than via
// `npm config set strict-ssl false`, which used to run first and permanently
// disabled certificate checking in the user's own ~/.npmrc — a side effect well
// outside what installing a project's dependencies should do.
const NPM_INSTALL_ARGS = [
  "install",
  "--include=dev",
  "--strict-ssl=false",
  "--cache",
  NPM_CACHE_DIR,
];

// Per-project mutex so two callers (init + preview start racing) coalesce
// onto one install instead of running npm install twice in parallel.
const locks = new Map<string, Promise<void>>();

export function nmTargetDir(projectId: string): string {
  return path.join(STORE_ROOT, projectId, "node_modules");
}

export function nmProjectDir(projectId: string): string {
  return path.join(STORE_ROOT, projectId);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function isDirEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

async function moveDirContents(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src);
  for (const name of entries) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    try {
      await fs.rename(from, to);
    } catch (err: any) {
      if (err?.code === "EXDEV") {
        // Cross-device — fall back to recursive copy, then remove source.
        await run("cp", ["-r", from, to], { timeout: INSTALL_TIMEOUT_MS });
        await rmRetry(from, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }
}

/**
 * Reconcile `{workspacePath}/node_modules` so it is a link pointing at
 * `nmTargetDir(projectId)`. Idempotent: safe to call on every project touch.
 *
 * Returns needsInstall=true when the target was just created or is empty,
 * signalling that a subsequent npm install is required.
 *
 * When the store is not in use (desktop on local disk or on a share that cannot
 * hold a junction), no symlink is created — the workspace owns its own
 * node_modules. A pre-existing junction left over from a prior run in the other
 * mode (or from a workspace copied between machines, or a root that has since
 * moved off OneDrive) is dropped here so the next install lands a real directory.
 */
export async function ensureNodeModulesSymlink(
  workspacePath: string,
  projectId: string,
): Promise<{ needsInstall: boolean }> {
  const link = path.join(workspacePath, "node_modules");

  if (!(await useStore())) {
    let st: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try { st = await fs.lstat(link); } catch { /* missing — fine */ }
    if (st?.isSymbolicLink()) {
      await fs.unlink(link).catch(() => { /* ignore */ });
      return { needsInstall: true };
    }
    if (!st) return { needsInstall: true };
    if (st.isDirectory()) return { needsInstall: await isDirEmpty(link) };
    // Stray file at node_modules path — remove and reinstall.
    await fs.unlink(link).catch(() => { /* ignore */ });
    return { needsInstall: true };
  }

  const target = nmTargetDir(projectId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const targetExisted = await fileExists(target);
  if (!targetExisted) await fs.mkdir(target, { recursive: true });

  let st: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try { st = await fs.lstat(link); } catch { /* missing — fine */ }

  if (st) {
    if (st.isSymbolicLink()) {
      let current = "";
      try { current = await fs.readlink(link); } catch { /* fall through */ }
      if (current && path.resolve(path.dirname(link), current) === path.resolve(target)) {
        // Already the correct link.
        return { needsInstall: !targetExisted || await isDirEmpty(target) };
      }
      await fs.unlink(link).catch(() => { /* ignore */ });
    } else if (st.isDirectory()) {
      // Legacy real-directory install sitting on /mnt/storage.
      // If target is empty, migrate contents so we don't lose the install.
      if (await isDirEmpty(target)) {
        try {
          await moveDirContents(link, target);
        } catch (err) {
          console.warn(`[nm-store] Migration of existing node_modules failed for ${projectId}, will reinstall:`, err);
        }
      }
      await rmRetry(link, { recursive: true, force: true });
    } else {
      // Stray file — clear it.
      await fs.unlink(link).catch(() => { /* ignore */ });
    }
  }

  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    await fs.symlink(target, link, linkType);
  } catch (err) {
    console.error(`[nm-store] Failed to create symlink ${link} -> ${target}:`, err);
    throw err;
  }

  return { needsInstall: !targetExisted || await isDirEmpty(target) };
}

// Install must run from inside the overlay dir, not the workspace. With cwd
// on NFS, npm's reify renames the existing `node_modules` aside (which
// operates on our symlink) and creates a fresh real directory in its place
// on NFS — defeating the whole store. Staging the manifest files into the
// overlay and running from there keeps node_modules on overlay and leaves
// the workspace symlink intact.
//
// Known limitation: `file:`-path dependencies in package.json won't resolve
// because their sources live under the workspace, not the overlay. The app
// template doesn't use them.
export async function runNpmInstall(workspacePath: string, projectId: string): Promise<void> {
  await fs.mkdir(NPM_CACHE_DIR, { recursive: true });

  if (!(await useStore())) {
    await npm(NPM_INSTALL_ARGS, { cwd: workspacePath, timeout: INSTALL_TIMEOUT_MS });
    return;
  }

  const overlayDir = nmProjectDir(projectId);
  await fs.mkdir(overlayDir, { recursive: true });

  for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
    const src = path.join(workspacePath, name);
    const dst = path.join(overlayDir, name);
    try {
      await fs.copyFile(src, dst);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  await npm(NPM_INSTALL_ARGS, { cwd: overlayDir, timeout: INSTALL_TIMEOUT_MS });

  // npm may have created or updated the lockfile; mirror it back so git
  // sees it and future installs start from the resolved versions.
  try {
    await fs.copyFile(path.join(overlayDir, "package-lock.json"), path.join(workspacePath, "package-lock.json"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

/**
 * The single chokepoint for "the project must have its dependencies ready".
 * Called from every lifecycle hook (create, preview start, restart after
 * package.json change). No-op when there is no package.json.
 */
export async function ensureDependencies(
  workspacePath: string,
  projectId: string,
): Promise<void> {
  if (!(await fileExists(path.join(workspacePath, "package.json")))) return;

  const existing = locks.get(projectId);
  if (existing) return existing;

  const pending = (async () => {
    const { needsInstall } = await ensureNodeModulesSymlink(workspacePath, projectId);
    if (needsInstall) await runNpmInstall(workspacePath, projectId);
  })();
  locks.set(projectId, pending);
  try {
    await pending;
  } finally {
    locks.delete(projectId);
  }
}

/**
 * Wipe node_modules so the next ensureDependencies() reinstalls from a
 * clean slate. Used when package.json changes.
 *
 * Store mode: clear the store target but keep the workspace symlink intact
 * (avoids the Azure Files ENOTEMPTY hazard of rm'ing through the symlink — and
 * on Windows fs.rm follows a junction, so this would otherwise delete the
 * target's contents through the link anyway).
 * In-place mode: rm the real `{workspacePath}/node_modules` directory.
 * `workspacePath` is required in in-place mode.
 */
export async function clearNodeModules(projectId: string, workspacePath?: string): Promise<void> {
  if (!(await useStore())) {
    if (!workspacePath) return;
    await rmRetry(path.join(workspacePath, "node_modules"), { recursive: true, force: true });
    return;
  }
  const target = nmTargetDir(projectId);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(target);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(name => rmRetry(path.join(target, name), { recursive: true, force: true }))
  );
}

/**
 * Copy an externally-built node_modules (e.g. the app template's
 * pre-installed dependencies) into place for this project.
 *
 * In store mode, that's the local-disk store keyed by projectId.
 * Otherwise it lands directly at `{workspacePath}/node_modules`, and
 * `workspacePath` is required.
 */
export async function seedNodeModulesFromDir(
  projectId: string,
  sourceDir: string,
  workspacePath?: string,
): Promise<void> {
  const target = (await useStore())
    ? nmTargetDir(projectId)
    : path.join(workspacePath!, "node_modules");
  await fs.mkdir(path.dirname(target), { recursive: true });
  // If an empty dir was pre-created elsewhere, remove it so the copy
  // lands the contents at the right path rather than inside a subdir.
  try { await fs.rmdir(target); } catch { /* non-empty or missing — ignore */ }
  // xcopy/cp rather than fs.cp: a seeded node_modules is tens of thousands of
  // small files, where the native copiers are markedly faster. Both are real
  // executables, so no shell is involved and the paths may be UNC.
  if (process.platform === "win32") {
    await run("xcopy", ["/E", "/I", "/Q", "/Y", sourceDir, target], { timeout: INSTALL_TIMEOUT_MS });
  } else {
    await run("cp", ["-r", sourceDir, target], { timeout: INSTALL_TIMEOUT_MS });
  }
}

export async function removeNodeModulesStore(projectId: string): Promise<void> {
  if (!(await useStore())) return; // workspace deletion removes node_modules
  await rmRetry(nmProjectDir(projectId), { recursive: true, force: true });
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name as string);
    try {
      if (entry.isDirectory()) {
        total += await dirSize(p);
      } else if (entry.isFile()) {
        const st = await fs.stat(p);
        total += st.size;
      }
    } catch { /* ignore races */ }
  }
  return total;
}

/**
 * Startup cleanup:
 *   - Delete any /tmp/vca-nm/{id} whose id is not in the known set.
 *   - If the store still exceeds STORE_CAP_BYTES, LRU-evict (by parent
 *     dir mtime) until under the cap. Projects whose preview is currently
 *     running are protected via `protectedIds`.
 */
export async function sweepNodeModulesStore(
  knownProjectIds: Set<string>,
  protectedIds: Set<string> = new Set(),
): Promise<void> {
  if (!(await useStore())) return; // no store to sweep
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(STORE_ROOT, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return;
  }

  // An empty known-set almost always means enumeration failed rather than that
  // every project vanished — listUserDirs() swallows a read error on the root
  // and returns []. With a workspace root on a network share that is a real
  // startup race, and sweeping on it would delete every project's dependencies.
  if (knownProjectIds.size === 0) {
    if (entries.some((e) => e.isDirectory())) {
      console.warn("[nm-store] Sweep skipped: no known projects, but the store is non-empty");
    }
    return;
  }

  // Orphan removal only applies to entries that have had time to be registered.
  // A project created seconds ago may not be in knownProjectIds yet.
  const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name as string;
    if (knownProjectIds.has(id) || protectedIds.has(id)) continue;
    const dir = path.join(STORE_ROOT, id);
    try {
      const st = await fs.stat(dir);
      if (now - st.mtimeMs < ORPHAN_GRACE_MS) continue;
    } catch { /* unreadable — fall through and try to remove it */ }
    console.log(`[nm-store] Sweep: removing orphaned store entry for ${id}`);
    await rmRetry(dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }

  // Size-cap enforcement: compute total, evict LRU until under cap.
  let total = await dirSize(STORE_ROOT);
  if (total <= STORE_CAP_BYTES) return;

  const stats: { id: string; mtimeMs: number }[] = [];
  try {
    const ents = await fs.readdir(STORE_ROOT, { withFileTypes: true }) as unknown as Dirent[];
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const name = e.name as string;
      if (protectedIds.has(name)) continue;
      try {
        const st = await fs.stat(path.join(STORE_ROOT, name));
        stats.push({ id: name, mtimeMs: st.mtimeMs });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { id } of stats) {
    if (total <= STORE_CAP_BYTES) break;
    const dir = path.join(STORE_ROOT, id);
    const size = await dirSize(dir);
    console.log(`[nm-store] Cap exceeded; evicting ${id} (~${Math.round(size / 1024 / 1024)} MB)`);
    await rmRetry(dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    total -= size;
  }
}
