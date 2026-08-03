import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "crypto";
import { saveUserProfile } from "../agent-manager.js";
import { getSessionStore, type SessionData } from "../session-store.js";
import { isAdminUser, maybeBootstrapAdmin, refreshUserMembershipsAtLogin } from "../vca-groups.js";
import { findLegacyUserId, migrateLegacyUser } from "../identity-migration.js";
import { getAuthConfig, getAuthConfigSnapshot } from "../auth-config.js";
import { verifyLocalLogin, hasAnyUsers, createLocalUser } from "../user-store.js";
import { hasAdminGroup, createVcaGroup, addManualMember } from "../vca-groups.js";

export const authRouter = Router();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      vcaSession?: SessionData;
      vcaSessionId?: string;
    }
  }
}

const pendingStates = new Map<string, number>(); // state -> expiresAt
const pendingRefreshes = new Map<string, Promise<SessionData | null>>();

const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 h
const SESSION_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 d
const AUTH_COOKIE_MAX_AGE_SEC = Math.floor(SESSION_CLEANUP_AGE_MS / 1000);
const DEFAULT_OAUTH_SCOPE = "openid profile email offline_access https://graph.microsoft.com/User.Read";

function oauthScopeFromSnapshot(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return DEFAULT_OAUTH_SCOPE;
  return scopes.join(" ");
}

const store = getSessionStore();

// Periodic cleanup: drop sessions whose expiresAt is older than 7 days. The
// refresh tokens behind them are unusable by then anyway. unref() so this
// timer doesn't keep the process alive on shutdown.
setInterval(() => {
  store.cleanupExpired(SESSION_CLEANUP_AGE_MS).then((n) => {
    if (n > 0) console.log(`[auth] cleanupExpired: removed ${n} stale session(s)`);
  }).catch((err) => {
    console.warn("[auth] cleanupExpired failed:", err);
  });
}, SESSION_CLEANUP_INTERVAL_MS).unref();

export function isAuthEnabled(): boolean {
  const snap = getAuthConfigSnapshot();
  if (!snap.enabled) return false;
  return !!(snap.tenantId && snap.clientId && snap.clientSecret);
}

/**
 * Read the email of the authenticated user attached to this request by
 * apiAuthMiddleware. Returns "" when auth is disabled or the request did
 * not pass through the middleware.
 */
export function getSessionEmail(req: Request): string {
  return req.vcaSession?.email || "";
}

/**
 * Resolve the userId of the currently authenticated user, or undefined if
 * the request has no valid session.
 */
export function getSessionUserId(req: Request): string | undefined {
  return req.vcaSession?.userId;
}

export function getSessionIsAdmin(req: Request): boolean {
  // Admin status is always read from the authenticated session — no
  // "auth disabled" bypass. Local users gain admin via vca-groups membership
  // (the apiAuthMiddleware populates `vcaSession.isAdmin` from there at
  // login + during refresh). Without a session, no admin.
  return req.vcaSession?.isAdmin === true;
}

// On every login and session refresh: run the one-shot bootstrap admin
// promotion, reconcile this user's membership in every linked vca group
// from a single /me/transitiveMemberOf call, then read the final isAdmin
// flag from the file-backed groups store. The Graph round-trip is bounded
// by the existing REFRESH_WINDOW_MS cadence (~5 min).
async function computeSessionFlags(
  userId: string,
  displayName: string,
  email: string,
  accessToken: string,
): Promise<{ isAdmin: boolean }> {
  try {
    await maybeBootstrapAdmin(userId, displayName, email);
  } catch (err) {
    console.warn("[auth] maybeBootstrapAdmin failed:", err);
  }
  try {
    await refreshUserMembershipsAtLogin(userId, accessToken, displayName, email);
  } catch (err) {
    console.warn("[auth] refreshUserMembershipsAtLogin failed:", err);
  }
  return { isAdmin: await isAdminUser(userId) };
}

// Legacy "vca_uid" cookie minted by older builds (when no-OAuth dev mode
// auto-created sessions). We don't mint new ones any more, but old browsers
// may still carry one — the OAuth callback reads it to migrate a user's
// pre-Entra workspace folder to their real Entra OID.
const LOCAL_UID_COOKIE = "vca_uid";

function appendCookie(res: Response, cookie: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookie]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), cookie]);
  }
}

