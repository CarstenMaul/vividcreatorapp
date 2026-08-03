import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { atomicWriteJson } from "./fs-utils.js";
import { adminPaths, userPaths, listUserDirs, RESERVED_DIRS } from "./paths.js";
import { hashPassword, verifyPassword, verifyAgainstDummy, validatePassword } from "./passwords.js";

export type AuthType = "local" | "entra";

export interface UserRecord {
  userId: string;
  authType: AuthType;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  passwordHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  userId: string;
  authType: AuthType;
  username: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

interface ErrorWithCode extends Error {
  code: string;
}

function err(code: string, message: string): ErrorWithCode {
  const e = new Error(message) as ErrorWithCode;
  e.code = code;
  return e;
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let writeMutex: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeMutex.then(fn, fn);
  writeMutex = next.catch(() => undefined);
  return next;
}

// ─── on-disk shape + backfill ──────────────────────────────────────

function computeDisplayName(r: { firstName: string; lastName: string; username: string; email: string }): string {
  const composed = `${r.firstName || ""} ${r.lastName || ""}`.trim();
  if (composed) return composed;
  if (r.username) return r.username;
  return r.email || "";
}

function toPublic(r: UserRecord): PublicUser {
  return {
    userId: r.userId,
    authType: r.authType,
    username: r.username,
    firstName: r.firstName,
    lastName: r.lastName,
    displayName: computeDisplayName(r),
    email: r.email,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function backfill(raw: any, userIdFromPath: string): UserRecord {
  const authType: AuthType = raw?.authType === "local" ? "local" : "entra";
  const legacyDisplayName = typeof raw?.displayName === "string" ? raw.displayName.trim() : "";
  const [firstLegacy = "", ...rest] = legacyDisplayName ? legacyDisplayName.split(/\s+/) : [];
  const lastLegacy = rest.join(" ");
  const email = typeof raw?.email === "string" ? raw.email : "";
  const updatedAt = typeof raw?.updatedAt === "string" ? raw.updatedAt : new Date().toISOString();
  return {
    userId: typeof raw?.userId === "string" && raw.userId ? raw.userId : userIdFromPath,
    authType,
    username: typeof raw?.username === "string" && raw.username ? raw.username : (email || userIdFromPath),
    firstName: typeof raw?.firstName === "string" ? raw.firstName : firstLegacy,
    lastName: typeof raw?.lastName === "string" ? raw.lastName : lastLegacy,
    email,
    passwordHash: typeof raw?.passwordHash === "string" && raw.passwordHash ? raw.passwordHash : undefined,
    createdAt: typeof raw?.createdAt === "string" && raw.createdAt ? raw.createdAt : updatedAt,
    updatedAt,
  };
}

async function writeUserFile(record: UserRecord): Promise<void> {
  await fs.mkdir(userPaths.dir(record.userId), { recursive: true });
  await atomicWriteJson(userPaths.profile(record.userId), record, 2);
}

// ─── username index ────────────────────────────────────────────────

interface UsernameIndex {
  byUsername: Record<string, string>;
  updatedAt: string;
}

let cachedIndex: UsernameIndex | null = null;
let cachedIndexMtimeMs = 0;

async function loadIndexFromDisk(): Promise<UsernameIndex> {
  const filePath = adminPaths.usersIndex();
  try {
    const stat = await fs.stat(filePath);
    if (cachedIndex != null && stat.mtimeMs === cachedIndexMtimeMs) return cachedIndex;
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<UsernameIndex>;
    const idx: UsernameIndex = {
      byUsername: parsed?.byUsername && typeof parsed.byUsername === "object" ? parsed.byUsername as Record<string, string> : {},
      updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
    cachedIndex = idx;
    cachedIndexMtimeMs = stat.mtimeMs;
    return idx;
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      cachedIndex = { byUsername: {}, updatedAt: new Date().toISOString() };
      cachedIndexMtimeMs = 0;
      return cachedIndex;
    }
    throw e;
  }
}

async function writeIndexToDisk(idx: UsernameIndex): Promise<void> {
  const filePath = adminPaths.usersIndex();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, idx, 2);
  cachedIndex = idx;
  try {
    const stat = await fs.stat(filePath);
    cachedIndexMtimeMs = stat.mtimeMs;
  } catch {
    cachedIndexMtimeMs = Date.now();
  }
}

async function rebuildIndex(): Promise<UsernameIndex> {
  const users = await listUsersInternal();
  const byUsername: Record<string, string> = {};
  for (const u of users) {
    if (u.username) byUsername[u.username.toLowerCase()] = u.userId;
  }
  const idx: UsernameIndex = { byUsername, updatedAt: new Date().toISOString() };
  await writeIndexToDisk(idx);
  return idx;
}

// ─── read API ──────────────────────────────────────────────────────

export async function loadUser(userId: string): Promise<UserRecord | null> {
  if (!userId) return null;
  try {
    const data = await fs.readFile(userPaths.profile(userId), "utf-8");
    const raw = JSON.parse(data);
    return backfill(raw, userId);
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    return null;
  }
}

export async function loadPublicUser(userId: string): Promise<PublicUser | null> {
  const r = await loadUser(userId);
  return r ? toPublic(r) : null;
}

async function listUsersInternal(): Promise<UserRecord[]> {
  const ids = await listUserDirs();
  const records: UserRecord[] = [];
  for (const id of ids) {
    const r = await loadUser(id);
    if (r) records.push(r);
  }
  return records;
}

export async function listUsers(): Promise<PublicUser[]> {
  const records = await listUsersInternal();
  return records
    .map(toPublic)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  if (!username || typeof username !== "string") return null;
  const key = username.toLowerCase();
  let idx = await loadIndexFromDisk();
  let userId = idx.byUsername[key];

  // Fallback: index may not have been built yet on a fresh deploy. Rebuild
  // it from a full scan, then re-check.
  if (!userId) {
    idx = await rebuildIndex();
    userId = idx.byUsername[key];
    if (!userId) return null;
  }

  const record = await loadUser(userId);
  // Stale index entry — the userId no longer exists on disk, or its current
  // username changed. Rebuild and recheck once.
  if (!record || record.username.toLowerCase() !== key) {
    idx = await rebuildIndex();
    userId = idx.byUsername[key];
    if (!userId) return null;
    return loadUser(userId);
  }
  return record;
}

export async function getUserHasProjects(userId: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(userPaths.projects(userId), "utf-8");
    const parsed = JSON.parse(raw) as { projects?: unknown[] };
    return Array.isArray(parsed?.projects) && parsed.projects.length > 0;
  } catch {
    return false;
  }
}

export async function hasAnyUsers(): Promise<boolean> {
  const ids = await listUserDirs();
  for (const id of ids) {
    const r = await loadUser(id);
    if (r) return true;
  }
  return false;
}

export async function countLocalAdmins(isAdminUser: (userId: string) => Promise<boolean>): Promise<number> {
  const records = await listUsersInternal();
  let count = 0;
  for (const r of records) {
    if (r.authType !== "local") continue;
    if (await isAdminUser(r.userId)) count++;
  }
  return count;
}

// ─── validation ────────────────────────────────────────────────────

function validateUsername(raw: unknown): string {
  if (typeof raw !== "string") throw err("INVALID_USERNAME", "username must be a string");
  const trimmed = raw.trim();
  if (!USERNAME_RE.test(trimmed)) {
    throw err("INVALID_USERNAME", "username must be 2–64 chars, letters/digits/._-");
  }
  return trimmed;
}

function validateNamePart(raw: unknown, field: string): string {
  if (raw == null) return "";
  if (typeof raw !== "string") throw err(`INVALID_${field.toUpperCase()}`, `${field} must be a string`);
  const trimmed = raw.trim();
  if (trimmed.length > 100) throw err(`INVALID_${field.toUpperCase()}`, `${field} must be at most 100 characters`);
  return trimmed;
}

function validateEmail(raw: unknown, required: boolean): string {
  if (raw == null || raw === "") {
    if (required) throw err("INVALID_EMAIL", "email is required");
    return "";
  }
  if (typeof raw !== "string") throw err("INVALID_EMAIL", "email must be a string");
  const trimmed = raw.trim();
  if (!EMAIL_RE.test(trimmed)) throw err("INVALID_EMAIL", "email is not a valid address");
  return trimmed;
}

// ─── mutating API ──────────────────────────────────────────────────

export interface CreateLocalUserInput {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export async function createLocalUser(input: CreateLocalUserInput): Promise<PublicUser> {
  const username = validateUsername(input.username);
  const firstName = validateNamePart(input.firstName, "firstName");
  const lastName = validateNamePart(input.lastName, "lastName");
  const email = validateEmail(input.email, false);
  validatePassword(input.password);

