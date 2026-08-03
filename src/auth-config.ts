import fs from "fs/promises";
import path from "path";
import { atomicWriteJson } from "./fs-utils.js";
import { adminPaths } from "./paths.js";

export interface AuthConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  updatedAt: string;
  updatedByUserId: string | null;
}

export type AuthConfigSource = "file" | "env" | "none";

export interface AuthConfigSnapshot extends AuthConfig {
  source: AuthConfigSource;
}

const DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/User.Read",
];

interface ErrorWithCode extends Error { code?: string; }

function err(code: string, message: string): ErrorWithCode {
  const e = new Error(message) as ErrorWithCode;
  e.code = code;
  return e;
}

let cachedSnapshot: AuthConfigSnapshot | null = null;
let cachedMtimeMs = 0;
let writeMutex: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeMutex.then(fn, fn);
  writeMutex = next.catch(() => undefined);
  return next;
}

function envSnapshot(): AuthConfigSnapshot {
  const tenantId = (process.env.AZURE_TENANT_ID || "").trim();
  const clientId = (process.env.AZURE_CLIENT_ID || "").trim();
  const clientSecret = process.env.AZURE_CLIENT_SECRET || "";
  const hasAny = tenantId || clientId || clientSecret;
  const explicitlyDisabled = process.env.ENTRA_AUTH_ENABLED === "0";
  const enabled = !explicitlyDisabled && !!(tenantId && clientId && clientSecret);
  return {
    enabled,
    tenantId,
    clientId,
    clientSecret,
    scopes: [...DEFAULT_SCOPES],
    updatedAt: "",
    updatedByUserId: null,
    source: hasAny ? "env" : "none",
  };
}

function normalize(parsed: Partial<AuthConfig>): AuthConfig {
  const scopes = Array.isArray(parsed.scopes) && parsed.scopes.every((s) => typeof s === "string")
    ? parsed.scopes
    : [...DEFAULT_SCOPES];
  return {
    enabled: parsed.enabled === true,
    tenantId: typeof parsed.tenantId === "string" ? parsed.tenantId.trim() : "",
    clientId: typeof parsed.clientId === "string" ? parsed.clientId.trim() : "",
    clientSecret: typeof parsed.clientSecret === "string" ? parsed.clientSecret : "",
    scopes,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    updatedByUserId: typeof parsed.updatedByUserId === "string" ? parsed.updatedByUserId : null,
  };
}

async function loadFromDisk(): Promise<AuthConfigSnapshot> {
  const filePath = adminPaths.authConfig();
  try {
    const stat = await fs.stat(filePath);
    if (cachedSnapshot != null && cachedSnapshot.source === "file" && stat.mtimeMs === cachedMtimeMs) {
      return cachedSnapshot;
    }
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    const cfg = normalize(parsed);
    const snap: AuthConfigSnapshot = { ...cfg, source: "file" };
    cachedSnapshot = snap;
    cachedMtimeMs = stat.mtimeMs;
    return snap;
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      const snap = envSnapshot();
      cachedSnapshot = snap;
      cachedMtimeMs = 0;
      return snap;
    }
    throw e;
  }
}

/**
 * Async read: re-stats the file every call and reloads if mtime moved. Always
 * refreshes the sync snapshot as a side effect, so isAuthEnabled() and any
 * downstream getAuthConfigSnapshot() reads pick up changes on the same request.
 */
export async function getAuthConfig(): Promise<AuthConfigSnapshot> {
  return loadFromDisk();
}

/**
 * Sync read of the last-loaded snapshot. Returns a synthetic env-derived
 * snapshot before the first async load (or if the file is missing). Express
 * middleware should `await getAuthConfig()` once per request before any sync
 * reads to guarantee freshness; initAuthConfig() warms the snapshot at boot.
 */
export function getAuthConfigSnapshot(): AuthConfigSnapshot {
  if (cachedSnapshot != null) return cachedSnapshot;
  const snap = envSnapshot();
  cachedSnapshot = snap;
  return snap;
}

/**
 * Warm the snapshot from disk so the very first call to isAuthEnabled()
 * sees the persisted state. Call from server startup.
 */
export async function initAuthConfig(): Promise<void> {
  try {
    await loadFromDisk();
  } catch (err) {
    console.warn("[auth-config] initial load failed; falling back to env:", err);
    cachedSnapshot = envSnapshot();
    cachedMtimeMs = 0;
  }
}

export function invalidateAuthConfigCache(): void {
  cachedSnapshot = null;
  cachedMtimeMs = 0;
}

