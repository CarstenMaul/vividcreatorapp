import { randomUUID } from "crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import { systemPaths, PROJECT_ICON_FILENAME } from "./paths.js";
import { withGitLock } from "./git-lock.js";
import { parseVersion, DEFAULT_APP_VERSION } from "./app-version.js";
import { stopAppProcess, rmRetry } from "./app-process-manager.js";
import { getDecryptedEnvMap } from "./env-vars-store.js";
import { git, tryGit, tryRun } from "./exec-utils.js";
import { bundledGitExe, resolveNpm } from "./bundled-runtime.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * Per-project deployment orchestration.
 *
 * The runner spawns + supervises one or more child processes for each
 * deployment action (Electron build, Git tag/push),
 * mirrors stdout/stderr to an in-memory ring buffer + on-disk log + SSE
 * listeners, and keeps a singleton per (projectKey, kind) so duplicate
 * clicks become 409.
 *
 * Each action takes a `workspacePath` (the project's directory) and a
 * `projectKey` (`<userId>:<projectId>`); operations are scoped to that
 * project, not the icode platform's own checkout.
 */

export type JobKind =
  | "electron-win"
  | "electron-mac"
  | "electron-linux"
  | "git-release";

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

/** Windows packaging: assisted NSIS installer or standalone portable exe. */
export type ElectronWinFormat = "installer" | "portable";

export interface PlatformJobState {
  jobId: string;
  kind: JobKind;
  projectKey: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  exitCode: number | null;
  // Only set by git-release after the bump completes.
  version?: string;
  tag?: string;
  // Only set by electron-win: the requested Windows packaging.
  format?: ElectronWinFormat;
}

export type JobEvent =
  | { type: "state"; state: PlatformJobState }
  | { type: "log"; line: string; stream: "stdout" | "stderr" };

type JobListener = (event: JobEvent) => void;

interface JobRecord {
  state: PlatformJobState;
  logRing: string[];
  logStream: fss.WriteStream;
  child: ChildProcess | null;
  cancelRequested: boolean;
}

const MAX_LOG_LINES = 500;
const STOP_TIMEOUT_MS = 5000;
const FORCE_KILL_GRACE_MS = 1000;

/** Active or last-completed job keyed by `${projectKey}:${kind}`. */
const jobsByScope: Map<string, JobRecord> = new Map();
/** SSE listeners keyed by jobId. */
const listeners: Map<string, Set<JobListener>> = new Map();
/** Singleton mutex per scope so we never have two running same-scope jobs. */
const startGuards: Map<string, Promise<unknown>> = new Map();

function scopeKey(projectKey: string, kind: JobKind): string {
  return `${projectKey}:${kind}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Public read accessors

export function getActiveJob(projectKey: string, kind: JobKind): PlatformJobState | null {
  const rec = jobsByScope.get(scopeKey(projectKey, kind));
  return rec ? rec.state : null;
}

export function getJobByIdState(jobId: string): PlatformJobState | null {
  for (const rec of jobsByScope.values()) {
    if (rec.state.jobId === jobId) return rec.state;
  }
  return null;
}

export function getJobLogBuffer(jobId: string): string[] {
  for (const rec of jobsByScope.values()) {
    if (rec.state.jobId === jobId) return [...rec.logRing];
  }
  return [];
}

export function getJobLogPath(jobId: string): string {
  return path.join(systemPaths.platformReleaseLogs(), `${jobId}.log`);
}

export function getProjectActiveJobs(projectKey: string): Record<JobKind, PlatformJobState | null> {
  const out = {
    "electron-win": null,
    "electron-mac": null,
    "electron-linux": null,
    "git-release": null,
  } as Record<JobKind, PlatformJobState | null>;
  for (const k of Object.keys(out) as JobKind[]) {
    const rec = jobsByScope.get(scopeKey(projectKey, k));
    if (rec) out[k] = rec.state;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// SSE subscription

export function subscribePlatformReleaseEvents(jobId: string, listener: JobListener): () => void {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(listener);
  return () => {
    const s = listeners.get(jobId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listeners.delete(jobId);
  };
}

function emit(jobId: string, event: JobEvent): void {
  const set = listeners.get(jobId);
  if (!set) return;
  for (const l of set) {
    try { l(event); } catch { /* ignore listener errors */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Job lifecycle

async function ensureLogsDir(): Promise<void> {
  await fs.mkdir(systemPaths.platformReleaseLogs(), { recursive: true });
}

async function createJobRecord(projectKey: string, kind: JobKind): Promise<JobRecord> {
  await ensureLogsDir();
  const jobId = randomUUID();
  const logPath = path.join(systemPaths.platformReleaseLogs(), `${jobId}.log`);
  const logStream = fss.createWriteStream(logPath, { flags: "w" });
  const state: PlatformJobState = {
    jobId,
    kind,
    projectKey,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    exitCode: null,
  };
  const rec: JobRecord = { state, logRing: [], logStream, child: null, cancelRequested: false };
  jobsByScope.set(scopeKey(projectKey, kind), rec);
  emit(jobId, { type: "state", state });
  return rec;
}

function appendLog(rec: JobRecord, line: string, stream: "stdout" | "stderr"): void {
  rec.logRing.push(line);
  if (rec.logRing.length > MAX_LOG_LINES) rec.logRing.splice(0, rec.logRing.length - MAX_LOG_LINES);
  try { rec.logStream.write(line + "\n"); } catch { /* ignore */ }
  emit(rec.state.jobId, { type: "log", line, stream });
}

function logEcho(rec: JobRecord, line: string): void {
  appendLog(rec, line, "stdout");
}

function finalizeJob(rec: JobRecord, status: JobStatus, error: string | null, exitCode: number | null): void {
  rec.state.status = status;
  rec.state.finishedAt = new Date().toISOString();
  rec.state.error = error;
  rec.state.exitCode = exitCode;
  try { rec.logStream.end(); } catch { /* ignore */ }
  emit(rec.state.jobId, { type: "state", state: rec.state });
}

// ─────────────────────────────────────────────────────────────────────────
// Child process supervision

interface SpawnRunOptions extends SpawnOptions {
  label?: string;
}

/**
 * Map a logical command name onto a real executable, so runCmd never needs a
 * shell. `npm` matters twice over: it ships as npm.cmd on Windows, which Node
 * refuses to spawn without `shell: true`, and a shell means cmd.exe, which
 * cannot hold a UNC working directory. See src/exec-utils.ts for the full story.
 */
function resolveCommand(command: string, args: string[]): { file: string; argv: string[] } {
  if (command === "npm") {
    const { exe, prefixArgs } = resolveNpm();
    return { file: exe, argv: [...prefixArgs, ...args] };
  }
  if (command === "git") return { file: bundledGitExe() ?? "git", argv: args };
  return { file: command, argv: args };
}

async function runCmd(
  rec: JobRecord,
  command: string,
  args: string[],
  opts: SpawnRunOptions = {},
): Promise<number> {
  const label = opts.label || [command, ...args].join(" ");
  logEcho(rec, `$ ${label}`);

  const { file, argv } = resolveCommand(command, args);

  let child: ChildProcess;
  try {
    child = spawn(file, argv, {
      ...opts,
      detached: !IS_WINDOWS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Never a shell. Under `shell`, Node joins argv with plain spaces and no
      // quoting, so `git commit -m "release v1.2.3"` reached git as `-m release`
      // plus a stray pathspec — every Windows release commit was malformed.
      shell: false,
    });
  } catch (err: any) {
    appendLog(rec, `[spawn failed] ${err?.message || String(err)}`, "stderr");
    return -1;
  }

  rec.child = child;

  const handleData = (stream: "stdout" | "stderr", carry: { value: string }) => (chunk: Buffer) => {
    carry.value += chunk.toString();
    const lines = carry.value.split("\n");
    carry.value = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.length === 0) continue;
      appendLog(rec, trimmed, stream);
    }
  };

  const stdoutCarry = { value: "" };
  const stderrCarry = { value: "" };
  if (child.stdout) child.stdout.on("data", handleData("stdout", stdoutCarry));
  if (child.stderr) child.stderr.on("data", handleData("stderr", stderrCarry));

  const code = await new Promise<number>((resolve) => {
    child.on("error", (err) => {
      appendLog(rec, `[child error] ${err.message}`, "stderr");
      resolve(-1);
    });
    child.on("exit", (code, signal) => {
      if (stdoutCarry.value.length > 0) appendLog(rec, stdoutCarry.value, "stdout");
      if (stderrCarry.value.length > 0) appendLog(rec, stderrCarry.value, "stderr");
      if (code != null) resolve(code);
      else if (signal != null) resolve(-1);
      else resolve(-1);
    });
  });

  rec.child = null;
  return code;
}

async function terminateGroup(child: ChildProcess, pid: number): Promise<void> {
  if (child.killed || !pid) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      child.removeListener("exit", onExit);
      resolve();
    };
    const onExit = () => finish();
    child.once("exit", onExit);
    try {
      if (IS_WINDOWS) void tryRun("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => { /* exit listener finalizes */ });
      else process.kill(-pid, "SIGTERM");
    } catch {
      finish();
      return;
    }
    forceTimer = setTimeout(() => {
      try {
        if (IS_WINDOWS) void tryRun("taskkill", ["/pid", String(pid), "/T", "/F"]).catch(() => {});
        else process.kill(-pid, "SIGKILL");
      } catch { /* ignore */ }
      setTimeout(finish, FORCE_KILL_GRACE_MS);
    }, STOP_TIMEOUT_MS);
  });
}

export async function cancelJob(projectKey: string, kind: JobKind): Promise<PlatformJobState | null> {
  const rec = jobsByScope.get(scopeKey(projectKey, kind));
  if (!rec || rec.state.status !== "running") return rec ? rec.state : null;
  rec.cancelRequested = true;
  const child = rec.child;
  if (child && child.pid) {
    appendLog(rec, "[cancel] terminating child process group...", "stderr");
    await terminateGroup(child, child.pid);
  }
  return rec.state;
}

// ─────────────────────────────────────────────────────────────────────────
// Singleton start guard

async function withStartGuard<T>(projectKey: string, kind: JobKind, fn: () => Promise<T>): Promise<T> {
  const sk = scopeKey(projectKey, kind);
  const existing = jobsByScope.get(sk);
  if (existing && existing.state.status === "running") {
    throw Object.assign(new Error(`Job ${kind} for ${projectKey} is already running`), {
      code: "JOB_ALREADY_RUNNING",
      activeJob: existing.state,
    });
  }
  const prev = startGuards.get(sk) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  startGuards.set(sk, next.catch(() => undefined));
  return next;
}

// Filesystem- and appId-safe slug derived from a display name: collapse any
// run of disallowed characters to a single "-", trim leading/trailing "-"/"."
// and fall back to a stable default. Used for the installer filename, the
// appId suffix (when no UUID), the session-partition key, and the static
// web-export artifact names (so all release/ artifacts share one convention).
export function slugifyAppName(name: string): string {
  return (name || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    || "vca-app";
}

// Reads the human-readable name and stable UUID that VCA records for each
// project in its workspace `project.yaml` (written by agent-manager at project
// creation/rename). Mirrors that file's double-quoted-scalar format. Returns an
// empty object when the file or a key is absent so callers can fall back.
async function readProjectIdentity(workspacePath: string): Promise<{ name?: string; uuid?: string }> {
  try {
    const yaml = await fs.readFile(path.join(workspacePath, "project.yaml"), "utf-8");
    const pick = (key: string): string | undefined => {
      const m = yaml.match(new RegExp(`^${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"));
      if (!m) return undefined;
      const v = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
      return v || undefined;
    };
    return { name: pick("application_name"), uuid: pick("application_uuid") };
  } catch {
    return {};
  }
}

