import fs from "fs/promises";
import path from "path";
import { atomicWriteJson } from "./fs-utils.js";
import { rewriteMemberUserId } from "./vca-groups.js";
import { userPaths, listUserDirs } from "./paths.js";

interface UserProfileFile {
  userId?: string;
  displayName?: string;
  email?: string;
  updatedAt?: string;
}

interface ProjectEntry {
  id: string;
  name?: string;
  sourceUserId?: string;
  [key: string]: unknown;
}

type LinksFile = Record<string, Array<{ userId: string; linkedAt: string }>>;

export interface IdentityMigrationResult {
  legacyUserId: string;
  newUserId: string;
  folderRenamed: boolean;
  projectsJsonUpdates: number;
  linksJsonUpdates: number;
  symlinksRewritten: number;
  groupMembersRewritten: number;
}

// Identify the legacy userId for an Entra login. Cookie wins; otherwise scan
// user.json files for an email match (case-insensitive). Returns null when no
// candidate exists or it points to the same Entra OID (idempotent re-run).
export async function findLegacyUserId(
  cookieUid: string | undefined,
  entraUserId: string,
  entraEmail: string,
): Promise<string | null> {
  if (cookieUid && cookieUid !== entraUserId) {
    if (await userDirExists(cookieUid)) return cookieUid;
  }
  if (entraEmail) {
    const match = await findLegacyUserIdByEmail(entraEmail);
    if (match && match !== entraUserId) return match;
  }
  return null;
}

async function userDirExists(userId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(userPaths.dir(userId));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function findLegacyUserIdByEmail(email: string): Promise<string | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  for (const name of await listUserDirs()) {
    try {
      const raw = await fs.readFile(userPaths.profile(name), "utf-8");
      const data = JSON.parse(raw) as UserProfileFile;
      if (typeof data.email === "string" && data.email.trim().toLowerCase() === wanted) {
        return name;
      }
    } catch {
      // skip non-readable / non-JSON dirs
    }
  }
  return null;
}

// Run the migration end-to-end. Throws if any step fails; the OAuth callback
// should treat that as a hard login failure rather than completing the session
// under the Entra OID with half-migrated data.
export async function migrateLegacyUser(
  legacyUserId: string,
  newUserId: string,
  newDisplayName: string,
  newEmail: string,
): Promise<IdentityMigrationResult> {
  if (!legacyUserId || !newUserId || legacyUserId === newUserId) {
    throw new Error("legacyUserId and newUserId must be distinct non-empty strings");
  }

  const result: IdentityMigrationResult = {
    legacyUserId,
    newUserId,
    folderRenamed: false,
    projectsJsonUpdates: 0,
    linksJsonUpdates: 0,
    symlinksRewritten: 0,
    groupMembersRewritten: 0,
  };

  const legacyDir = userPaths.dir(legacyUserId);
  const newDir = userPaths.dir(newUserId);

  const legacyStat = await fs.stat(legacyDir).catch(() => null);
  if (!legacyStat || !legacyStat.isDirectory()) {
    throw Object.assign(new Error(`Legacy user dir ${legacyDir} not found`), { code: "LEGACY_DIR_MISSING" });
  }

  const newStat = await fs.stat(newDir).catch(() => null);
  if (newStat) {
    throw Object.assign(
      new Error(`Cannot migrate ${legacyUserId} → ${newUserId}: target ${newDir} already exists`),
      { code: "IDENTITY_MIGRATION_TARGET_EXISTS" },
    );
  }

  await fs.rename(legacyDir, newDir);
  result.folderRenamed = true;

  await rewriteOwnUserJson(newDir, newUserId, newDisplayName, newEmail);

  const { projectsJsonUpdates, linksJsonUpdates, symlinksRewritten } = await rewriteOtherUsersReferences(
    legacyUserId,
    newUserId,
  );
  result.projectsJsonUpdates = projectsJsonUpdates;
  result.linksJsonUpdates = linksJsonUpdates;
  result.symlinksRewritten = symlinksRewritten;

  const groupRewrite = await rewriteMemberUserId(legacyUserId, newUserId);
  result.groupMembersRewritten = groupRewrite.membersRewritten;

  console.log(
    `[identity-migration] ${newEmail || newUserId} migrated ${legacyUserId} → ${newUserId}: ` +
      `projects.json=${result.projectsJsonUpdates}, links.json=${result.linksJsonUpdates}, ` +
      `symlinks=${result.symlinksRewritten}, group members=${result.groupMembersRewritten}`,
  );

  return result;
}