export interface SaveAuthConfigInput {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  /** Pass the sentinel "<unchanged>" to preserve the existing secret. */
  clientSecret: string;
  scopes?: string[];
}

export const UNCHANGED_SECRET_SENTINEL = "<unchanged>";

function validate(input: SaveAuthConfigInput): { tenantId: string; clientId: string; scopes: string[] } {
  const tenantId = typeof input.tenantId === "string" ? input.tenantId.trim() : "";
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  if (input.enabled) {
    if (!tenantId) throw err("INVALID_TENANT_ID", "tenantId is required when enabling OAuth");
    if (!clientId) throw err("INVALID_CLIENT_ID", "clientId is required when enabling OAuth");
  }
  const scopes = Array.isArray(input.scopes) && input.scopes.length > 0
    ? input.scopes.filter((s) => typeof s === "string" && s.trim().length > 0)
    : [...DEFAULT_SCOPES];
  return { tenantId, clientId, scopes };
}

export async function saveAuthConfig(input: SaveAuthConfigInput, actorUserId: string | null): Promise<AuthConfigSnapshot> {
  const { tenantId, clientId, scopes } = validate(input);
  return withWriteLock(async () => {
    const current = await loadFromDisk();
    const secret = input.clientSecret === UNCHANGED_SECRET_SENTINEL
      ? current.clientSecret
      : (input.clientSecret ?? "");
    if (input.enabled && !secret) {
      throw err("INVALID_CLIENT_SECRET", "clientSecret is required when enabling OAuth");
    }
    const next: AuthConfig = {
      enabled: input.enabled === true,
      tenantId,
      clientId,
      clientSecret: secret,
      scopes,
      updatedAt: new Date().toISOString(),
      updatedByUserId: actorUserId,
    };
    const filePath = adminPaths.authConfig();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteJson(filePath, next, 2);
    let mtimeMs = Date.now();
    try {
      const stat = await fs.stat(filePath);
      mtimeMs = stat.mtimeMs;
    } catch { /* fall through */ }
    const snap: AuthConfigSnapshot = { ...next, source: "file" };
    cachedSnapshot = snap;
    cachedMtimeMs = mtimeMs;
    return snap;
  });
}

export interface RedactedAuthConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecretSet: boolean;
  scopes: string[];
  updatedAt: string;
  updatedByUserId: string | null;
  source: AuthConfigSource;
}

export function redact(snap: AuthConfigSnapshot): RedactedAuthConfig {
  return {
    enabled: snap.enabled,
    tenantId: snap.tenantId,
    clientId: snap.clientId,
    clientSecretSet: snap.clientSecret.length > 0,
    scopes: snap.scopes,
    updatedAt: snap.updatedAt,
    updatedByUserId: snap.updatedByUserId,
    source: snap.source,
  };
}

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

/**
 * Hit the tenant's OIDC well-known document and (optionally) attempt a
 * client_credentials token exchange. Used both by the "Test connection"
 * button and as a preflight gate when persisting enabled: true.
 */
export async function testAuthConfig(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<{ ok: true; discovery: OidcDiscovery } | { ok: false; stage: "well-known" | "client-credentials"; message: string }> {
  const trimmedTenant = tenantId.trim();
  const trimmedClient = clientId.trim();
  if (!trimmedTenant) return { ok: false, stage: "well-known", message: "tenantId is required" };
  let discovery: OidcDiscovery;
  try {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(trimmedTenant)}/v2.0/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) {
      return { ok: false, stage: "well-known", message: `Discovery returned HTTP ${res.status}` };
    }
    discovery = await res.json() as OidcDiscovery;
    if (!discovery.token_endpoint || !discovery.authorization_endpoint) {
      return { ok: false, stage: "well-known", message: "Discovery document missing token/authorization endpoint" };
    }
  } catch (e: any) {
    return { ok: false, stage: "well-known", message: e?.message || "Discovery fetch failed" };
  }

  if (!trimmedClient || !clientSecret) {
    return { ok: true, discovery };
  }

  try {
    const res = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: trimmedClient,
        client_secret: clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json() as { error?: string; error_description?: string };
        detail = body.error_description || body.error || "";
      } catch {
        detail = await res.text();
      }
      return { ok: false, stage: "client-credentials", message: detail || `HTTP ${res.status}` };
    }
  } catch (e: any) {
    return { ok: false, stage: "client-credentials", message: e?.message || "Token request failed" };
  }
  return { ok: true, discovery };
}