/**
 * `.cjs` extension forces CommonJS regardless of the project's package.json
 * `type` field. We use CommonJS for the Electron bootstrap so it works
 * whether the user project is ESM (`"type": "module"`) or CJS — every
 * default-app-template ships as ESM, so this matters in practice.
 *
 * Boots the user's `server.js` as a child Node process under the Electron
 * binary (ELECTRON_RUN_AS_NODE=1). We do NOT in-process-require server.js:
 * if the user's server has uncaught errors or stays open on dependencies
 * we don't bundle (like better-sqlite3), an in-process crash would kill
 * the BrowserWindow too. The subprocess inherits stdio so its logs land
 * in the Electron console.
 *
 * Hardening, all keyed off `appKey` (the rename-stable project UUID; name
 * slug for legacy projects without project.yaml):
 *  - Stable preferred port derived from appKey, so the app keeps one web
 *    origin — and thus its localStorage/IndexedDB — across launches.
 *  - Session partition keyed by appKey (not the generic package.json name,
 *    which is "app" for most projects and would collide across apps).
 *  - The server binds loopback only (BIND_HOST) and requires a per-launch
 *    access token (APP_ACCESS_TOKEN env + vca_app_token cookie), so nothing
 *    but this Electron shell — in particular no other local process — can
 *    use it.
 *
 * Exported for the build-time verification harness; production callers go
 * through ensureElectronScaffold.
 */
