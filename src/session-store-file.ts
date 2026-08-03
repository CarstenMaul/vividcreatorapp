import fs from "fs/promises";
import path from "path";
import type { SessionData, SessionStore } from "./session-store.js";
import { sessionPaths } from "./paths.js";

// Match the hex sessionId minted in auth.ts (`randomBytes(32).toString("hex")`).
// Reject any other characters before doing path math, so a malformed cookie
// can't traverse out of the sessions dir.
const SESSION_ID_RE = /^[a-f0-9]{1,128}$/;

function sessionPath(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error("Invalid sessionId");
  }
  return sessionPaths.file(sessionId);
}

const RENAME_RETRY_DELAYS_MS = [10, 30, 80, 200];

// Atomic write: stage to a uniquely-named temp file in the same directory,
// then rename over the target. fs.rename is atomic on POSIX (production).
// On Windows it can fail with EPERM/EBUSY under concurrency when the OS has
// not fully released a handle on the destination from a sibling write — a
// short retry loop handles that without compromising atomicity.
async function atomicWriteSession(filePath: string, value: SessionData): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), "utf-8");
  let attempt = 0;
  while (true) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err: any) {
      const code = err?.code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
        try { await fs.unlink(tmp); } catch { /* ignore */ }
        throw err;
      }
      if (attempt >= RENAME_RETRY_DELAYS_MS.length) {
        try { await fs.unlink(tmp); } catch { /* ignore */ }
        throw err;
      }
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt++]));
    }
  }
}

export class FileSessionStore implements SessionStore {
  private dirEnsured = false;
  // Per-session mutex: chains writes for the same sessionId so they serialize
  // within this process. Different sessions remain independent (separate
  // entries) and run in parallel. Mirrors the pendingRefreshes pattern in
  // auth.ts and avoids rename contention against ourselves.
  private writeChains = new Map<string, Promise<void>>();

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await fs.mkdir(sessionPaths.dir(), { recursive: true });
    this.dirEnsured = true;
  }

  async get(sessionId: string): Promise<SessionData | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    try {
      const raw = await fs.readFile(sessionPath(sessionId), "utf-8");
      const parsed = JSON.parse(raw) as Partial<SessionData>;
      // Backward compat: sessions written before the authType field default to "entra".
      const authType: SessionData["authType"] = parsed.authType === "local" ? "local" : "entra";
      return {
        userId: parsed.userId || "",
        displayName: parsed.displayName || "",
        email: parsed.email || "",
        expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
        accessToken: parsed.accessToken || "",
        refreshToken: parsed.refreshToken || "",
        isAdmin: parsed.isAdmin === true,
        authType,
      };
    } catch (err: any) {
      if (err && err.code === "ENOENT") return null;
      console.warn(`[session-store-file] Failed to read ${sessionId}:`, err?.message || err);
      return null;
    }
  }

  async set(sessionId: string, data: SessionData): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error("Invalid sessionId");
    await this.ensureDir();
    const prev = this.writeChains.get(sessionId) || Promise.resolve();
    const next = prev
      .catch(() => { /* prior failure must not poison the chain */ })
      .then(() => atomicWriteSession(sessionPath(sessionId), data));
    // Track the chain head so the next set() waits for *this* write.
    // Clean up the map slot when this is the last write in flight.
    this.writeChains.set(sessionId, next);
    next.finally(() => {
      if (this.writeChains.get(sessionId) === next) {
        this.writeChains.delete(sessionId);
      }
    });
    return next;
  }

  async delete(sessionId: string): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId)) return;
    try {
      await fs.unlink(sessionPath(sessionId));
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  async cleanupExpired(olderThanMs: number): Promise<number> {
    let entries: string[];
    try {
      entries = await fs.readdir(sessionPaths.dir());
    } catch (err: any) {
      if (err?.code === "ENOENT") return 0;
      throw err;
    }
    const cutoff = Date.now() - olderThanMs;
    let deleted = 0;
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!SESSION_ID_RE.test(id)) continue;
      const p = path.join(sessionPaths.dir(), name);
      try {
        const raw = await fs.readFile(p, "utf-8");
        const data = JSON.parse(raw) as SessionData;
        if (typeof data.expiresAt === "number" && data.expiresAt < cutoff) {
          await fs.unlink(p);
          deleted++;
        }
      } catch {
        // Unparseable / disappeared — skip.
      }
    }
    return deleted;
  }

  describe(): string {
    return `file (${sessionPaths.dir()})`;
  }
}
