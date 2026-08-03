// Generic, provider-parameterized OAuth sign-in for pi-ai LLM providers whose
// `.auth.oauth` exposes the standard `OAuthAuth` contract (login/refresh/toAuth).
//
// This is the extracted, reusable core behind ChatGPT/Codex sign-in
// (src/codex-auth.ts) — now shared by Kimi (device-code) and OpenRouter (PKCE
// browser) too. pi-ai ships the whole protocol per provider (the browser PKCE
// flow with a loopback callback server, the device-code flow, token refresh,
// and the request dialect). Since pi 0.80.8 the app owns credential persistence
// through pi-ai's CredentialStore interface: ModelRuntime/Models runs the
// per-prompt token refresh inside store.modify() (a serialized, cross-process
// read-modify-write), re-persisting rotated refresh tokens. This module owns
// what VCA adds on top, per provider:
//
//   - a process-wide CredentialStore at admin/<provider>-auth.json whose content
//     is encrypted at rest with the env-secrets master key and guarded by a
//     cross-process file lock (proper-lockfile, sibling .lock),
//   - a single-pending-login state machine driven by the admin routes.
//
// Each provider's credential is deployment-wide (one subscription/account per
// VCA install), mirroring the admin-configured LLM API key.
import type { AuthEvent, AuthInteraction, AuthPrompt, Credential, CredentialInfo, CredentialStore, OAuthAuth } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";
import { decryptSecretSync, encryptSecretSync, getMasterKey } from "./secret-crypto.js";

type OAuthCredential = Extract<Credential, { type: "oauth" }>;

/**
 * Static description of a provider's OAuth sign-in. `oauthFlow` returns the
 * pi-ai `OAuthAuth` (from `provider().auth.oauth`); `methods` are the login
 * methods the flow supports (codex: both; kimi: device only; openrouter:
 * browser only); `describeCredential` derives provider-specific status fields
 * from the stored credential (codex decodes the JWT for email/plan/account).
 */
export interface ProviderOAuthConfig {
  /** pi provider id — the CredentialStore key pi reads/writes (e.g. "openai-codex", "kimi-coding", "openrouter"). */
  providerId: string;
  /** Human label for errors/log messages (e.g. "ChatGPT", "Kimi", "OpenRouter"). */
  displayName: string;
  /** Log prefix, e.g. "codex-auth". */
  logTag: string;
  /** Encrypted credential file path (adminPaths.codexAuth, etc.). */
  authPath: () => string;
  /** The pi-ai OAuth flow; throws if the provider exposes none. */
  oauthFlow: () => OAuthAuth;
  /** Login methods this provider's flow supports (first is the default). */
  methods: OAuthLoginMethod[];
  /** Extra status fields derived from the stored oauth credential. */
  describeCredential?: (cred: OAuthCredential) => Record<string, unknown>;
}

/**
 * Undici's fetch reports every network failure as a bare "fetch failed"
 * TypeError with the actual reason (DNS, TLS interception, proxy refusal)
 * buried in the `cause` chain — unwrap it so the Settings card shows
 * something actionable.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    let msg = e.message;
    // Parallel connect attempts (e.g. per resolved IP) surface as an
    // AggregateError whose own message is often empty — use the first inner.
    if (e instanceof AggregateError && (!msg || msg === "AggregateError")) {
      const first = e.errors.find((x): x is Error => x instanceof Error);
      if (first) msg = first.message;
    }
    if (msg && !parts.includes(msg)) parts.push(msg);
    e = e.cause;
  }
  return parts.join(": ") || String(err);
}

// ---------------------------------------------------------------------------
// Encrypted credential store
// ---------------------------------------------------------------------------

/**
 * pi-ai CredentialStore backed by an encrypted JSON file. modify()/delete()
 * take a cross-process lock and re-read the file, so concurrent refreshes
 * (multiple prompts, multiple processes) cannot double-refresh or clobber a
 * rotated token; read()/list() serve the in-memory snapshot, which every
 * locked operation re-syncs from disk. One instance per provider file.
 */
export class EncryptedOAuthCredentialStore implements CredentialStore {
  private data: Record<string, Credential> = {};
  private warnedDecryptFailure = false;

  constructor(private readonly authPath: string, private readonly logTag: string) {
    this.ensureFile();
    // Forgiving load: a corrupt file reads as signed-out (matching pi's old
    // reload()); the strict parse inside the locked write path still surfaces
    // the corruption instead of silently wiping it.
    try {
      this.data = this.parse(readFileSync(this.authPath, "utf-8"));
    } catch (err) {
      console.error(`[${this.logTag}] ${this.authPath} is unreadable — treating as signed out:`, err);
      this.data = {};
    }
  }

