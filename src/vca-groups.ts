import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { atomicWriteJson } from "./fs-utils.js";
import { listGraphGroupMembers, type NormalizedUser } from "./graph-org.js";
import { adminPaths } from "./paths.js";

export type VcaGroupKind = "admin" | "users";
export type MemberSource = "manual" | "graph";

export interface VcaGroupMember {
  userId: string;
  displayName: string;
  email: string;
  source: MemberSource;
  addedAt: string;
  addedBy: string | null;
  lastSeenInGraphAt: string | null;
}

export interface VcaGroup {
  id: string;
  kind: VcaGroupKind;
  name: string;
  description: string;
  linkedGraphGroupId: string | null;
  linkedGraphGroupName: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: "ok" | "failed" | "partial" | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
  members: VcaGroupMember[];
}

interface VcaGroupsFile {
  groups: VcaGroup[];
}

export interface VcaBootstrap {
  firstAdminPromotedAt: string | null;
  firstAdminUserId: string | null;
  createdAt: string;
}

export interface VcaGroupSummary {
  id: string;
  kind: VcaGroupKind;
  name: string;
  description: string;
  linkedGraphGroupId: string | null;
  linkedGraphGroupName: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: VcaGroup["lastSyncStatus"];
  lastSyncError: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ErrorWithCode extends Error {
  code?: string;
}

function err(code: string, message: string): ErrorWithCode {
  const e = new Error(message) as ErrorWithCode;
  e.code = code;
  return e;
}

let cachedGroups: VcaGroup[] | null = null;
let cachedGroupsMtimeMs = 0;

let cachedBootstrap: VcaBootstrap | null = null;
let cachedBootstrapMtimeMs = 0;

let writeMutex: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeMutex.then(fn, fn);
  writeMutex = next.catch(() => undefined);
  return next;
}

async function loadGroupsFromDisk(): Promise<VcaGroup[]> {
  const filePath = adminPaths.vcaGroups();
  try {
    const stat = await fs.stat(filePath);
    if (cachedGroups != null && stat.mtimeMs === cachedGroupsMtimeMs) {
      return cachedGroups;
    }
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<VcaGroupsFile>;
    const groups = Array.isArray(parsed.groups) ? parsed.groups.map(normalizeGroup) : [];
    cachedGroups = groups;
    cachedGroupsMtimeMs = stat.mtimeMs;
    return groups;
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      cachedGroups = [];
      cachedGroupsMtimeMs = 0;
      return cachedGroups;
    }
    throw e;
  }
}

function normalizeGroup(g: any): VcaGroup {
  return {
    id: typeof g?.id === "string" ? g.id : randomUUID(),
    kind: g?.kind === "admin" || g?.kind === "users" ? g.kind : "users",
    name: typeof g?.name === "string" ? g.name : "",
    description: typeof g?.description === "string" ? g.description : "",
    linkedGraphGroupId: typeof g?.linkedGraphGroupId === "string" && g.linkedGraphGroupId ? g.linkedGraphGroupId : null,
    linkedGraphGroupName: typeof g?.linkedGraphGroupName === "string" && g.linkedGraphGroupName ? g.linkedGraphGroupName : null,
    lastSyncedAt: typeof g?.lastSyncedAt === "string" ? g.lastSyncedAt : null,
    lastSyncStatus: g?.lastSyncStatus === "ok" || g?.lastSyncStatus === "failed" || g?.lastSyncStatus === "partial" ? g.lastSyncStatus : null,
    lastSyncError: typeof g?.lastSyncError === "string" ? g.lastSyncError : null,
    createdAt: typeof g?.createdAt === "string" ? g.createdAt : new Date().toISOString(),
    updatedAt: typeof g?.updatedAt === "string" ? g.updatedAt : new Date().toISOString(),
    members: Array.isArray(g?.members) ? g.members.map(normalizeMember).filter((m: VcaGroupMember | null): m is VcaGroupMember => m != null) : [],
  };
}

