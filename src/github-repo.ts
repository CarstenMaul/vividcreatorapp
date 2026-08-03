// GitHub Repos client for the auto-create-remote feature. Sibling of
// devops-repo.ts — same stable `code` contract so the UI localizes errors
// uniformly across providers. Supports github.com and GitHub Enterprise
// (API base https://<host>/api/v3).

export type GitHubErrorCode =
  | "INVALID_PAT"
  | "REPO_EXISTS"
  | "GITHUB_ERROR";

export interface GitHubError extends Error {
  code: GitHubErrorCode;
  status?: number;
}

function makeGitHubError(message: string, code: GitHubErrorCode, status?: number): GitHubError {
  const err = new Error(message) as GitHubError;
  err.code = code;
  if (status !== undefined) err.status = status;
  return err;
}

/** Resolve the REST API base for github.com or a GitHub Enterprise host. */
function apiBaseFor(host: string): string {
  const h = String(host || "").toLowerCase().trim().replace(/^www\./, "");
  if (!h || h === "github.com" || h === "api.github.com") return "https://api.github.com";
  return `https://${host.trim()}/api/v3`;
}

export async function createGitHubRepo(opts: {
  host: string;         // "github.com" or a GHE host
  org: string;          // "" = personal (/user/repos), else /orgs/{org}/repos
  pat: string;
  repoName: string;
  privateRepo?: boolean; // default true
}): Promise<{ remoteUrl: string }> {
  const apiBase = apiBaseFor(opts.host);
  const url = opts.org
    ? `${apiBase}/orgs/${encodeURIComponent(opts.org)}/repos`
    : `${apiBase}/user/repos`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "vca", // GitHub rejects requests without a User-Agent
    },
    body: JSON.stringify({
      name: opts.repoName,
      private: opts.privateRepo !== false,
      auto_init: false,
    }),
  });

  if (res.status === 401 || res.status === 403) {
    throw makeGitHubError("Invalid or expired GitHub PAT", "INVALID_PAT", res.status);
  }
  if (res.status === 422) {
    const body = (await res.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
    const already = Array.isArray(body?.errors) && body!.errors!.some((e) => /already exists/i.test(e?.message || ""));
    if (already) {
      throw makeGitHubError(`A repo named "${opts.repoName}" already exists`, "REPO_EXISTS", 422);
    }
    throw makeGitHubError(
      `Create failed (422): ${JSON.stringify(body?.errors || body).slice(0, 200)}`,
      "GITHUB_ERROR",
      422,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw makeGitHubError(`Create failed (${res.status}): ${text.slice(0, 200)}`, "GITHUB_ERROR", res.status);
  }

  const created = (await res.json()) as { clone_url?: string; html_url?: string };
  const remoteUrl = created.clone_url || created.html_url;
  if (!remoteUrl) {
    throw makeGitHubError("Create response did not include a clone URL", "GITHUB_ERROR");
  }
  return { remoteUrl };
}
