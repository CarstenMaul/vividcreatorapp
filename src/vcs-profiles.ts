import fs from "fs/promises";
import { randomUUID } from "crypto";
import { atomicWriteJson } from "./fs-utils.js";
import { adminPaths } from "./paths.js";
import { UNCHANGED_SECRET_SENTINEL } from "./auth-config.js";
import { encryptSecret, decryptSecret } from "./secret-crypto.js";
import { parseDevOpsProjectUrl } from "./devops-repo.js";

/**
 * Named global version-control profiles for Settings > Version Control. A
 * profile bundles a provider (GitHub or Azure DevOps), the host/org/project
 * coordinates, and a default credential (username + PAT/password). Projects
 * reference a profile by id and may override its credential per-project.
 *
 * Persisted at admin/vcs-profiles.json. The PAT is a write-capable SCM
 * credential, so — unlike llm-profiles' cleartext apiKey — it is stored ONLY
 * as AES-256-GCM ciphertext (`enc`, see secret-crypto.ts), mirroring env-vars.
 * The real secret is resolved (decrypted) server-side only at git-operation
 * time; the browser only ever sees the UNCHANGED_SECRET_SENTINEL.
 */

export type VcsProvider = "github" | "azure-devops";

export interface StoredVcsProfile {
  id: string;
  name: string;
  provider: VcsProvider;
  host: string;          // github.com | dev.azure.com | GHE/legacy host (normalized on save)
  organization: string;  // GitHub org/owner ("" = personal); Azure DevOps org
  project: string;       // Azure DevOps project; "" for GitHub
  username: string;      // default git username ("" = PAT-only)
  enc?: string;          // ciphertext of PAT/password (absent = no secret)
}

/** Client-facing view: the secret is never sent in plaintext. */
export interface ClientVcsProfile {
  id: string;
  name: string;
  provider: VcsProvider;
  host: string;
  organization: string;
  project: string;
  username: string;
  pat: string;           // UNCHANGED_SECRET_SENTINEL when enc set, else ""
}

interface VcsProfilesFile {
  profiles: StoredVcsProfile[];
}

const VALID_PROVIDERS: ReadonlySet<string> = new Set(["github", "azure-devops"]);

let writeMutex: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeMutex.then(fn, fn);
  writeMutex = next.catch(() => undefined);
  return next;
}