function normalizeMember(m: any): VcaGroupMember | null {
  if (typeof m?.userId !== "string" || !m.userId) return null;
  const source: MemberSource = m?.source === "graph" ? "graph" : "manual";
  return {
    userId: m.userId,
    displayName: typeof m?.displayName === "string" ? m.displayName : "",
    email: typeof m?.email === "string" ? m.email : "",
    source,
    addedAt: typeof m?.addedAt === "string" ? m.addedAt : new Date().toISOString(),
    addedBy: typeof m?.addedBy === "string" ? m.addedBy : null,
    lastSeenInGraphAt: typeof m?.lastSeenInGraphAt === "string" ? m.lastSeenInGraphAt : null,
  };
}

async function writeGroupsToDisk(groups: VcaGroup[]): Promise<void> {
  const filePath = adminPaths.vcaGroups();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, { groups } as VcaGroupsFile, 2);
  cachedGroups = groups;
  try {
    const stat = await fs.stat(filePath);
    cachedGroupsMtimeMs = stat.mtimeMs;
  } catch {
    cachedGroupsMtimeMs = Date.now();
  }
}

async function loadBootstrapFromDisk(): Promise<VcaBootstrap> {
  const filePath = adminPaths.vcaBootstrap();
  try {
    const stat = await fs.stat(filePath);
    if (cachedBootstrap != null && stat.mtimeMs === cachedBootstrapMtimeMs) {
      return cachedBootstrap;
    }
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<VcaBootstrap>;
    const bootstrap: VcaBootstrap = {
      firstAdminPromotedAt: typeof parsed?.firstAdminPromotedAt === "string" ? parsed.firstAdminPromotedAt : null,
      firstAdminUserId: typeof parsed?.firstAdminUserId === "string" ? parsed.firstAdminUserId : null,
      createdAt: typeof parsed?.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    };
    cachedBootstrap = bootstrap;
    cachedBootstrapMtimeMs = stat.mtimeMs;
    return bootstrap;
  } catch (e: any) {
    if (e && e.code === "ENOENT") {
      const bootstrap: VcaBootstrap = {
        firstAdminPromotedAt: null,
        firstAdminUserId: null,
        createdAt: new Date().toISOString(),
      };
      cachedBootstrap = bootstrap;
      cachedBootstrapMtimeMs = 0;
      return bootstrap;
    }
    throw e;
  }
}

async function writeBootstrapToDisk(bootstrap: VcaBootstrap): Promise<void> {
  const filePath = adminPaths.vcaBootstrap();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, bootstrap, 2);
  cachedBootstrap = bootstrap;
  try {
    const stat = await fs.stat(filePath);
    cachedBootstrapMtimeMs = stat.mtimeMs;
  } catch {
    cachedBootstrapMtimeMs = Date.now();
  }
}

