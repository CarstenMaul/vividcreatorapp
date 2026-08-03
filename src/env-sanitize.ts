/**
 * Central place for scrubbing secrets out of environments handed to child
 * processes we do not fully trust.
 *
 * Two consumers, two policies:
 *
 *  - The PREVIEW runner (generated user apps) uses a DENY-LIST
 *    (`sanitizeChildEnv`): keep everything except known internal keys. A
 *    generated app legitimately needs most of the ambient environment.
 *
 *  - The AGENT SHELL (the pi bash tool) uses an ALLOW-LIST
 *    (`buildSanitizedAgentEnv`): drop everything except a curated set of
 *    non-secret vars the agent's toolchain needs. The agent runs
 *    model-authored commands, so a deny-list that "fails open" for any future
 *    secret is not good enough here.
 */

// Internal env consumed by VCA itself; must never reach a preview app or the
// agent shell. Prefix match covers provider families (AZURE_*, ANTHROPIC_*, …).
export const VCA_INTERNAL_ENV_PREFIXES = [
  "AZURE_",
  "ENTRA_",
  "ANTHROPIC_",
  "OPENAI_",
  "VCA_",
];
// Internal provider keys that lack a unique prefix in VCA_INTERNAL_ENV_PREFIXES
// but must still be withheld.
export const VCA_INTERNAL_ENV_NAMES = new Set<string>([
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "KIMI_API_KEY",
]);

/**
 * Deny-list scrub for preview (generated) apps: keep everything except VCA's
 * own internal keys. Unchanged behavior from the previous in-place copy in
 * app-process-manager.ts.
 */
export function sanitizeChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (VCA_INTERNAL_ENV_NAMES.has(k)) continue;
    if (VCA_INTERNAL_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

// ── Agent-shell allow-list ──────────────────────────────────────────────────
//
// Curated set of environment variables the agent's legitimate toolchain (git,
// npm, azure-cli, the bundled Node/Git runtime) needs. Everything else — every
// provider API key, DevOps PAT, Entra secret, and any future secret — is
// dropped by construction. Compared case-insensitively so it works regardless
// of the OS's env-key casing (Windows exposes "Path", Linux "PATH").
//
// Keep this list narrow. Widen it only when a real breakage is observed.
const AGENT_ENV_ALLOW = new Set<string>(
  [
    // Command resolution — PATH already has the bundled runtime prepended by pi.
    "PATH",
    // Home / identity (git/npm/az read their config from here).
    "HOME", "USER", "LOGNAME", "SHELL",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
    // Locale / terminal.
    "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM",
    // Temp dirs.
    "TMPDIR", "TMP", "TEMP",
    // Corporate egress: proxy + CA trust. git/npm/az genuinely need these, and
    // the container sets NODE_TLS_REJECT_UNAUTHORIZED=0 for the intercepting
    // proxy. None of these are secrets.
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
    // az config dir (a path, not a credential). Explicitly kept even though it
    // starts with AZURE_ — see AGENT_ENV_ALLOW_EXCEPTIONS below.
    "AZURE_CONFIG_DIR",
    // Windows platform basics needed by Git Bash / node.
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE",
    "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
    "NUMBER_OF_PROCESSORS", "COMPUTERNAME",
  ].map((k) => k.toLowerCase()),
);

// Prefix families that are always allowed (locale sub-vars: LC_ALL, LC_CTYPE, …
// and the lowercase proxy variants http_proxy/https_proxy/no_proxy/all_proxy).
// git_config_* carries VCA's TLS posture (http.sslVerify etc.) into the agent's
// git — non-secret config VCA sets when the admin disables TLS verification; see
// tls-config.ts.
const AGENT_ENV_ALLOW_PREFIXES = ["lc_", "git_config_"];

// Allow-list entries that deliberately overlap a deny pattern (known non-secret
// despite the family prefix). Anything else that collides is a mistake.
const AGENT_ENV_ALLOW_EXCEPTIONS = new Set<string>(["azure_config_dir"]);

// Fail-fast drift guard: if a future edit adds a genuinely secret-shaped var to
// the allow-list, refuse to load rather than silently leak it.
for (const key of AGENT_ENV_ALLOW) {
  if (AGENT_ENV_ALLOW_EXCEPTIONS.has(key)) continue;
  const upper = key.toUpperCase();
  const collides =
    VCA_INTERNAL_ENV_NAMES.has(upper) ||
    VCA_INTERNAL_ENV_PREFIXES.some((p) => upper.startsWith(p));
  if (collides) {
    throw new Error(
      `env-sanitize: agent env allow-list entry "${key}" collides with an ` +
        `internal-secret pattern; remove it or add to AGENT_ENV_ALLOW_EXCEPTIONS ` +
        `if it is provably non-secret.`,
    );
  }
}

function isAgentEnvAllowed(key: string): boolean {
  const kl = key.toLowerCase();
  return AGENT_ENV_ALLOW.has(kl) || AGENT_ENV_ALLOW_PREFIXES.some((p) => kl.startsWith(p));
}

/**
 * Allow-list scrub for the agent's bash tool. Returns a fresh env containing
 * only the curated non-secret vars above; every other var (all provider keys,
 * PATs, Entra secrets) is dropped. `source` is pi's shell env, whose PATH is
 * already prepended with the bundled-runtime bin dir — we pass it through as-is.
 */
export function buildSanitizedAgentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (isAgentEnvAllowed(k)) out[k] = v;
  }
  return out;
}
