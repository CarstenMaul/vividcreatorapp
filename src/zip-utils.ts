import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Extraction junk that zip tools create; ignored when locating the payload root. */
export const ZIP_JUNK = new Set(["__MACOSX", ".DS_Store", "Thumbs.db"]);

/**
 * Extract a zip archive with a native tool. Info-ZIP unzip is available in
 * the Docker image and in Git Bash; packaged Windows desktops don't have it,
 * so fall back to bsdtar. execFile (no shell) + `--` sentinel: filenames
 * cannot be parsed as flags or shell metacharacters — same pattern as
 * unzipUserdata in agent-manager.ts.
 */
export async function extractZipTo(zipPath: string, destDir: string): Promise<void> {
  try {
    await execFileAsync("unzip", ["-o", "-q", "--", zipPath, "-d", destDir]);
    return;
  } catch (err: any) {
    // Only fall back when the unzip binary itself is missing; a failing
    // extraction (corrupt archive) must surface as an error.
    if (err?.code !== "ENOENT") throw err;
  }
  // On Windows, address System32's tar.exe (bsdtar, reads zip) explicitly —
  // a Git-Bash GNU tar earlier in the PATH can neither read zip archives nor
  // drive-letter paths ("C:" parses as a remote host).
  const tarBin =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  await execFileAsync(tarBin, ["-xf", zipPath, "-C", destDir]);
}

/**
 * Remove symlinks from the extracted tree before it is copied into its
 * destination, so a crafted archive cannot plant links pointing outside of it.
 */
export async function stripSymlinks(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) await fs.rm(p, { force: true });
    else if (e.isDirectory()) await stripSymlinks(p);
  }
}
