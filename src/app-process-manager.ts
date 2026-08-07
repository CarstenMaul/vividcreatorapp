import { randomUUID } from "crypto";
import { spawn, exec, type ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import http from "http";
import net from "net";
import { ensureDependencies, clearNodeModules } from "./node-modules-store.js";
import { resolveAppNode } from "./bundled-runtime.js";
import { classifyVolume, isNonLocalVolume } from "./volume-info.js";
import { npm, tryRun } from "./exec-utils.js";
import { sanitizeChildEnv } from "./env-sanitize.js";
import { getDecryptedEnvMap } from "./env-vars-store.js";

// Only for the two Linux-only `ss` probes below, which genuinely want a shell
// (they rely on `2>/dev/null`) and pass no cwd, so the UNC hazard that drove
// everything else onto src/exec-utils.ts does not apply to them.
const execAsync = promisify(exec);

const IS_WINDOWS = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

export type LogCallback = (line: string, stream: "stdout" | "stderr") => void;
export type PreviewStatus = "stopped" | "starting" | "running" | "stopping" | "crashed";

export interface PreviewState {
  projectKey: string;
  status: PreviewStatus;
  running: boolean;
  port: number | null;
  pid: number | null;
  instanceId: string | null;
  hasProcess: boolean;
  lastError: string | null;
  lastUsedAt: number | null;
}

export type PreviewEvent =
  | { type: "state"; state: PreviewState }
  | { type: "log"; line: string; stream: "stdout" | "stderr" }
  | { type: "reload"; state: PreviewState };

type PreviewEventListener = (event: PreviewEvent) => void;

interface AppRuntime {
  workspacePath: string | null;
  status: PreviewStatus;
  process: ChildProcess | null;
  port: number | null;
  pid: number | null;
  processGroupId: number | null;
  pkgMtime: number;
  logBuffer: string[];
  logStream?: fss.WriteStream;
  lastUsedAt: number | null;
  lastError: string | null;
  instanceId: string | null;
  hadProcess: boolean;
  stopRequested: boolean;
  initialReady: boolean;
  reloadSignalPending: boolean;
  detectedPort: number | null;
}

const runtimes = new Map<string, AppRuntime>();
const listeners = new Map<string, Set<PreviewEventListener>>();
const projectQueues = new Map<string, Promise<void>>();

const reservedPorts = new Set<number>();
let portQueue: Promise<void> = Promise.resolve();

const POOL_START = parseInt(process.env.PREVIEW_PORT_START || "4001", 10);
const POOL_END = parseInt(process.env.PREVIEW_PORT_END || "4099", 10);
const MAX_CONCURRENT_PREVIEWS = parseInt(process.env.MAX_CONCURRENT_PREVIEWS || "10", 10);

const MAX_LOG_LINES = 200;
const READY_POLL_INTERVAL = 300;
const READY_HTTP_TIMEOUT = 1000;
const START_TIMEOUT_MS = parseInt(process.env.PREVIEW_START_TIMEOUT_MS || "30000", 10);
const STOP_TIMEOUT = 5000;
const FORCE_KILL_GRACE_MS = 1000;
const RELOAD_SIGNAL_TIMEOUT_MS = 10000;

const READY_PATTERN = /\b(listening|running|started|ready)\b/i;
const PORT_EXTRACT = /\bport\s+(\d+)\b/i;

const DOTENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_, ch: string) => {
    switch (ch) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case '"': return '"';
      case "\\": return "\\";
      default: return ch;
    }
  });
}

async function readDotEnvFromWorkspace(workspacePath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspacePath, ".env"), "utf-8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = rawLine.match(DOTENV_LINE_RE);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = unescapeDoubleQuoted(value.slice(1, -1));
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx);
      value = value.trimEnd();
    }
    out[key] = value;
  }
  return out;
}

function getOrCreateRuntime(projectKey: string, workspacePath?: string): AppRuntime {
  let runtime = runtimes.get(projectKey);
  if (!runtime) {
    runtime = {
      workspacePath: workspacePath ?? null,
      status: "stopped",
      process: null,
      port: null,
      pid: null,
      processGroupId: null,
      pkgMtime: 0,
      logBuffer: [],
      lastUsedAt: null,
      lastError: null,
      instanceId: null,
      hadProcess: false,
      stopRequested: false,
      initialReady: false,
      reloadSignalPending: false,
      detectedPort: null,
    };
    runtimes.set(projectKey, runtime);
  } else if (workspacePath) {
    runtime.workspacePath = workspacePath;
  }
  return runtime;
}