function summary(g: VcaGroup): VcaGroupSummary {
  return {
    id: g.id,
    kind: g.kind,
    name: g.name,
    description: g.description,
    linkedGraphGroupId: g.linkedGraphGroupId,
    linkedGraphGroupName: g.linkedGraphGroupName,
    lastSyncedAt: g.lastSyncedAt,
    lastSyncStatus: g.lastSyncStatus,
    lastSyncError: g.lastSyncError,
    memberCount: g.members.length,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

// ─── Public reads ──────────────────────────────────────────────────

export async function listVcaGroups(): Promise<VcaGroupSummary[]> {
  const groups = await loadGroupsFromDisk();
  return groups.map(summary);
}

export async function getVcaGroup(groupId: string): Promise<VcaGroup | null> {
  const groups = await loadGroupsFromDisk();
  return groups.find((g) => g.id === groupId) ?? null;
}

/** Full groups incl. members — for the encrypted config export. */
export async function getAllVcaGroups(): Promise<VcaGroup[]> {
  return loadGroupsFromDisk();
}

/**
 * Wholesale replacement of the groups store (encrypted config-file import).
 * Every entry is normalized (ids/members/graph-links preserved). This defines
 * the deployment's entire authorization model, so callers must protect against
 * self-lockout — see ensureUserInAdminGroup.
 */
export async function replaceVcaGroups(rawGroups: unknown[]): Promise<VcaGroup[]> {
  return withWriteLock(async () => {
    const groups = (Array.isArray(rawGroups) ? rawGroups : []).map(normalizeGroup);
    await writeGroupsToDisk(groups);
    return groups;
  });
}

/**
 * Guarantee `userId` retains admin access. Called after a wholesale groups
 * import so the operator performing the import can't lock themselves out if
 * the imported admin group doesn't list them. No-op when already an admin.
 */
export async function ensureUserInAdminGroup(userId: string, displayName: string, email: string): Promise<void> {
  if (!userId) return;
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    if (groups.some((g) => g.kind === "admin" && g.members.some((m) => m.userId === userId))) return;
    const nowIso = new Date().toISOString();
    // Prefer an existing unlinked admin group; a Graph-linked one would drop a
    // manual member on its next sync, so it can't guarantee access.
    let target = groups.find((g) => g.kind === "admin" && !g.linkedGraphGroupId);
    if (!target) {
      const takenNames = new Set(groups.filter((g) => g.kind === "admin").map((g) => g.name.toLowerCase()));
      const name = takenNames.has("administrators") ? "Administrators (import)" : "Administrators";
      target = {
        id: randomUUID(),
        kind: "admin",
        name,
        description: "Created during configuration import to preserve admin access",
        linkedGraphGroupId: null,
        linkedGraphGroupName: null,
        lastSyncedAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        members: [],
      };
      groups.push(target);
    }
    target.members.push({
      userId,
      displayName: displayName || "",
      email: email || "",
      source: "manual",
      addedAt: nowIso,
      addedBy: "__config-import__",
      lastSeenInGraphAt: null,
    });
    target.updatedAt = nowIso;
    await writeGroupsToDisk(groups);
  });
}

export async function hasUsersGroup(): Promise<boolean> {
  const groups = await loadGroupsFromDisk();
  return groups.some((g) => g.kind === "users");
}

export async function hasAdminGroup(): Promise<boolean> {
  const groups = await loadGroupsFromDisk();
  return groups.some((g) => g.kind === "admin");
}

export async function isAdminUser(userId: string): Promise<boolean> {
  if (!userId) return false;
  const groups = await loadGroupsFromDisk();
  return groups.some((g) => g.kind === "admin" && g.members.some((m) => m.userId === userId));
}

export async function isVcaUser(userId: string): Promise<boolean> {
  if (!userId) return false;
  const groups = await loadGroupsFromDisk();
  if (groups.some((g) => g.kind === "admin" && g.members.some((m) => m.userId === userId))) return true;
  return groups.some((g) => g.kind === "users" && g.members.some((m) => m.userId === userId));
}

// ─── Group CRUD ────────────────────────────────────────────────────

function validateName(name: unknown): string {
  if (typeof name !== "string") throw err("INVALID_NAME", "name must be a string");
  const trimmed = name.trim();
  if (!trimmed) throw err("INVALID_NAME", "name is required");
  if (trimmed.length > 100) throw err("INVALID_NAME", "name must be at most 100 characters");
  return trimmed;
}

function validateKind(kind: unknown): VcaGroupKind {
  if (kind !== "admin" && kind !== "users") throw err("INVALID_KIND", "kind must be 'admin' or 'users'");
  return kind;
}

export interface CreateVcaGroupInput {
  kind: VcaGroupKind;
  name: string;
  description?: string;
}