function clearLocalUidCookie(res: Response): void {
  appendCookie(res, `${LOCAL_UID_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
}

// API paths that may be hit before/without a session (handshake endpoints).
// Everything else requires a valid session and a matching userId.
const API_AUTH_EXEMPT = new Set<string>([
  "/config",
]);

/**
 * Express middleware enforcing per-user authorization for /api routes.
 *  - Requires a valid Entra session cookie (when auth is enabled).
 *  - Rejects requests whose body / query / route `userId` does not match
 *    the authenticated user, preventing one user from acting on another's
 *    projects by spoofing the userId field.
 */
export async function apiAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (API_AUTH_EXEMPT.has(req.path)) return next();

  // Refresh the in-memory snapshot from disk so isAuthEnabled() reflects any
  // recent admin save without waiting for a process restart. mtime-cached.
  try { await getAuthConfig(); } catch { /* fall back to last snapshot */ }

  // Every /api/* request needs a real session — VCA does not auto-create
  // "anonymous" sessions any more. Login happens at /auth/login-local (local)
  // or /auth/login (Entra); the very first install gets bootstrapped via
  // /auth/setup-first-user.
  const sessionId = getCookie(req, "session_id");
  if (!sessionId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let session = await store.get(sessionId);
  if (!session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const now = Date.now();

  const freshSession = await refreshSessionIfNeeded(sessionId, session, res, now);
  if (!freshSession) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  session = freshSession;

  if (req.path.startsWith("/admin/") && session.isAdmin !== true) {
    res.status(403).json({ error: "Admin privileges required" });
    return;
  }

  if (!enforceUserIdMatch(req, res, session.userId)) return;

  req.vcaSession = session;
  req.vcaSessionId = sessionId;
  next();
}

function enforceUserIdMatch(req: Request, res: Response, sessionUserId: string): boolean {
  const candidates: unknown[] = [
    req.body && (req.body as { userId?: unknown }).userId,
    req.query?.userId,
    req.params?.userId,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof value !== "string" || value !== sessionUserId) {
      res.status(403).json({ error: "userId does not match authenticated session" });
      return false;
    }
  }
  return true;
}

/**
 * Lightweight session lookup for the preview proxy. Reads the session_id
 * cookie and returns the stored session, or null if there is none. Unlike
 * apiAuthMiddleware this deliberately does NOT perform an Entra token refresh:
 * a single preview page pulls many same-origin sub-resources, and refreshing
 * per asset would be needlessly heavy. Hard expiry / token refresh stay
 * enforced on the /api and /auth paths the app uses alongside the preview.
 */
export async function getPreviewSession(req: Request): Promise<SessionData | null> {
  const sessionId = getCookie(req, "session_id");
  if (!sessionId) return null;
  return (await store.get(sessionId)) ?? null;
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k === name) {
      try { return decodeURIComponent(v); } catch { return v; }
    }
  }
  return undefined;
}

function getBaseUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
  return `${proto}://${host}`;
}

async function refreshSession(sessionId: string): Promise<SessionData | null> {
  const session = await store.get(sessionId);
  if (!session) return null;

  // Local sessions never refresh via Entra. Their expiry is slid in
  // refreshSessionIfNeeded instead.
  if (session.authType === "local") return session;

  if (!session.refreshToken) return null;

  try {
    const cfg = await getAuthConfig();
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret, // gitleaks:allow
          refresh_token: session.refreshToken,
          grant_type: "refresh_token",
          scope: oauthScopeFromSnapshot(cfg.scopes),
        }).toString(),
      }
    );

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("[auth] Token refresh failed:", errText);
      if (isTerminalRefreshFailure(errText)) {
        await store.delete(sessionId);
      }
      return null;
    }

    const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in: number };
    const expiresIn = tokens.expires_in || 3600;

    const flags = await computeSessionFlags(session.userId, session.displayName, session.email, tokens.access_token);
    const updated: SessionData = {
      userId: session.userId,
      displayName: session.displayName,
      email: session.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || session.refreshToken,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
      isAdmin: flags.isAdmin,
      authType: "entra",
    };
    await store.set(sessionId, updated);

    saveUserProfile(updated.userId, updated.displayName, updated.email).catch(err =>
      console.warn("[auth] saveUserProfile failed:", err)
    );

    return updated;
  } catch (err) {
    console.error("[auth] Token refresh error:", err);
    return null;
  }
}

function refreshSessionDeduped(sessionId: string): Promise<SessionData | null> {
  const existing = pendingRefreshes.get(sessionId);
  if (existing) return existing;

  const promise = refreshSession(sessionId).finally(() => {
    pendingRefreshes.delete(sessionId);
  });
  pendingRefreshes.set(sessionId, promise);
  return promise;
}

