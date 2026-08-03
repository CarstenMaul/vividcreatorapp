import { codexAuthManager } from "./codex-auth.js";
import { kimiAuthManager } from "./kimi-auth.js";
import { openrouterAuthManager } from "./openrouter-auth.js";
import type { ProviderOAuthManager } from "./provider-oauth.js";

/**
 * Registry of the provider OAuth managers keyed by the short slug used in the
 * admin routes (/admin/<slug>-auth/*). One shared source of truth so the route
 * factory and server startup don't hard-code the provider list. Each manager is
 * an ES-module singleton shared with its adapter's credential-store accessors
 * (agent-manager consumes those directly).
 */
export type ProviderAuthSlug = "codex" | "kimi" | "openrouter";

const MANAGERS: Record<ProviderAuthSlug, ProviderOAuthManager> = {
  codex: codexAuthManager,
  kimi: kimiAuthManager,
  openrouter: openrouterAuthManager,
};

/** Resolve a manager by slug, or undefined for an unknown/unsupported slug. */
export function getProviderAuthManager(slug: string): ProviderOAuthManager | undefined {
  return Object.prototype.hasOwnProperty.call(MANAGERS, slug)
    ? MANAGERS[slug as ProviderAuthSlug]
    : undefined;
}

/**
 * Init every provider's encrypted store at server startup. Each is best-effort
 * (a failure just means that provider reports "not signed in"); one failing
 * never blocks the others.
 */
export async function initAllProviderAuth(): Promise<void> {
  await Promise.all(Object.values(MANAGERS).map((m) => m.init()));
}
