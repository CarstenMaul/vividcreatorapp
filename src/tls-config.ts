import tls from "node:tls";
import { getCachedVcaSettings } from "./admin-settings.js";

/**
 * Global TLS certificate verification for the server process's outbound HTTPS,
 * governed by the admin "Network" setting (default: enabled).
 *
 * Node reads `process.env.NODE_TLS_REJECT_UNAUTHORIZED` when establishing each
 * outbound TLS connection, so mutating it here takes effect for subsequent
 * connections without a restart. Child processes VCA spawns (the agent shell,
 * preview apps) inherit `process.env`, so they follow the same posture.
 *
 * Historically the container image hard-disabled verification via
 * `ENV NODE_TLS_REJECT_UNAUTHORIZED=0` for a corporate TLS-intercepting proxy.
 * That is now an admin-controlled, persisted setting instead — verification is
 * on by default; disabling it is a deliberate, auditable choice.
 */

// git ignores NODE_TLS_REJECT_UNAUTHORIZED — it has its own TLS backend
// (schannel on Windows, OpenSSL elsewhere). To make the git subprocesses VCA
// spawns (Version Control push/pull, releases, system-content sync) honor the
// same posture, inject config through git's GIT_CONFIG_* env mechanism, which
// every child git reads from process.env — exactly like the Node var above.
//
//   http.sslVerify=false           — skip certificate verification.
//   http.schannelCheckRevoke=false — also skip revocation checking on Windows,
//                                    which otherwise fails closed behind a
//                                    TLS-intercepting proxy with
//                                    CRYPT_E_NO_REVOCATION_CHECK. The OpenSSL
//                                    backend ignores this key, so it is safe on
//                                    every platform.
// VCA sets no other git config via env, so it owns these GIT_CONFIG_* slots.
const GIT_TLS_BYPASS: ReadonlyArray<readonly [string, string]> = [
  ["http.sslVerify", "false"],
  ["http.schannelCheckRevoke", "false"],
];

function applyGitTlsVerification(enabled: boolean): void {
  if (enabled) {
    delete process.env.GIT_CONFIG_COUNT;
    for (let i = 0; i < GIT_TLS_BYPASS.length; i++) {
      delete process.env[`GIT_CONFIG_KEY_${i}`];
      delete process.env[`GIT_CONFIG_VALUE_${i}`];
    }
  } else {
    process.env.GIT_CONFIG_COUNT = String(GIT_TLS_BYPASS.length);
    GIT_TLS_BYPASS.forEach(([key, value], i) => {
      process.env[`GIT_CONFIG_KEY_${i}`] = key;
      process.env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
  }
}

export function applyTlsVerification(enabled: boolean): void {
  if (enabled) {
    // Node verifies by default. Clear any inherited image-level override so a
    // fresh deploy — or toggling the setting back on — actually re-enables it.
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  // Keep git's TLS posture in lock-step with Node's.
  applyGitTlsVerification(enabled);
  console.log(
    `[tls] Certificate verification ${
      enabled
        ? "ENABLED"
        : "DISABLED (NODE_TLS_REJECT_UNAUTHORIZED=0, git http.sslVerify=false)"
    }`,
  );
}

/** Apply the persisted setting. Call once at startup after loadVcaSettings(). */
export function applyTlsVerificationFromSettings(): void {
  applyTlsVerification(getCachedVcaSettings().tlsVerificationEnabled);
}

/**
 * Merge the OS trust store (Windows certificate store, macOS Keychain, Linux
 * system bundle) into Node's default CA set. Node only trusts its bundled
 * Mozilla roots, so behind corporate TLS interception every outbound fetch
 * (LLM providers, ChatGPT OAuth, web tools) dies with "unable to get local
 * issuer certificate" even though the OS — and therefore every browser and
 * git's schannel backend — trusts the intercepting CA. Merging only ADDS
 * anchors the machine admin already installed; verification stays on.
 *
 * Call once at startup before any outbound HTTPS. Node child processes don't
 * inherit an in-process CA set, so NODE_USE_SYSTEM_CA=1 is exported for
 * spawned Node tooling to pick up at its own startup. Requires Node >= 22.15
 * for the tls CA-management APIs; older runtimes keep bundled-roots behavior.
 */
export function trustSystemCaCertificates(): void {
  try {
    if (typeof tls.getCACertificates !== "function" || typeof tls.setDefaultCACertificates !== "function") return;
    const system = tls.getCACertificates("system");
    if (system.length === 0) return;
    const merged = new Set([...tls.getCACertificates("default"), ...system]);
    tls.setDefaultCACertificates([...merged]);
    process.env.NODE_USE_SYSTEM_CA = "1";
    console.log(`[tls] Trusting ${system.length} OS-store CA certificate(s) alongside Node's bundled roots`);
  } catch (err) {
    console.warn("[tls] Could not load the OS certificate store (continuing with bundled roots):", err);
  }
}
