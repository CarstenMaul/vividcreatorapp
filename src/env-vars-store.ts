import fs from "fs/promises";
import { atomicWriteJson } from "./fs-utils.js";
import { adminPaths } from "./paths.js";
import { UNCHANGED_SECRET_SENTINEL } from "./auth-config.js";
import { encryptSecret, decryptSecret } from "./secret-crypto.js";

/**
 * Admin-defined platform environment variables, persisted at
 * admin/env-vars.json. Non-secret values are stored plaintext; secret values
 * are stored only as AES-256-GCM ciphertext (`enc`) — see src/secret-crypto.ts.
 *
 * These vars are injected into (1) the VCA server's process.env, (2) the
 * per-project preview process, and (3) deployed apps. They are deliberately
 * NOT fed to the embedded agent's shell (that keeps its own allow-list).
 *
 * Mutation is admin-only (gated at the route layer). The redacted client view
 * uses the UNCHANGED_SECRET_SENTINEL so a secret can round-trip on save without
 * the browser ever seeing the plaintext.
 */

export interface StoredEnvVar {
  key: string;
  secret: boolean;
  value?: string; // present for non-secret
  enc?: string; // present for secret (ciphertext)
}

interface EnvVarsFile {
  vars: StoredEnvVar[];
  updatedAt: string;
  updatedByUserId: string | null;
}

/** Client-facing view: secrets never carry a real value. */
export interface ClientEnvVar {
  key: string;
  secret: boolean;
  value: string; // plaintext for non-secret; sentinel/"" for secret
}

// Env keys VCA (or the sandbox) manages itself — admins must not override these
// via this feature or they could break the platform / re-open the sandbox.
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  "WORKSPACES_ROOT",
  "PORT",
  "PATH",
  "Path",
  "BIND_HOST",
  "APP_ACCESS_TOKEN",
  "VCA_PACKAGED",
  "VCA_PREVIEW",
  "NODE_TLS_REJECT_UNAUTHORIZED",
]);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}

/** Returns an error string if the proposed key set is invalid, else null. */
export function validateEnvKeys(vars: { key: string }[]): string | null {
  const seen = new Set<string>();
  for (const v of vars) {
    const k = (v.key || "").trim();
    if (!k) return "Every variable needs a name.";
    if (!isValidEnvKey(k)) return `Invalid variable name "${k}" (use letters, digits, underscore; not starting with a digit).`;
    if (RESERVED_ENV_KEYS.has(k)) return `"${k}" is reserved by VCA and cannot be set here.`;
    if (seen.has(k)) return `Duplicate variable name "${k}".`;
    seen.add(k);
  }
  return null;
}

let cached: EnvVarsFile = { vars: [], updatedAt: "", updatedByUserId: null };
let cachedMtimeMs = 0;
let writeMutex: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeMutex.then(fn, fn);
  writeMutex = next.catch(() => undefined);
  return next;
}

function coerce(raw: unknown): EnvVarsFile {
  if (!raw || typeof raw !== "object") return { vars: [], updatedAt: "", updatedByUserId: null };
  const r = raw as Record<string, unknown>;
  const rawVars = Array.isArray(r.vars) ? r.vars : [];
  const vars: StoredEnvVar[] = [];
  for (const item of rawVars) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === "string" ? o.key : "";
    if (!key) continue;
    const secret = o.secret === true;
    if (secret) {
      vars.push({ key, secret: true, enc: typeof o.enc === "string" ? o.enc : undefined });
    } else {
      vars.push({ key, secret: false, value: typeof o.value === "string" ? o.value : "" });
    }
  }
  return {
    vars,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    updatedByUserId: typeof r.updatedByUserId === "string" ? r.updatedByUserId : null,
  };
}

async function readFromDisk(): Promise<{ file: EnvVarsFile; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(adminPaths.envVars());
    const text = await fs.readFile(adminPaths.envVars(), "utf-8");
    return { file: coerce(JSON.parse(text)), mtimeMs: stat.mtimeMs };
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    console.warn("[env-vars] failed to read:", err);
    return null;
  }
}

/** Read fresh from disk (refreshing the cache). Use at startup. */
export async function loadEnvVars(): Promise<EnvVarsFile> {
  const result = await readFromDisk();
  cached = result ? result.file : { vars: [], updatedAt: "", updatedByUserId: null };
  cachedMtimeMs = result ? result.mtimeMs : 0;
  return cached;
}