  private decodeStored(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    // Plaintext JSON passes through: the store seeds the file with "{}", and it
    // doubles as a manual-recovery escape hatch.
    if (trimmed === "" || trimmed.startsWith("{")) return raw;
    try {
      return decryptSecretSync(trimmed);
    } catch (err) {
      if (!this.warnedDecryptFailure) {
        this.warnedDecryptFailure = true;
        console.error(
          `[${this.logTag}] Cannot decrypt ${this.authPath} (master key changed?) — ` +
          "treating as signed out. Sign in again.",
          err,
        );
      }
      return "{}";
    }
  }

  private ensureFile(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.authPath)) writeFileSync(this.authPath, "{}", { encoding: "utf-8", mode: 0o600 });
  }

  /** Throws on corrupt plaintext JSON (surfaced to the caller, never wiped). */
  private parse(raw: string | undefined): Record<string, Credential> {
    const decoded = this.decodeStored(raw);
    if (decoded === undefined || decoded.trim() === "") return {};
    return JSON.parse(decoded) as Record<string, Credential>;
  }

  /** Sync snapshot read for status display (no refresh, possibly expired). */
  getSync(providerId: string): Credential | undefined {
    return this.data[providerId];
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.data[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, cred]) => ({ providerId, type: cred.type }));
  }

  private async withFileLock<T>(fn: (current: Record<string, Credential>) => Promise<{ result: T; write?: Record<string, Credential> }>): Promise<T> {
    this.ensureFile();
    const release = await lockfile.lock(this.authPath, {
      retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
      stale: 30_000,
      realpath: false,
    });
    try {
      const current = this.parse(readFileSync(this.authPath, "utf-8"));
      const { result, write } = await fn(current);
      if (write) {
        writeFileSync(this.authPath, encryptSecretSync(JSON.stringify(write, null, 2)), { encoding: "utf-8", mode: 0o600 });
        this.data = write;
      } else {
        this.data = current;
      }
      return result;
    } finally {
      await release().catch(() => { /* stale/compromised lock — next lock() recovers */ });
    }
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.withFileLock(async (current) => {
      const next = await fn(current[providerId]);
      if (next === undefined) return { result: current[providerId] };
      return { result: next, write: { ...current, [providerId]: next } };
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.withFileLock(async (current) => {
      if (!(providerId in current)) return { result: undefined };
      const { [providerId]: _removed, ...rest } = current;
      return { result: undefined, write: rest };
    });
  }
}

// ---------------------------------------------------------------------------
// Status / login-state types
// ---------------------------------------------------------------------------

export interface ProviderAuthStatus {
  signedIn: boolean;
  expiresAt?: number;
  /** Access token past its expiry. Informational — pi refreshes on next use. */
  expired?: boolean;
  // Provider-specific extras (email, planType, accountId, …) via describeCredential.
  [key: string]: unknown;
}

export type OAuthLoginMethod = "browser" | "device_code";

export type OAuthLoginState =
  | { status: "idle" }
  | {
      status: "pending";
      method: OAuthLoginMethod;
      startedAt: number;
      authUrl?: string;
      userCode?: string;
      verificationUri?: string;
      progress?: string;
    }
  | { status: "success"; finishedAt: number }
  | { status: "error"; message: string; finishedAt: number };

export class OAuthLoginPendingError extends Error {
  constructor(displayName: string) {
    super(`A ${displayName} sign-in is already in progress`);
    this.name = "OAuthLoginPendingError";
  }
}

const BROWSER_LOGIN_TIMEOUT_MS = 10 * 60_000;
// pi's device flow self-expires after 15 min; our guard only mops up after it.
const DEVICE_LOGIN_TIMEOUT_MS = 16 * 60_000;
const LOGIN_INFO_TIMEOUT_MS = 15_000;

interface LoginAttempt {
  method: OAuthLoginMethod;
  cancelled: boolean;
  codeWaiter: { resolve: (code: string) => void; reject: (err: Error) => void } | null;
  abort: AbortController;
  timer: NodeJS.Timeout | null;
}

// ---------------------------------------------------------------------------
// Per-provider manager: encrypted store singleton + single-pending-login
// state machine + status/verify. One instance per provider (codex, kimi,
// openrouter), each with independent credential file and login state.
// ---------------------------------------------------------------------------

export class ProviderOAuthManager {
  private store: EncryptedOAuthCredentialStore | null = null;
  private flow: OAuthAuth | null = null;
  private loginState: OAuthLoginState = { status: "idle" };
  private activeAttempt: LoginAttempt | null = null;

  constructor(private readonly config: ProviderOAuthConfig) {}

  private oauth(): OAuthAuth {
    if (!this.flow) this.flow = this.config.oauthFlow();
    return this.flow;
  }

  /**
   * Best-effort init (server startup, retried lazily by the login route). Must
   * run after applyEnvVarsToProcess() so an admin-provided VCA_SECRETS_KEY is
   * honored; the master key is preloaded because the store's encrypt/decrypt
   * runs synchronously inside the file lock.
   */
  async init(): Promise<void> {
    if (this.store) return;
    try {
      await getMasterKey();
      this.store = new EncryptedOAuthCredentialStore(this.config.authPath(), this.config.logTag);
    } catch (err) {
      this.store = null;
      console.error(`[${this.config.logTag}] init failed — ${this.config.displayName} sign-in unavailable:`, err);
    }
  }

  /** The shared store handed to this provider's ModelRuntimes (pi refreshes through it). */
  getCredentialStore(): CredentialStore {
    if (!this.store) throw new Error(`${this.config.displayName} auth storage not initialized`);
    return this.store;
  }

  hasCredential(): boolean {
    return this.store?.getSync(this.config.providerId)?.type === "oauth";
  }

  getStatus(): ProviderAuthStatus {
    const cred = this.store?.getSync(this.config.providerId);
    if (cred?.type !== "oauth") return { signedIn: false };
    const status: ProviderAuthStatus = { signedIn: true };
    // Skip an absurd sentinel expiry (OpenRouter's minted key never expires and
    // sets Number.MAX_SAFE_INTEGER) — showing it as a date is meaningless.
    if (typeof cred.expires === "number" && cred.expires > 0 && cred.expires < Number.MAX_SAFE_INTEGER) {
      status.expiresAt = cred.expires;
      status.expired = cred.expires <= Date.now();
    }
    if (this.config.describeCredential) Object.assign(status, this.config.describeCredential(cred as OAuthCredential));
    return status;
  }

  getLoginState(): OAuthLoginState {
    return this.loginState;
  }

  /**
   * Active health probe for the Settings card. A no-op while the access token
   * is valid; once expired it runs the same locked, double-checked refresh
   * pi-ai performs per request against the real store (the single source of
   * truth — rotated tokens are persisted). On refresh failure the credential is
   * preserved for retry and the error is surfaced for display; the user must
   * sign in again. Providers whose credential never expires (OpenRouter) always
   * report healthy without a network call.
   */
  async verify(): Promise<{ healthy: boolean; error?: string }> {
    const cred = this.store?.getSync(this.config.providerId);
    if (!this.store || cred?.type !== "oauth") return { healthy: false, error: "Not signed in" };
    if (typeof cred.expires !== "number" || Date.now() < cred.expires) return { healthy: true };
    try {
      const post = await this.store.modify(this.config.providerId, async (current) => {
        if (current?.type !== "oauth") return undefined; // logged out meanwhile
        if (typeof current.expires === "number" && Date.now() < current.expires) return undefined; // another process/request refreshed
        return this.oauth().refresh(current);
      });
      if (post?.type !== "oauth") return { healthy: false, error: "Not signed in" };
      return { healthy: true };
    } catch (err) {
      const error = describeError(err);
      console.warn(`[${this.config.logTag}] Health check failed: ${error}`);
      return { healthy: false, error };
    }
  }

  private clearAttemptTimer(attempt: LoginAttempt): void {
    if (attempt.timer) {
      clearTimeout(attempt.timer);
      attempt.timer = null;
    }
  }

  /**
   * Start a sign-in. Resolves as soon as the auth URL (browser) or user code
   * (device) is known — the flow itself keeps running in the background and is
   * observed via getLoginState(). Throws OAuthLoginPendingError while another
   * login is running. `method` defaults to the provider's first supported method.
   */
  async startLogin(requestedMethod?: OAuthLoginMethod): Promise<OAuthLoginState> {
    if (this.loginState.status === "pending" && this.activeAttempt) {
      // Abandoned logins are mopped up by the attempt timer; a stale pending
      // state here means the timer hasn't fired yet — treat it as busy.
      throw new OAuthLoginPendingError(this.config.displayName);
    }
    // Clamp to a method this provider's flow actually supports, so a mismatched
    // request (e.g. "browser" for the device-only Kimi flow) falls back to the
    // provider default instead of hanging on a prompt that never arrives.
    const method = requestedMethod && this.config.methods.includes(requestedMethod)
      ? requestedMethod
      : this.config.methods[0];
    await this.init();
    const auth = this.getCredentialStore();

    const attempt: LoginAttempt = {
      method,
      cancelled: false,
      codeWaiter: null,
      abort: new AbortController(),
      timer: null,
    };
    this.activeAttempt = attempt;
    const pending: Extract<OAuthLoginState, { status: "pending" }> = {
      status: "pending",
      method,
      startedAt: Date.now(),
    };
    this.loginState = pending;

    let infoReady!: () => void;
    const infoReadyPromise = new Promise<void>((resolve) => { infoReady = resolve; });

    // The admin pastes the redirect URL (or bare code) via POST .../login/code.
    // The codex browser flow races this prompt against its localhost:1455
    // callback server (silently degrading to this manual path if port 1455 is
    // taken) and aborts it via prompt.signal once the callback wins. Kimi
    // (device) and OpenRouter (loopback) never issue a manual_code prompt, so
    // this waiter is codex-only in practice.
    const waitForSubmittedCode = (signal?: AbortSignal): Promise<string> =>
      attempt.cancelled
        ? Promise.reject(new Error("Sign-in cancelled"))
        : new Promise<string>((resolve, reject) => {
            attempt.codeWaiter = { resolve, reject };
            signal?.addEventListener("abort", () => {
              if (attempt.codeWaiter?.reject === reject) attempt.codeWaiter = null;
              reject(new Error("Sign-in prompt cancelled"));
            }, { once: true });
          });

    const interaction: AuthInteraction = {
      // Honored by the device-code flow's fetches; the browser flow's cancel
      // path is rejecting the pending prompt below.
      signal: attempt.abort.signal,
      prompt: async (p: AuthPrompt): Promise<string> => {
        // Codex first asks which method to use; single-method providers never do.
        if (p.type === "select") return method;
        return waitForSubmittedCode(p.signal);
      },
      notify: (event: AuthEvent): void => {
        if (event.type === "auth_url") {
          pending.authUrl = event.url;
          infoReady();
        } else if (event.type === "device_code") {
          pending.userCode = event.userCode;
          pending.verificationUri = event.verificationUri;
          infoReady();
        } else if (event.type === "progress" || event.type === "info") {
          pending.progress = event.message;
        }
      },
    };

    // login() yields the credential; persisting it into the encrypted store is
    // app-owned since pi 0.80.8 (same modify() call Models.login performs).
    const done = this.oauth()
      .login(interaction)
      .then((credential) => auth.modify(this.config.providerId, async () => credential))
      .then(() => {
        if (this.activeAttempt !== attempt) return;
        this.clearAttemptTimer(attempt);
        this.loginState = { status: "success", finishedAt: Date.now() };
      })
      .catch((err: unknown) => {
        if (this.activeAttempt !== attempt) return;
        this.clearAttemptTimer(attempt);
        if (attempt.cancelled) return; // cancelLogin already set the state
        this.loginState = {
          status: "error",
          message: describeError(err),
          finishedAt: Date.now(),
        };
      })
      .finally(() => {
        if (this.activeAttempt === attempt) this.activeAttempt = null;
      });

    const timeoutMs = method === "browser" ? BROWSER_LOGIN_TIMEOUT_MS : DEVICE_LOGIN_TIMEOUT_MS;
    attempt.timer = setTimeout(() => {
      if (this.activeAttempt === attempt && this.loginState.status === "pending") {
        this.cancelLogin("Sign-in timed out");
      }
    }, timeoutMs);
    attempt.timer.unref?.();

    // Unblock the HTTP route once the URL/code is known — or once the flow has
    // already settled (e.g. an immediate network error).
    await Promise.race([
      infoReadyPromise,
      done,
      new Promise<void>((resolve) => { setTimeout(resolve, LOGIN_INFO_TIMEOUT_MS).unref?.(); }),
    ]);
    return this.loginState;
  }

  /** Feed the pasted redirect URL / authorization code into a pending login. */
  submitLoginCode(code: string): void {
    const attempt = this.activeAttempt;
    const waiter = attempt?.codeWaiter;
    if (!attempt || this.loginState.status !== "pending" || !waiter) {
      throw new Error(`No ${this.config.displayName} sign-in is waiting for a code`);
    }
    attempt.codeWaiter = null;
    waiter.resolve(code);
  }

  /**
   * Cancel a pending login (also dismisses a settled error/success state back
   * to idle). With a reason, the state becomes an error carrying it instead.
   */
  cancelLogin(reason?: string): void {
    const attempt = this.activeAttempt;
    const finalState: OAuthLoginState = reason
      ? { status: "error", message: reason, finishedAt: Date.now() }
      : { status: "idle" };
    if (!attempt || this.loginState.status !== "pending") {
      this.loginState = { status: "idle" };
      return;
    }
    attempt.cancelled = true;
    this.clearAttemptTimer(attempt);
    attempt.abort.abort();
    const waiter = attempt.codeWaiter;
    attempt.codeWaiter = null;
    waiter?.reject(new Error(reason || "Sign-in cancelled"));
    this.loginState = finalState;
  }

  /** Remove the stored credential; cached sessions fail on their next prompt. */
  async logout(): Promise<void> {
    this.cancelLogin();
    await this.store?.delete(this.config.providerId);
  }
}
