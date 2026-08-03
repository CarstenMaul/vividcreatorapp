import { app, BrowserWindow, Menu, dialog, ipcMain, shell, session as electronSession } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { promises as fs } from "fs";
import { appendFileSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import net from "net";
import {
  resolveWorkspacesRoot,
  readRootConfig,
  writeRootConfig,
  validateRootChange,
} from "./storage-root.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXED_PORT = 38473;
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,64}$/;
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Boot logging. A packaged app has no attached console, and `void loadURL(...)`
// used to swallow every failure — so a blank window left zero trace. Everything
// here appends to %APPDATA%/VCA/logs/boot.log with a since-start timestamp so we
// can see exactly where time goes and which load/render step failed.
// ---------------------------------------------------------------------------
const START = Date.now();
let logFile: string | null = null;
function log(msg: string): void {
  const line = `[boot +${Date.now() - START}ms] ${msg}\n`;
  try {
    if (!logFile) {
      const dir = path.join(app.getPath("userData"), "logs");
      mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, "boot.log");
    }
    appendFileSync(logFile, line);
  } catch {
    // logging must never throw
  }
  // Also surface in dev where a terminal is attached.
  console.log(line.trimEnd());
}

function dataUrl(html: string): string {
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>VCA</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:'Segoe UI',system-ui,sans-serif;background:#1f2430;color:#e6e6e6}
.box{text-align:center}.spinner{width:34px;height:34px;border:3px solid #3a4252;border-top-color:#7aa2f7;
border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="box"><div class="spinner"></div><div>Starting VCA…</div></div></body></html>`;

// Shown while a staged workspace-root change is being applied at boot. A large
// (cross-drive) copy can take a while, so make it clear VCA is busy, not hung.
const MOVING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>VCA</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:'Segoe UI',system-ui,sans-serif;background:#1f2430;color:#e6e6e6}
.box{text-align:center;max-width:420px;padding:0 24px}.spinner{width:34px;height:34px;border:3px solid #3a4252;
border-top-color:#7aa2f7;border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite}
.note{color:#9aa5ce;font-size:12px;margin-top:10px}@keyframes spin{to{transform:rotate(360deg)}}</style></head>
<body><div class="box"><div class="spinner"></div><div>Moving your workspace…</div>
<div class="note">This can take a moment for a large workspace. Please don't close VCA.</div></div></body></html>`;

function errorHtml(title: string, detail: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
  return `<!doctype html><html><head><meta charset="utf-8"><title>VCA — error</title>
<style>html,body{height:100%;margin:0}body{font-family:'Segoe UI',system-ui,sans-serif;
background:#1f2430;color:#e6e6e6;padding:32px;box-sizing:border-box}
h1{color:#f7768e;font-size:18px}pre{white-space:pre-wrap;word-break:break-word;background:#161a23;
border:1px solid #3a4252;border-radius:6px;padding:12px;font-size:12px;line-height:1.5}
.hint{color:#9aa5ce;font-size:12px;margin-top:16px}</style></head>
<body><h1>${esc(title)}</h1><pre>${esc(detail)}</pre>
<div class="hint">Details were also written to the boot log under %APPDATA%/VCA/logs/boot.log.</div>
</body></html>`;
}

let win: BrowserWindow | null = null;

function attachDiagnostics(w: BrowserWindow): void {
  const wc = w.webContents;
  wc.on("did-finish-load", () => log(`did-finish-load: ${wc.getURL()}`));
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) =>
    log(`did-fail-load: ${code} ${desc} url=${url} mainFrame=${isMainFrame}`),
  );
  wc.on("render-process-gone", (_e, details) =>
    log(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`),
  );
  wc.on("preload-error", (_e, preloadPath, error) =>
    log(`preload-error: ${preloadPath} ${error?.stack || error}`),
  );
  // Electron 36+ delivers a single event object; reading only from it avoids the
  // "console-message arguments are deprecated" warning the positional form emits.
  wc.on("console-message", (e: any) => {
    log(`[renderer:${e?.level}] ${e?.message} (${e?.sourceId}:${e?.lineNumber})`);
  });
  w.on("unresponsive", () => log("window became unresponsive"));

  // Menu is removed, so wire DevTools to keyboard directly.
  wc.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown") return;
    const toggle =
      input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i");
    if (!toggle) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  });
}

function sanitizeUsername(raw: string): string {
  const cleaned = (raw || "").trim();
  if (USERNAME_RE.test(cleaned)) return cleaned;
  let slug = cleaned.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (slug.length < 2) slug = (slug + "user").slice(0, 2);
  if (slug.length > 64) slug = slug.slice(0, 64);
  return slug || "user";
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not respond on ${url} within ${timeoutMs}ms`);
}

/**
 * Surface the desktop user's project folder under Documents\VCA via a directory
 * junction (Windows) / symlink (macOS/Linux). The real files stay in %APPDATA%
 * (see workspacesRoot below) — this is only a pointer for convenience.
 *
 * Why a link and not moving the data: Documents is OneDrive-redirected in many
 * corporate setups, and node_modules there gets locked by the sync filter
 * (EBUSY). OneDrive skips reparse points, so the junction is NOT synced — the
 * data stays safely off OneDrive while still being reachable from Documents.
 *
 * Idempotent, never clobbers a real folder the user may have created, and never
 * fatal (a failed link must not block startup).
 */
async function ensureDocumentsLink(targetDir: string): Promise<void> {
  let documentsDir: string;
  try {
    documentsDir = app.getPath("documents");
  } catch (err) {
    log(`Documents link skipped (no documents path): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const linkPath = path.join(documentsDir, "VCA");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const samePath = (a: string, b: string): boolean => {
    // readlink on a junction may return a \\?\ prefix and/or trailing slash.
    const norm = (p: string) => path.resolve(p.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "");
    const na = norm(a);
    const nb = norm(b);
    return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  };
  try {
    const stat = await fs.lstat(linkPath).catch(() => null);
    if (stat) {
      // libuv reports NTFS junctions as symbolic links, so this covers both.
      if (!stat.isSymbolicLink()) {
        log("Documents\\VCA exists and is a real folder — leaving it untouched");
        return;
      }
      const current = await fs.readlink(linkPath).catch(() => "");
      if (samePath(current, targetDir)) {
        log("Documents\\VCA already links to the project folder");
        return;
      }
      // Points elsewhere: remove ONLY the link entry (never recurse into the
      // target, which would delete the real project files).
      try { await fs.unlink(linkPath); } catch { try { await fs.rmdir(linkPath); } catch { /* best-effort */ } }
    }
    await fs.mkdir(documentsDir, { recursive: true });
    await fs.symlink(targetDir, linkPath, linkType);
    log(`created Documents\\VCA -> ${targetDir} (${linkType})`);
  } catch (err) {
    log(`could not create Documents\\VCA link: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * IPC surface for Settings → Storage. The renderer (our own SPA, contextIsolated,
 * no nodeIntegration) reaches these via the window.vcaDesktop preload bridge.
 * Registered once per boot; handlers read the live root from process.env so they
 * reflect whatever resolveWorkspacesRoot() committed this session.
 */
let storageIpcRegistered = false;
function registerStorageIpc(w: BrowserWindow, defaultRoot: string): void {
  if (storageIpcRegistered) return;
  storageIpcRegistered = true;
  const userDataDir = app.getPath("userData");
  const currentRoot = (): string => process.env.WORKSPACES_ROOT || defaultRoot;

  ipcMain.handle("vca:getStorageInfo", async () => {
    const cfg = await readRootConfig(userDataDir);
    return { root: currentRoot(), defaultRoot, pending: cfg.pending ?? null };
  });

  ipcMain.handle("vca:pickFolder", async () => {
    const res = await dialog.showOpenDialog(w, {
      title: "Choose a workspace folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("vca:stageRootChange", async (_e, arg: unknown) => {
    const a = (arg ?? {}) as { newRoot?: unknown; mode?: unknown };
    const newRoot = typeof a.newRoot === "string" ? a.newRoot : "";
    const mode = a.mode === "move" || a.mode === "new" || a.mode === "existing" ? a.mode : "";
    const v = await validateRootChange({ newRoot, mode: mode as "move" | "new" | "existing", currentRoot: currentRoot() });
    if (!v.ok) return { ok: false, error: v.error };
    const cfg = await readRootConfig(userDataDir);
    await writeRootConfig(userDataDir, {
      root: cfg.root ?? currentRoot(),
      pending: { newRoot: v.normalized as string, mode: mode as "move" | "new" | "existing", requestedAt: new Date().toISOString() },
    });
    log(`staged workspace root change: mode=${mode} newRoot=${v.normalized}`);
    return { ok: true };
  });

  ipcMain.handle("vca:cancelPendingChange", async () => {
    const cfg = await readRootConfig(userDataDir);
    await writeRootConfig(userDataDir, { root: cfg.root ?? currentRoot() });
    log("cancelled pending workspace root change");
    return { ok: true };
  });

  // Open a project's userdata/ folder in the OS file explorer — on the
  // desktop the workspace is a real local directory, so native browsing
  // beats the in-app file dialog. Segments are strictly validated: they
  // are path components under the workspace root.
  const SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
  ipcMain.handle("vca:openUserdataFolder", async (_e, arg: unknown) => {
    const a = (arg ?? {}) as { userId?: unknown; projectId?: unknown };
    const userId = typeof a.userId === "string" ? a.userId : "";
    const projectId = typeof a.projectId === "string" ? a.projectId : "";
    if (!SEGMENT_RE.test(userId) || !SEGMENT_RE.test(projectId)) {
      return { ok: false, error: "invalid path segment" };
    }
    const dir = path.join(currentRoot(), userId, projectId, "userdata");
    try {
      await fs.mkdir(dir, { recursive: true });
      const err = await shell.openPath(dir);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

async function bootstrap(): Promise<void> {
  // Remove the default File/Edit/View/Help menu — VCA is a single-purpose
  // window with no use for it. Setting null also disables the Alt-key fallback
  // that autoHideMenuBar would leave in place. On macOS the OS still owns the
  // top-of-screen menu bar; this trims it to the minimal "VCA" item.
  Menu.setApplicationMenu(null);

  // Create the window up front showing a splash, so the user sees VCA within a
  // second instead of staring at nothing while the server boots. We swap to the
  // real app once /health passes. Use a local const so it stays non-null across
  // the awaits below (the module-level `win` is only for the bootstrap catch).
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "VCA",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  win = w;
  attachDiagnostics(w);

  // getDisplayMedia() is rejected in Electron unless the app supplies a capture
  // source via this handler. Serving the requesting frame reproduces Chrome's
  // preferCurrentTab behavior (the preview-screenshot button captures VCA's own
  // window): no source picker, and no OS screen-recording permission needed.
  electronSession.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    callback({ video: request.frame ?? w.webContents.mainFrame });
  });
  if (process.env.VCA_DEVTOOLS === "1") w.webContents.openDevTools({ mode: "detach" });
  void w.loadURL(dataUrl(LOADING_HTML));
  log("splash window shown");

  const rawUsername = os.userInfo().username || "user";
  const username = sanitizeUsername(rawUsername);
  const userId = username;

  // Physical workspace root. The default is %APPDATA%\vca on Windows,
  // ~/Library/Application Support/vca on macOS, ~/.config/vca on Linux —
  // deliberately NOT under app.getPath("documents"), which is OneDrive-redirected
  // in many corporate setups (node_modules there gets locked by the sync filter
  // and breaks installs with EBUSY on default_app.asar etc.).
  //
  // The user can relocate this folder in Settings → Storage. That stages a change
  // in %APPDATA%\VCA\workspace-root.json (Electron userData — kept OUTSIDE the
  // movable root) which resolveWorkspacesRoot() applies HERE, before the server
  // bundle is imported, while nothing holds file handles. A failed move keeps the
  // old data intact and starts on the old root.
  const defaultRoot = path.join(app.getPath("appData"), "vca");
  const rootResult = await resolveWorkspacesRoot({
    userDataDir: app.getPath("userData"),
    defaultRoot,
    onMoveStart: () => { void w.loadURL(dataUrl(MOVING_HTML)); },
    log,
  });
  const workspacesRoot = rootResult.root;
  process.env.WORKSPACES_ROOT = workspacesRoot;
  // If we swapped to the "Moving…" splash, return to the generic one for the
  // rest of boot (server start), which is then replaced by the real app URL.
  if (rootResult.applied) void w.loadURL(dataUrl(LOADING_HTML));
  if (rootResult.error) {
    dialog.showErrorBox(
      "VCA could not move your workspace",
      `The workspace could not be moved to the new folder, so VCA is still using:\n${workspacesRoot}\n\n` +
        `Details: ${rootResult.error}\n\n` +
        `The change is still pending and will be retried next launch. You can cancel it in Settings → Storage.`,
    );
  }
  registerStorageIpc(w, defaultRoot);

  if (!(await isPortFree(FIXED_PORT))) {
    dialog.showErrorBox(
      "VCA cannot start",
      `Port ${FIXED_PORT} is already in use. Close the conflicting application and relaunch VCA.`,
    );
    app.quit();
    return;
  }
  process.env.PORT = String(FIXED_PORT);
  process.env.VCA_PACKAGED = "1";
  // Expose the packaged app version to the in-process server so getAppConfig()
  // (and the sidebar header) can show it. Must precede the dist/server.js import.
  process.env.APP_VERSION = app.getVersion();

  // Make VCA self-contained: prepend the bundled Node 24 + Git dirs (shipped
  // under resources/runtime) to PATH so every npm/npx/git child process uses
  // them instead of requiring a system install. No-op in dev / when nothing is
  // bundled. Must run before the server starts spawning. See bundled-runtime.ts.
  try {
    const { applyBundledRuntime } = await import("../dist/bundled-runtime.js");
    const r = applyBundledRuntime();
    log(`bundled runtime: node=${r.node ?? "system"} git=${r.git ?? "system"}`);
  } catch (err) {
    log(`bundled runtime setup skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  log("importing server module");
  const serverModule = await import("../dist/server.js");
  log("starting server");
  await serverModule.startServer();
  log("server.listen returned; waiting for health");
  await waitForHealth(`http://127.0.0.1:${FIXED_PORT}/health`, HEALTH_TIMEOUT_MS);
  log("health OK");

  const userStore = await import("../dist/user-store.js");
  await userStore.provisionDesktopUser({ userId, username });
  // Make the user's projects reachable from Documents\VCA (data stays here in
  // %APPDATA%; this is just a junction/symlink). Non-fatal.
  await ensureDocumentsLink(path.join(workspacesRoot, userId));

  const sessionStoreModule = await import("../dist/session-store.js");
  const sessionId = randomBytes(32).toString("hex");
  await sessionStoreModule.getSessionStore().set(sessionId, {
    userId,
    displayName: username,
    email: "",
    expiresAt: Date.now() + SESSION_TTL_MS,
    accessToken: "",
    refreshToken: "",
    isAdmin: true,
    authType: "local",
  });

  await electronSession.defaultSession.cookies.set({
    url: `http://127.0.0.1:${FIXED_PORT}`,
    name: "session_id",
    value: sessionId,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expirationDate: (Date.now() + SESSION_TTL_MS) / 1000,
  });

  log("loading app URL");
  try {
    await w.loadURL(`http://127.0.0.1:${FIXED_PORT}`);
    log("app URL load resolved");
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    log(`app URL load failed: ${message}`);
    void w.loadURL(dataUrl(errorHtml("VCA failed to load its window", message)));
  }
}

app.whenReady().then(bootstrap).catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  log(`bootstrap failed: ${message}`);
  console.error("[electron] bootstrap failed:", err);
  if (win && !win.isDestroyed()) {
    void win.loadURL(dataUrl(errorHtml("VCA failed to start", message)));
  } else {
    dialog.showErrorBox("VCA failed to start", message);
    app.exit(1);
  }
});

process.on("uncaughtException", (err) => log(`main uncaughtException: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => log(`main unhandledRejection: ${err}`));

let shuttingDown = false;
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
  const shutdown = (async () => {
    try {
      const serverModule = await import("../dist/server.js");
      await serverModule.stopServer();
    } catch (err) {
      console.error("[electron] stopServer failed:", err);
    }
  })();

  Promise.race([shutdown, timeout]).finally(() => app.exit(0));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
