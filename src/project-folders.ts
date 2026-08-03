import fs from "fs/promises";
import { randomUUID } from "crypto";
import { userPaths } from "./paths.js";
import { atomicWriteJson } from "./fs-utils.js";

/**
 * Per-user VIRTUAL folder tree for the project list, persisted in
 * <userRoot>/project-folders.json as a flat array of { id, name, parentId }.
 * Folders are pure display metadata: assignments live as an optional
 * `folderId` on the user's projects.json entries, and nothing about a
 * project's on-disk location ever changes when it is moved between folders.
 */

export interface ProjectFolder {
  id: string;
  name: string;
  parentId: string | null;
}

const MAX_NAME_LEN = 100;

// Per-user promise-chain mutex so concurrent folder mutations don't lose
// writes (same pattern as user-prefs.ts).
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(userId, next.catch(() => {}));
  return next;
}

async function readRaw(userId: string): Promise<ProjectFolder[]> {
  try {
    const text = await fs.readFile(userPaths.projectFolders(userId), "utf-8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const out: ProjectFolder[] = [];
    for (const entry of parsed) {
      const e = entry as { id?: unknown; name?: unknown; parentId?: unknown };
      if (typeof e?.id !== "string" || !e.id || typeof e?.name !== "string" || !e.name.trim()) continue;
      out.push({ id: e.id, name: e.name, parentId: typeof e.parentId === "string" ? e.parentId : null });
    }
    return out;
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn("[project-folders] failed to read:", err);
    return [];
  }
}

async function writeRaw(userId: string, folders: ProjectFolder[]): Promise<void> {
  await fs.mkdir(userPaths.dir(userId), { recursive: true });
  await atomicWriteJson(userPaths.projectFolders(userId), folders, 2);
}

export class FolderValidationError extends Error {
  status = 400;
}

function validateName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new FolderValidationError("Folder name is required");
  if (trimmed.length > MAX_NAME_LEN) throw new FolderValidationError(`Folder name must be ${MAX_NAME_LEN} characters or fewer`);
  return trimmed;
}

export async function listProjectFolders(userId: string): Promise<ProjectFolder[]> {
  return readRaw(userId);
}

export async function createProjectFolder(
  userId: string,
  name: unknown,
  parentId: string | null,
): Promise<{ folder: ProjectFolder; folders: ProjectFolder[] }> {
  const cleanName = validateName(name);
  return withLock(userId, async () => {
    const folders = await readRaw(userId);
    if (parentId && !folders.some((f) => f.id === parentId)) {
      throw new FolderValidationError("Parent folder not found");
    }
    const folder: ProjectFolder = { id: randomUUID(), name: cleanName, parentId: parentId || null };
    folders.push(folder);
    await writeRaw(userId, folders);
    return { folder, folders };
  });
}

export async function renameProjectFolder(
  userId: string,
  folderId: string,
  name: unknown,
): Promise<ProjectFolder[]> {
  const cleanName = validateName(name);
  return withLock(userId, async () => {
    const folders = await readRaw(userId);
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) throw new FolderValidationError("Folder not found");
    folder.name = cleanName;
    await writeRaw(userId, folders);
    return folders;
  });
}

/**
 * Re-parent a folder within the virtual tree. Rejected if the new parent is
 * the folder itself or one of its own descendants, which would splice a cycle
 * out of the hierarchy. Pure display metadata — nothing moves on disk.
 * newParentId null/"" → top level.
 */
export async function moveProjectFolder(
  userId: string,
  folderId: string,
  newParentId: string | null,
): Promise<ProjectFolder[]> {
  return withLock(userId, async () => {
    const folders = await readRaw(userId);
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) throw new FolderValidationError("Folder not found");
    const target = newParentId || null;
    if (target) {
      if (target === folderId) {
        throw new FolderValidationError("A folder cannot be moved into itself");
      }
      if (!folders.some((f) => f.id === target)) {
        throw new FolderValidationError("Parent folder not found");
      }
      // Walking up from the target must never reach the folder being moved,
      // or the drop would nest a folder inside its own subtree.
      const byId = new Map(folders.map((f) => [f.id, f]));
      const seen = new Set<string>();
      let cursor: string | null = target;
      while (cursor) {
        if (cursor === folderId) {
          throw new FolderValidationError("A folder cannot be moved into one of its own subfolders");
        }
        if (seen.has(cursor)) break; // defensive: bail on any pre-existing cycle
        seen.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
      }
    }
    folder.parentId = target;
    await writeRaw(userId, folders);
    return folders;
  });
}

/**
 * Delete a folder. Child folders are re-parented to the deleted folder's
 * parent (never deleted with it), so no part of the hierarchy silently
 * disappears. Returns the deleted folder's parentId so the caller can
 * reassign the projects that pointed at it the same way.
 */
export async function deleteProjectFolder(
  userId: string,
  folderId: string,
): Promise<{ parentId: string | null; folders: ProjectFolder[] }> {
  return withLock(userId, async () => {
    const folders = await readRaw(userId);
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) throw new FolderValidationError("Folder not found");
    const parentId = folder.parentId;
    const next = folders
      .filter((f) => f.id !== folderId)
      .map((f) => (f.parentId === folderId ? { ...f, parentId } : f));
    await writeRaw(userId, next);
    return { parentId, folders: next };
  });
}
