import { git, secretsInUrl } from "./exec-utils.js";

/**
 * Find the latest version tag (vX.X.X) in a remote git repo.
 * Uses `git ls-remote --tags` so no local clone is needed.
 * Returns the tag name (e.g. "v1.2.3") or null if none found.
 */
export async function findLatestVersionTag(authUrl: string): Promise<string | null> {
  // authUrl carries a PAT in its userinfo; redact it so a failure can't spill
  // the credential into an error message, a log line or an API response.
  const { stdout } = await git(["ls-remote", "--tags", authUrl], {
    timeout: 15000,
    redact: secretsInUrl(authUrl),
  });
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

/**
 * Build an authenticated https clone URL by embedding a PAT as userinfo.
 *
 * The PAT is percent-encoded: a token containing `@`, `:`, `/` or `#` would
 * otherwise silently corrupt the URL (the naive `url.replace("https://", …)`
 * this replaced did exactly that). Mirrors buildAuthedUrl in agent-manager.ts.
 */
export function buildAuthUrl(url: string, pat: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    // Not parseable — hand it back untouched and let git report the problem.
    return url;
  }
  if (parsed.protocol !== "https:") return url;
  parsed.username = encodeURIComponent(pat);
  parsed.password = "";
  return parsed.toString();
}
