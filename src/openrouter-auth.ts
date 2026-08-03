import type { CredentialStore } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { adminPaths } from "./paths.js";
import { ProviderOAuthManager, type ProviderOAuthConfig } from "./provider-oauth.js";

/**
 * OpenRouter OAuth for the "openrouter" LLM provider. A thin adapter over the
 * shared src/provider-oauth.ts manager.
 *
 * pi-ai ships a PKCE browser flow: it starts an ephemeral 127.0.0.1 loopback
 * server on a random port with a randomized callback path, emits the
 * authorization URL, and — on the redirect back — exchanges the code for a
 * durable OpenRouter API key. The credential is `{access: <key>, refresh: "",
 * expires: MAX_SAFE_INTEGER}` (never expires; refresh is a no-op) and toAuth()
 * returns `{apiKey: access}` — i.e. the same request shape as a pasted API key,
 * just sourced from the encrypted store.
 *
 * IMPORTANT: the flow completes via a browser redirect to the *server's*
 * 127.0.0.1:<port>, with no manual-paste fallback. It therefore only works when
 * the server and the browser share a machine — the packaged desktop app (like
 * the Codex VCA_PACKAGED browser-open path). On a remote/Docker deployment the
 * callback lands on the user's machine instead and cannot complete; there, the
 * static OpenRouter API-key configuration remains the supported path.
 *
 * Stored encrypted at admin/openrouter-auth.json.
 */

export const OPENROUTER_PROVIDER_ID = "openrouter";

const config: ProviderOAuthConfig = {
  providerId: OPENROUTER_PROVIDER_ID,
  displayName: "OpenRouter",
  logTag: "openrouter-auth",
  authPath: adminPaths.openrouterAuth,
  methods: ["browser"],
  oauthFlow: () => {
    const oauth = openrouterProvider().auth.oauth;
    if (!oauth) throw new Error("pi-ai openrouter provider has no OAuth flow");
    return oauth;
  },
};

export const openrouterAuthManager = new ProviderOAuthManager(config);

export function initOpenRouterAuth(): Promise<void> {
  return openrouterAuthManager.init();
}

/** The shared store handed to openrouter ModelRuntimes (pi reads the minted key through it). */
export function getOpenRouterCredentialStore(): CredentialStore {
  return openrouterAuthManager.getCredentialStore();
}

export function hasOpenRouterCredential(): boolean {
  return openrouterAuthManager.hasCredential();
}