/** Extract a bare hostname from a possibly-pasted URL; normalize legacy Azure. */
function normalizeHost(raw: string, provider: VcsProvider): string {
  let host = String(raw || "").trim();
  if (!host) return "";
  if (/^https?:\/\//i.test(host) || host.includes("/")) {
    try {
      host = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`).hostname;
    } catch {
      host = host.split("/")[0];
    }
  }
  host = host.toLowerCase();
  // Legacy Azure DevOps {org}.visualstudio.com is served by dev.azure.com.
  if (provider === "azure-devops" && host.endsWith(".visualstudio.com")) return "dev.azure.com";
  return host;
}

function coerceStored(raw: unknown): StoredVcsProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const provider = r.provider === "github" || r.provider === "azure-devops" ? r.provider : null;
  if (!id || !name || !provider) return null;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
  return {
    id,
    name,
    provider,
    host: normalizeHost(str("host"), provider),
    organization: str("organization"),
    project: provider === "azure-devops" ? str("project") : "",
    username: str("username"),
    enc: typeof r.enc === "string" && r.enc ? (r.enc as string) : undefined,
  };
}

async function readFile(): Promise<VcsProfilesFile> {
  try {
    const text = await fs.readFile(adminPaths.vcsProfiles(), "utf-8");
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    const profiles = list.map(coerceStored).filter((p: StoredVcsProfile | null): p is StoredVcsProfile => p !== null);
    return { profiles };
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn("[vcs-profiles] failed to read:", err);
    return { profiles: [] };
  }
}

async function writeFile(data: VcsProfilesFile): Promise<void> {
  await fs.mkdir(adminPaths.dir(), { recursive: true });
  await atomicWriteJson(adminPaths.vcsProfiles(), data, 2);
}

// ─── redaction / client shape ──────────────────────────────────────

export function redactVcsProfile(p: StoredVcsProfile): ClientVcsProfile {
  return {
    id: p.id,
    name: p.name,
    provider: p.provider,
    host: p.host,
    organization: p.organization,
    project: p.project,
    username: p.username,
    pat: p.enc ? UNCHANGED_SECRET_SENTINEL : "",
  };
}

// ─── reads ─────────────────────────────────────────────────────────

export async function listVcsProfiles(): Promise<StoredVcsProfile[]> {
  return (await readFile()).profiles;
}

export async function getVcsProfile(id: string): Promise<StoredVcsProfile | null> {
  const { profiles } = await readFile();
  return profiles.find((p) => p.id === id) ?? null;
}

// ─── shape a client payload into stored fields (secret handled by caller) ──

type ProfileInput = Omit<ClientVcsProfile, "id">;

function shapeFields(input: Partial<ProfileInput>, provider: VcsProvider): Omit<StoredVcsProfile, "id" | "enc"> {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    name: str(input.name),
    provider,
    host: normalizeHost(str(input.host), provider),
    organization: str(input.organization),
    project: provider === "azure-devops" ? str(input.project) : "",
    username: str(input.username),
  };
}

async function encForPat(pat: unknown, previous?: string): Promise<string | undefined> {
  // Sentinel → keep prior ciphertext; non-empty → encrypt; "" → clear.
  if (pat === UNCHANGED_SECRET_SENTINEL) return previous;
  if (typeof pat === "string" && pat.length > 0) return encryptSecret(pat);
  return undefined;
}

// ─── mutations ─────────────────────────────────────────────────────

export async function createVcsProfile(input: ProfileInput): Promise<ClientVcsProfile[]> {
  const provider: VcsProvider = input.provider === "github" || input.provider === "azure-devops" ? input.provider : "github";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("Profile name is required");
  if (name.length > 64) throw new Error("Profile name must be 64 characters or fewer");
  // No fallback source for a new profile — a sentinel resolves to empty.
  const pat = input.pat === UNCHANGED_SECRET_SENTINEL ? "" : input.pat;
  const enc = await encForPat(pat);
  const profile: StoredVcsProfile = { id: randomUUID(), ...shapeFields(input, provider), enc };
  return withWriteLock(async () => {
    const data = await readFile();
    data.profiles.push(profile);
    await writeFile(data);
    return data.profiles.map(redactVcsProfile);
  });
}

export async function updateVcsProfile(id: string, updates: Partial<ProfileInput>): Promise<ClientVcsProfile[]> {
  return withWriteLock(async () => {
    const data = await readFile();
    const existing = data.profiles.find((p) => p.id === id);
    if (!existing) throw new Error("Profile not found");
    const provider: VcsProvider =
      updates.provider === "github" || updates.provider === "azure-devops" ? updates.provider : existing.provider;
    const shaped = shapeFields({ ...redactVcsProfile(existing), ...updates }, provider);
    if (!shaped.name) throw new Error("Profile name is required");
    const enc = await encForPat(updates.pat === undefined ? UNCHANGED_SECRET_SENTINEL : updates.pat, existing.enc);
    const merged: StoredVcsProfile = { id, ...shaped, enc };
    const idx = data.profiles.findIndex((p) => p.id === id);
    data.profiles[idx] = merged;
    await writeFile(data);
    return data.profiles.map(redactVcsProfile);
  });
}

export async function deleteVcsProfile(id: string): Promise<ClientVcsProfile[]> {
  return withWriteLock(async () => {
    const data = await readFile();
    const next = data.profiles.filter((p) => p.id !== id);
    if (next.length === data.profiles.length) throw new Error("Profile not found");
    data.profiles = next;
    await writeFile(data);
    return data.profiles.map(redactVcsProfile);
  });
}

/**
 * Wholesale replacement (encrypted config-file import). Each incoming profile
 * carries a plaintext `pat` (decrypted inside the transfer envelope); it is
 * re-encrypted here under this instance's own key.
 */
export async function replaceVcsProfiles(input: { profiles: unknown[] }): Promise<ClientVcsProfile[]> {
  const incoming = Array.isArray(input.profiles) ? input.profiles : [];
  const shaped: StoredVcsProfile[] = [];
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const provider = r.provider === "github" || r.provider === "azure-devops" ? (r.provider as VcsProvider) : null;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!provider || !name) continue;
    const pat = typeof r.pat === "string" ? r.pat : "";
    shaped.push({
      id: typeof r.id === "string" && r.id ? r.id : randomUUID(),
      ...shapeFields(r as Partial<ProfileInput>, provider),
      enc: pat ? await encryptSecret(pat) : undefined,
    });
  }
  return withWriteLock(async () => {
    await writeFile({ profiles: shaped });
    return shaped.map(redactVcsProfile);
  });
}

/**
 * Config-transfer export: decrypt every profile's secret to plaintext `pat`.
 * The result lands only inside the scrypt-encrypted transfer envelope.
 */
export async function collectVcsProfilesDecrypted(): Promise<{ profiles: ClientVcsProfile[] }> {
  const { profiles } = await readFile();
  const out: ClientVcsProfile[] = [];
  for (const p of profiles) {
    let pat = "";
    if (p.enc) {
      try {
        pat = await decryptSecret(p.enc);
      } catch (err) {
        console.warn(`[vcs-profiles] failed to decrypt secret for "${p.name}" (exporting without it):`, err);
      }
    }
    out.push({ ...redactVcsProfile(p), pat });
  }
  return { profiles: out };
}

// ─── one-time migration from legacy vca-settings devops fields ─────

/**
 * On first boot after the VCS-profiles refactor, migrate the legacy global
 * Azure DevOps config (devopsProjectUrl + devopsPat in vca-settings.json) into
 * a "Migrated" profile, then strip the plaintext PAT from vca-settings.json.
 * Guarded to run only once (absence of vcs-profiles.json). Best-effort — any
 * failure is logged and ignored (existing project origins keep working, since
 * their credentials already live in .git/config).
 */
export async function migrateLegacyDevopsSettings(): Promise<void> {
  try {
    await fs.access(adminPaths.vcsProfiles());
    return; // profiles already exist — migration already ran (or not needed)
  } catch { /* no profiles file yet — proceed */ }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(adminPaths.vcaSettings(), "utf-8"));
  } catch {
    return; // no settings file — nothing to migrate
  }
  const devopsProjectUrl = typeof raw.devopsProjectUrl === "string" ? raw.devopsProjectUrl.trim() : "";
  const devopsPat = typeof raw.devopsPat === "string" ? raw.devopsPat : "";
  const hadLegacy = devopsProjectUrl !== "" || devopsPat !== "" || "autoCreateRemote" in raw;
  if (!hadLegacy) return;

  if (devopsProjectUrl) {
    try {
      const { host, org, project } = parseDevOpsProjectUrl(devopsProjectUrl);
      await createVcsProfile({
        name: "Migrated (Azure DevOps)",
        provider: "azure-devops",
        host,
        organization: org,
        project,
        username: "",
        pat: devopsPat,
      });
      console.log("[vcs-profiles] migrated legacy Azure DevOps settings into a profile");
    } catch (err) {
      console.warn("[vcs-profiles] legacy DevOps migration skipped (unparseable URL):", err);
    }
  }

  // Strip the now-dead (and plaintext-secret-bearing) legacy keys from disk.
  delete raw.devopsPat;
  delete raw.devopsProjectUrl;
  delete raw.autoCreateRemote;
  try {
    await atomicWriteJson(adminPaths.vcaSettings(), raw, 2);
  } catch (err) {
    console.warn("[vcs-profiles] failed to strip legacy devops keys from vca-settings.json:", err);
  }
}

// ─── server-side credential resolution (git-op time) ───────────────

export interface ResolvedVcsCredentials {
  provider: VcsProvider;
  host: string;
  organization: string;
  project: string;
  username: string;
  secret: string;
}

export async function resolveProfileCredentials(
  profileId: string,
  override?: { username?: string; enc?: string } | null,
): Promise<ResolvedVcsCredentials | null> {
  if (!profileId) return null;
  const profile = await getVcsProfile(profileId);
  if (!profile) return null;

  let secret = "";
  if (profile.enc) {
    try { secret = await decryptSecret(profile.enc); } catch { secret = ""; }
  }
  let username = profile.username;

  if (override) {
    if (override.enc) {
      try { secret = await decryptSecret(override.enc); } catch { /* keep profile secret */ }
    }
    if (typeof override.username === "string" && override.username.trim()) {
      username = override.username.trim();
    }
  }

  return {
    provider: profile.provider,
    host: profile.host,
    organization: profile.organization,
    project: profile.project,
    username,
    secret,
  };
}