export async function createVcaGroup(input: CreateVcaGroupInput, _adminUserId: string): Promise<VcaGroup> {
  const kind = validateKind(input.kind);
  const name = validateName(input.name);
  const description = typeof input.description === "string" ? input.description.trim() : "";
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    if (groups.some((g) => g.kind === kind && g.name.toLowerCase() === name.toLowerCase())) {
      throw err("DUPLICATE_GROUP", `A ${kind} group named "${name}" already exists`);
    }
    const nowIso = new Date().toISOString();
    const group: VcaGroup = {
      id: randomUUID(),
      kind,
      name,
      description,
      linkedGraphGroupId: null,
      linkedGraphGroupName: null,
      lastSyncedAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      members: [],
    };
    groups.push(group);
    await writeGroupsToDisk(groups);
    return group;
  });
}

export interface UpdateVcaGroupInput {
  name?: string;
  description?: string;
}

export async function updateVcaGroup(groupId: string, patch: UpdateVcaGroupInput): Promise<VcaGroup> {
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw err("NOT_FOUND", `No vca group with id ${groupId}`);
    if (patch.name !== undefined) {
      const name = validateName(patch.name);
      if (groups.some((g) => g.id !== groupId && g.kind === group.kind && g.name.toLowerCase() === name.toLowerCase())) {
        throw err("DUPLICATE_GROUP", `A ${group.kind} group named "${name}" already exists`);
      }
      group.name = name;
    }
    if (patch.description !== undefined) {
      group.description = typeof patch.description === "string" ? patch.description.trim() : "";
    }
    group.updatedAt = new Date().toISOString();
    await writeGroupsToDisk(groups);
    return group;
  });
}

export async function deleteVcaGroup(groupId: string): Promise<void> {
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    const target = groups.find((g) => g.id === groupId);
    if (!target) throw err("NOT_FOUND", `No vca group with id ${groupId}`);
    if (target.kind === "admin" && target.members.length > 0) {
      const otherAdminsHaveMembers = groups.some((g) => g.id !== groupId && g.kind === "admin" && g.members.length > 0);
      if (!otherAdminsHaveMembers) {
        throw err("LAST_ADMIN_GROUP", "Cannot delete the last admin group while it has members");
      }
    }
    const next = groups.filter((g) => g.id !== groupId);
    await writeGroupsToDisk(next);
  });
}

// ─── Manual members (unlinked groups only) ─────────────────────────

export interface AddManualMemberInput {
  userId: string;
  displayName?: string;
  email?: string;
}

export async function addManualMember(groupId: string, input: AddManualMemberInput, addedBy: string): Promise<VcaGroupMember> {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!userId) throw err("INVALID_USER_ID", "userId is required");
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw err("NOT_FOUND", `No vca group with id ${groupId}`);
    if (group.linkedGraphGroupId) {
      throw err("GROUP_IS_LINKED", "Cannot add manual members to a group linked to Microsoft Graph");
    }
    const existing = group.members.find((m) => m.userId === userId);
    if (existing) {
      if (input.displayName) existing.displayName = input.displayName;
      if (input.email) existing.email = input.email;
      group.updatedAt = new Date().toISOString();
      await writeGroupsToDisk(groups);
      return existing;
    }
    const member: VcaGroupMember = {
      userId,
      displayName: input.displayName || "",
      email: input.email || "",
      source: "manual",
      addedAt: new Date().toISOString(),
      addedBy,
      lastSeenInGraphAt: null,
    };
    group.members.push(member);
    group.updatedAt = new Date().toISOString();
    await writeGroupsToDisk(groups);
    return member;
  });
}