async function refreshSessionIfNeeded(
  sessionId: string,
  session: SessionData,
  res: Response,
  now = Date.now(),
): Promise<SessionData | null> {
  // Local sessions: no Entra refresh — slide expiry, recompute isAdmin lazily
  // when we'd otherwise expire, and re-emit the cookie. Fully expired local
  // sessions return null so the caller deletes them.
  if (session.authType === "local") {
    const expired = now > session.expiresAt;
    if (expired) return null;
    if (session.expiresAt - now < REFRESH_WINDOW_MS) {
      // Slide forward to the full cookie lifetime so an active user never
      // hits expiry mid-flow.
      const updated: SessionData = {
        ...session,
        expiresAt: Date.now() + AUTH_COOKIE_MAX_AGE_SEC * 1000,
        isAdmin: await isAdminUser(session.userId),
      };
      await store.set(sessionId, updated);
      setSessionCookie(res, sessionId);
      return updated;
    }
    setSessionCookie(res, sessionId);
    return session;
  }

  const expired = now > session.expiresAt;
  const refreshable = expired || session.expiresAt - now < REFRESH_WINDOW_MS;
  if (!refreshable) {
    setSessionCookie(res, sessionId);
    return session;
  }

  const refreshed = await refreshSessionDeduped(sessionId);
  if (refreshed) {
    setSessionCookie(res, sessionId);
    return refreshed;
  }

  if (!expired) {
    setSessionCookie(res, sessionId);
    return session;
  }

  return null;
}

function isTerminalRefreshFailure(errText: string): boolean {
  try {
    const parsed = JSON.parse(errText) as { error?: string; error_codes?: number[] };
    if (parsed.error === "invalid_grant") return true;
    if (Array.isArray(parsed.error_codes) && parsed.error_codes.includes(700082)) return true;
  } catch {
    // Fall back to the raw payload below.
  }
  return /\binvalid_grant\b/i.test(errText) || /\bAADSTS700082\b/i.test(errText);
}

function setSessionCookie(res: Response, sessionId: string): void {
  appendCookie(
    res,
    `session_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE_SEC}; Path=/`,
  );
}

function clearSessionCookie(res: Response): void {
  appendCookie(res, "session_id=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/");
}

const SILENT_STATE_PREFIX = "silent:";
const POPUP_STATE_PREFIX = "popup:";

type FlowMode = "redirect" | "silent" | "popup";

function flowOf(state: string | undefined): FlowMode {
  if (typeof state !== "string") return "redirect";
  if (state.startsWith(SILENT_STATE_PREFIX)) return "silent";
  if (state.startsWith(POPUP_STATE_PREFIX)) return "popup";
  return "redirect";
}

async function startAuthorize(req: Request, res: Response, mode: FlowMode): Promise<void> {
  const cfg = await getAuthConfig();
  if (!isAuthEnabled()) {
    res.status(404).json({ error: "Auth not configured" });
    return;
  }

  const raw = randomBytes(16).toString("hex");
  const state =
    mode === "silent" ? `${SILENT_STATE_PREFIX}${raw}` :
    mode === "popup" ? `${POPUP_STATE_PREFIX}${raw}` :
    raw;
  pendingStates.set(state, Date.now() + 10 * 60 * 1000);

  // Clean up old states
  const now = Date.now();
  for (const [s, exp] of pendingStates) {
    if (now > exp) pendingStates.delete(s);
  }

  const redirectUri = `${getBaseUrl(req)}/auth/callback`;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: oauthScopeFromSnapshot(cfg.scopes),
    state,
    response_mode: "query",
  });
  if (mode === "silent") params.set("prompt", "none");

  res.redirect(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize?${params}`);
}

authRouter.get("/login", async (req: Request, res: Response) => {
  await startAuthorize(req, res, "redirect");
});

// Silent renewal entry point. The frontend opens this in a hidden iframe.
// Entra is asked with prompt=none, which means: succeed silently if the user
// still has an SSO session; otherwise return an error (login_required /
// interaction_required / consent_required) without showing UI. Either result
// is reported back to the parent window via /auth/silent-result.
authRouter.get("/silent-login", async (req: Request, res: Response) => {
  await startAuthorize(req, res, "silent");
});

// Interactive sign-in opened in a popup window from the soft "Session expired"
// modal. The OAuth flow runs normally (user may type a password / use MFA);
// when it lands back on /auth/callback, the popup: state prefix routes it
// through /silent-result so the opener (the SPA) is notified and can dismiss
// the modal without a top-level reload.
authRouter.get("/popup-login", async (req: Request, res: Response) => {
  await startAuthorize(req, res, "popup");
});

function silentResultRedirect(res: Response, ok: boolean, reason?: string): void {
  const params = new URLSearchParams({ ok: ok ? "1" : "0" });
  if (reason) params.set("reason", reason);
  res.redirect(`/auth/silent-result?${params}`);
}

// Loaded inside the silent-renewal iframe OR inside a popup window after the
// "Reconnect" modal flow. Posts the outcome to the opener / parent frame
// (same origin) and closes itself if it's a popup. Either way, the SPA
// running in the original tab decides whether to retry pending work or stay
// in the soft-expired state.
authRouter.get("/silent-result", (req: Request, res: Response) => {
  const ok = req.query.ok === "1";
  const reason = typeof req.query.reason === "string" ? req.query.reason : "";
  // Tiny self-contained HTML — no external resources, no inline JSON for the
  // template parser to choke on. Content is escaped via JSON.stringify so a
  // hostile reason= value can't break out of the string literal.
  const okJson = JSON.stringify(ok);
  const reasonJson = JSON.stringify(reason);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html><meta charset="utf-8"><title>vca auth</title><script>
(function(){
  var msg = { type: "vca-silent-auth", ok: ${okJson}, reason: ${reasonJson} };
  try { if (window.opener) window.opener.postMessage(msg, location.origin); } catch (e) {}
  try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, location.origin); } catch (e) {}
  if (window.opener) { setTimeout(function(){ try { window.close(); } catch (e) {} }, 50); }
})();
</script>`);
});