function toPreviewState(projectKey: string, runtime?: AppRuntime): PreviewState {
  if (!runtime) {
    return {
      projectKey,
      status: "stopped",
      running: false,
      port: null,
      pid: null,
      instanceId: null,
      hasProcess: false,
      lastError: null,
      lastUsedAt: null,
    };
  }
  return {
    projectKey,
    status: runtime.status,
    running: runtime.status === "running",
    port: runtime.port,
    pid: runtime.pid,
    instanceId: runtime.instanceId,
    hasProcess: runtime.hadProcess,
    lastError: runtime.lastError,
    lastUsedAt: runtime.lastUsedAt,
  };
}

function emitPreviewEvent(projectKey: string, event: PreviewEvent): void {
  const subs = listeners.get(projectKey);
  if (!subs || subs.size === 0) return;
  for (const listener of [...subs]) {
    try {
      listener(event);
    } catch (err) {
      console.warn(`[process] Preview listener failed for ${projectKey}:`, err);
    }
  }
}

function emitPreviewState(projectKey: string, runtime?: AppRuntime): void {
  emitPreviewEvent(projectKey, { type: "state", state: toPreviewState(projectKey, runtime ?? runtimes.get(projectKey)) });
}

function closeLogStream(stream?: fss.WriteStream): void {
  if (!stream) return;
  try { stream.end(); } catch { /* ignore */ }
}

function appendRuntimeLog(
  projectKey: string,
  instanceId: string,
  line: string,
  stream: "stdout" | "stderr",
  logCallback?: LogCallback,
): void {
  const runtime = runtimes.get(projectKey);
  if (!runtime || runtime.instanceId !== instanceId) return;

  const ts = new Date().toISOString();
  runtime.logBuffer.push(`[${ts}] [${stream}] ${line}`);
  if (runtime.logBuffer.length > MAX_LOG_LINES) runtime.logBuffer.shift();

  try {
    runtime.logStream?.write(`[${ts}] [${stream}] ${line}\n`);
  } catch {
    // Ignore log file write failures; they must not destabilize the supervisor.
  }

  try {
    logCallback?.(line, stream);
  } catch {
    // A caller log callback should not break process supervision.
  }

  emitPreviewEvent(projectKey, { type: "log", line, stream });
}

async function withProjectQueue<T>(projectKey: string, task: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(projectKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  projectQueues.set(projectKey, queued);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (projectQueues.get(projectKey) === queued) {
      projectQueues.delete(projectKey);
    }
  }
}