export async function removeManualMember(groupId: string, userId: string): Promise<void> {
  if (!userId) throw err("INVALID_USER_ID", "userId is required");
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw err("NOT_FOUND", `No vca group with id ${groupId}`);
    if (group.linkedGraphGroupId) {
      throw err("GROUP_IS_LINKED", "Cannot remove members from a group linked to Microsoft Graph");
    }
    if (group.kind === "admin") {
      const wouldEmpty = group.members.length === 1 && group.members[0].userId === userId;
      if (wouldEmpty) {
        const otherAdminsHaveMembers = groups.some((g) => g.id !== groupId && g.kind === "admin" && g.members.length > 0);
        if (!otherAdminsHaveMembers) {
          throw err("LAST_ADMIN", "Cannot remove the last admin");
        }
      }
    }
    group.members = group.members.filter((m) => m.userId !== userId);
    group.updatedAt = new Date().toISOString();
    await writeGroupsToDisk(groups);
  });
}

// ─── Graph link / unlink / sync ────────────────────────────────────

export async function linkToGraphGroup(groupId: string, graphGroupId: string, graphGroupName: string, _adminUserId: string): Promise<VcaGroup> {
  if (!graphGroupId.trim()) throw err("INVALID_GRAPH_GROUP_ID", "graphGroupId is required");
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw err("NOT_FOUND", `No vca group with id ${groupId}`);
    group.linkedGraphGroupId = graphGroupId.trim();
    group.linkedGraphGroupName = graphGroupName.trim() || null;
    group.updatedAt = new Date().toISOString();
    await writeGroupsToDisk(groups);
    return group;
  });
}

export type UnlinkMode = "keep" | "drop";

export async function unlinkFromGraphGroup(groupId: string, mode: UnlinkMode): Promise<VcaGroup> {
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw err("NOT_FOUND", `No vca group with id ${groupId}`);
    group.linkedGraphGroupId = null;
    group.linkedGraphGroupName = null;
    group.lastSyncedAt = null;
    group.lastSyncStatus = null;
    group.lastSyncError = null;
    if (mode === "drop") {
      group.members = group.members.filter((m) => m.source !== "graph");
    } else {
      group.members = group.members.map((m) => (m.source === "graph" ? { ...m, source: "manual", lastSeenInGraphAt: null } : m));
    }
    group.updatedAt = new Date().toISOString();
    await writeGroupsToDisk(groups);
    return group;
  });
}

export interface SyncResult {
  added: number;
  removed: number;
  kept: number;
}

export async function syncLinkedGroup(groupId: string): Promise<SyncResult> {
  // Fetch members OUTSIDE the write lock — Graph calls can take seconds.
  const preview = await loadGroupsFromDisk();
  const target = preview.find((g) => g.id === groupId);
  if (!target) throw err("NOT_FOUND", `No vca group with id ${groupId}`);
  if (!target.linkedGraphGroupId) throw err("NOT_LINKED", "Group is not linked to a Microsoft Graph group");
  const graphGroupId = target.linkedGraphGroupId;

  let graphMembers: NormalizedUser[];
  try {
    graphMembers = await listGraphGroupMembers(graphGroupId);
  } catch (e: any) {
    await withWriteLock(async () => {
      const groups = await loadGroupsFromDisk();
      const g = groups.find((x) => x.id === groupId);
      if (!g) return;
      g.lastSyncedAt = new Date().toISOString();
      g.lastSyncStatus = "failed";
      g.lastSyncError = e?.message || String(e);
      await writeGroupsToDisk(groups);
    });
    throw e;
  }

  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    const g = groups.find((x) => x.id === groupId);
    if (!g) throw err("NOT_FOUND", `No vca group with id ${groupId}`);
    if (!g.linkedGraphGroupId) throw err("NOT_LINKED", "Group is no longer linked");

    const nowIso = new Date().toISOString();
    const incomingIds = new Set<string>();
    let added = 0;
    let kept = 0;
    for (const u of graphMembers) {
      if (!u.id) continue;
      incomingIds.add(u.id);
      const existing = g.members.find((m) => m.userId === u.id);
      if (existing) {
        existing.source = "graph";
        existing.displayName = u.displayName || existing.displayName;
        existing.email = u.mail || existing.email;
        existing.lastSeenInGraphAt = nowIso;
        kept++;
      } else {
        g.members.push({
          userId: u.id,
          displayName: u.displayName || "",
          email: u.mail || "",
          source: "graph",
          addedAt: nowIso,
          addedBy: null,
          lastSeenInGraphAt: nowIso,
        });
        added++;
      }
    }
    const before = g.members.length;
    g.members = g.members.filter((m) => m.source !== "graph" || incomingIds.has(m.userId));
    const removed = before - g.members.length;
    g.lastSyncedAt = nowIso;
    g.lastSyncStatus = "ok";
    g.lastSyncError = null;
    g.updatedAt = nowIso;
    await writeGroupsToDisk(groups);
    return { added, removed, kept };
  });
}

