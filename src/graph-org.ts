// Microsoft Graph client. App-only auth (Managed Identity preferred, service
// principal fallback). Used by:
//   - user lookup + people search (transfer-ownership recipient autocomplete)
//   - admin "link vca group to Microsoft Graph group" feature
//     (searchGraphGroups + listGraphGroupMembers)
//
// Required app roles on the Graph service principal:
//   - User.Read.All        (getUserById, searchUsers)
//   - GroupMember.Read.All (searchGraphGroups, listGraphGroupMembers)
//
// Missing any required role surfaces status 403 / code GRAPH_INSUFFICIENT_PERMISSIONS
// and callers degrade gracefully.

import { ManagedIdentityCredential, type TokenCredential } from "@azure/identity";

const GRAPH_TOKEN_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000;
const GRAPH_REQUIRED_APP_ROLES = ["User.Read.All", "GroupMember.Read.All"];
const GRAPH_PAGE_CAP = 20;

const USER_SELECT = "id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,mobilePhone,businessPhones";

export interface NormalizedUser {
  id: string;
  displayName: string;
  givenName: string;
  surname: string;
  mail: string;
  userPrincipalName: string;
  jobTitle: string;
  department: string;
  officeLocation: string;
  mobilePhone: string;
  businessPhones: string[];
}

interface ClientSecretCandidate {
  type: "clientSecret";
  source: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

interface ManagedIdentityCandidate {
  type: "managedIdentity";
  source: string;
  credential: TokenCredential;
}

type Candidate = ClientSecretCandidate | ManagedIdentityCandidate;

function compactEnv(value: string | undefined): string {
  return String(value || "").trim();
}

function buildCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const addClientSecret = (source: string, tenantId?: string, clientId?: string, clientSecret?: string) => {
    const c: ClientSecretCandidate = {
      type: "clientSecret",
      source,
      tenantId: compactEnv(tenantId),
      clientId: compactEnv(clientId),
      clientSecret: compactEnv(clientSecret),
    };
    if (!c.tenantId || !c.clientId || !c.clientSecret) return;
    if (candidates.some(x => x.type === "clientSecret" && x.tenantId === c.tenantId && x.clientId === c.clientId)) return;
    candidates.push(c);
  };

  // Service principal credentials first — production grants the AZ_ACCOUNT_*
  // SP broader Graph roles (GroupMember.Read.All on top of User.Read.All) than
  // the managed identity. The broader role is needed for the admin Groups &
  // Access link picker / sync. Managed identity stays as a dev-environment
  // fallback when no SP creds are in env.
  addClientSecret("GRAPH_*", process.env.GRAPH_TENANT_ID, process.env.GRAPH_CLIENT_ID, process.env.GRAPH_CLIENT_SECRET);
  addClientSecret("AZ_ACCOUNT_*", process.env.AZ_ACCOUNT_TENANT_UUID, process.env.AZ_ACCOUNT_SP_UUID, process.env.AZ_ACCOUNT_PASSWORD);
  addClientSecret("AZURE_*", process.env.AZURE_TENANT_ID, process.env.AZURE_CLIENT_ID, process.env.AZURE_CLIENT_SECRET);
  addClientSecret("CLIENT_*", process.env.TENANT_ID, process.env.CLIENT_ID, process.env.CLIENT_SECRET);
  candidates.push({ type: "managedIdentity", source: "MANAGED_IDENTITY", credential: new ManagedIdentityCredential() });

  return candidates;
}

const CANDIDATES: Candidate[] = buildCandidates();
// Initialized to null so the first successful selection in getAccessToken
// trips the `selectedCandidate !== candidate` branch and logs which
// candidate (and which app-role claims) we actually picked. Without this
// the [graph-auth] diagnostic stays silent forever on a clean start.
let selectedCandidate: Candidate | null = null;
let tokenCache: { token: string; expiresAt: number; cacheKey: string } = { token: "", expiresAt: 0, cacheKey: "" };

interface GraphError extends Error {
  status?: number;
  code?: string;
  source?: string;
}

function ensureConfigured(): void {
  if (!CANDIDATES.length) {
    const err: GraphError = new Error("Microsoft Graph credentials are not configured.");
    err.status = 503;
    err.code = "GRAPH_NOT_CONFIGURED";
    throw err;
  }
}