async function withPortQueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = portQueue.catch(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  portQueue = previous.then(() => gate);

  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function isActiveRuntime(runtime: AppRuntime): boolean {
  return runtime.status === "starting" || runtime.status === "running" || runtime.status === "stopping";
}

async function readProjectScripts(workspacePath: string): Promise<Record<string, string>> {
  try {
    const text = await fs.readFile(path.join(workspacePath, "package.json"), "utf-8");
    const pkg = JSON.parse(text);
    return (pkg?.scripts as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

// Best-effort mitigation for legacy projects on network storage.
//
// On a workspace root that is a mapped network drive, `vite build` has been seen
// to fail with a root spelled as the drive's UNC target:
//   [UNRESOLVED_ENTRY] Cannot resolve entry module ../../server/share/.../web/index.html
// The arithmetic is certain: vite computes its root as
// `normalizePath(path.resolve(config.root))`, and normalizePath is
// `path.posix.normalize(slash(id))`, which collapses the leading `\\` of a UNC
// path and destroys the server component. What is NOT established is which
// component canonicalises the drive letter into that UNC spelling in the first
// place — it is not npm, not vite's config loader, and not vite's JS-side
// realpath (all three verified to preserve the drive-letter spelling). The
// remaining suspect is rolldown's native Rust resolver, which cannot be observed
// from a `subst` drive because subst never yields a UNC path, and SMB loopback
// is blocked on the dev machine.
//
// Current templates sidestep the whole question by never reading __dirname (see
// the template's vite.config.js), but every project scaffolded before that keeps
// its own copy of the old config. For those, `--configLoader native` replaces
// the rolldown config bundling with a plain dynamic import, so the config's path
// only ever passes through Node's ESM loader — which resolves symlinks but not
// drive mappings. That makes it a plausible, zero-touch mitigation rather than a
// proven fix; the actual repair is rewriting the project's config.
//
// Scoped to non-local volumes and to the stock `vite build` script: an agent may
// have replaced the build with something that rejects vite's flags.
const STOCK_VITE_BUILD_RE = /(^|&&)\s*vite build\s*$/;

async function viteConfigLoaderArgs(workspacePath: string, buildScript: string): Promise<string[]> {
  if (!STOCK_VITE_BUILD_RE.test(buildScript)) return [];
  try {
    const volume = await classifyVolume(workspacePath);
    return isNonLocalVolume(volume) ? ["--", "--configLoader", "native"] : [];
  } catch {
    return []; // classification is best-effort; never block a build on it
  }
}

// Run `npm run build` once before spawning the preview, if the project has a
// build script. Vite-bundled templates output to public/, which server.js then
// serves statically. Old templates without a build script no-op.
async function maybeRunProjectBuild(
  workspacePath: string,
  projectKey: string,
  logCallback?: LogCallback,
): Promise<void> {
  const scripts = await readProjectScripts(workspacePath);
  if (!scripts.build) return;

  const emit = (line: string, stream: "stdout" | "stderr" = "stdout"): void => {
    try { logCallback?.(line, stream); } catch { /* ignore listener errors */ }
    console.log(`[${projectKey}] [build] ${line}`);
  };

  const args = ["run", "build", ...await viteConfigLoaderArgs(workspacePath, scripts.build)];

  emit(`npm ${args.join(" ")} (Vite frontend bundle)`);
  try {
    const { stdout, stderr } = await npm(args, {
      cwd: workspacePath,
      timeout: 5 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (stdout) stdout.split("\n").filter(Boolean).forEach((l) => emit(l, "stdout"));
    if (stderr) stderr.split("\n").filter(Boolean).forEach((l) => emit(l, "stderr"));
    emit("build complete");
  } catch (err: any) {
    if (err?.stdout) String(err.stdout).split("\n").filter(Boolean).forEach((l: string) => emit(l, "stdout"));
    if (err?.stderr) String(err.stderr).split("\n").filter(Boolean).forEach((l: string) => emit(l, "stderr"));
    throw new Error(`npm run build failed (exit ${err?.code ?? "?"}): ${err?.shortMessage ?? err?.message ?? String(err)}`);
  }
}

async function getPackageMtime(workspacePath: string): Promise<number> {
  try {
    const stat = await fs.stat(path.join(workspacePath, "package.json"));
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

async function reserveFreePort(): Promise<number> {
  return withPortQueue(async () => {
    for (let port = POOL_START; port <= POOL_END; port++) {
      if (reservedPorts.has(port)) continue;
      if (await isPortInUse(port)) continue;
      reservedPorts.add(port);
      return port;
    }
    return -1;
  });
}

async function releaseReservedPort(port: number | null): Promise<void> {
  if (port == null) return;
  await withPortQueue(async () => {
    reservedPorts.delete(port);
  });
}

async function finalizeRuntimeStopped(projectKey: string, runtime: AppRuntime, port: number | null): Promise<void> {
  runtime.status = "stopped";
  runtime.process = null;
  runtime.port = null;
  runtime.pid = null;
  runtime.processGroupId = null;
  runtime.instanceId = null;
  runtime.stopRequested = false;
  runtime.initialReady = false;
  runtime.reloadSignalPending = false;
  runtime.detectedPort = null;
  closeLogStream(runtime.logStream);
  runtime.logStream = undefined;
  await releaseReservedPort(port);
  emitPreviewState(projectKey, runtime);
}

async function handleChildExit(
  projectKey: string,
  instanceId: string,
  childPort: number,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  const runtime = runtimes.get(projectKey);
  // A stale exit (runtime gone or instance already replaced) means a
  // stop/replace was already processed, so it counts as requested too.
  const stopRequested = !runtime || runtime.instanceId !== instanceId || runtime.stopRequested;
  if (stopRequested) {
    appendRuntimeLog(projectKey, instanceId, `Process stopped (code=${code}, signal=${signal})`, "stdout");
  } else {
    appendRuntimeLog(projectKey, instanceId, `Process exited (code=${code}, signal=${signal})`, "stderr");
  }

  if (!runtime || runtime.instanceId !== instanceId) {
    await releaseReservedPort(childPort);
    return;
  }

  runtime.process = null;
  runtime.pid = null;
  runtime.processGroupId = null;
  runtime.port = null;
  runtime.instanceId = null;
  runtime.stopRequested = false;
  runtime.initialReady = false;
  runtime.reloadSignalPending = false;
  runtime.detectedPort = null;
  closeLogStream(runtime.logStream);
  runtime.logStream = undefined;

  runtime.status = stopRequested ? "stopped" : "crashed";
  if (!stopRequested) {
    runtime.lastError = `Process exited (code=${code}, signal=${signal})`;
  }

  await releaseReservedPort(childPort);
  emitPreviewState(projectKey, runtime);
}

async function terminateProcessGroup(child: ChildProcess, pid: number): Promise<void> {
  if (child.killed || !pid) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      child.removeListener("exit", onExit);
      resolve();
    };

    const onExit = () => finish();
    child.once("exit", onExit);

    try {
      if (IS_WINDOWS) {
        // taskkill /T walks the child tree; /F forces termination. There is
        // no graceful-then-force step on Windows — taskkill /F is the only
        // way to reliably kill `node.exe --watch` + any spawned children.
        void tryRun("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => { /* exit listener finalizes */ });
      } else {
        process.kill(-pid, "SIGTERM");
      }
    } catch {
      finish();
      return;
    }

    forceKillTimer = setTimeout(() => {
      try {
        if (IS_WINDOWS) {
          void tryRun("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => {});
        } else {
          process.kill(-pid, "SIGKILL");
        }
      } catch { /* ignore */ }
      setTimeout(finish, FORCE_KILL_GRACE_MS);
    }, STOP_TIMEOUT);
  });
}

async function maybeEmitReload(projectKey: string, instanceId: string): Promise<void> {
  const runtime = runtimes.get(projectKey);
  if (!runtime || runtime.instanceId !== instanceId || runtime.status !== "running" || runtime.reloadSignalPending) {
    return;
  }

  runtime.reloadSignalPending = true;
  try {
    const readyPort = await waitForRuntimeReady(projectKey, instanceId, runtime.port, runtime.processGroupId, RELOAD_SIGNAL_TIMEOUT_MS);
    const current = runtimes.get(projectKey);
    if (readyPort == null || !current || current.instanceId !== instanceId || current.status !== "running") return;
    emitPreviewEvent(projectKey, { type: "reload", state: toPreviewState(projectKey, current) });
    emitPreviewState(projectKey, current);
  } finally {
    const current = runtimes.get(projectKey);
    if (current && current.instanceId === instanceId) {
      current.reloadSignalPending = false;
    }
  }
}

async function startAppProcessInternal(
  workspacePath: string,
  projectKey: string,
  logCallback?: LogCallback,
): Promise<number> {
  const runtime = getOrCreateRuntime(projectKey, workspacePath);
  if (runtime.status === "running" && runtime.port != null) {
    runtime.lastUsedAt = Date.now();
    emitPreviewState(projectKey, runtime);
    return runtime.port;
  }

  if (!(await isNodeProject(workspacePath))) {
    runtime.workspacePath = workspacePath;
    runtime.lastError = null;
    emitPreviewState(projectKey, runtime);
    return -1;
  }

  runtime.workspacePath = workspacePath;
  runtime.status = "starting";
  runtime.lastError = null;
  runtime.lastUsedAt = Date.now();
  emitPreviewState(projectKey, runtime);

  try {
    await ensureDependencies(workspacePath, projectKey.split(":")[1] ?? "");
  } catch (err) {
    runtime.status = "crashed";
    runtime.lastError = `ensureDependencies failed: ${err}`;
    emitPreviewState(projectKey, runtime);
    appendRuntimeLog(projectKey, runtime.instanceId ?? "", `ensureDependencies failed: ${err}`, "stderr", logCallback);
    return -1;
  }

  await evictLruIfNeeded(projectKey);

  try {
    await maybeRunProjectBuild(workspacePath, projectKey, logCallback);
  } catch (err) {
    runtime.status = "crashed";
    runtime.lastError = `${err}`;
    emitPreviewState(projectKey, runtime);
    return -1;
  }

  const port = await reserveFreePort();
  if (port < 0) {
    runtime.status = "crashed";
    runtime.lastError = `No free preview port available in ${POOL_START}-${POOL_END}`;
    emitPreviewState(projectKey, runtime);
    return -1;
  }

  const pkgMtime = await getPackageMtime(workspacePath);
  const logFilePath = path.join(workspacePath, ".vca-server.log");
  const logStream = fss.createWriteStream(logFilePath, { flags: "w" });
  const instanceId = randomUUID();

  runtime.status = "starting";
  runtime.process = null;
  runtime.port = port;
  runtime.pid = null;
  runtime.processGroupId = null;
  runtime.pkgMtime = pkgMtime;
  runtime.logBuffer = [];
  runtime.logStream = logStream;
  runtime.lastUsedAt = Date.now();
  runtime.lastError = null;
  runtime.instanceId = instanceId;
  runtime.hadProcess = true;
  runtime.stopRequested = false;
  runtime.initialReady = false;
  runtime.reloadSignalPending = false;
  runtime.detectedPort = null;
  emitPreviewState(projectKey, runtime);

  const projectId = projectKey.split(":")[1] ?? "";
  const appName = `vca-app-${projectId.slice(0, 8)}`;
  const projectDotEnv = await readDotEnvFromWorkspace(workspacePath);
  // Admin-defined platform env vars (Settings → Environment), incl. decrypted
  // secrets. Layered explicitly (below) so secret-NAMED vars survive the
  // sanitizeChildEnv deny-list; the project's own .env still wins over them.
  const adminEnv = await getDecryptedEnvMap();
  let child: ChildProcess;
  // Packaged desktop: the bundled Node 24 (resources/runtime/node). Container/
  // dev: process.execPath is already `node`. electronAsNode is only true on the
  // fallback where execPath is the Electron binary.
  const { exe: appNodeExe, electronAsNode } = resolveAppNode();
  try {
    child = spawn(appNodeExe, ["--watch", "--watch-preserve-output", "server.js"], {
      cwd: workspacePath,
      // Linux: own process group so we can SIGTERM the whole tree via -pid.
      // Windows: `detached: true` opens a new console window for node.exe;
      // use `windowsHide` + taskkill /T for cross-process-tree termination.
      detached: !IS_WINDOWS,
      windowsHide: true,
      env: {
        ...sanitizeChildEnv(process.env),
        // Admin platform env vars — after the deny-list scrub so vars named with
        // an internal prefix aren't stripped; before the fixed/reserved vars and
        // projectDotEnv so those still win.
        ...adminEnv,
        PORT: String(port),
        // TLS verification is inherited from the server's global posture
        // (Settings → Network, applied to process.env by tls-config). A preview
        // app can still override it in its own .env (projectDotEnv, below).
        EXECENV: "DEV",
        APPNAME: appName,
        // Internal platform credentials (Azure / OpenAI / Anthropic / Google /
        // OpenRouter keys, Entra IDs) are intentionally NOT forwarded to preview
        // apps — sanitizeChildEnv above strips them. A generated app that needs
        // an API key must supply it via its own .env (projectDotEnv below).
        ...projectDotEnv,
        VCA_PREVIEW: "1",
        // Only needed on the fallback where the runtime resolved to the Electron
        // binary (no bundled node). ELECTRON_RUN_AS_NODE=1 makes it boot as plain
        // Node. With the bundled node.exe (normal packaged path) or `node`
        // (container/dev) this is omitted.
        ...(electronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    closeLogStream(logStream);
    runtime.status = "crashed";
    runtime.port = null;
    runtime.pid = null;
    runtime.processGroupId = null;
    runtime.instanceId = null;
    runtime.logStream = undefined;
    runtime.lastError = `Failed to spawn preview: ${err}`;
    await releaseReservedPort(port);
    emitPreviewState(projectKey, runtime);
    return -1;
  }

  runtime.process = child;
  runtime.pid = child.pid ?? null;
  runtime.processGroupId = child.pid ?? null;
  emitPreviewState(projectKey, runtime);

  const handleData = (stream: "stdout" | "stderr", chunk: Buffer, carry: { value: string }) => {
    carry.value += chunk.toString();
    const lines = carry.value.split("\n");
    carry.value = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      appendRuntimeLog(projectKey, instanceId, line, stream, logCallback);
      if (stream === "stdout") {
        const current = runtimes.get(projectKey);
        if (current && current.instanceId === instanceId && current.detectedPort == null) {
          const match = line.match(PORT_EXTRACT);
          if (match) {
            const detected = parseInt(match[1], 10);
            if (Number.isFinite(detected)) current.detectedPort = detected;
          }
        }
        if (READY_PATTERN.test(line)) {
          void maybeEmitReload(projectKey, instanceId);
        }
      }
    }
  };

  if (child.stdout) {
    const carry = { value: "" };
    child.stdout.on("data", (chunk: Buffer) => handleData("stdout", chunk, carry));
  }
  if (child.stderr) {
    const carry = { value: "" };
    child.stderr.on("data", (chunk: Buffer) => handleData("stderr", chunk, carry));
  }

  child.on("exit", (code, signal) => {
    void handleChildExit(projectKey, instanceId, port, code, signal);
  });

  appendRuntimeLog(projectKey, instanceId, `[supervisor] Starting preview on port ${port}`, "stdout", logCallback);
  const readyPort = await waitForRuntimeReady(projectKey, instanceId, port, child.pid ?? null, START_TIMEOUT_MS);
  const current = runtimes.get(projectKey);
  if (readyPort == null || !current || current.instanceId !== instanceId) {
    if (current && current.instanceId === instanceId) {
      current.lastError = `Preview did not become ready on port ${port} within ${START_TIMEOUT_MS}ms`;
    }
    if (child.pid) {
      await terminateProcessGroup(child, child.pid);
    } else {
      await releaseReservedPort(port);
    }
    return -1;
  }

  if (readyPort !== port) {
    appendRuntimeLog(projectKey, instanceId, `[supervisor] App ignored PORT=${port}, switching to detected port ${readyPort}`, "stdout", logCallback);
    await releaseReservedPort(port);
    current.port = readyPort;
  }
  current.status = "running";
  current.initialReady = true;
  current.lastUsedAt = Date.now();
  emitPreviewState(projectKey, current);
  return readyPort;
}

async function stopAppProcessInternal(projectKey: string): Promise<void> {
  const runtime = runtimes.get(projectKey);
  if (!runtime) return;

  if (!runtime.process || !runtime.instanceId || !runtime.pid) {
    const port = runtime.port;
    await finalizeRuntimeStopped(projectKey, runtime, port);
    return;
  }

  runtime.status = "stopping";
  runtime.stopRequested = true;
  emitPreviewState(projectKey, runtime);

  const { process: child, pid, instanceId, port } = runtime;
  await terminateProcessGroup(child, pid);
  await waitForPortReleased(port, 5000);

  const current = runtimes.get(projectKey);
  if (!current || current.instanceId !== instanceId) return;
  await finalizeRuntimeStopped(projectKey, current, port);
}

async function waitForRuntimeReady(
  projectKey: string,
  instanceId: string,
  port: number | null,
  processGroupId: number | null,
  timeoutMs: number,
): Promise<number | null> {
  if (port == null || processGroupId == null) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = runtimes.get(projectKey);
    if (!runtime || runtime.instanceId !== instanceId) return null;

    const candidates = new Set<number>();
    candidates.add(port);
    if (runtime.detectedPort != null) candidates.add(runtime.detectedPort);

    for (const candidate of candidates) {
      // Linux: confirm the listening pid belongs to our spawned group so we
      // don't false-positive on some other process binding the port. Windows
      // and macOS have no /proc+ss equivalent; the in-memory port reservation
      // and the child process being alive are sufficient — fall through to
      // the HTTP probe directly.
      const ownsPort = IS_LINUX
        ? await isPortOwnedByProcessGroup(candidate, processGroupId)
        : isChildAlive(projectKey, instanceId);
      if (ownsPort && await isHttpReady(candidate)) return candidate;
    }

    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL));
  }
  return null;
}

function isChildAlive(projectKey: string, instanceId: string): boolean {
  const runtime = runtimes.get(projectKey);
  if (!runtime || runtime.instanceId !== instanceId) return false;
  const child = runtime.process;
  return !!child && child.exitCode == null && child.signalCode == null;
}

async function getListeningPids(port: number): Promise<Set<number>> {
  const pids = new Set<number>();
  try {
    const { stdout } = await execAsync(`ss -ltnp 'sport = :${port}' 2>/dev/null`);
    for (const match of stdout.matchAll(/pid=(\d+)/g)) {
      pids.add(parseInt(match[1], 10));
    }
  } catch {
    // Ignore missing ss output and treat as no listeners.
  }
  return pids;
}

async function getProcessGroupId(pid: number): Promise<number | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf-8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const rest = stat.slice(close + 2).trim().split(/\s+/);
    const pgrp = parseInt(rest[2], 10);
    return Number.isFinite(pgrp) ? pgrp : null;
  } catch {
    return null;
  }
}

async function isPortOwnedByProcessGroup(port: number, processGroupId: number): Promise<boolean> {
  const pids = await getListeningPids(port);
  if (pids.size === 0) return false;
  for (const pid of pids) {
    const pgid = await getProcessGroupId(pid);
    if (pgid === processGroupId) return true;
  }
  return false;
}

async function isHttpReady(port: number): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", reject);
      req.setTimeout(READY_HTTP_TIMEOUT, () => {
        req.destroy();
        reject(new Error("timeout"));
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForPortReleased(port: number | null, timeoutMs: number): Promise<boolean> {
  if (port == null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL));
  }
  return false;
}

async function evictLruIfNeeded(newKey: string): Promise<void> {
  const active = [...runtimes.entries()].filter(([, runtime]) => runtime.status === "running");
  if (active.length < MAX_CONCURRENT_PREVIEWS) return;

  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [key, runtime] of active) {
    if (key === newKey) continue;
    const ts = runtime.lastUsedAt ?? 0;
    if (ts < oldestTs) {
      oldestTs = ts;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    console.log(`[process] Evicting LRU preview ${oldestKey} to make room for ${newKey}`);
    await stopAppProcess(oldestKey);
  }
}

async function listPreviewProcessPidsFromProc(): Promise<Set<number>> {
  const pids = new Set<number>();
  try {
    const entries = await fs.readdir("/proc", { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = parseInt(entry.name, 10);
      if (pid === process.pid) continue;
      try {
        const environ = await fs.readFile(`/proc/${pid}/environ`);
        if (environ.includes(Buffer.from("VCA_PREVIEW=1"))) {
          pids.add(pid);
        }
      } catch {
        // Ignore unreadable proc entries.
      }
    }
  } catch {
    // Ignore /proc read failures.
  }
  return pids;
}

async function listPreviewProcessPidsFromPorts(): Promise<Set<number>> {
  const pids = new Set<number>();
  try {
    const { stdout } = await execAsync(
      `ss -tlnp 'sport >= ${POOL_START} and sport <= ${POOL_END}' 2>/dev/null`,
    );
    for (const match of stdout.matchAll(/pid=(\d+)/g)) {
      const pid = parseInt(match[1], 10);
      if (pid !== process.pid) pids.add(pid);
    }
  } catch {
    // Ignore missing ss output.
  }
  return pids;
}

/**
 * Check whether a workspace looks like a Node.js project (has server.js + package.json).
 */
export async function isNodeProject(workspacePath: string): Promise<boolean> {
  try {
    await Promise.all([
      fs.access(path.join(workspacePath, "server.js")),
      fs.access(path.join(workspacePath, "package.json")),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function getPreviewState(projectKey: string): PreviewState {
  return toPreviewState(projectKey, runtimes.get(projectKey));
}

export function subscribePreviewEvents(projectKey: string, listener: PreviewEventListener): () => void {
  let subs = listeners.get(projectKey);
  if (!subs) {
    subs = new Set();
    listeners.set(projectKey, subs);
  }
  subs.add(listener);
  return () => {
    const current = listeners.get(projectKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(projectKey);
  };
}

/**
 * Get the port of a running app process, or null if not running.
 */
export function getAppProcessPort(projectKey: string): number | null {
  const runtime = runtimes.get(projectKey);
  if (!runtime || runtime.status !== "running") return null;
  return runtime.port;
}

/**
 * Whether a preview process exists or has existed in this backend instance.
 */
export function hasAssignedPort(projectKey: string): boolean {
  const runtime = runtimes.get(projectKey);
  return !!runtime && (runtime.hadProcess || isActiveRuntime(runtime) || runtime.status === "crashed");
}

/**
 * Get recent log output from the app process.
 */
export function getAppProcessLogs(projectKey: string): string {
  const runtime = runtimes.get(projectKey);
  return runtime ? runtime.logBuffer.join("\n") : "";
}

/**
 * Clear the in-memory log buffer for a project's app process. The process keeps
 * running and new log lines will accumulate fresh. No-op if no runtime exists.
 */
export function clearAppProcessLogs(projectKey: string): void {
  const runtime = runtimes.get(projectKey);
  if (runtime) runtime.logBuffer = [];
}

/**
 * Start a Node.js app process for a project workspace.
 * Returns the allocated port, or -1 if the workspace is not a Node project.
 */
export async function startAppProcess(
  workspacePath: string,
  projectKey: string,
  logCallback?: LogCallback,
): Promise<number> {
  return withProjectQueue(projectKey, () => startAppProcessInternal(workspacePath, projectKey, logCallback));
}

/**
 * Bump the lastUsedAt timestamp for a project's preview process.
 */
export function touchProcess(projectKey: string): void {
  const runtime = runtimes.get(projectKey);
  if (!runtime || runtime.status !== "running") return;
  runtime.lastUsedAt = Date.now();
}

/**
 * Stop a running app process. Kills the entire process group to free the TCP port.
 */
export async function stopAppProcess(projectKey: string): Promise<void> {
  await withProjectQueue(projectKey, () => stopAppProcessInternal(projectKey));
}

/**
 * Release a project's runtime state permanently (e.g. on project deletion).
 */
export function releasePort(projectKey: string): void {
  const runtime = runtimes.get(projectKey);
  if (runtime?.port != null) {
    void releaseReservedPort(runtime.port);
  }
  runtimes.delete(projectKey);
  listeners.delete(projectKey);
}

/**
 * Recursive fs.rm with short retries for transient Windows lock errors.
 *
 * ENOTEMPTY/EBUSY show up mid-delete under concurrency; EPERM/EACCES appear when
 * the OS (or AV, or a still-open handle from a live agent session) briefly holds
 * a file inside the tree — the classic "operation not permitted, rmdir" on
 * Windows. All are transient, so back off and retry rather than surface them.
 */
const RM_TRANSIENT_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"]);
export async function rmRetry(target: string, opts: { recursive?: boolean; force?: boolean }): Promise<void> {
  const delays = [50, 150, 400, 1000];
  for (let i = 0; i <= delays.length; i++) {
    try {
      await fs.rm(target, opts);
      return;
    } catch (err: any) {
      if (!RM_TRANSIENT_CODES.has(err?.code)) throw err;
      if (i === delays.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
  }
}

/**
 * Restart the app process. This always performs a deterministic stop/start cycle.
 */
export async function restartAppProcess(
  workspacePath: string,
  projectKey: string,
  logCallback?: LogCallback,
): Promise<number> {
  return withProjectQueue(projectKey, async () => {
    const runtime = getOrCreateRuntime(projectKey, workspacePath);
    const currentPkgMtime = await getPackageMtime(workspacePath);
    const needsDependencyReset = runtime.pkgMtime > 0 && currentPkgMtime > runtime.pkgMtime;

    await stopAppProcessInternal(projectKey);
    if (needsDependencyReset) {
      await clearNodeModules(projectKey.split(":")[1] ?? "", workspacePath);
    }
    return startAppProcessInternal(workspacePath, projectKey, logCallback);
  });
}

/**
 * Check whether a TCP port is currently in use.
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Stop all running preview processes (used during graceful shutdown).
 */
export async function shutdownAll(): Promise<void> {
  const keys = [...runtimes.keys()];
  if (keys.length === 0) return;
  console.log(`[process] Shutting down ${keys.length} preview processes`);
  await Promise.allSettled(keys.map((key) => stopAppProcess(key)));
}

/**
 * Kill orphaned preview processes left over from a previous server instance.
 */
export async function cleanupOrphanedProcesses(): Promise<void> {
  if (process.platform !== "linux") return;

  const pids = new Set<number>();
  for (const pid of await listPreviewProcessPidsFromProc()) pids.add(pid);
  for (const pid of await listPreviewProcessPidsFromPorts()) pids.add(pid);

  const processGroups = new Set<number>();
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const pgid = await getProcessGroupId(pid);
    if (pgid && pgid !== process.pid) {
      processGroups.add(pgid);
      continue;
    }
  }

  for (const pgid of processGroups) {
    try {
      console.log(`[process] Killing orphaned preview process group ${pgid}`);
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Ignore already-dead process groups.
    }
  }

  for (const pid of pids) {
    if (pid === process.pid) continue;
    const pgid = await getProcessGroupId(pid);
    if (pgid && pgid !== process.pid) continue;
    try {
      console.log(`[process] Killing orphaned preview process ${pid}`);
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore already-dead processes.
    }
  }
}
