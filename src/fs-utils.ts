import fs from "fs/promises";
import path from "path";

/**
 * Low-level filesystem helpers with no project dependencies.
 *
 * These live here (not in agent-manager.ts) so the many lower-level config/
 * store modules that need them — admin-settings, auth-config, mcp-servers,
 * user-store, env-vars-store, … — don't have to import the top-level
 * agent-manager god-file, which imports back from several of them. Keeping
 * these utilities dependency-free (only Node's fs/path) breaks those cycles.
 */

/**
 * Atomic JSON write: stage to a sibling temp file, then rename over the target.
 *
 * Concurrent prompts / diagram edits / message saves can fire overlapping
 * fs.writeFile calls on the same file. A naive write opens, truncates, then
 * streams bytes — readers (and a second concurrent writer) can observe a
 * truncated or partially-written file. fs.rename is atomic (on POSIX, and on
 * Windows for files within the same volume), so swapping a fully-written temp
 * file in place gives readers all-or-nothing visibility and ensures the final
 * state is whichever writer finished last (no torn bytes).
 */
export async function atomicWriteJson(filePath: string, value: unknown, indent?: number): Promise<void> {
  const data = indent != null ? JSON.stringify(value, null, indent) : JSON.stringify(value);
  // Per-process unique suffix avoids two concurrent writers using the same
  // temp filename (which would let one truncate the other's staged content).
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, data, "utf-8");
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    // On rename failure, best-effort cleanup of the temp file
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Recursively copy a directory tree, skipping .git and node_modules. */
export async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