export function renderElectronMainCjs(appKey: string, displayName: string, adminEnv: Record<string, string> = {}): string {
  // Window title bar text = the app's real name. Emitted as a JSON string so
  // quotes/backslashes form a valid JS string literal in the generated .cjs.
  const titleLiteral = JSON.stringify(displayName || "vca-app");
  // Admin platform env vars baked into the desktop app (plaintext is acceptable
  // here — the deployed Electron app is single-user on its own machine). Emitted
  // as a JS object literal; env keys are validated to [A-Za-z_][A-Za-z0-9_]* so
  // JSON is safe. Reserved vars (PORT, BIND_HOST, APP_ACCESS_TOKEN, …) are
  // never present.
  const adminEnvLiteral = JSON.stringify(adminEnv || {});
  return `// Auto-generated by VCA "Deploy as Electron app". Do not edit — regenerated
// every build. Wraps server.js in an Electron BrowserWindow and waits for
// the HTTP listener to come up before loading it.
const { app, BrowserWindow, Menu, session, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const net = require("net");
const path = require("path");

// Rename-stable per-project key (project UUID; name slug for legacy
// projects). Seeds the session partition and the preferred-port sequence.
const APP_KEY = ${JSON.stringify(appKey)};

// Per-app partition so cookies/localStorage cannot bleed in from a
// concurrently-running VCA host or another generated app.
const PARTITION = "persist:vca-app-" + APP_KEY;

// Per-launch secret shared with the server child. createWindow() plants it
// as an httpOnly cookie in this window's session; server.js (its
// APP_ACCESS_TOKEN guard) rejects every request without it, so other local
// processes cannot use the app's server.
const ACCESS_TOKEN = crypto.randomBytes(32).toString("hex");

let serverProcess = null;
let mainWindow = null;

// Deterministic preferred-port sequence derived from APP_KEY, kept in
// 20000-44999 (below Windows' default ephemeral range, so squatters are
// rare). Same machine + same app -> same port -> same origin, which is
// what keeps client-side storage alive across launches.
function candidatePort(i) {
  const h = crypto.createHash("sha256").update(APP_KEY).digest().readUInt32BE(0);
  return 20000 + ((h + i * 769) % 25000);
}

// True if the port can be bound on loopback right now. It is freed again
// immediately; the tiny race until server.js re-binds it is acceptable.
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

// Ask the OS for a free ephemeral port — last resort when the whole
// preferred sequence is taken (origin stability is lost for that launch
// only; the next launch retries the preferred sequence).
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = (addr && typeof addr === "object") ? addr.port : 0;
      srv.close(() => p ? resolve(p) : reject(new Error("failed to read ephemeral port")));
    });
  });
}

async function resolvePort() {
  // Honour an explicit PORT (e.g. when running inside Docker behind a
  // fixed-port reverse proxy); otherwise walk the preferred sequence.
  if (process.env.PORT) return parseInt(process.env.PORT, 10);
  for (let i = 0; i < 10; i++) {
    const p = candidatePort(i);
    if (await portFree(p)) return p;
  }
  return pickFreePort();
}

function startServer(port) {
  // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes
  // it boot as plain Node and execute server.js directly.
  serverProcess = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname,
    // Admin platform env vars layered before the fixed vars so PORT etc. win.
    // BIND_HOST keeps the server loopback-only; APP_ACCESS_TOKEN arms its
    // access guard (matched by the cookie set in createWindow).
    env: Object.assign({}, process.env, ${adminEnvLiteral}, {
      PORT: String(port),
      BIND_HOST: "127.0.0.1",
      APP_ACCESS_TOKEN: ACCESS_TOKEN,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    }),
    stdio: "inherit",
    windowsHide: true,
  });
  serverProcess.on("exit", (code) => {
    console.error("[vca-electron] server exited with code", code);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
}

function waitForListener(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      // Any HTTP response proves the listener is up — the access guard
      // answers this cookie-less probe with 401, which is fine.
      const req = http.get({ host: "127.0.0.1", port: port, path: "/", timeout: 800 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("server did not come up in " + timeoutMs + "ms"));
        else setTimeout(tick, 250);
      });
      req.on("timeout", () => { req.destroy(); });
    };
    tick();
  });
}

async function createWindow(port) {
  // Remove the default File/Edit/View/Help menu — the generated app is a
  // single-purpose window. Null disables the Alt-key fallback that
  // autoHideMenuBar would leave in place.
  Menu.setApplicationMenu(null);
  const ses = session.fromPartition(PARTITION);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: ${titleLiteral},
    webPreferences: { session: ses },
  });
  // Keep the window title as the app's real name. The served page ships a
  // generic <title>, which Electron would otherwise copy onto the window.
  mainWindow.on("page-title-updated", (e) => e.preventDefault());
  const origin = "http://127.0.0.1:" + port;
  // Keep the window on the app: external links open in the system browser,
  // anything else is dropped.
  const openExternal = (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === origin || url.startsWith(origin + "/")) return { action: "allow" };
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === origin || url.startsWith(origin + "/")) return;
    event.preventDefault();
    openExternal(url);
  });
  try {
    await waitForListener(port, 20000);
    // The access cookie must be in place before the first document request;
    // httpOnly so page script cannot read the token.
    await ses.cookies.set({ url: origin, name: "vca_app_token", value: ACCESS_TOKEN, httpOnly: true });
    await mainWindow.loadURL(origin);
  } catch (err) {
    await mainWindow.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(
        "<h2>Server did not start</h2><pre>" + String(err) + "</pre>"
      )
    );
  }
}

// Single instance per app: a second launch focuses the running window
// instead of racing for the next port in the sequence (which would land on
// a fresh origin with empty storage).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const port = await resolvePort();
    startServer(port);
    await createWindow(port);
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(port); });
  });
}

app.on("window-all-closed", () => {
  if (serverProcess) { try { serverProcess.kill(); } catch (e) { /* ignore */ } }
  if (process.platform !== "darwin") app.quit();
});

process.on("exit", () => {
  if (serverProcess) { try { serverProcess.kill(); } catch (e) { /* ignore */ } }
});
`;
}

