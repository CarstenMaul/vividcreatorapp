import fs from "fs/promises";
import os from "os";
import path from "path";
import lockfile from "proper-lockfile";
import { classifyVolume } from "./volume-info.js";
import { WORKSPACES_ROOT } from "./paths.js";

/**
 * Cross-machine "one person per project" lease.
 *
 * A shared WORKSPACES_ROOT on a fileserver is a supported way for colleagues to
 * see each other's projects (sharing is metadata-only — linkProject records a
 * link and resolveOwnerUserId points every path at the owner's directory), so
 * two VCA instances genuinely converge on the same workspace directory. Nothing
 * in VCA is safe under that:
 *
 *  - git-lock.ts deletes `.git/index.lock` before every operation, so a second
 *    instance actively destroys the first one's in-flight commit.
 *  - Every other mutex (git-lock, project-list, inbound-links, node-modules,
 *    session-store, the preview port queue) is an in-process Map.
 *  - fs-utils' atomicWriteJson is last-writer-wins with no compare-and-swap, so
 *    concurrent edits to projects.json / links.json silently lose updates.
 *  - Two agents on one project interleave appends into the same chat JSONL.
 *
 * Making all of that concurrency-safe is a different and much larger project.
 * Holding a lease instead is cheap and turns silent corruption into a clear
 * "already open on <machine> by <user>".
 *
 * proper-lockfile is used because it is already a dependency and its mkdir-based
 * acquisition is atomic over SMB. `realpath: false` is essential: resolving the
 * path would rewrite a mapped drive letter to its UNC target, so two clients
 * with different mappings of the same share would compute different lock paths
 * and both "succeed". (The same spelling drift already broke agent session
 * resumption — see the note in agent-manager.ts.)
 */

/** Holder metadata, written next to the lock so a peer can be named in the UI. */
export interface LeaseHolder {
  machine: string;
  user: string;
  pid: number;
  /** ISO timestamp the lease was taken. */
  since: string;
}

export type AcquireResult =
  | { ok: true; holder: LeaseHolder }
  | { ok: false; holder: LeaseHolder | null };

/** Lease heartbeat interval; proper-lockfile refreshes the lock's mtime. */
const UPDATE_MS = 15_000;
/**
 * How long a lease survives without a heartbeat before a peer may steal it.
 * Generous because the mtime lives on a network share: an SMB round trip plus
 * client-side metadata caching makes short windows produce false steals.
 */
const STALE_MS = 60_000;

const HOLDER_FILE = ".vca-lock.json";

/** Live releases for leases this process holds, keyed by workspace path. */
const held = new Map<string, () => Promise<void>>();

let enabledPromise: Promise<boolean> | null = null;

/**
 * Whether leasing applies at all.
 *
 * A workspace root on plain local disk cannot be reached by a second machine,
 * and only one VCA can run per machine anyway (the server binds a fixed port),
 * so leasing there would add a lock file and a heartbeat to every project for no
 * benefit. Network drives and cloud-synced folders are exactly the roots two
 * people can share, so those get leases.
 *
 * VCA_PROJECT_LEASE=1/0 forces it on or off, mostly for tests.
 */
export async function leasingEnabled(): Promise<boolean> {
  if (process.env.VCA_PROJECT_LEASE === "1") return true;
  if (process.env.VCA_PROJECT_LEASE === "0") return false;
  if (!enabledPromise) {
    enabledPromise = classifyVolume(WORKSPACES_ROOT)
      .then((v) => v.kind !== "local")
      .catch(() => false);
  }
  return enabledPromise;
}

function holderPath(workspacePath: string): string {
  return path.join(workspacePath, HOLDER_FILE);
}

