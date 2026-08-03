import { FileSessionStore } from "./session-store-file.js";

export interface SessionData {
  userId: string;
  displayName: string;
  email: string;
  expiresAt: number; // ms since epoch
  accessToken: string;
  refreshToken: string;
  isAdmin: boolean;
  // "entra" → session originated from OAuth callback, refreshable via Entra token endpoint.
  // "local" → session originated from /auth/login-local; accessToken/refreshToken are empty,
  //           and refresh is just a sliding expiry on the local cookie.
  authType: "local" | "entra";
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData): Promise<void>;
  delete(sessionId: string): Promise<void>;
  /** Delete sessions whose expiresAt is older than `now - olderThanMs`. Returns count deleted. */
  cleanupExpired(olderThanMs: number): Promise<number>;
  describe(): string;
}

let _store: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (_store) return _store;
  _store = new FileSessionStore();
  console.log(`[session-store] active: ${_store.describe()}`);
  return _store;
}