/**
 * Electron-builder config matching VCA's own packaging style:
 *  - Windows: assisted NSIS installer (per-user, choose-folder wizard) or,
 *    per `winFormat`, a standalone portable exe (single file, no install —
 *    self-extracts to a temp dir on each launch and cleans up on exit)
 *  - DMG on macOS, AppImage on Linux
 *  - asar disabled so spawn() can read server.js + node_modules directly
 *    from the on-disk app folder (asar archives are opaque to child_process)
 *  - npmRebuild so native modules compile against Electron's Node ABI
 *
 * Exported for the build-time verification harness; production callers go
 * through ensureElectronScaffold.
 */
export function renderElectronBuilderYml(displayName: string, appUuid?: string, hasIcon = false, winFormat: ElectronWinFormat = "installer"): string {
  const slug = slugifyAppName(displayName);
  // When the project has an app icon we place it at build/icon.png before the
  // build; referencing it per-platform makes electron-builder generate the
  // Windows .ico (installer + installed app), the macOS .icns, and the Linux png.
  const iconLine = hasIcon ? "\n  icon: build/icon.png" : "";
  // appId is tied to the project's stable UUID so each project is a distinct
  // app (no cross-project collisions / accidental in-place overwrites); fall
  // back to the slug when no UUID is available.
  const appIdSuffix = (appUuid && appUuid.replace(/[^A-Za-z0-9.-]/g, "-")) || slug;
  // Distinct artifact suffixes (-setup- / -portable-) let an installer and a
  // portable exe of the same version coexist in release/. The nsis options
  // block is emitted only for the installer target (portable ignores it).
  const winSection = winFormat === "portable"
    ? `win:${iconLine}
  target:
    - target: portable
      arch: x64
  artifactName: ${slug}-\${version}-portable-\${arch}.\${ext}`
    : `win:${iconLine}
  target:
    - target: nsis
      arch: x64
  artifactName: ${slug}-\${version}-setup-\${arch}.\${ext}
nsis:
  oneClick: false
  perMachine: false
  allowElevation: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  runAfterFinish: true`;
  // productName is the human-readable app name (window title, installed program,
  // Start-Menu shortcut, and .exe base name). Emit via JSON.stringify so spaces
  // or quotes form a valid YAML double-quoted scalar.
  return `appId: com.vca.project.${appIdSuffix}
productName: ${JSON.stringify(displayName || "vca-app")}
copyright: Copyright VCA
directories:
  output: release
files:
  - "**/*"
  - "!**/*.map"
  - "!**/.git/**"
  - "!**/.vca-*"
  # Agent memory is committed with the project (so it survives a clone) but can
  # hold internal notes and user preferences — keep it out of shipped installers.
  - "!**/project.md"
  - "!**/release/**"
  - "!**/win-unpacked/**"
  - "!**/mac/**"
  - "!**/linux-unpacked/**"
asar: false
npmRebuild: true
${winSection}
mac:${iconLine}
  target:
    - target: dmg
      arch:
        - x64
        - arm64
  artifactName: ${slug}-\${version}-\${arch}.\${ext}
linux:${iconLine}
  target:
    - target: AppImage
      arch: x64
  artifactName: ${slug}-\${version}-\${arch}.\${ext}
`;
}