async function rewriteOwnUserJson(newDir: string, newUserId: string, displayName: string, email: string): Promise<void> {
  const userJsonPath = path.join(newDir, "user.json");
  let existing: UserProfileFile = {};
  try {
    const raw = await fs.readFile(userJsonPath, "utf-8");
    existing = JSON.parse(raw) as UserProfileFile;
  } catch {
    // ENOENT or unreadable — start fresh
  }
  const next: UserProfileFile = {
    ...existing,
    userId: newUserId,
    displayName: displayName || existing.displayName || "",
    email: email || existing.email || "",
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(userJsonPath, next, 2);
}

async function rewriteOtherUsersReferences(
  legacyUserId: string,
  newUserId: string,
): Promise<{ projectsJsonUpdates: number; linksJsonUpdates: number; symlinksRewritten: number }> {
  let projectsJsonUpdates = 0;
  let linksJsonUpdates = 0;
  let symlinksRewritten = 0;

  for (const name of await listUserDirs()) {
    if (name === legacyUserId || name === newUserId) continue;
    const otherUserDir = userPaths.dir(name);

    const projectsTouched = await rewriteOtherUserProjectsJson(otherUserDir, legacyUserId, newUserId);
    projectsJsonUpdates += projectsTouched;

    // Sharing is metadata-only now — a userId change is fully applied by the
    // projects.json (sourceUserId) and links.json rewrites; there are no share
    // junctions to re-point. symlinksRewritten stays 0 (kept for result compat).

    const linksTouched = await rewriteOtherUserLinksJson(otherUserDir, legacyUserId, newUserId);
    linksJsonUpdates += linksTouched;
  }

  return { projectsJsonUpdates, linksJsonUpdates, symlinksRewritten };
}

async function rewriteOtherUserProjectsJson(otherUserDir: string, legacyUserId: string, newUserId: string): Promise<number> {
  const projectsPath = path.join(otherUserDir, "projects.json");
  let parsed: ProjectEntry[];
  try {
    const raw = await fs.readFile(projectsPath, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return 0;
    parsed = data as ProjectEntry[];
  } catch {
    return 0;
  }
  let changed = 0;
  for (const entry of parsed) {
    if (entry && typeof entry === "object" && entry.sourceUserId === legacyUserId) {
      entry.sourceUserId = newUserId;
      changed++;
    }
  }
  if (changed > 0) {
    await atomicWriteJson(projectsPath, parsed, 2);
  }
  return changed;
}

async function rewriteOtherUserLinksJson(otherUserDir: string, legacyUserId: string, newUserId: string): Promise<number> {
  const linksPath = path.join(otherUserDir, "links.json");
  let parsed: LinksFile;
  try {
    const raw = await fs.readFile(linksPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return 0;
    parsed = data as LinksFile;
  } catch {
    return 0;
  }
  let changed = 0;
  for (const projectId of Object.keys(parsed)) {
    const list = parsed[projectId];
    if (!Array.isArray(list)) continue;
    const nextList: typeof list = [];
    let touched = false;
    const seen = new Set<string>();
    for (const entry of list) {
      if (!entry || typeof entry !== "object" || typeof entry.userId !== "string") continue;
      const userId = entry.userId === legacyUserId ? newUserId : entry.userId;
      if (entry.userId === legacyUserId) touched = true;
      if (seen.has(userId)) {
        const dupIdx = nextList.findIndex((x) => x.userId === userId);
        if (dupIdx >= 0 && entry.linkedAt && (!nextList[dupIdx].linkedAt || entry.linkedAt < nextList[dupIdx].linkedAt)) {
          nextList[dupIdx].linkedAt = entry.linkedAt;
        }
        continue;
      }
      seen.add(userId);
      nextList.push({ userId, linkedAt: entry.linkedAt });
    }
    if (touched) {
      parsed[projectId] = nextList;
      changed++;
    }
  }
  if (changed > 0) {
    await atomicWriteJson(linksPath, parsed, 2);
  }
  return changed;
}