export function getCachedEnvVars(): EnvVarsFile {
  return cached;
}

/** Client view: secret values replaced by the sentinel (set) or "" (unset). */
export function redactEnvVars(file: EnvVarsFile = cached): ClientEnvVar[] {
  return file.vars.map((v) =>
    v.secret
      ? { key: v.key, secret: true, value: v.enc ? UNCHANGED_SECRET_SENTINEL : "" }
      : { key: v.key, secret: false, value: v.value ?? "" },
  );
}

/**
 * Merge-write the full var list. For each secret whose incoming value is the
 * UNCHANGED sentinel, the stored ciphertext is preserved; a new value is
 * (re-)encrypted; "" clears it. Non-secret values are stored plaintext.
 * Vars absent from `incoming` are dropped.
 */
export async function writeEnvVars(
  incoming: ClientEnvVar[],
  actorUserId: string | null,
): Promise<EnvVarsFile> {
  return withWriteLock(async () => {
    const current = (await readFromDisk())?.file ?? { vars: [], updatedAt: "", updatedByUserId: null };
    const prevByKey = new Map(current.vars.map((v) => [v.key, v]));

    const nextVars: StoredEnvVar[] = [];
    for (const v of incoming) {
      const key = v.key.trim();
      if (v.secret) {
        const prev = prevByKey.get(key);
        if (v.value === UNCHANGED_SECRET_SENTINEL) {
          // keep whatever was stored (may be undefined if never set)
          nextVars.push({ key, secret: true, enc: prev?.secret ? prev.enc : undefined });
        } else if (v.value && v.value.length > 0) {
          nextVars.push({ key, secret: true, enc: await encryptSecret(v.value) });
        } else {
          // cleared
          nextVars.push({ key, secret: true, enc: undefined });
        }
      } else {
        nextVars.push({ key, secret: false, value: v.value ?? "" });
      }
    }

    const merged: EnvVarsFile = {
      vars: nextVars,
      updatedAt: new Date().toISOString(),
      updatedByUserId: actorUserId,
    };

    await fs.mkdir(adminPaths.dir(), { recursive: true });
    await atomicWriteJson(adminPaths.envVars(), merged, 2);
    cached = merged;
    try {
      cachedMtimeMs = (await fs.stat(adminPaths.envVars())).mtimeMs;
    } catch { /* best-effort */ }
    return merged;
  });
}

/**
 * Decrypt all vars into a plain { KEY: value } map. Secrets are decrypted here.
 * Used for server-process injection, the preview spawn env, and Electron. Never
 * sent to a client.
 */
export async function getDecryptedEnvMap(file: EnvVarsFile = cached): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of file.vars) {
    if (v.secret) {
      if (!v.enc) continue;
      try {
        out[v.key] = await decryptSecret(v.enc);
      } catch (err) {
        console.warn(`[env-vars] failed to decrypt "${v.key}" (skipping):`, err);
      }
    } else {
      out[v.key] = v.value ?? "";
    }
  }
  return out;
}

/**
 * Deployment view: plaintext non-secret values inline, plus the list of secret
 * keys (whose values are handled per-target — never dumped into git or an image
 * layer). Used by the Azure git-tag release emitter.
 */
export async function getDeployEnvSpec(
  file: EnvVarsFile = cached,
): Promise<{ plain: Record<string, string>; secrets: Record<string, string>; secretKeys: string[] }> {
  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const v of file.vars) {
    if (v.secret) {
      if (!v.enc) continue;
      try {
        secrets[v.key] = await decryptSecret(v.enc);
      } catch (err) {
        console.warn(`[env-vars] failed to decrypt "${v.key}" for deploy (skipping):`, err);
      }
    } else {
      plain[v.key] = v.value ?? "";
    }
  }
  return { plain, secrets, secretKeys: Object.keys(secrets) };
}

/**
 * Assign every non-reserved decrypted var onto the running process.env. Called
 * at startup (after loadEnvVars) and again on save so changes take effect
 * without a restart. Mirrors the shape of src/tls-config.ts.
 */
export async function applyEnvVarsToProcess(file: EnvVarsFile = cached): Promise<void> {
  const map = await getDecryptedEnvMap(file);
  let applied = 0;
  for (const [k, v] of Object.entries(map)) {
    if (RESERVED_ENV_KEYS.has(k)) continue;
    process.env[k] = v;
    applied++;
  }
  console.log(`[env-vars] Applied ${applied} admin env var(s) to process.env`);
}
