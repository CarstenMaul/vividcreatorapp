/**
 * Phase 1 in-process hardening for the embedded pi coding agent.
 *
 * Two portable, always-on protections wired through pi's documented tool
 * extension points (no forking, behavior otherwise preserved):
 *
 *  1. The `bash` tool's environment is replaced with a curated allow-list via
 *     a spawnHook, so provider API keys / PATs / Entra secrets are no longer
 *     visible to model-authored shell commands (`echo $ANTHROPIC_API_KEY` → "").
 *
 *  2. The file tools (`read`/`write`/`edit`/`grep`/`find`/`ls`) get custom
 *     `operations` that realpath-check every target against the session's
 *     workspace root before touching the filesystem, so absolute paths, `..`
 *     traversal, and symlink-escape all fail with "Path escapes project
 *     workspace".
 *
 * NOT covered here (see Phase 2): a raw `bash` command can still `cd ..` and
 * read peer workspaces / on-disk secrets — only an OS-level jail stops that.
 * The env scrub removes secrets from the shell's environment, not the shell's
 * filesystem reach.
 */

import fsp from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import {
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  type BashSpawnContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { buildSanitizedAgentEnv } from "./env-sanitize.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * The containment root for a session: the *real* (symlink-resolved) path of the
 * workspace. For shared projects the caller already resolves the owner's real
 * dir (sharing is metadata-only — the path accessors redirect a recipient to the
 * owner), so this is normally an identity resolve; realpath still runs to collapse
 * any in-workspace symlinks and give a stable boundary. Computed once per session.
 */
export async function resolveWorkspaceRealRoot(workspacePath: string): Promise<string> {
  try {
    return await fsp.realpath(workspacePath);
  } catch {
    // Workspace is created (initWorkspace) before this runs; fall back to a
    // lexically-resolved path if realpath somehow fails.
    return path.resolve(workspacePath);
  }
}

function withinRoot(real: string, root: string): boolean {
  const a = IS_WINDOWS ? real.toLowerCase() : real;
  const b = IS_WINDOWS ? root.toLowerCase() : root;
  if (a === b) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return a.startsWith(prefix);
}

/**
 * realpath the nearest existing ancestor of a not-yet-existing path, then
 * re-append the missing tail. Lets us contain writes to new files/dirs (whose
 * own realpath would fail) while still resolving any symlink in the existing
 * ancestry.
 */
async function realpathNearestAncestor(target: string): Promise<string> {
  const tail: string[] = [];
  let dir = target;
  for (;;) {
    try {
      const real = await fsp.realpath(dir);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error("Path has no existing ancestor");
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Throw unless `absPath` resolves to a location inside `realRoot`. Uses realpath
 * (not a string `..` check) so an in-workspace symlink pointing outward is also
 * caught. Returns the normalized absolute path on success.
 */
export async function assertInsideWorkspace(absPath: string, realRoot: string): Promise<string> {
  const norm = path.resolve(absPath);
  let real: string;
  try {
    real = await fsp.realpath(norm);
  } catch {
    real = await realpathNearestAncestor(norm);
  }
  if (!withinRoot(real, realRoot)) {
    throw new Error("Path escapes project workspace");
  }
  return norm;
}

// Minimal image sniffer mirroring pi's supported set (JPEG/PNG/GIF/WebP). Used
// so our read-tool override keeps image auto-detection instead of treating
// images as text. Reimplemented here to avoid a deep import into pi internals.
const IMAGE_SNIFF_BYTES = 4100;

function asciiAt(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buf[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

async function detectImageMime(absPath: string): Promise<string | null> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(absPath, "r");
    const buf = Buffer.alloc(IMAGE_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, IMAGE_SNIFF_BYTES, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      return b[3] === 0xf7 ? null : "image/jpeg";
    }
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return "image/png";
    }
    if (asciiAt(b, 0, "GIF")) return "image/gif";
    if (asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP")) return "image/webp";
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

// Approximates the ignore list find passes (["**/node_modules/**","**/.git/**"]).
const GLOB_IGNORE_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;

/**
 * A workspace-confined replacement for find's default fd-based glob. Uses Node's
 * built-in fs.glob (stable in Node 24) and drops any match that escapes the
 * root. Providing a `glob` op makes pi's find tool take its custom-glob branch,
 * which also gates on our `exists` guard first. Trade-off vs. fd: nested
 * .gitignore rules are not honored (only node_modules/.git are excluded) — find
 * is not in the default active tool set, so this is defense-in-depth.
 */
async function confinedGlob(
  pattern: string,
  searchPath: string,
  options: { ignore: string[]; limit: number },
  realRoot: string,
): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of fsp.glob(pattern, { cwd: searchPath })) {
    const rel = typeof entry === "string" ? entry : String(entry);
    if (GLOB_IGNORE_RE.test(rel)) continue;
    const abs = path.isAbsolute(rel) ? rel : path.resolve(searchPath, rel);
    try {
      await assertInsideWorkspace(abs, realRoot);
    } catch {
      continue;
    }
    out.push(abs);
    if (out.length >= options.limit) break;
  }
  return out;
}

export interface HardenedToolOptions {
  /** Explicit shell binary for the bash tool (bundled Git Bash on desktop). */
  shellPath?: string;
}

/**
 * Build hardened versions of pi's built-in tools. Passed to createAgentSession
 * as customTools, they override the built-ins of the same name in the registry,
 * so the active read/bash/edit/write set becomes the confined variants.
 * grep/find/ls are overridden too (defense-in-depth; not active by default).
 */
export function buildHardenedToolDefinitions(
  cwd: string,
  realRoot: string,
  opts: HardenedToolOptions = {},
): ToolDefinition[] {
  const guard = (p: string): Promise<string> => assertInsideWorkspace(p, realRoot);

  const spawnHook = (ctx: BashSpawnContext): BashSpawnContext => ({
    command: ctx.command,
    cwd: ctx.cwd,
    env: buildSanitizedAgentEnv(ctx.env),
  });

  const tools = [
    // bash: env scrubbed; exec backend left as pi's default (streaming, abort,
    // timeout, process-tree kill all preserved).
    createBashToolDefinition(cwd, { shellPath: opts.shellPath, spawnHook }),

    createReadToolDefinition(cwd, {
      operations: {
        readFile: async (a) => {
          await guard(a);
          return fsp.readFile(a);
        },
        access: async (a) => {
          await guard(a);
          await fsp.access(a, fsConstants.R_OK);
        },
        detectImageMimeType: async (a) => {
          await guard(a);
          return detectImageMime(a);
        },
      },
    }),

    createWriteToolDefinition(cwd, {
      operations: {
        writeFile: async (a, content) => {
          await guard(a);
          await fsp.writeFile(a, content, "utf-8");
        },
        mkdir: async (dir) => {
          await guard(dir);
          await fsp.mkdir(dir, { recursive: true });
        },
      },
    }),

    createEditToolDefinition(cwd, {
      operations: {
        readFile: async (a) => {
          await guard(a);
          return fsp.readFile(a);
        },
        writeFile: async (a, content) => {
          await guard(a);
          await fsp.writeFile(a, content, "utf-8");
        },
        access: async (a) => {
          await guard(a);
          await fsp.access(a, fsConstants.R_OK | fsConstants.W_OK);
        },
      },
    }),

    createGrepToolDefinition(cwd, {
      operations: {
        // Checked before pi spawns ripgrep, so an out-of-root search dir is
        // rejected up front.
        isDirectory: async (a) => {
          await guard(a);
          return (await fsp.stat(a)).isDirectory();
        },
        readFile: async (a) => {
          await guard(a);
          return (await fsp.readFile(a)).toString("utf-8");
        },
      },
    }),

    createFindToolDefinition(cwd, {
      operations: {
        exists: async (a) => {
          try {
            await guard(a);
            await fsp.access(a);
            return true;
          } catch {
            return false;
          }
        },
        glob: (pattern, searchPath, options) => confinedGlob(pattern, searchPath, options, realRoot),
      },
    }),

    createLsToolDefinition(cwd, {
      operations: {
        exists: async (a) => {
          try {
            await guard(a);
            await fsp.access(a);
            return true;
          } catch {
            return false;
          }
        },
        stat: async (a) => {
          await guard(a);
          return fsp.stat(a);
        },
        readdir: async (a) => {
          await guard(a);
          return fsp.readdir(a);
        },
      },
    }),
  ];
  // pi's create*ToolDefinition return narrowly-typed ToolDefinition<Schema,…>.
  // The generic ToolDefinition[] element type widens the schema, making
  // renderCall's `args` parameter contravariantly incompatible. The runtime
  // shapes are exactly what pi holds internally (ToolDefinition<any,any>), so
  // widen through unknown at this boundary.
  return tools as unknown as ToolDefinition[];
}