  return withWriteLock(async () => {
    const idx = await loadIndexFromDisk();
    if (idx.byUsername[username.toLowerCase()]) {
      throw err("DUPLICATE_USERNAME", `Username "${username}" already exists`);
    }
    const userId = randomUUID();
    const nowIso = new Date().toISOString();
    const passwordHash = await hashPassword(input.password);
    const record: UserRecord = {
      userId,
      authType: "local",
      username,
      firstName,
      lastName,
      email,
      passwordHash,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await writeUserFile(record);
    await writeIndexToDisk({
      byUsername: { ...idx.byUsername, [username.toLowerCase()]: userId },
      updatedAt: nowIso,
    });
    return toPublic(record);
  });
}

export interface CreateEntraUserInput {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
}

// Used by the admin "create Entra user" path AND by auth.ts on first login
// to auto-provision a record. Idempotent: if the userId already exists, the
// stored record's fields are updated where they were empty (Graph wins on
// blanks; we don't blow away admin-edited values).
export async function createEntraUser(input: CreateEntraUserInput): Promise<PublicUser> {
  if (typeof input.userId !== "string" || !input.userId.trim()) {
    throw err("INVALID_USER_ID", "userId (Entra OID) is required");
  }
  const userId = input.userId.trim();
  const username = validateUsername(input.username);
  const firstName = validateNamePart(input.firstName, "firstName");
  const lastName = validateNamePart(input.lastName, "lastName");
  const email = validateEmail(input.email, false);

  return withWriteLock(async () => {
    const idx = await loadIndexFromDisk();
    const existing = await loadUser(userId);
    const nowIso = new Date().toISOString();

    // Username uniqueness: only check when the username actually changes
    // (or the user is new).
    const newKey = username.toLowerCase();
    if (idx.byUsername[newKey] && idx.byUsername[newKey] !== userId) {
      throw err("DUPLICATE_USERNAME", `Username "${username}" already exists`);
    }

    if (existing) {
      const record: UserRecord = {
        ...existing,
        authType: "entra",
        username,
        firstName: existing.firstName || firstName,
        lastName: existing.lastName || lastName,
        email: existing.email || email,
        updatedAt: nowIso,
      };
      await writeUserFile(record);
      if (existing.username.toLowerCase() !== newKey) {
        const nextIndex = { ...idx.byUsername };
        delete nextIndex[existing.username.toLowerCase()];
        nextIndex[newKey] = userId;
        await writeIndexToDisk({ byUsername: nextIndex, updatedAt: nowIso });
      } else if (!idx.byUsername[newKey]) {
        await writeIndexToDisk({ byUsername: { ...idx.byUsername, [newKey]: userId }, updatedAt: nowIso });
      }
      return toPublic(record);
    }

    const record: UserRecord = {
      userId,
      authType: "entra",
      username,
      firstName,
      lastName,
      email,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await writeUserFile(record);
    await writeIndexToDisk({
      byUsername: { ...idx.byUsername, [newKey]: userId },
      updatedAt: nowIso,
    });
    return toPublic(record);
  });
}

export interface ProvisionDesktopUserInput {
  userId: string;
  username: string;
}

// Used by the Electron main process on boot to materialize a record for the
// current OS desktop session. Writes `authType: "local"` with no
// passwordHash — the session is minted directly by the main process so the
// password flow never runs. Idempotent: re-running with the same userId
// only fills empty fields. Never reached by the container/web entrypoint.
export async function provisionDesktopUser(input: ProvisionDesktopUserInput): Promise<PublicUser> {
  if (typeof input.userId !== "string" || !input.userId.trim()) {
    throw err("INVALID_USER_ID", "userId is required");
  }
  const userId = input.userId.trim();
  const username = validateUsername(input.username);

  return withWriteLock(async () => {
    const idx = await loadIndexFromDisk();
    const existing = await loadUser(userId);
    const nowIso = new Date().toISOString();

    const newKey = username.toLowerCase();
    if (idx.byUsername[newKey] && idx.byUsername[newKey] !== userId) {
      throw err("DUPLICATE_USERNAME", `Username "${username}" already exists`);
    }

    if (existing) {
      const record: UserRecord = {
        ...existing,
        authType: "local",
        username,
        updatedAt: nowIso,
      };
      await writeUserFile(record);
      if (existing.username.toLowerCase() !== newKey) {
        const nextIndex = { ...idx.byUsername };
        delete nextIndex[existing.username.toLowerCase()];
        nextIndex[newKey] = userId;
        await writeIndexToDisk({ byUsername: nextIndex, updatedAt: nowIso });
      } else if (!idx.byUsername[newKey]) {
        await writeIndexToDisk({ byUsername: { ...idx.byUsername, [newKey]: userId }, updatedAt: nowIso });
      }
      return toPublic(record);
    }

    const record: UserRecord = {
      userId,
      authType: "local",
      username,
      firstName: "",
      lastName: "",
      email: "",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await writeUserFile(record);
    await writeIndexToDisk({
      byUsername: { ...idx.byUsername, [newKey]: userId },
      updatedAt: nowIso,
    });
    return toPublic(record);
  });
}

export interface UpdateUserInput {
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export async function updateUser(userId: string, patch: UpdateUserInput): Promise<PublicUser> {
  return withWriteLock(async () => {
    const existing = await loadUser(userId);
    if (!existing) throw err("NOT_FOUND", `No user with id ${userId}`);

    const next: UserRecord = { ...existing };
    let usernameChanged = false;
    const idx = await loadIndexFromDisk();

    if (patch.username !== undefined) {
      const username = validateUsername(patch.username);
      const newKey = username.toLowerCase();
      const oldKey = existing.username.toLowerCase();
      if (newKey !== oldKey) {
        if (idx.byUsername[newKey] && idx.byUsername[newKey] !== userId) {
          throw err("DUPLICATE_USERNAME", `Username "${username}" already exists`);
        }
        usernameChanged = true;
      }
      next.username = username;
    }
    if (patch.firstName !== undefined) next.firstName = validateNamePart(patch.firstName, "firstName");
    if (patch.lastName !== undefined) next.lastName = validateNamePart(patch.lastName, "lastName");
    if (patch.email !== undefined) next.email = validateEmail(patch.email, false);

    next.updatedAt = new Date().toISOString();
    await writeUserFile(next);

    if (usernameChanged) {
      const byUsername = { ...idx.byUsername };
      delete byUsername[existing.username.toLowerCase()];
      byUsername[next.username.toLowerCase()] = userId;
      await writeIndexToDisk({ byUsername, updatedAt: next.updatedAt });
    } else if (!idx.byUsername[existing.username.toLowerCase()]) {
      // self-heal a missing entry without changing the username
      await writeIndexToDisk({
        byUsername: { ...idx.byUsername, [existing.username.toLowerCase()]: userId },
        updatedAt: next.updatedAt,
      });
    }
    return toPublic(next);
  });
}

export async function setLocalPassword(userId: string, newPassword: string): Promise<void> {
  validatePassword(newPassword);
  return withWriteLock(async () => {
    const existing = await loadUser(userId);
    if (!existing) throw err("NOT_FOUND", `No user with id ${userId}`);
    if (existing.authType !== "local") throw err("NOT_LOCAL_USER", "Only local users have a password");
    const passwordHash = await hashPassword(newPassword);
    const next: UserRecord = { ...existing, passwordHash, updatedAt: new Date().toISOString() };
    await writeUserFile(next);
  });
}

export async function deleteUser(userId: string): Promise<void> {
  return withWriteLock(async () => {
    const existing = await loadUser(userId);
    if (!existing) throw err("NOT_FOUND", `No user with id ${userId}`);
    try {
      await fs.unlink(userPaths.profile(userId));
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
    const idx = await loadIndexFromDisk();
    const key = existing.username.toLowerCase();
    if (idx.byUsername[key] === userId) {
      const byUsername = { ...idx.byUsername };
      delete byUsername[key];
      await writeIndexToDisk({ byUsername, updatedAt: new Date().toISOString() });
    }
  });
}

// ─── bulk export/import (encrypted config transfer) ────────────────

/** All user records incl. passwordHash — for the encrypted config export. */
export async function listAllUserRecords(): Promise<UserRecord[]> {
  return listUsersInternal();
}

function coerceImportedUser(raw: unknown): UserRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const userId = typeof r.userId === "string" ? r.userId.trim() : "";
  if (!userId) return null;
  // userId is the on-disk workspace directory name — reject anything that
  // could escape the user's own folder or collide with a reserved dir.
  if (
    RESERVED_DIRS.has(userId) ||
    userId.startsWith(".") ||
    userId.includes("/") ||
    userId.includes("\\") ||
    userId.includes("..") ||
    userId.includes("\0")
  ) {
    return null;
  }
  return backfill(r, userId);
}

/**
 * Upsert user records from an encrypted config import. Adds new users and
 * overwrites matching userIds (preserving each userId and bcrypt passwordHash);
 * it never deletes existing users, so the importing admin's own account and
 * everyone's projects survive. The username index is rebuilt from disk after.
 */
export async function importUserRecords(records: unknown[]): Promise<{ imported: number; skipped: number }> {
  return withWriteLock(async () => {
    let imported = 0;
    let skipped = 0;
    for (const raw of Array.isArray(records) ? records : []) {
      const rec = coerceImportedUser(raw);
      if (!rec) {
        skipped++;
        continue;
      }
      await writeUserFile(rec);
      imported++;
    }
    await rebuildIndex();
    return { imported, skipped };
  });
}

// ─── login helpers ─────────────────────────────────────────────────

export async function verifyLocalLogin(username: string, password: string): Promise<UserRecord | null> {
  const record = await findUserByUsername(username);
  if (!record || record.authType !== "local" || !record.passwordHash) {
    // Burn the cost so timing matches the real verify branch.
    await verifyAgainstDummy(password);
    return null;
  }
  const ok = await verifyPassword(password, record.passwordHash);
  return ok ? record : null;
}

// Re-export for callers that want to keep all user-related concerns in one
// import.
export { hashPassword, verifyPassword };
