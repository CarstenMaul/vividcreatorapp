import { spawn } from "child_process";
import { bundledGitExe, resolveNpm } from "./bundled-runtime.js";

/**
 * Shell-free child-process helpers.
 *
 * Everything here spawns a real executable directly — never `exec`, never
 * `shell: true`. Two reasons:
 *
 *  1. **UNC working directories.** Node's `exec` (and `spawn` with `shell`) goes
 *     through `cmd.exe /d /s /c` on Windows, and cmd.exe refuses a UNC current
 *     directory: it prints "UNC paths are not supported. Defaulting to Windows
 *     directory." and runs in C:\Windows anyway. With a WORKSPACES_ROOT on
 *     `\\server\share` that turned every build into
 *     "npm error ENOENT ... C:\Windows\package.json". CreateProcess itself
 *     accepts a UNC lpCurrentDirectory, so a shell-free spawn just works.
 *  2. **Quoting.** Under `shell`, Node joins argv with plain spaces and no
 *     quoting, so any argument containing a space silently splits — which is why
 *     `git commit -m "release v1.2.3"` was reaching git as `-m release` plus a
 *     stray pathspec. Passing a real argv removes the entire quoting/injection
 *     surface.
 *
 * Results deliberately mirror the `{ stdout, stderr }` shape of promisified
 * `exec`, and thrown errors carry `.code`/`.stdout`/`.stderr`, so call sites
 * that already destructure or inspect those keep working unchanged.
 */

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface RunOptions {
  cwd?: string;
  /** Milliseconds before the child is killed. Unset means no timeout. */
  timeout?: number;
  /** Max bytes buffered per stream before the run is aborted. Default 16 MB. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /**
   * Literal strings to blank out of stdout, stderr and error messages — pass any
   * PAT or credential-bearing URL so it cannot reach a log or an API response.
   */
  redact?: string[];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunError extends Error {
  code: number | string;
  stdout: string;
  stderr: string;
}

function redact(text: string, secrets?: string[]): string {
  if (!text || !secrets?.length) return text;
  let out = text;
  for (const secret of secrets) {
    // Short strings would blank out unrelated text; a real token is never this short.
    if (secret && secret.length >= 6) out = out.split(secret).join("***");
  }
  return out;
}

function describe(file: string, args: string[], secrets?: string[]): string {
  return redact([file, ...args].join(" "), secrets);
}

function makeError(
  message: string,
  code: number | string,
  stdout: string,
  stderr: string,
): RunError {
  const err = new Error(message) as RunError;
  err.code = code;
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

/**
 * Spawn `file` with `args` and collect its output. Resolves with the exit code
 * whatever it is; only spawn failures, timeouts, aborts and buffer overflows
 * reject.
 */
export function tryRun(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const secrets = opts.redact;

    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        // Never a shell — see the module comment.
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      reject(makeError(
        `Failed to spawn ${describe(file, args, secrets)}: ${err?.message ?? String(err)}`,
        err?.code ?? "ESPAWN", "", "",
      ));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const kill = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };

    function onAbort(): void {
      kill();
      settle(() => reject(makeError(
        `Aborted: ${describe(file, args, secrets)}`, "ABORT_ERR",
        redact(stdout, secrets), redact(stderr, secrets),
      )));
    }

    const collect = (stream: NodeJS.ReadableStream, onChunk: (s: string) => void): void => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        onChunk(chunk);
        if (stdout.length > maxBuffer || stderr.length > maxBuffer) {
          kill();
          settle(() => reject(makeError(
            `Output exceeded maxBuffer (${maxBuffer} bytes): ${describe(file, args, secrets)}`,
            "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            redact(stdout, secrets), redact(stderr, secrets),
          )));
        }
      });
    };

    if (child.stdout) collect(child.stdout, (c) => { stdout += c; });
    if (child.stderr) collect(child.stderr, (c) => { stderr += c; });

    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        kill();
        settle(() => reject(makeError(
          `Timed out after ${opts.timeout}ms: ${describe(file, args, secrets)}`, "ETIMEDOUT",
          redact(stdout, secrets), redact(stderr, secrets),
        )));
      }, opts.timeout);
    }

    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return; }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err: any) => {
      settle(() => reject(makeError(
        `Failed to run ${describe(file, args, secrets)}: ${err?.message ?? String(err)}`,
        err?.code ?? "ESPAWN", redact(stdout, secrets), redact(stderr, secrets),
      )));
    });

    child.on("close", (code, signal) => {
      settle(() => resolve({
        // A signal-killed child reports code null; surface it as a non-zero exit.
        code: code ?? (signal ? 1 : 0),
        stdout: redact(stdout, secrets),
        stderr: redact(stderr, secrets),
      }));
    });
  });
}

/** Like tryRun, but throws when the command exits non-zero. */
export async function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const result = await tryRun(file, args, opts);
  if (result.code !== 0) {
    throw makeError(
      `Command failed (exit ${result.code}): ${describe(file, args, opts.redact)}` +
      (result.stderr.trim() ? `\n${result.stderr.trim()}` : ""),
      result.code, result.stdout, result.stderr,
    );
  }
  return result;
}

/**
 * Pull the credential parts out of an authenticated URL
 * (`https://user:pat@host/…` or `https://pat@host/…`) so they can be passed as
 * `redact`. Saves every caller from having to thread the raw PAT alongside the
 * URL just to keep it out of logs and error messages.
 */
export function secretsInUrl(url: string): string[] {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/@]+)@/i.exec(url);
  if (!match) return [];
  const userinfo = match[1];
  const parts = [userinfo, ...userinfo.split(":")];
  return parts.filter((p) => p.length >= 6).map(decodeURIComponentSafe).concat(parts);
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** The git executable to use: the bundled PortableGit when present, else PATH. */
function gitExe(): string {
  return bundledGitExe() ?? "git";
}

/** Run git. Throws on a non-zero exit. */
export function git(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(gitExe(), args, opts);
}

/** Run git, resolving with the exit code instead of throwing. */
export function tryGit(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return tryRun(gitExe(), args, opts);
}

/**
 * Run npm as `node <npm-cli.js>` rather than the `npm.cmd` shim, so it needs no
 * shell and works with a UNC cwd. See resolveNpm() in bundled-runtime.ts.
 *
 * Note this only controls how npm *itself* is launched: `npm run <script>` still
 * hands the script body to a shell (cmd.exe on Windows) with the project as cwd,
 * so a UNC workspace remains unbuildable regardless. Mapped drive letters are
 * fine.
 */
export function npm(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { exe, prefixArgs } = resolveNpm();
  return run(exe, [...prefixArgs, ...args], opts);
}

/** Run npm, resolving with the exit code instead of throwing. */
export function tryNpm(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { exe, prefixArgs } = resolveNpm();
  return tryRun(exe, [...prefixArgs, ...args], opts);
}
