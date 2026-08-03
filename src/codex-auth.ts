import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { adminPaths } from "./paths.js";
import {
  OAuthLoginPendingError,
  ProviderOAuthManager,
  type OAuthLoginMethod,
  type OAuthLoginState,
  type ProviderOAuthConfig,
} from "./provider-oauth.js";

/**
 * ChatGPT/Codex subscription auth for the "openai-codex" LLM provider.
 *
 * This is now a thin adapter over the shared, provider-parameterized
 * src/provider-oauth.ts manager (extracted verbatim from what used to live
 * here). pi-ai ships the whole protocol for this provider — the OAuth PKCE
 * browser flow (it spins up a one-shot localhost:1455 callback server inside
 * this process and races it against a manual paste), the device-code flow,
 * token refresh, and the chatgpt.com/backend-api Responses dialect. Since pi
 * 0.80.8 the app owns credential persistence through pi-ai's CredentialStore
 * interface: ModelRuntime/Models runs the per-prompt token refresh inside
 * store.modify() (a serialized, cross-process read-modify-write), re-persisting
 * rotated refresh tokens. This module owns what VCA adds on top:
 *
 *   - a process-wide CredentialStore at admin/codex-auth.json whose content is
 *     encrypted at rest with the env-secrets master key and guarded by a
 *     cross-process file lock (proper-lockfile, sibling codex-auth.json.lock),
 *   - a single-pending-login state machine driven by the admin routes
 *     (POST /api/admin/codex-auth/login etc.).
 *
 * The credential is deployment-wide (one ChatGPT Plus/Pro account per VCA
 * install), mirroring the admin-configured LLM API key.
 */

export const CODEX_PROVIDER_ID = "openai-codex";

// Codex enriches its status with claims decoded from the OAuth access token
// (a JWT): the ChatGPT account id, plan tier, and account email. Kimi and
// OpenRouter credentials are opaque and carry no such claims.
function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) return {};
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function describeCodexCredential(cred: Extract<Credential, { type: "oauth" }>): Record<string, unknown> {
  const claims = decodeJwtClaims(cred.access);
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const profile = (claims["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  const accountId = asNonEmptyString((cred as { accountId?: unknown }).accountId) ?? asNonEmptyString(auth.chatgpt_account_id);
  if (accountId) extra.accountId = accountId;
  const planType = asNonEmptyString(auth.chatgpt_plan_type);
  if (planType) extra.planType = planType;
  const email = asNonEmptyString(profile.email) ?? asNonEmptyString(claims.email);
  if (email) extra.email = email;
  return extra;
}

const config: ProviderOAuthConfig = {
  providerId: CODEX_PROVIDER_ID,
  displayName: "ChatGPT",
  logTag: "codex-auth",
  authPath: adminPaths.codexAuth,
  // Both the browser PKCE (localhost:1455 callback + manual paste) and the
  // device-code flow are supported for codex.
  methods: ["browser", "device_code"],
  oauthFlow: () => {
    const oauth = openaiCodexProvider().auth.oauth;
    if (!oauth) throw new Error("pi-ai openai-codex provider has no OAuth flow");
    return oauth;
  },
  describeCredential: describeCodexCredential,
};

/**
 * The shared Codex OAuth manager (encrypted store + single-pending-login state
 * machine). Exported for the admin route registry; agent-manager consumes only
 * the credential store + hasCredential helpers below.
 */
export const codexAuthManager = new ProviderOAuthManager(config);

// ---------------------------------------------------------------------------
// Public API — unchanged names/signatures so agent-manager.ts, server.ts, and
// the admin routes keep working across the extraction.
// ---------------------------------------------------------------------------

export type CodexLoginMethod = OAuthLoginMethod;
export type CodexLoginState = OAuthLoginState;

/** Kept as a distinct symbol for the routes' `instanceof` check. */
export { OAuthLoginPendingError as CodexLoginPendingError };

export interface CodexAuthStatus {
  signedIn: boolean;
  accountId?: string;
  planType?: string;
  email?: string;
  expiresAt?: number;
  /** Access token past its expiry. Informational — pi refreshes on next use. */
  expired?: boolean;
}

/**
 * Best-effort init (server startup, retried lazily by the login route). Must
 * run after applyEnvVarsToProcess() so an admin-provided VCA_SECRETS_KEY is
 * honored.
 */
export function initCodexAuth(): Promise<void> {
  return codexAuthManager.init();
}

/** The shared store handed to codex ModelRuntimes (pi refreshes through it). */
export function getCodexCredentialStore(): CredentialStore {
  return codexAuthManager.getCredentialStore();
}

export function hasCodexCredential(): boolean {
  return codexAuthManager.hasCredential();
}

export function getCodexAuthStatus(): CodexAuthStatus {
  return codexAuthManager.getStatus() as CodexAuthStatus;
}

export function verifyCodexAuth(): Promise<{ healthy: boolean; error?: string }> {
  return codexAuthManager.verify();
}

export function getCodexLoginState(): CodexLoginState {
  return codexAuthManager.getLoginState();
}

export function startCodexLogin(method: CodexLoginMethod): Promise<CodexLoginState> {
  return codexAuthManager.startLogin(method);
}

export function submitCodexLoginCode(code: string): void {
  codexAuthManager.submitLoginCode(code);
}

export function cancelCodexLogin(reason?: string): void {
  codexAuthManager.cancelLogin(reason);
}

export function codexLogout(): Promise<void> {
  return codexAuthManager.logout();
}