authRouter.get("/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  const mode = flowOf(state);
  const reportsToOpener = mode === "silent" || mode === "popup";

  if (error) {
    console.error(`[auth] OAuth error: ${error} - ${error_description}`);
    if (state) pendingStates.delete(state);
    if (reportsToOpener) {
      silentResultRedirect(res, false, error);
      return;
    }
    res.status(400).send(`Authentication error: ${error_description || error}`);
    return;
  }

  if (!code || !state) {
    if (reportsToOpener) {
      silentResultRedirect(res, false, "missing-code");
      return;
    }
    res.status(400).send("Missing code or state");
    return;
  }

  const stateExpiry = pendingStates.get(state);
  if (!stateExpiry || Date.now() > stateExpiry) {
    if (reportsToOpener) {
      silentResultRedirect(res, false, "invalid-state");
      return;
    }
    res.status(400).send("Invalid or expired state");
    return;
  }
  pendingStates.delete(state);

  const redirectUri = `${getBaseUrl(req)}/auth/callback`;

  try {
    const cfg = await getAuthConfig();
    // Exchange authorization code for tokens
    const tokenRes = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret, // gitleaks:allow
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: oauthScopeFromSnapshot(cfg.scopes),
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("[auth] Token exchange failed:", errText);
      if (reportsToOpener) {
        silentResultRedirect(res, false, "token-exchange-failed");
        return;
      }
      res.status(500).send("Token exchange failed — check server logs");
      return;
    }

    const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in: number };

    // Fetch user profile from Microsoft Graph
    const graphRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!graphRes.ok) {
      const errText = await graphRes.text();
      console.error("[auth] Graph /me failed:", errText);
      if (reportsToOpener) {
        silentResultRedirect(res, false, "graph-me-failed");
        return;
      }
      res.status(500).send("Failed to retrieve user info from Graph");
      return;
    }

    const user = await graphRes.json() as {
      id: string;
      displayName: string;
      userPrincipalName: string;
      mail?: string;
    };

    const email = user.mail || user.userPrincipalName;

    // Legacy-userId migration: if this Entra user previously used the app
    // under a server-assigned random UUID (auth-disabled mode), rename their
    // workspace folder and rewrite every cross-reference exactly once. Hard
    // fail the login on partial migration — better to retry than commit a
    // half-migrated session.
    const legacyUid = getCookie(req, LOCAL_UID_COOKIE);
    try {
      const legacyUserId = await findLegacyUserId(legacyUid, user.id, email);
      if (legacyUserId) {
        await migrateLegacyUser(legacyUserId, user.id, user.displayName, email);
      }
    } catch (err: any) {
      console.error("[auth] identity migration failed:", err);
      if (reportsToOpener) {
        silentResultRedirect(res, false, "migration_failed");
        return;
      }
      res.status(500).send(`Identity migration failed: ${err?.message || err}`);
      return;
    }
    clearLocalUidCookie(res);

    const flags = await computeSessionFlags(user.id, user.displayName, email, tokens.access_token);
    const isAdmin = flags.isAdmin;

    console.log(`[auth] User authenticated: ${user.displayName} (${user.userPrincipalName})${isAdmin ? " [admin]" : ""}`);

    saveUserProfile(user.id, user.displayName, email).catch(err =>
      console.warn("[auth] saveUserProfile failed:", err)
    );

    const sessionId = randomBytes(32).toString("hex");
    const expiresIn = tokens.expires_in || 3600;

    await store.set(sessionId, {
      userId: user.id,
      displayName: user.displayName,
      email,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || "",
      isAdmin,
      authType: "entra",
    });

    setSessionCookie(res, sessionId);
    if (reportsToOpener) {
      silentResultRedirect(res, true);
    } else {
      res.redirect("/");
    }
  } catch (err) {
    console.error("[auth] Callback error:", err);
    if (reportsToOpener) {
      silentResultRedirect(res, false, "callback-exception");
      return;
    }
    res.status(500).send("Authentication failed — check server logs");
  }
});