// Refresh the logged-in user's membership across every linked vca group from
// a single delegated /me/transitiveMemberOf call. Returns {admin, user} flags
// reflecting final state across linked AND unlinked groups.
export async function refreshUserMembershipsAtLogin(
  userId: string,
  accessToken: string,
  displayName: string,
  email: string,
): Promise<{ admin: boolean; user: boolean }> {
  if (!userId) return { admin: false, user: false };

  const groups = await loadGroupsFromDisk();
  const linkedGroups = groups.filter((g) => g.linkedGraphGroupId);

  let memberOfIds = new Set<string>();
  if (linkedGroups.length > 0) {
    try {
      memberOfIds = await fetchUserGraphGroupIds(accessToken);
    } catch (e: any) {
      console.warn(`[vca-groups] /me/transitiveMemberOf failed for ${userId}: ${e?.message || e} — keeping prior memberships`);
      // Fall back to current state — don't touch memberships.
      return computeFlagsFor(userId, await loadGroupsFromDisk());
    }
  }

  if (linkedGroups.length === 0) {
    return computeFlagsFor(userId, groups);
  }

  return withWriteLock(async () => {
    const fresh = await loadGroupsFromDisk();
    const nowIso = new Date().toISOString();
    let dirty = false;
    for (const g of fresh) {
      if (!g.linkedGraphGroupId) continue;
      const isMember = memberOfIds.has(g.linkedGraphGroupId);
      const existingIdx = g.members.findIndex((m) => m.userId === userId);
      const existing = existingIdx >= 0 ? g.members[existingIdx] : null;
      if (isMember) {
        if (existing) {
          if (existing.source !== "graph" || existing.lastSeenInGraphAt !== nowIso) {
            existing.source = "graph";
            existing.displayName = displayName || existing.displayName;
            existing.email = email || existing.email;
            existing.lastSeenInGraphAt = nowIso;
            dirty = true;
          }
        } else {
          g.members.push({
            userId,
            displayName: displayName || "",
            email: email || "",
            source: "graph",
            addedAt: nowIso,
            addedBy: null,
            lastSeenInGraphAt: nowIso,
          });
          g.updatedAt = nowIso;
          dirty = true;
        }
      } else if (existing && existing.source === "graph") {
        g.members.splice(existingIdx, 1);
        g.updatedAt = nowIso;
        dirty = true;
      }
    }
    if (dirty) await writeGroupsToDisk(fresh);
    return computeFlagsFor(userId, fresh);
  });
}

function computeFlagsFor(userId: string, groups: VcaGroup[]): { admin: boolean; user: boolean } {
  let admin = false;
  let user = false;
  for (const g of groups) {
    if (g.members.some((m) => m.userId === userId)) {
      if (g.kind === "admin") admin = true;
      if (g.kind === "users") user = true;
    }
  }
  if (admin) user = true;
  return { admin, user };
}