/**
 * Replacement for electron-builder's stock NSIS portable stub
 * (app-builder-lib/templates/nsis/portable.nsi).
 *
 * The stock stub re-extracts the entire embedded app package (hundreds of MB
 * with asar:false) into a fresh temp dir on EVERY launch and deletes it on
 * exit, so every start of a portable app pays the full extraction — minutes
 * on AV-scanned machines. This variant extracts once per build into
 * %LOCALAPPDATA%\vca-portable\<appKey>\<buildId>, drops a marker file, and
 * subsequent launches jump straight to ExecWait. A new build gets a new
 * buildId, which purges the app's older caches and re-extracts once. The
 * cache is orphaned if the user deletes the exe (accepted tradeoff). A named
 * mutex makes a second stub launched mid-extraction wait for the marker
 * instead of racing the extractor.
 *
 * electron-builder 26.x offers no config hook for a custom portable script —
 * PortableOptions rejects a `script` key (additionalProperties: false) and
 * NsisTarget.buildInstaller hardcodes the template path — so the build job
 * overwrites the template inside the project's node_modules after npm
 * install. Compile contract kept from the stock template (verify on major
 * bumps): makensis runs with cwd = templates/nsis and -WX, common.nsh
 * resolves via cwd, extractAppPackage.nsh via the injected !addincludedir,
 * StdUtils via the injected shared header, and the -D defines (PRODUCT_*,
 * REQUEST_EXECUTION_LEVEL, APP_64/APP_FILENAME, COMPRESSION_METHOD, …) are
 * unchanged. `appKey` must already be slug-safe (it seeds paths and the
 * mutex name).
 *
 * Exported for the build-time verification harness; production callers go
 * through startElectronBuild.
 */
export function renderPortableNsi(appKey: string, buildId: string): string {
  return `# Auto-generated by VCA "Deploy as Electron app" (portable format). Replaces
# electron-builder's stock portable stub, which re-extracts the whole app to a
# temp dir on every launch and deletes it on exit. This variant caches the
# extraction per build under %LOCALAPPDATA%\\vca-portable so only the first
# launch of each build pays the extraction cost.
!include "common.nsh"
!include "extractAppPackage.nsh"

# https://github.com/electron-userland/electron-builder/issues/3972#issuecomment-505171582
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel \${REQUEST_EXECUTION_LEVEL}

Function .onInit
  SetSilent silent
  !insertmacro check64BitAndSetRegView
FunctionEnd

Section
  InitPluginsDir

  StrCpy $R7 "$LOCALAPPDATA\\vca-portable\\${appKey}"
  StrCpy $INSTDIR "$R7\\${buildId}"

  # Cache from an earlier launch of this exact build -> skip extraction.
  IfFileExists "$INSTDIR\\.vca-portable-ok" launch

  # One extractor at a time per app: a second stub launched during the first
  # extraction waits for the marker instead of corrupting the cache.
  System::Call 'kernel32::CreateMutex(i 0, i 0, t "Local\\vca-portable-${appKey}") i .R8 ?e'
  Pop $R9
  IntCmp $R9 183 waitForOther ; ERROR_ALREADY_EXISTS
  Goto extract

waitForOther:
  StrCpy $R6 0
waitLoop:
  IfFileExists "$INSTDIR\\.vca-portable-ok" launch
  Sleep 1000
  IntOp $R6 $R6 + 1
  # Give up after ~5 min and extract anyway (self-heal if the extractor died).
  IntCmp $R6 300 extract waitLoop extract

extract:
  # New build id -> purge caches of older builds of this app (best effort;
  # files locked by a still-running old instance survive until next launch).
  RMDir /r "$R7"
  SetOutPath $INSTDIR

  !ifdef APP_DIR_64
    File /r "\${APP_DIR_64}\\*.*"
  !else
    !insertmacro extractEmbeddedAppPackage
  !endif

  FileOpen $R5 "$INSTDIR\\.vca-portable-ok" w
  FileClose $R5

launch:
  SetOutPath $INSTDIR
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "\${APP_FILENAME}").r0'
  \${StdUtils.GetAllParameters} $R0 0

  ExecWait '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" $R0' $0
  SetErrorLevel $0

  # Leave the cache in place; just release our working-directory lock on it.
  SetOutPath $EXEDIR
SectionEnd
`;
}

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  [k: string]: unknown;
}

async function readPackageJson(workspacePath: string): Promise<PackageJson> {
  const text = await fs.readFile(path.join(workspacePath, "package.json"), "utf-8");
  return JSON.parse(text) as PackageJson;
}