authRouter.get("/me", async (req: Request, res: Response) => {
  const sessionId = getCookie(req, "session_id");
  if (!sessionId) {
    res.json(null);
    return;
  }

  let session = await store.get(sessionId);
  if (!session) {
    clearSessionCookie(res);
    res.json(null);
    return;
  }

  const freshSession = await refreshSessionIfNeeded(sessionId, session, res);
  if (!freshSession) {
    await store.delete(sessionId);
    clearSessionCookie(res);
    res.json(null);
    return;
  }
  session = freshSession;

  res.json({
    userId: session.userId,
    displayName: session.displayName,
    email: session.email,
    isAdmin: session.isAdmin === true,
  });
});

authRouter.get("/refresh", async (req: Request, res: Response) => {
  const sessionId = getCookie(req, "session_id");
  if (!sessionId) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return;
  }

  const session = await store.get(sessionId);
  if (!session) {
    clearSessionCookie(res);
    res.status(401).json({ ok: false, error: "Authentication required" });
    return;
  }

  const freshSession = await refreshSessionIfNeeded(sessionId, session, res);
  if (!freshSession) {
    await store.delete(sessionId);
    clearSessionCookie(res);
    res.status(401).json({ ok: false, error: "Authentication required" });
    return;
  }

  res.json({
    ok: true,
    expiresAt: freshSession.expiresAt,
    userId: freshSession.userId,
    isAdmin: freshSession.isAdmin === true,
  });
});

authRouter.get("/logout", async (req: Request, res: Response) => {
  const sessionId = getCookie(req, "session_id");
  let wasLocalSession = false;
  if (sessionId) {
    const existing = await store.get(sessionId);
    wasLocalSession = existing?.authType === "local";
    await store.delete(sessionId);
  }
  clearSessionCookie(res);

  // Local-session sign-outs never bounce through Entra — that would either
  // 404 (Entra disabled) or surface "no AAD session" UX to a user who never
  // had one.
  if (!wasLocalSession && isAuthEnabled()) {
    const cfg = await getAuthConfig();
    const postLogoutUri = encodeURIComponent(`${getBaseUrl(req)}/`);
    res.redirect(
      `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogoutUri}`
    );
  } else {
    res.redirect("/");
  }
});

// ─── Local username/password login ──────────────────────────────────
// Per-IP rate limit: 10 failed attempts per 60s window. Reset on success.
// Held in-memory; resets across server restarts. Sufficient for an admin-
// managed user base (no enumeration at scale), and avoids a new persistence
// dependency.

interface RateBucket { count: number; windowStart: number }
const LOGIN_RATE_BUCKETS = new Map<string, RateBucket>();
const LOGIN_RATE_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_LIMIT = 10;

function loginRateKey(req: Request): string {
  return (req.ip || req.socket?.remoteAddress || "unknown").toString();
}

function checkLoginRate(req: Request): { ok: boolean; retryAfterSec: number } {
  const key = loginRateKey(req);
  const now = Date.now();
  const bucket = LOGIN_RATE_BUCKETS.get(key);
  if (!bucket || now - bucket.windowStart > LOGIN_RATE_WINDOW_MS) {
    LOGIN_RATE_BUCKETS.set(key, { count: 0, windowStart: now });
    return { ok: true, retryAfterSec: 0 };
  }
  if (bucket.count >= LOGIN_RATE_LIMIT) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.windowStart + LOGIN_RATE_WINDOW_MS - now) / 1000) };
  }
  return { ok: true, retryAfterSec: 0 };
}

