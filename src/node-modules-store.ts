import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import type { Dirent } from "fs";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

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
// The store is only used in cloud mode. In Electron (VCA_PACKAGED=1) the
// workspace is already on local disk, so node_modules is installed in-place
// and the store, LRU sweep, and overlay-staging trick are all bypassed.
const STORE_ROOT = process.env.NODE_MODULES_STORE || path.join(os.tmpdir(), "vca-nm");

const isElectron = (): boolean => process.env.VCA_PACKAGED === "1";

// Shared npm download cache so repeat installs of the same dep across
// different projects become local file copies instead of registry fetches.
const NPM_CACHE_DIR = process.env.NPM_SHARED_CACHE || path.join(os.tmpdir(), "vca-npm-cache");

// Size cap for STORE_ROOT; when exceeded, LRU eviction kicks in during
// the startup sweep. 10 GB default leaves headroom on a 20 GB overlay.
const STORE_CAP_BYTES = parseInt(process.env.NODE_MODULES_STORE_CAP || String(10 * 1024 * 1024 * 1024), 10);

const INSTALL_TIMEOUT_MS = 300_000;

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
        await execAsync(`cp -r "${from}" "${to}"`, { timeout: INSTALL_TIMEOUT_MS });
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
 * In Electron mode, no symlink is created — the workspace owns its own
 * node_modules. A pre-existing junction left over from a prior cloud run
 * (or from a workspace copied between machines) is dropped here so the
 * next install lands a real directory.
 */
export async function ensureNodeModulesSymlink(
  workspacePath: string,
  projectId: string,
): Promise<{ needsInstall: boolean }> {
  const link = path.join(workspacePath, "node_modules");

  if (isElectron()) {
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

  // --include=dev is mandatory: a generated app's build toolchain (vite,
  // tailwind, @vitejs/plugin-react) lives in devDependencies, so `npm run build`
  // can only succeed if they're installed. The container image sets
  // NODE_ENV=production, under which a bare `npm install` silently omits dev
  // deps — the build then dies with "vite: not found". Forcing --include=dev
  // overrides that omission and behaves identically in Electron (where NODE_ENV
  // isn't "production" anyway).
  if (isElectron()) {
    const cmd = `npm config set strict-ssl false && npm install --include=dev --cache "${NPM_CACHE_DIR}"`;
    await execAsync(cmd, { cwd: workspacePath, timeout: INSTALL_TIMEOUT_MS });
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

  const cmd = `npm config set strict-ssl false && npm install --include=dev --cache "${NPM_CACHE_DIR}"`;
  await execAsync(cmd, { cwd: overlayDir, timeout: INSTALL_TIMEOUT_MS });

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

  const run = (async () => {
    const { needsInstall } = await ensureNodeModulesSymlink(workspacePath, projectId);
    if (needsInstall) await runNpmInstall(workspacePath, projectId);
  })();
  locks.set(projectId, run);
  try {
    await run;
  } finally {
    locks.delete(projectId);
  }
}

/**
 * Wipe node_modules so the next ensureDependencies() reinstalls from a
 * clean slate. Used when package.json changes.
 *
 * Cloud: clear the store target but keep the workspace symlink intact
 * (avoids Azure Files ENOTEMPTY hazard of rm'ing through the symlink).
 * Electron: rm the real `{workspacePath}/node_modules` directory.
 * `workspacePath` is required in Electron mode.
 */
export async function clearNodeModules(projectId: string, workspacePath?: string): Promise<void> {
  if (isElectron()) {
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
 * In cloud, that's the overlay-disk store keyed by projectId.
 * In Electron, it lands directly at `{workspacePath}/node_modules`.
 * `workspacePath` is required in Electron mode.
 */
export async function seedNodeModulesFromDir(
  projectId: string,
  sourceDir: string,
  workspacePath?: string,
): Promise<void> {
  const target = isElectron()
    ? path.join(workspacePath!, "node_modules")
    : nmTargetDir(projectId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // If an empty dir was pre-created elsewhere, remove it so the copy
  // lands the contents at the right path rather than inside a subdir.
  try { await fs.rmdir(target); } catch { /* non-empty or missing — ignore */ }
  const shellCmd = process.platform === "win32"
    ? `xcopy /E /I /Q /Y "${sourceDir}" "${target}"`
    : `cp -r "${sourceDir}" "${target}"`;
  await execAsync(shellCmd, { timeout: INSTALL_TIMEOUT_MS });
}

export async function removeNodeModulesStore(projectId: string): Promise<void> {
  if (isElectron()) return; // workspace deletion removes node_modules
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
  if (isElectron()) return; // no store to sweep
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(STORE_ROOT, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name as string;
    if (knownProjectIds.has(id) || protectedIds.has(id)) continue;
    console.log(`[nm-store] Sweep: removing orphaned store entry for ${id}`);
    await rmRetry(path.join(STORE_ROOT, id), { recursive: true, force: true }).catch(() => { /* ignore */ });
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
