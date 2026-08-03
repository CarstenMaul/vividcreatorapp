import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Find the latest version tag (vX.X.X) in a remote git repo.
 * Uses `git ls-remote --tags` so no local clone is needed.
 * Returns the tag name (e.g. "v1.2.3") or null if none found.
 */
export async function findLatestVersionTag(authUrl: string): Promise<string | null> {
  const { stdout } = await execAsync(`git ls-remote --tags "${authUrl}"`, { timeout: 15000 });
  if (!stdout.trim()) return null;

  const tags = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const parts = line.split("\t");
      return parts[1]?.replace("refs/tags/", "") || "";
    })
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));

  if (tags.length === 0) return null;

  tags.sort((a, b) => {
    const [aMaj, aMin, aPat] = a.slice(1).split(".").map(Number);
    const [bMaj, bMin, bPat] = b.slice(1).split(".").map(Number);
    return bMaj - aMaj || bMin - aMin || bPat - aPat;
  });

  return tags[0];
}

/**
 * Strip leading "v" from a tag name → version string.
 * e.g. "v1.2.3" → "1.2.3"
 */
export function tagToVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}