/** Case-insensitive on Windows, so the same project is one key however spelled. */
function key(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function describeSelf(user: string): LeaseHolder {
  return {
    machine: os.hostname(),
    user,
    pid: process.pid,
    since: new Date().toISOString(),
  };
}

/** Read whoever currently claims the project, or null if the file is absent/garbage. */
export async function readLeaseHolder(workspacePath: string): Promise<LeaseHolder | null> {
  try {
    const raw = JSON.parse(await fs.readFile(holderPath(workspacePath), "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    return {
      machine: typeof raw.machine === "string" ? raw.machine : "?",
      user: typeof raw.user === "string" ? raw.user : "?",
      pid: typeof raw.pid === "number" ? raw.pid : 0,
      since: typeof raw.since === "string" ? raw.since : "",
    };
  } catch {
    return null;
  }
}

/** True when this process already holds the lease. */
export function holdsLease(workspacePath: string): boolean {
  return held.has(key(workspacePath));
}

/**
 * Take the project's lease. Re-acquiring a lease this process already holds is a
 * no-op success, so callers can treat this as "ensure I hold it".
 *
 * On failure the current holder is returned (when readable) so the caller can
 * say who has it rather than just refusing.
 */
export async function acquireLease(workspacePath: string, holder: LeaseHolder): Promise<AcquireResult> {
  const k = key(workspacePath);
  if (held.has(k)) return { ok: true, holder };

  const target = holderPath(workspacePath);
  try {
    // proper-lockfile arbitrates via a sibling `<file>.lock` directory, but it
    // requires the target to exist. Create it withOUT truncating: a failed
    // acquisition must not overwrite the current holder's details, or the peer
    // we are about to name would have just been erased by us.
    const handle = await fs.open(target, "a");
    await handle.close();
  } catch {
    // Can't even create a file in the workspace — let the caller's own error
    // handling deal with it rather than reporting a bogus "someone else has it".
    return { ok: false, holder: null };
  }

  try {
    const release = await lockfile.lock(target, {
      stale: STALE_MS,
      update: UPDATE_MS,
      realpath: false,
      // No retries: the answer to "someone else has this project open" is a
      // message, not a wait.
      retries: 0,
    });
    held.set(k, release);
    // Only now that the lock is ours may we claim the holder file.
    await fs.writeFile(target, JSON.stringify(holder, null, 2), "utf-8").catch(() => { /* cosmetic */ });
    return { ok: true, holder };
  } catch (err: any) {
    if (err?.code === "ELOCKED") return { ok: false, holder: await readLeaseHolder(workspacePath) };
    return { ok: false, holder: null };
  }
}

/** Drop a lease this process holds. Safe to call when it holds none. */
export async function releaseLease(workspacePath: string): Promise<void> {
  const k = key(workspacePath);
  const release = held.get(k);
  if (!release) return;
  held.delete(k);
  try {
    await release();
  } catch {
    // Already stolen as stale, or the share went away — either way we no longer
    // hold it, which is what the caller asked for.
  }
}

/** Drop every lease this process holds. For shutdown. */
export async function releaseAllLeases(): Promise<void> {
  await Promise.all([...held.keys()].map((k) => releaseLease(k)));
}

/**
 * Break someone else's lease. Only for an explicit user "take over" after being
 * shown who holds it — a peer whose VCA was killed leaves a lease that is stale
 * but not yet expired, and waiting out STALE_MS is a poor experience.
 */
export async function forceReleaseLease(workspacePath: string): Promise<void> {
  await releaseLease(workspacePath);
  try {
    await lockfile.unlock(holderPath(workspacePath), { realpath: false });
  } catch {
    // proper-lockfile refuses to unlock a lock it doesn't own; remove the lock
    // directory directly, which is exactly what its own stale-steal does.
    await fs.rm(`${holderPath(workspacePath)}.lock`, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
}

/**
 * Run `fn` while holding the lease, for one-shot operations that must not
 * interleave with another machine (a release build, a rollback). Throws a
 * PROJECT_LOCKED error when someone else has it.
 *
 * If this process already holds the lease, the existing one is reused and NOT
 * released at the end — the outer holder still owns it.
 */
export async function withLease<T>(
  workspacePath: string,
  holder: LeaseHolder,
  fn: () => Promise<T>,
): Promise<T> {
  const alreadyHeld = holdsLease(workspacePath);
  const res = await acquireLease(workspacePath, holder);
  if (!res.ok) {
    const who = res.holder ? `${res.holder.user} on ${res.holder.machine}` : "another VCA instance";
    const err = new Error(`This project is currently open by ${who}.`) as Error & { code: string; holder: LeaseHolder | null };
    err.code = "PROJECT_LOCKED";
    err.holder = res.holder;
    throw err;
  }
  try {
    return await fn();
  } finally {
    if (!alreadyHeld) await releaseLease(workspacePath);
  }
}
