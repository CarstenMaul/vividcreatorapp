import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import fs from "fs/promises";
import { adminPaths } from "./paths.js";

/**
 * AES-256-GCM encryption for admin env-var secret values — VCA's first
 * encryption-at-rest. Ciphertext is stored in admin/env-vars.json; the master
 * key is kept separately.
 *
 * Master key resolution (see getMasterKey):
 *   1. process.env.VCA_SECRETS_KEY — an operator-provided 32-byte key (hex or
 *      base64). Strongest: the key never touches disk. Use e.g. a Container App
 *      secret in production.
 *   2. Otherwise auto-generate a 32-byte key on first use and persist it to
 *      admin/.env-secrets-key (0600, dot-prefixed, never returned by any route,
 *      outside the agent's confined file-tool scope).
 *
 * Honest threat model: the auto-generated key lives on the same persistent
 * volume as the ciphertext, so encryption protects secret VALUES against
 * app-surface leakage (API responses, logs, partial file exposure, the
 * sandboxed agent file-tools) — but NOT full-volume compromise. For that,
 * provide VCA_SECRETS_KEY from a store the volume snapshot doesn't contain.
 */

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function parseProvidedKey(raw: string): Buffer | null {
  const s = raw.trim();
  // hex (64 chars) or base64 — must decode to exactly 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s, "base64");
    if (b.length === KEY_BYTES) return b;
  } catch { /* not base64 */ }
  return null;
}

/**
 * Resolve (or lazily create) the master key. Cached after first call.
 */
export async function getMasterKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const provided = process.env.VCA_SECRETS_KEY;
  if (provided) {
    const key = parseProvidedKey(provided);
    if (!key) {
      throw new Error(
        "VCA_SECRETS_KEY is set but is not a 32-byte key (expected 64 hex chars or base64 of 32 bytes).",
      );
    }
    cachedKey = key;
    console.log("[secret-crypto] Using operator-provided master key (VCA_SECRETS_KEY).");
    return key;
  }

  const keyPath = adminPaths.envSecretsKey();
  try {
    const existing = await fs.readFile(keyPath);
    // Stored base64; tolerate trailing newline/whitespace.
    const key = Buffer.from(existing.toString("utf-8").trim(), "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(`master key at ${keyPath} is ${key.length} bytes, expected ${KEY_BYTES}`);
    }
    cachedKey = key;
    return key;
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }

  // First use: generate and persist. mode 0600 so only the owner can read it.
  const key = randomBytes(KEY_BYTES);
  await fs.mkdir(adminPaths.dir(), { recursive: true });
  await fs.writeFile(keyPath, key.toString("base64") + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    await fs.chmod(keyPath, 0o600);
  } catch { /* chmod may be a no-op on some filesystems (e.g. Azure Files SMB) */ }
  cachedKey = key;
  console.log("[secret-crypto] Generated a new master key for env-var secrets.");
  return key;
}

function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function decryptWithKey(key: Buffer, blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error("ciphertext too short to be valid");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
}

/** Encrypt a plaintext secret → base64(iv | authTag | ciphertext). */
export async function encryptSecret(plaintext: string): Promise<string> {
  return encryptWithKey(await getMasterKey(), plaintext);
}

/** Decrypt a base64(iv | authTag | ciphertext) blob back to plaintext. */
export async function decryptSecret(blob: string): Promise<string> {
  return decryptWithKey(await getMasterKey(), blob);
}

/**
 * Sync variants for callers on synchronous read/write paths (the codex-auth
 * credential store). Require getMasterKey() to have been awaited once.
 */
export function isMasterKeyLoaded(): boolean {
  return cachedKey !== null;
}

function requireCachedKey(): Buffer {
  if (!cachedKey) {
    throw new Error("secret-crypto master key not loaded — await getMasterKey() first");
  }
  return cachedKey;
}

export function encryptSecretSync(plaintext: string): string {
  return encryptWithKey(requireCachedKey(), plaintext);
}

export function decryptSecretSync(blob: string): string {
  return decryptWithKey(requireCachedKey(), blob);
}