function decodeJwtPayload(token: string): { roles?: unknown } {
  try {
    const encoded = String(token || "").split(".")[1] || "";
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function hasRequiredRole(token: string): boolean {
  const payload = decodeJwtPayload(token);
  const roles = Array.isArray(payload.roles) ? payload.roles as string[] : [];
  return GRAPH_REQUIRED_APP_ROLES.some(r => roles.includes(r));
}

async function readJsonText(text: string): Promise<any> {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function requestToken(candidate: Candidate): Promise<{ access_token: string; expires_in: number }> {
  if (candidate.type === "managedIdentity") {
    try {
      const tok = await candidate.credential.getToken(GRAPH_TOKEN_SCOPE);
      if (!tok?.token) {
        const err: GraphError = new Error("Managed identity did not return a Microsoft Graph access token.");
        err.status = 502;
        err.code = "GRAPH_TOKEN_ERROR";
        err.source = candidate.source;
        throw err;
      }
      return {
        access_token: tok.token,
        expires_in: Math.max(60, Math.floor(((tok.expiresOnTimestamp || Date.now() + 3600_000) - Date.now()) / 1000)),
      };
    } catch (err: any) {
      err.status = err.status || 502;
      err.code = err.code || "GRAPH_TOKEN_ERROR";
      err.source = candidate.source;
      throw err;
    }
  }

  const body = new URLSearchParams({
    client_id: candidate.clientId,
    client_secret: candidate.clientSecret,
    scope: GRAPH_TOKEN_SCOPE,
    grant_type: "client_credentials",
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(candidate.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await readJsonText(await response.text());
  if (!response.ok || !payload.access_token) {
    const err: GraphError = new Error(payload.error_description || payload.error || "Could not acquire Graph access token.");
    err.status = response.status || 502;
    err.code = payload.error || "GRAPH_TOKEN_ERROR";
    err.source = candidate.source;
    throw err;
  }
  return payload;
}

async function getAccessToken(): Promise<string> {
  ensureConfigured();
  const now = Date.now();
  const preferred = selectedCandidate
    ? [selectedCandidate, ...CANDIDATES.filter(c => c !== selectedCandidate)]
    : CANDIDATES;

  let lastError: GraphError | null = null;
  for (const candidate of preferred) {
    const cacheKey = candidate.type === "managedIdentity"
      ? candidate.source
      : `${candidate.tenantId}:${candidate.clientId}`;

    if (tokenCache.token && tokenCache.cacheKey === cacheKey && tokenCache.expiresAt > now + 60_000) {
      return tokenCache.token;
    }

    try {
      const payload = await requestToken(candidate);
      if (!hasRequiredRole(payload.access_token)) {
        const err: GraphError = new Error(`${candidate.source} does not grant ${GRAPH_REQUIRED_APP_ROLES.join(" or ")} for Microsoft Graph.`);
        err.status = 403;
        err.code = "GRAPH_INSUFFICIENT_PERMISSIONS";
        err.source = candidate.source;
        lastError = err;
        continue;
      }
      if (selectedCandidate !== candidate) {
        const tokenRoles = (() => {
          const decoded = decodeJwtPayload(payload.access_token);
          return Array.isArray(decoded.roles) ? (decoded.roles as string[]).join(",") : "<none>";
        })();
        console.log(`[graph-auth] selected credential source=${candidate.source} roles=${tokenRoles}`);
      }
      selectedCandidate = candidate;
      tokenCache = {
        token: payload.access_token,
        expiresAt: now + Math.max(60, Number(payload.expires_in || 3600) - 120) * 1000,
        cacheKey,
      };
      return tokenCache.token;
    } catch (err) {
      lastError = err as GraphError;
    }
  }

  const err: GraphError = new Error(lastError?.message || `No configured Microsoft Graph credential grants ${GRAPH_REQUIRED_APP_ROLES.join(" or ")}.`);
  err.status = lastError?.status || 403;
  err.code = lastError?.code || "GRAPH_INSUFFICIENT_PERMISSIONS";
  throw err;
}

async function graphFetch(url: string, extraHeaders?: Record<string, string>): Promise<any> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(extraHeaders || {}),
  };
  const response = await fetch(url, { headers });
  const payload = await readJsonText(await response.text());
  if (!response.ok) {
    const graphErr = payload.error || {};
    const err: GraphError = new Error(graphErr.message || payload.message || `Microsoft Graph request failed with status ${response.status}.`);
    err.status = response.status;
    err.code = graphErr.code || "GRAPH_REQUEST_ERROR";
    throw err;
  }
  return payload;
}

async function graphRequest(pathname: string, extraHeaders?: Record<string, string>): Promise<any> {
  return graphFetch(`${GRAPH_BASE_URL}${pathname}`, extraHeaders);
}

// Walk all pages of a Graph collection endpoint, following @odata.nextLink.
// Caps at GRAPH_PAGE_CAP pages — large tenants can have thousands of group
// memberships and we'd rather stop than DOS Graph from a runaway loop.
async function graphRequestAll(pathname: string, extraHeaders?: Record<string, string>): Promise<any[]> {
  const items: any[] = [];
  let url: string | null = `${GRAPH_BASE_URL}${pathname}`;
  let pages = 0;
  while (url) {
    const payload = await graphFetch(url, extraHeaders);
    if (Array.isArray(payload.value)) items.push(...payload.value);
    url = payload["@odata.nextLink"] || null;
    pages++;
    if (pages > GRAPH_PAGE_CAP) {
      console.warn(`[graph] graphRequestAll: aborted after ${GRAPH_PAGE_CAP} pages for ${pathname}`);
      break;
    }
  }
  return items;
}

function normalizeUser(user: any): NormalizedUser {
  return {
    id: user.id || "",
    displayName: user.displayName || "Unknown person",
    givenName: user.givenName || "",
    surname: user.surname || "",
    mail: user.mail || user.userPrincipalName || "",
    userPrincipalName: user.userPrincipalName || "",
    jobTitle: user.jobTitle || "",
    department: user.department || "",
    officeLocation: user.officeLocation || "",
    mobilePhone: user.mobilePhone || "",
    businessPhones: Array.isArray(user.businessPhones) ? user.businessPhones : [],
  };
}

// ─── Per-user caches ──────────────────────────────────────────────

const userByIdCache = new Map<string, { value: NormalizedUser | null; expiresAt: number }>();

function cacheGet<T>(map: Map<string, { value: T; expiresAt: number }>, key: string, now: number): T | undefined {
  const hit = map.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  if (hit) map.delete(key);
  return undefined;
}

function cacheSet<T>(map: Map<string, { value: T; expiresAt: number }>, key: string, value: T, now: number): void {
  map.set(key, { value, expiresAt: now + GRAPH_CACHE_TTL_MS });
}

// ─── Public helpers ───────────────────────────────────────────────

export async function getUserById(userId: string): Promise<NormalizedUser | null> {
  if (!userId) return null;
  const now = Date.now();
  const cached = cacheGet(userByIdCache, userId, now);
  if (cached !== undefined) return cached;
  try {
    const user = normalizeUser(await graphRequest(`/users/${encodeURIComponent(userId)}?$select=${USER_SELECT}`));
    cacheSet(userByIdCache, userId, user, now);
    return user;
  } catch (err: any) {
    if (err.status === 404) {
      cacheSet(userByIdCache, userId, null, now);
      return null;
    }
    throw err;
  }
}

export function isGraphConfigured(): boolean {
  return CANDIDATES.length > 0;
}

// ─── User search helpers ──────────────────────────────────────────

function escapeODataString(s: string): string {
  return s.replace(/'/g, "''");
}

// People search by displayName / mail / userPrincipalName prefix. Uses an
// `or` filter which Graph requires `ConsistencyLevel: eventual` for.
export async function searchUsers(query: string, limit: number = 10): Promise<NormalizedUser[]> {
  const q = (query || "").trim();
  if (!q) return [];
  const safe = escapeODataString(q);
  const cappedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 10, 25));
  const filter = `startswith(displayName,'${safe}') or startswith(mail,'${safe}') or startswith(userPrincipalName,'${safe}')`;
  const pathname = `/users?$filter=${encodeURIComponent(filter)}&$top=${cappedLimit}&$select=${USER_SELECT}&$count=true`;
  const payload = await graphRequest(pathname, { ConsistencyLevel: "eventual" });
  const value = Array.isArray(payload.value) ? payload.value : [];
  return value.map(normalizeUser);
}

// ─── Linked Graph group admin features ────────────────────────────
// Used by `src/vca-groups.ts` for the admin "link vca group to a
// Microsoft Graph group" flow. Requires GroupMember.Read.All; on
// insufficient permissions, callers get a 403 with code
// GRAPH_INSUFFICIENT_PERMISSIONS and the admin UI shows a
// permission-required banner instead of crashing.

export interface GraphGroupSummary {
  id: string;
  displayName: string;
  description?: string;
}

export async function searchGraphGroups(query: string, limit: number = 10): Promise<GraphGroupSummary[]> {
  const q = (query || "").trim();
  if (!q) return [];
  const safe = escapeODataString(q);
  const cappedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 10, 25));
  const filter = `startswith(displayName,'${safe}')`;
  const pathname = `/groups?$filter=${encodeURIComponent(filter)}&$top=${cappedLimit}&$select=id,displayName,description&$count=true`;
  const payload = await graphRequest(pathname, { ConsistencyLevel: "eventual" });
  const value = Array.isArray(payload.value) ? payload.value : [];
  return value
    .map((g: any) => ({
      id: typeof g?.id === "string" ? g.id : "",
      displayName: typeof g?.displayName === "string" ? g.displayName : "",
      description: typeof g?.description === "string" ? g.description : undefined,
    }))
    .filter((g: GraphGroupSummary) => g.id && g.displayName);
}

export async function listGraphGroupMembers(graphGroupId: string): Promise<NormalizedUser[]> {
  if (!graphGroupId) return [];
  const items = await graphRequestAll(
    `/groups/${encodeURIComponent(graphGroupId)}/transitiveMembers/microsoft.graph.user?$select=${USER_SELECT}&$top=999`,
  );
  return items.map(normalizeUser);
}