async function fetchUserGraphGroupIds(accessToken: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let url: string | null = "https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$select=id&$top=999";
  let pages = 0;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const text = await res.text();
      const e = err("GRAPH_REQUEST_ERROR", `/me/transitiveMemberOf failed: ${res.status} ${text}`);
      (e as any).status = res.status;
      throw e;
    }
    const data = (await res.json()) as { value?: Array<{ id?: string }>; "@odata.nextLink"?: string };
    if (Array.isArray(data.value)) {
      for (const v of data.value) if (typeof v?.id === "string") ids.add(v.id);
    }
    url = data["@odata.nextLink"] || null;
    pages++;
    if (pages > 20) {
      console.warn("[vca-groups] fetchUserGraphGroupIds aborted after 20 pages");
      break;
    }
  }
  return ids;
}

// ─── Bootstrap ────────────────────────────────────────────────────

export async function maybeBootstrapAdmin(userId: string, displayName: string, email: string): Promise<boolean> {
  if (!userId) return false;
  const bootstrap = await loadBootstrapFromDisk();
  if (bootstrap.firstAdminPromotedAt) return false;

  const envUserId = (process.env.VCA_BOOTSTRAP_ADMIN_USER_ID || "").trim();
  const envUpn = (process.env.VCA_BOOTSTRAP_ADMIN_UPN || "").trim().toLowerCase();
  const matchesUserId = envUserId && userId === envUserId;
  const matchesUpn = envUpn && email && email.trim().toLowerCase() === envUpn;
  if (!matchesUserId && !matchesUpn) return false;

  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    let adminGroup = groups.find((g) => g.kind === "admin");
    const nowIso = new Date().toISOString();
    if (!adminGroup) {
      adminGroup = {
        id: randomUUID(),
        kind: "admin",
        name: "Administrators",
        description: "Initial administrator group seeded by VCA_BOOTSTRAP_ADMIN_*",
        linkedGraphGroupId: null,
        linkedGraphGroupName: null,
        lastSyncedAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        members: [],
      };
      groups.push(adminGroup);
    }
    if (!adminGroup.members.some((m) => m.userId === userId)) {
      adminGroup.members.push({
        userId,
        displayName: displayName || "",
        email: email || "",
        source: "manual",
        addedAt: nowIso,
        addedBy: "__bootstrap__",
        lastSeenInGraphAt: null,
      });
      adminGroup.updatedAt = nowIso;
    }
    await writeGroupsToDisk(groups);
    await writeBootstrapToDisk({
      firstAdminPromotedAt: nowIso,
      firstAdminUserId: userId,
      createdAt: bootstrap.createdAt,
    });
    console.log(`[bootstrap] promoted ${email || userId} (${userId}) to admin via VCA_BOOTSTRAP_ADMIN_*`);
    return true;
  });
}

// ─── Migration hook (identity-migration.ts) ────────────────────────

export interface RewriteMemberResult {
  groupsTouched: number;
  membersRewritten: number;
}

export async function rewriteMemberUserId(legacyUserId: string, newUserId: string): Promise<RewriteMemberResult> {
  if (!legacyUserId || !newUserId || legacyUserId === newUserId) {
    return { groupsTouched: 0, membersRewritten: 0 };
  }
  return withWriteLock(async () => {
    const groups = await loadGroupsFromDisk();
    let groupsTouched = 0;
    let membersRewritten = 0;
    for (const g of groups) {
      let touched = false;
      for (const m of g.members) {
        if (m.userId === legacyUserId) {
          m.userId = newUserId;
          membersRewritten++;
          touched = true;
        }
        if (m.addedBy === legacyUserId) {
          m.addedBy = newUserId;
          touched = true;
        }
      }
      if (touched) {
        g.updatedAt = new Date().toISOString();
        groupsTouched++;
      }
    }
    if (groupsTouched > 0) await writeGroupsToDisk(groups);

    const bootstrap = await loadBootstrapFromDisk();
    if (bootstrap.firstAdminUserId === legacyUserId) {
      await writeBootstrapToDisk({ ...bootstrap, firstAdminUserId: newUserId });
    }

    return { groupsTouched, membersRewritten };
  });
}
