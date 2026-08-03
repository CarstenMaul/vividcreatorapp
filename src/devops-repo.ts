// Azure DevOps Repos client for the auto-create-remote feature.
// Parses both modern (dev.azure.com/{org}/{project}) and legacy
// ({org}.visualstudio.com/{collection}/{project}) URLs and calls the DevOps
// REST API to create a repository. All errors carry a stable `code` so the
// UI can localize them.

export type DevOpsErrorCode =
  | "UNPARSEABLE_URL"
  | "INVALID_PAT"
  | "PROJECT_NOT_FOUND"
  | "REPO_EXISTS"
  | "DEVOPS_ERROR";

export interface DevOpsError extends Error {
  code: DevOpsErrorCode;
  status?: number;
}

function makeDevOpsError(message: string, code: DevOpsErrorCode, status?: number): DevOpsError {
  const err = new Error(message) as DevOpsError;
  err.code = code;
  if (status !== undefined) err.status = status;
  return err;
}

export interface ParsedDevOpsUrl {
  host: string;    // e.g. "dev.azure.com" or "company.visualstudio.com"
  org: string;     // e.g. "myorg" or "DefaultCollection" (legacy collection)
  project: string; // decoded project name, e.g. "Department"
}

// Accepts:
//   https://dev.azure.com/{org}/{project}
//   https://dev.azure.com/{org}/{project}/_git/{repo}    (trailing /_git is stripped)
//   https://{org}.visualstudio.com/{collection}/{project}
//   https://{org}.visualstudio.com/{collection}/{project}/_git/{repo}
// Trailing slashes are tolerated. The project segment is URL-decoded.
export function parseDevOpsProjectUrl(rawUrl: string): ParsedDevOpsUrl {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) throw makeDevOpsError("DevOps project URL is empty", "UNPARSEABLE_URL");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw makeDevOpsError("DevOps project URL is not a valid URL", "UNPARSEABLE_URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw makeDevOpsError("DevOps project URL must be http(s)", "UNPARSEABLE_URL");
  }

  // Drop trailing /_git/<repo> if pasted by mistake.
  let pathname = parsed.pathname;
  const gitIdx = pathname.indexOf("/_git/");
  if (gitIdx >= 0) pathname = pathname.slice(0, gitIdx);

  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const host = parsed.host.toLowerCase();

  if (host === "dev.azure.com" || host === "ssh.dev.azure.com") {
    if (segments.length < 2) {
      throw makeDevOpsError("Expected /{org}/{project} after dev.azure.com", "UNPARSEABLE_URL");
    }
    const [org, project] = segments;
    return { host: "dev.azure.com", org, project };
  }

  if (host.endsWith(".visualstudio.com")) {
    // Normalize legacy {org}.visualstudio.com URLs to dev.azure.com — the
    // modern REST API only consistently honors the dev.azure.com endpoint.
    // The subdomain is the org name; "DefaultCollection" (the only collection
    // on hosted Azure DevOps) is implicit and we drop it if present.
    const org = host.replace(/\.visualstudio\.com$/, "");
    let project: string | undefined;
    if (segments.length === 0) {
      throw makeDevOpsError("Expected /{project} after the host", "UNPARSEABLE_URL");
    } else if (segments.length === 1) {
      project = segments[0];
    } else if (/^DefaultCollection$/i.test(segments[0])) {
      project = segments[1];
    } else {
      // Custom collection or unexpected layout — assume the last segment is
      // the project name.
      project = segments[segments.length - 1];
    }
    return { host: "dev.azure.com", org, project };
  }

  throw makeDevOpsError("Host is not a recognized Azure DevOps host", "UNPARSEABLE_URL");
}

function basicAuth(pat: string): string {
  return "Basic " + Buffer.from(`:${pat}`).toString("base64");
}

function buildBaseUrl(host: string, org: string): string {
  // dev.azure.com expects /{org}/... ; *.visualstudio.com expects /{collection}/...
  // In both cases the second path segment after host is what we put first.
  return `https://${host}/${encodeURIComponent(org)}`;
}

export async function createDevOpsRepo(
  host: string,
  org: string,
  project: string,
  pat: string,
  repoName: string,
): Promise<{ remoteUrl: string }> {
  const headers = { Authorization: basicAuth(pat), "Content-Type": "application/json" };
  const base = buildBaseUrl(host, org);

  // 1) Resolve project id (lets us fail fast with a clear error on bad PAT
  //    or wrong project name before attempting to create).
  const projectRes = await fetch(`${base}/_apis/projects/${encodeURIComponent(project)}?api-version=7.1`, { headers });
  if (projectRes.status === 401 || projectRes.status === 403) {
    throw makeDevOpsError("Invalid or expired DevOps PAT", "INVALID_PAT", projectRes.status);
  }
  if (projectRes.status === 404) {
    throw makeDevOpsError(
      `DevOps project not found at https://${host}/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}`,
      "PROJECT_NOT_FOUND",
      404,
    );
  }
  if (!projectRes.ok) {
    const text = await projectRes.text().catch(() => "");
    throw makeDevOpsError(`Lookup failed (${projectRes.status}): ${text.slice(0, 200)}`, "DEVOPS_ERROR", projectRes.status);
  }
  const projectInfo = await projectRes.json() as { id?: string };
  if (!projectInfo.id) {
    throw makeDevOpsError("DevOps project response did not include an id", "DEVOPS_ERROR");
  }

  // 2) Create repo.
  const createRes = await fetch(`${base}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=7.1`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: repoName, project: { id: projectInfo.id } }),
  });
  if (createRes.status === 401 || createRes.status === 403) {
    throw makeDevOpsError("Invalid or expired DevOps PAT", "INVALID_PAT", createRes.status);
  }
  if (createRes.status === 409) {
    throw makeDevOpsError(`A repo named "${repoName}" already exists in DevOps`, "REPO_EXISTS", 409);
  }
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => "");
    throw makeDevOpsError(`Create failed (${createRes.status}): ${text.slice(0, 200)}`, "DEVOPS_ERROR", createRes.status);
  }
  const created = await createRes.json() as { remoteUrl?: string; webUrl?: string };
  const rawUrl = created.remoteUrl || created.webUrl;
  if (!rawUrl) {
    throw makeDevOpsError("Create response did not include a clone URL", "DEVOPS_ERROR");
  }
  // Azure DevOps embeds the calling user's identity in remoteUrl
  // (e.g. "https://company@dev.azure.com/..."). Strip it so the URL is
  // clean for display and so setGitRemote can embed our PAT correctly.
  const remoteUrl = rawUrl.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  return { remoteUrl };
}