function recordLoginFailure(req: Request): void {
  const key = loginRateKey(req);
  const bucket = LOGIN_RATE_BUCKETS.get(key);
  if (bucket) {
    bucket.count++;
  } else {
    LOGIN_RATE_BUCKETS.set(key, { count: 1, windowStart: Date.now() });
  }
}

function resetLoginRate(req: Request): void {
  LOGIN_RATE_BUCKETS.delete(loginRateKey(req));
}

authRouter.post("/login-local", async (req: Request, res: Response) => {
  try {
    const rate = checkLoginRate(req);
    if (!rate.ok) {
      res.status(429).json({ error: "Too many failed attempts. Try again shortly.", retryAfterSec: rate.retryAfterSec });
      return;
    }

    const body = (req.body || {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!username || !password) {
      recordLoginFailure(req);
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const record = await verifyLocalLogin(username, password);
    if (!record) {
      recordLoginFailure(req);
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    resetLoginRate(req);

    const displayName = `${record.firstName} ${record.lastName}`.trim() || record.username || record.email;
    const isAdmin = await isAdminUser(record.userId);

    const sessionId = randomBytes(32).toString("hex");
    await store.set(sessionId, {
      userId: record.userId,
      displayName,
      email: record.email,
      expiresAt: Date.now() + AUTH_COOKIE_MAX_AGE_SEC * 1000,
      accessToken: "",
      refreshToken: "",
      isAdmin,
      authType: "local",
    });

    // Drop any stale local-only UID cookie now that the user has a real session.
    clearLocalUidCookie(res);
    setSessionCookie(res, sessionId);
    console.log(`[auth] Local login: ${record.username} (${record.userId})${isAdmin ? " [admin]" : ""}`);
    res.status(204).end();
  } catch (err) {
    console.error("[auth] /login-local failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Frontend handshake: tells the login screen which sign-in paths to render
// and whether the "first user setup" panel should replace the login form.
// Always available — no session required.
authRouter.get("/login-options", async (_req: Request, res: Response) => {
  const needsFirstUser = !(await hasAnyUsers());
  res.json({ local: true, oauth: isAuthEnabled(), needsFirstUser });
});

// First-time setup: when the workspace has no users at all, anyone visiting
// the login screen can mint the first local user — they become a member of a
// freshly-created Administrators group and are logged in immediately. Once a
// single user exists, this endpoint refuses (409) and admins must use the
// Settings → Users panel instead.
authRouter.post("/setup-first-user", async (req: Request, res: Response) => {
  try {
    if (await hasAnyUsers()) {
      res.status(409).json({ error: "Setup already complete", code: "ALREADY_SETUP" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const firstName = typeof body.firstName === "string" ? body.firstName : "";
    const lastName = typeof body.lastName === "string" ? body.lastName : "";
    const email = typeof body.email === "string" ? body.email : "";

    const user = await createLocalUser({ username, firstName, lastName, email, password });

    // Bootstrap the admin group + add this user as its sole member.
    if (!(await hasAdminGroup())) {
      const group = await createVcaGroup(
        { kind: "admin", name: "Administrators", description: "Created during first-user setup" },
        user.userId,
      );
      await addManualMember(group.id, {
        userId: user.userId,
        displayName: user.displayName,
        email: user.email,
      }, "__bootstrap__");
    }

    const sessionId = randomBytes(32).toString("hex");
    await store.set(sessionId, {
      userId: user.userId,
      displayName: user.displayName,
      email: user.email,
      expiresAt: Date.now() + AUTH_COOKIE_MAX_AGE_SEC * 1000,
      accessToken: "",
      refreshToken: "",
      isAdmin: true,
      authType: "local",
    });

    clearLocalUidCookie(res);
    setSessionCookie(res, sessionId);
    console.log(`[auth] First-user setup: ${user.username} (${user.userId}) [admin]`);
    res.status(204).end();
  } catch (err: any) {
    const code = err?.code;
    const codeToStatus: Record<string, number> = {
      INVALID_USERNAME: 400,
      INVALID_PASSWORD: 400,
      INVALID_EMAIL: 400,
      INVALID_FIRSTNAME: 400,
      INVALID_LASTNAME: 400,
      DUPLICATE_USERNAME: 409,
    };
    const status = (code && codeToStatus[code]) || 500;
    res.status(status).json({ error: err?.message || String(err), code });
  }
});