async function writePackageJson(workspacePath: string, pkg: PackageJson): Promise<void> {
  await fs.writeFile(path.join(workspacePath, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

async function ensureElectronScaffold(workspacePath: string, rec: JobRecord, winFormat: ElectronWinFormat = "installer"): Promise<{ appKey: string }> {
  // Read package.json first — we need the app name and a place to write the
  // electron config back to.
  let pkg: PackageJson;
  try { pkg = await readPackageJson(workspacePath); }
  catch {
    throw Object.assign(new Error("Project is missing package.json — cannot run Electron build"), { code: "MISSING_PACKAGE_JSON" });
  }

  // Resolve the app's real display name + stable UUID from project.yaml (the
  // source of truth VCA writes at create/rename). package.json `name` is the
  // generic template default ("app") for most projects, so it's only a
  // fallback here — this is what makes the built app/installer carry the
  // project's real name instead of "app".
  const identity = await readProjectIdentity(workspacePath);
  const displayName = identity.name?.trim() || pkg.name?.trim() || "vca-app";
  // Rename-stable key for the wrapper's session partition and preferred-port
  // seed: the project UUID, or the package name for legacy projects that
  // predate project.yaml.
  const appKey = slugifyAppName(identity.uuid?.trim() || pkg.name || "vca-app");

  // 1. electron-main.cjs — always overwrite. .cjs forces CommonJS even when
  // the project's package.json has "type": "module", so the bootstrap loads
  // regardless of the user's module mode. Old electron-main.js files from a
  // previous (buggy) scaffold get removed below.
  const mainCjsPath = path.join(workspacePath, "electron-main.cjs");
  const electronAdminEnv = await getDecryptedEnvMap();
  await fs.writeFile(mainCjsPath, renderElectronMainCjs(appKey, displayName, electronAdminEnv), "utf-8");
  logEcho(rec, `[scaffold] wrote electron-main.cjs${Object.keys(electronAdminEnv).length ? ` (+${Object.keys(electronAdminEnv).length} admin env var(s))` : ""}`);
  // Clean up the legacy ESM/CJS-ambiguous filename if it lingers from an
  // earlier build — leaving it would let `main` accidentally resolve to it.
  await fs.rm(path.join(workspacePath, "electron-main.js"), { force: true });

  // 2. electron-builder.yml — always overwrite (we control its content).
  // Users shouldn't customize the generated config; if they need to, they
  // can hand-edit after the build and accept it'll be regenerated.
  // App icon: the owner's square PNG master (.vca-icon.png) becomes build/icon.png,
  // from which electron-builder generates the Windows .ico (installer + installed
  // app), the macOS .icns, and the Linux AppImage icon. Sync it to the master's
  // presence so removing the icon reverts to the default on the next build.
  const iconMaster = path.join(workspacePath, PROJECT_ICON_FILENAME);
  const buildIconPath = path.join(workspacePath, "build", "icon.png");
  let hasIcon = false;
  try {
    await fs.access(iconMaster);
    await fs.mkdir(path.dirname(buildIconPath), { recursive: true });
    await fs.copyFile(iconMaster, buildIconPath);
    hasIcon = true;
  } catch {
    // No master (or copy failed): remove any stale build/icon.png so
    // electron-builder doesn't keep auto-detecting a removed icon.
    await fs.rm(buildIconPath, { force: true });
  }

  const ymlPath = path.join(workspacePath, "electron-builder.yml");
  await fs.writeFile(ymlPath, renderElectronBuilderYml(displayName, identity.uuid?.trim(), hasIcon, winFormat), "utf-8");
  logEcho(rec, `[scaffold] wrote electron-builder.yml (${winFormat === "portable" ? "portable exe" : "nsis installer"} win target, asar:false${hasIcon ? ", project icon" : ""})`);

  // 3. package.json: ensure main=electron-main.cjs, electron + electron-builder
  // devDeps, and dist:win/mac/linux scripts.
  let pkgChanged = false;
  if (pkg.main !== "electron-main.cjs") { pkg.main = "electron-main.cjs"; pkgChanged = true; }
  pkg.devDependencies = pkg.devDependencies || {};
  // Pin to Electron 42 (bundles Node 24, matching VCA's own runtime). Any 42.x
  // is fine — they all ship Node 24, so the deployed app's Node ABI lines up
  // with the host that builds and previews it.
  if (!pkg.devDependencies.electron) { pkg.devDependencies.electron = "^42.0.0"; pkgChanged = true; }
  if (!pkg.devDependencies["electron-builder"]) { pkg.devDependencies["electron-builder"] = "^26.0.0"; pkgChanged = true; }
  // Advisory Node-24 pin so apps scaffolded from older templates (which predate
  // the template's engines field) still document the required runtime.
  const desiredNodeEngine = ">=24 <25";
  pkg.engines = pkg.engines || {};
  if (pkg.engines.node !== desiredNodeEngine) { pkg.engines.node = desiredNodeEngine; pkgChanged = true; }
  pkg.scripts = pkg.scripts || {};
  // Always force these to our canonical commands so a stale value doesn't
  // silently target the wrong builder flags. Prefix `npm run build &&` when
  // the project has a build script (Vite-bundled templates) so the frontend
  // is regenerated before electron-builder packages public/ into the asar.
  const buildPrefix = pkg.scripts.build ? "npm run build && " : "";
  const winCmd = `${buildPrefix}electron-builder --win`;
  const macCmd = `${buildPrefix}electron-builder --mac`;
  const linuxCmd = `${buildPrefix}electron-builder --linux`;
  if (pkg.scripts["dist:win"] !== winCmd) { pkg.scripts["dist:win"] = winCmd; pkgChanged = true; }
  if (pkg.scripts["dist:mac"] !== macCmd) { pkg.scripts["dist:mac"] = macCmd; pkgChanged = true; }
  if (pkg.scripts["dist:linux"] !== linuxCmd) { pkg.scripts["dist:linux"] = linuxCmd; pkgChanged = true; }
  // Guarantee a valid main.minor.build version — electron-builder interpolates
  // it into the installer filename (artifactName ${version}). Apps scaffolded
  // before per-app versioning, or with a malformed version, get the default.
  if (!parseVersion(pkg.version)) { pkg.version = DEFAULT_APP_VERSION; pkgChanged = true; }
  if (pkgChanged) {
    await writePackageJson(workspacePath, pkg);
    logEcho(rec, "[scaffold] patched package.json (main + electron deps + dist scripts)");
  }

  return { appKey };
}

// npm stages aside as `node_modules\.electron-XXXX` during install. If a prior
// run died mid-rename (e.g. EBUSY from a process holding the asar open), the
// half-renamed dir survives and wedges the next install. Remove any such
// leftovers before each attempt. Returns the names that were removed.
async function cleanElectronStaging(workspacePath: string): Promise<string[]> {
  const nm = path.join(workspacePath, "node_modules");
  let entries: string[];
  try {
    entries = await fs.readdir(nm);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const stale = entries.filter((e) => e.startsWith(".electron-"));
  for (const name of stale) {
    try {
      await rmRetry(path.join(nm, name), { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
  return stale;
}

// ─────────────────────────────────────────────────────────────────────────
// Action: Electron build (per-project)

export interface ElectronBuildInput {
  workspacePath: string;
  projectKey: string;
  target: "win" | "mac" | "linux";
  // Windows packaging; ignored for mac/linux. Defaults to "installer".
  winFormat?: ElectronWinFormat;
  actor: string | null;
}

export async function startElectronBuild(input: ElectronBuildInput): Promise<{ jobId: string }> {
  const kind: JobKind = `electron-${input.target}` as JobKind;
  return withStartGuard(input.projectKey, kind, async () => {
    // Validate the workspace exists + has a package.json (or will after scaffold).
    try { await fs.access(input.workspacePath); }
    catch {
      throw Object.assign(new Error("Project workspace does not exist"), { code: "WORKSPACE_MISSING" });
    }
    const winFormat: ElectronWinFormat = input.winFormat || "installer";
    const rec = await createJobRecord(input.projectKey, kind);
    if (input.target === "win") {
      rec.state.format = winFormat;
      emit(rec.state.jobId, { type: "state", state: rec.state });
    }
    const jobId = rec.state.jobId;

    void (async () => {
      try {
        const { appKey } = await ensureElectronScaffold(input.workspacePath, rec, winFormat);

        // Stop any running preview for this project before mutating its
        // node_modules. On Windows, `process.execPath --watch server.js`
        // (the preview spawn) maps files inside node_modules into the
        // running process, which causes npm's atomic stage-aside rename
        // to fail with EBUSY on node_modules\electron\dist\resources\
        // default_app.asar. The 500ms pause lets the OS finish releasing
        // handles after the process group exits.
        try {
          logEcho(rec, "[deps] stopping preview to release file handles");
          await stopAppProcess(input.projectKey);
          await new Promise((r) => setTimeout(r, 500));
        } catch (err: any) {
          logEcho(rec, `[deps] stop preview warning: ${err?.message || String(err)}`);
        }

        // Install dependencies first (otherwise electron-builder can't find electron).
        // The electron postinstall downloads a large prebuilt zip from the npm CDN
        // and intermittently fails with ECONNRESET on a cold first run. Mitigate at
        // two layers: npm's own fetch-retry config (Layer A), and one outer retry
        // with prefer-offline so attempt 2 reuses anything cached by attempt 1
        // (Layer B). A 3s pause before retry also lets Windows release file handles
        // (often held briefly by AV) that otherwise produce EPERM on cleanup.
        const npmInstallEnv = {
          ...process.env,
          npm_config_fetch_retries: "5",
          npm_config_fetch_retry_mintimeout: "10000",
          npm_config_fetch_retry_maxtimeout: "120000",
        };
        const sweepStaging = async (): Promise<void> => {
          try {
            const stale = await cleanElectronStaging(input.workspacePath);
            if (stale.length) {
              logEcho(rec, `[deps] removed stale staging dirs: ${stale.join(", ")}`);
            }
          } catch (err: any) {
            logEcho(rec, `[deps] staging cleanup warning: ${err?.message || String(err)}`);
          }
        };
        await sweepStaging();
        logEcho(rec, "[deps] running npm install (attempt 1/2)");
        let code = await runCmd(rec, "npm", ["install"], {
          cwd: input.workspacePath,
          label: "npm install",
          env: npmInstallEnv,
        });
        if (code !== 0 && !rec.cancelRequested) {
          logEcho(rec, `[deps] npm install attempt 1 failed (exit ${code}); retrying in 3s with prefer-offline`);
          await new Promise((r) => setTimeout(r, 3000));
          await sweepStaging();
          logEcho(rec, "[deps] running npm install (attempt 2/2)");
          code = await runCmd(rec, "npm", ["install"], {
            cwd: input.workspacePath,
            label: "npm install (retry)",
            env: { ...npmInstallEnv, npm_config_prefer_offline: "true" },
          });
        }
        if (code !== 0) {
          finalizeJob(rec, "failed", `npm install exited with code ${code}`, code);
          return;
        }
        // Portable stub swap: electron-builder 26 has no config hook for a
        // custom portable NSIS script, so overwrite its template inside the
        // project's node_modules (just (re)created by npm install above) with
        // the cached-extraction variant. Installer/mac/linux builds keep the
        // stock templates untouched.
        if (input.target === "win" && winFormat === "portable") {
          const nsisTplDir = path.join(input.workspacePath, "node_modules", "app-builder-lib", "templates", "nsis");
          const buildId = randomUUID().replace(/-/g, "").slice(0, 16);
          try {
            await fs.access(nsisTplDir);
            await fs.writeFile(path.join(nsisTplDir, "portable.nsi"), renderPortableNsi(appKey, buildId), "utf-8");
            logEcho(rec, "[scaffold] patched portable.nsi (cached extraction under %LOCALAPPDATA%\\vca-portable)");
          } catch (err: any) {
            appendLog(rec, `[scaffold] portable.nsi patch skipped (${err?.message || String(err)}) — the stock stub re-extracts on every launch`, "stderr");
          }
        }
        code = await runCmd(rec, "npm", ["run", `dist:${input.target}`], {
          cwd: input.workspacePath,
          label: `npm run dist:${input.target}`,
        });
        if (rec.cancelRequested) finalizeJob(rec, "cancelled", "Cancelled by user", code);
        else if (code === 0) finalizeJob(rec, "succeeded", null, code);
        else finalizeJob(rec, "failed", `electron-builder exited with code ${code}`, code);
      } catch (err: any) {
        finalizeJob(rec, "failed", err?.message || String(err), null);
      }
    })();

    return { jobId };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Action: Git tag/push release (per-project)

export type BumpKind = "patch" | "minor" | "major" | "custom";

function bumpSemver(current: string, bump: BumpKind, custom?: string): string {
  if (bump === "custom") {
    const v = (custom || "").trim().replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+(?:-[\w.+-]+)?$/.test(v)) {
      throw Object.assign(new Error(`Custom version "${custom}" must look like X.Y.Z`), { code: "INVALID_VERSION" });
    }
    return v;
  }
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw Object.assign(new Error(`Cannot parse current version: ${current}`), { code: "INVALID_VERSION" });
  let [maj, min, pat] = [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  if (bump === "patch") pat += 1;
  else if (bump === "minor") { min += 1; pat = 0; }
  else if (bump === "major") { maj += 1; min = 0; pat = 0; }
  return `${maj}.${min}.${pat}`;
}

async function readWorkspaceVersion(workspacePath: string): Promise<string> {
  const pkg = await readPackageJson(workspacePath);
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw Object.assign(new Error("Project package.json has no version field"), { code: "INVALID_PACKAGE_JSON" });
  }
  return pkg.version;
}

async function writeWorkspaceVersion(workspacePath: string, version: string): Promise<void> {
  const pkg = await readPackageJson(workspacePath);
  pkg.version = version;
  await writePackageJson(workspacePath, pkg);
}

async function gitCurrentBranch(workspacePath: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspacePath });
  return stdout.trim();
}

async function gitTagExists(workspacePath: string, tag: string, remote: string): Promise<boolean> {
  const local = await tryGit(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: workspacePath });
  if (local.code === 0) return true;
  try {
    const { stdout } = await git(["ls-remote", "--tags", remote, tag], { cwd: workspacePath });
    if (stdout.trim()) return true;
  } catch { /* offline or no such remote */ }
  return false;
}

async function isGitRepo(workspacePath: string): Promise<boolean> {
  const res = await tryGit(["rev-parse", "--is-inside-work-tree"], { cwd: workspacePath });
  return res.code === 0;
}

export interface GitReleaseInput {
  workspacePath: string;
  projectKey: string;
  bump: BumpKind;
  customVersion?: string;
  branchOverride?: string;
  actor: string | null;
}

export async function startGitRelease(input: GitReleaseInput): Promise<{ jobId: string; version: string; tag: string }> {
  const kind: JobKind = "git-release";
  return withStartGuard(input.projectKey, kind, async () => {
    if (!(await isGitRepo(input.workspacePath))) {
      throw Object.assign(new Error("Project workspace is not a git repository"), { code: "NOT_GIT_REPO" });
    }
    const currentVersion = await readWorkspaceVersion(input.workspacePath);
    const nextVersion = bumpSemver(currentVersion, input.bump, input.customVersion);
    const tag = `v${nextVersion}`;
    // Version Control configures the project's remote (origin); the release
    // just bumps, tags, and pushes there — no pipeline/DevOps steps.
    const remote = "origin";
    const branch = (input.branchOverride || "").trim()
      || await gitCurrentBranch(input.workspacePath);

    if (await gitTagExists(input.workspacePath, tag, remote)) {
      throw Object.assign(new Error(`Tag ${tag} already exists`), { code: "TAG_EXISTS", existingTag: tag });
    }

    const rec = await createJobRecord(input.projectKey, kind);
    rec.state.version = nextVersion;
    rec.state.tag = tag;
    emit(rec.state.jobId, { type: "state", state: rec.state });
    const jobId = rec.state.jobId;
    const commitMessage = `release v${nextVersion}`;

    void (async () => {
      try {
        await withGitLock(input.workspacePath, async () => {
          logEcho(rec, `[version] ${currentVersion} → ${nextVersion}`);
          await writeWorkspaceVersion(input.workspacePath, nextVersion);

          let code = await runCmd(rec, "git", ["add", "-A"], { cwd: input.workspacePath });
          if (code !== 0) throw Object.assign(new Error("git add failed"), { code: "GIT_ADD_FAILED" });

          code = await runCmd(rec, "git", ["commit", "-m", commitMessage], { cwd: input.workspacePath });
          if (code !== 0) throw Object.assign(new Error("git commit failed (nothing to commit, or hook rejected)"), { code: "GIT_COMMIT_FAILED" });

          code = await runCmd(rec, "git", ["tag", tag], { cwd: input.workspacePath });
          if (code !== 0) throw Object.assign(new Error(`git tag ${tag} failed`), { code: "GIT_TAG_FAILED" });

          code = await runCmd(rec, "git", ["push", remote, branch], { cwd: input.workspacePath });
          if (code !== 0) throw Object.assign(new Error(`git push ${remote} ${branch} failed`), { code: "GIT_PUSH_BRANCH_FAILED" });

          code = await runCmd(rec, "git", ["push", remote, tag], { cwd: input.workspacePath });
          if (code !== 0) throw Object.assign(new Error(`git push ${remote} ${tag} failed`), { code: "GIT_PUSH_TAG_FAILED" });
        });

        if (rec.cancelRequested) finalizeJob(rec, "cancelled", "Cancelled by user", null);
        else finalizeJob(rec, "succeeded", null, 0);
      } catch (err: any) {
        finalizeJob(rec, "failed", err?.message || String(err), null);
      }
    })();

    return { jobId, version: nextVersion, tag };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Runtime info exposed to the per-project GET endpoint

export interface ProjectDeployInfo {
  workspaceExists: boolean;
  packageVersion: string | null;
  isGitRepo: boolean;
  currentBranch: string;
  dirty: boolean;
  latestTag: string | null;
}

export async function readProjectDeployInfo(workspacePath: string): Promise<ProjectDeployInfo> {
  let workspaceExists = false;
  try { await fs.access(workspacePath); workspaceExists = true; } catch { /* missing */ }
  if (!workspaceExists) {
    return { workspaceExists: false, packageVersion: null, isGitRepo: false, currentBranch: "", dirty: false, latestTag: null };
  }
  let packageVersion: string | null = null;
  try { packageVersion = (await readPackageJson(workspacePath)).version || null; } catch { /* none */ }
  const repo = await isGitRepo(workspacePath);
  let currentBranch = "";
  let dirty = false;
  let latestTag: string | null = null;
  if (repo) {
    try { currentBranch = await gitCurrentBranch(workspacePath); } catch { /* ignore */ }
    try {
      const { stdout } = await git(["status", "--porcelain"], { cwd: workspacePath });
      dirty = stdout.trim().length > 0;
    } catch { /* ignore */ }
    try {
      const { stdout } = await git(["describe", "--tags", "--abbrev=0"], { cwd: workspacePath });
      latestTag = stdout.trim() || null;
    } catch { /* no tags yet */ }
  }
  return { workspaceExists, packageVersion, isGitRepo: repo, currentBranch, dirty, latestTag };
}
