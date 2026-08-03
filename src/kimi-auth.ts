import type { CredentialStore } from "@earendil-works/pi-ai";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { adminPaths } from "./paths.js";
import { ProviderOAuthManager, type ProviderOAuthConfig } from "./provider-oauth.js";

/**
 * Kimi Code (subscription) auth for the "kimi-coding" LLM provider
 * (https://api.kimi.com/coding, anthropic-messages dialect). A thin adapter
 * over the shared src/provider-oauth.ts manager.
 *
 * pi-ai ships the whole protocol: a device-code (RFC 8628) sign-in — it emits a
 * user code + verification URL, then polls the token endpoint — plus real
 * refresh-token rotation and the `Authorization: Bearer <access>` request
 * dialect. There is no browser/loopback or manual-paste path, so the device
 * flow is the only method and it works on any deployment (remote or desktop),
 * unlike OpenRouter's loopback flow.
 *
 * The credential is deployment-wide (one Kimi subscription per VCA install),
 * stored encrypted at admin/kimi-auth.json and refreshed in place by pi.
 */

export const KIMI_PROVIDER_ID = "kimi-coding";

const config: ProviderOAuthConfig = {
  providerId: KIMI_PROVIDER_ID,
  displayName: "Kimi Code",
  logTag: "kimi-auth",
  authPath: adminPaths.kimiAuth,
  methods: ["device_code"],
  oauthFlow: () => {
    const oauth = kimiCodingProvider().auth.oauth;
    if (!oauth) throw new Error("pi-ai kimi-coding provider has no OAuth flow");
    return oauth;
  },
};

export const kimiAuthManager = new ProviderOAuthManager(config);

export function initKimiAuth(): Promise<void> {
  return kimiAuthManager.init();
}

/** The shared store handed to kimi-coding ModelRuntimes (pi refreshes through it). */
export function getKimiCredentialStore(): CredentialStore {
  return kimiAuthManager.getCredentialStore();
}

export function hasKimiCredential(): boolean {
  return kimiAuthManager.hasCredential();
}
