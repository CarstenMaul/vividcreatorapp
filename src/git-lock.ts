import fs from "fs/promises";
import path from "path";

const lockChains = new Map<string, Promise<void>>();

/**
 * Serialize all git operations per workspace directory.
 * Uses a promise-chain mutex keyed by workspacePath so that concurrent
 * callers on the same repo queue up instead of hitting index.lock conflicts.
 * Also removes stale .git/index.lock files (crash recovery) before each op.
 */
export async function withGitLock<T>(workspacePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockChains.get(workspacePath) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  lockChains.set(workspacePath, next);

  await prev;

  // Clean stale index.lock left by a crashed process
  try {
    await fs.rm(path.join(workspacePath, ".git", "index.lock"), { force: true });
  } catch { /* ignore */ }

  try {
    return await fn();
  } finally {
    release();
    if (lockChains.get(workspacePath) === next) {
      lockChains.delete(workspacePath);
    }
  }
}
