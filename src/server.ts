import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";
import { apiRouter } from "./routes/api.js";
import { authRouter, apiAuthMiddleware } from "./routes/auth.js";
import { previewRouter, proxyToApp, isPreviewAuthorized, sendForbiddenPage } from "./routes/preview.js";
import { getPreviewState, shutdownAll, cleanupOrphanedProcesses } from "./app-process-manager.js";
import { getLLMConfig, listAllKnownProjectIds, cleanupLegacyShareJunctions } from "./agent-manager.js";
import { sweepNodeModulesStore } from "./node-modules-store.js";
import { syncAllSystemContent } from "./system-content-sync.js";
import { bootstrapDefaultsFromRepo } from "./default-bootstrap.js";
import { getSessionStore } from "./session-store.js";
import { initAuthConfig } from "./auth-config.js";
import { loadVcaSettings } from "./admin-settings.js";
import { migrateLegacyDevopsSettings } from "./vcs-profiles.js";
import { applyTlsVerificationFromSettings, trustSystemCaCertificates } from "./tls-config.js";
import { loadEnvVars, applyEnvVarsToProcess } from "./env-vars-store.js";
import { initAllProviderAuth } from "./provider-auth-registry.js";
import { adminPaths } from "./paths.js";
import { applyAppNamePlaceholders, getAppNameConfig } from "./app-name-config.js";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const IS_PACKAGED = process.env.VCA_PACKAGED === "1";
// Packaged desktop (Electron) only ever serves its own local BrowserWindow, so
// bind loopback to keep the app off the LAN. Containers must bind 0.0.0.0 so the
// platform ingress can reach them. BIND_HOST overrides for deliberate LAN use.
const BIND_HOST = process.env.BIND_HOST || (IS_PACKAGED ? "127.0.0.1" : "0.0.0.0");

function warnDeprecatedGroupEnvVars(): void {
  const deprecated = [
    "AZURE_ENTRA_ADMIN_GROUP_ID",
    "VCA_USERS_GROUP_ID",
    "AZURE_ENTRA_GROUP_ID",
    "VCA_USERS_GROUP_NAME",
  ].filter((name) => !!process.env[name]);
  if (deprecated.length === 0) return;
  console.warn(
    `[deprecated] Env vars ${deprecated.join(", ")} are no longer read at request time — ` +
      `admin/users membership now lives in ${adminPaths.vcaGroups()}. ` +
      `Configure via Settings → Groups & Access in the admin UI; the env vars can be removed from the pipeline.`,
  );
}

const app = express();

app.use(express.json({ limit: "50mb" }));

// Vite builds the SPA to dist-web/. In packaged Electron the tree lives under
// asar-unpacked resources (see electron-builder.yml asarUnpack). Detect via
// VCA_PACKAGED set by electron/main.ts. `resourcesPath` is added by Electron
// at runtime; Node's process type doesn't declare it.
const PUBLIC_DIR = IS_PACKAGED
  ? path.join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, "app.asar.unpacked", "dist-web")
  : path.join(__dirname, "..", "dist-web");

// Only index.html needs server-side substitution (for the <title>
// __APP_SHORTCUT__). The i18n dictionaries are now bundled and resolve
// placeholders client-side via /app-config below.
function serveWithAppNameSubstitution(relPath: string, contentType: string) {
  return (_req: express.Request, res: express.Response) => {
    try {
      const raw = fs.readFileSync(path.join(PUBLIC_DIR, relPath), "utf-8");
      res.type(contentType).send(applyAppNamePlaceholders(raw));
    } catch (err: any) {
      res.status(500).send(err?.message || "Failed to read file");
    }
  };
}
app.get("/", serveWithAppNameSubstitution("index.html", "text/html"));
app.get("/index.html", serveWithAppNameSubstitution("index.html", "text/html"));

// Public app-name config — must be reachable pre-login, so it lives outside
// /api (apiAuthMiddleware below) and outside /auth.
app.get("/app-config", (_req, res) => res.json(getAppNameConfig()));

// Static frontend
app.use(express.static(PUBLIC_DIR));

// Debug: log all API requests
app.use("/api", (req, _res, next) => {
  console.log(`[http] ${req.method} ${req.originalUrl}`);
  next();
});

// Health check (responds before any sync completes)
app.get("/health", (_req, res) => res.json({
  status: "healthy",
  sessionStore: {
    backend: "file",
    description: getSessionStore().describe(),
  },
}));

// Auth routes (Entra ID OAuth)
app.use("/auth", authRouter);

// API routes — apiAuthMiddleware enforces session + userId match before any handler
app.use("/api", apiAuthMiddleware, apiRouter);

// Preview routes
app.use("/preview", previewRouter);

// Catch-all: proxy absolute-path requests originating from preview iframes.
// When user apps use root-relative paths (e.g. <script src="/app.js"> or fetch("/api/data")),
// the browser resolves them against the main server, bypassing the /preview proxy.
// This middleware detects such requests via the Referer header and proxies them correctly.
app.use(async (req, res, next) => {
  const referer = req.headers.referer || "";
  const match = referer.match(/\/preview\/([^/?#]+)\/([^/?#]+)/);
  if (!match) return next();

  const [, userId, projectId] = match;

  // Same ownership rule as the /preview router: only the namespace owner's own
  // session may reach these root-relative resources. Fail closed on any error.
  try {
    if (!(await isPreviewAuthorized(req, userId))) {
      sendForbiddenPage(res);
      return;
    }
  } catch {
    sendForbiddenPage(res);
    return;
  }

  const previewState = getPreviewState(`${userId}:${projectId}`);
  const appPort = previewState.status === "running" ? previewState.port : null;
  const filePath = req.path.substring(1) || "index.html";

  if (appPort) {
    proxyToApp(req, res, appPort, filePath, userId, projectId);
  } else if (previewState.hasProcess) {
    res.status(502).send("Preview process is not running");
  } else {
    next();
  }
});

let serverInstance: HttpServer | null = null;
let startPromise: Promise<HttpServer> | null = null;

// Non-blocking startup work, kicked off after app.listen(). None of this is
// required to render the first page, so it must never gate accepting requests.
// Each step swallows its own errors: the server keeps serving (bundled/stale
// fallbacks apply) even when a step fails or a network sync times out.
async function runBackgroundStartup(): Promise<void> {
  // Kill orphaned preview processes from a previous server instance.
  try {
    await cleanupOrphanedProcesses();
  } catch (err) {
    console.warn("[startup] cleanupOrphanedProcesses failed:", err);
  }

  // Clean up overlay-disk node_modules store: drop entries for projects that
  // no longer exist, and enforce the size cap via LRU eviction.
  try {
    const known = await listAllKnownProjectIds();
    await sweepNodeModulesStore(known);
  } catch (err) {
    console.warn("[nm-store] Sweep failed:", err);
  }

  // One-time migration: remove stale share junctions from older builds now that
  // cross-user sharing is metadata-only (works on network/SMB workspace roots).
  try {
    const removed = await cleanupLegacyShareJunctions();
    if (removed > 0) console.log(`[share-migration] removed ${removed} legacy share junction(s)`);
  } catch (err) {
    console.warn("[share-migration] cleanup failed:", err);
  }

  // Resolve admin-managed system prompt + app templates and clone admin-listed
  // skill repos. Network-bound (git) and slow when unreachable; non-fatal.
  try {
    const report = await syncAllSystemContent();
    if (report.ok) {
      const tplCount = report.appTemplates?.length ?? 0;
      console.log(
        `[startup] System content synced (` +
        `prompt ${report.systemPromptVersion ?? "—"}, ` +
        `templates ${tplCount}, ` +
        `skills ${report.skillsSource})`,
      );
    } else {
      console.error(`[startup] System content sync failed: ${report.error}`);
    }
  } catch (err) {
    console.error("[startup] System content sync threw:", err);
  }
}

// Boot path used by both the container/local auto-start branch (below) and
// the Electron main process (via `await import("./server.js")` then
// `startServer()`).  Idempotent: returns the same server on repeat calls.
export async function startServer(): Promise<HttpServer> {
  if (serverInstance) return serverInstance;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    // Fast, local prerequisites the very first request depends on. These are
    // disk-only and must finish before we accept connections:
    //  - initAuthConfig warms the auth-config snapshot from
    //    ${WORKSPACES_ROOT}/admin/auth-config.json (env-var fallback) so
    //    isAuthEnabled() is correct on the first request.
    //  - loadVcaSettings warms admin config.
    //  - bootstrapDefaultsFromRepo seeds the admin tree from `defaults/` (a
    //    local copy). Idempotent; admin UI edits win on later restarts. Must
    //    run before syncAllSystemContent so the sync sees the seeded content.
    await initAuthConfig();
    try {
      await loadVcaSettings();
      // One-time: migrate legacy global Azure DevOps settings into a VCS
      // profile and strip the plaintext PAT from vca-settings.json. No-op once
      // vcs-profiles.json exists.
      await migrateLegacyDevopsSettings();
      // Apply the persisted global TLS posture before any outbound HTTPS
      // (system-content git sync, Entra, LLM providers) can run. Default is
      // verification enabled; admins can disable it in Settings → Network.
      applyTlsVerificationFromSettings();
      // Trust the OS certificate store on top of Node's bundled roots so
      // corporate TLS interception doesn't break outbound HTTPS (see
      // tls-config.ts). Must precede any outbound connection below.
      trustSystemCaCertificates();
      // Admin-defined platform env vars (Settings → Environment) are injected
      // onto process.env so the server and everything it spawns can see them.
      await loadEnvVars();
      await applyEnvVarsToProcess();
      // Embedded pi never installs a proxy dispatcher (only its CLI does), so
      // its fetch/WebSocket/OAuth-refresh would silently bypass HTTP(S)_PROXY.
      // Gated: nothing changes when no proxy is configured. Runs after
      // applyEnvVarsToProcess so admin-set proxy vars are honored too.
      if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
        try {
          const { EnvHttpProxyAgent, setGlobalDispatcher, install } = await import("undici");
          setGlobalDispatcher(new EnvHttpProxyAgent());
          // Swap globalThis.fetch/WebSocket to this undici so the dispatcher
          // applies everywhere (Node's built-ins ignore npm-undici's global).
          install();
          console.log("[startup] HTTP(S)_PROXY detected — installed proxy-aware fetch/WebSocket dispatcher (NO_PROXY honored)");
        } catch (err) {
          console.warn("[startup] Failed to install proxy dispatcher:", err);
        }
      }
      // After applyEnvVarsToProcess so an admin-provided VCA_SECRETS_KEY is
      // honored. Best-effort per provider: a failure just means that provider
      // (ChatGPT/Codex, Kimi, OpenRouter) reports "not signed in".
      await initAllProviderAuth();
      const seedReport = await bootstrapDefaultsFromRepo();
      if (seedReport.seeded.length) {
        console.log(`[startup] Bootstrap seeded ${seedReport.seeded.length} default(s): ${seedReport.seeded.join(", ")}`);
      }
    } catch (err) {
      console.error("[startup] Default bootstrap threw:", err);
    }

    const server = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(PORT, BIND_HOST, () => {
        serverInstance = s;
        const llm = getLLMConfig();
        console.log(`VCA server running on http://${BIND_HOST === "0.0.0.0" ? "localhost" : BIND_HOST}:${PORT} (bound ${BIND_HOST})`);
        // Reflects the active LLM: AZURE env vars (server-configured) win, then
        // admin Settings (vca-settings.json), then PROVIDER/MODEL env-var defaults.
        console.log(`LLM: ${llm.displayName} (${llm.mode})`);
        console.log(`[debug] Code version: 2026-03-27-b`);
        warnDeprecatedGroupEnvVars();
        resolve(s);
      });
    });

    // Everything below is background work the initial page render does NOT
    // depend on. Critically this includes syncAllSystemContent(), which does
    // git network I/O (clone/ls-remote) that can hang for minutes on a
    // restricted/offline network — running it after listen() is what lets the
    // Electron window appear immediately instead of after the sync times out
    // (the /health endpoint already responds before any sync completes).
    void runBackgroundStartup();

    return server;
  })();

  return startPromise;
}

export async function stopServer(): Promise<void> {
  const s = serverInstance;
  if (!s) return;
  serverInstance = null;
  startPromise = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  await shutdownAll();
}

// Auto-start for container/local/dev. The Electron main process sets
// VCA_PACKAGED=1 to suppress this and drive startServer() itself; it also
// owns shutdown via Electron's app lifecycle, so the SIGTERM/SIGINT/etc.
// handlers below are scoped to the auto-start branch only.
if (process.env.VCA_PACKAGED !== "1") {
  let shuttingDown = false;
  const gracefulShutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${reason}, shutting down`);
    await stopServer();
    process.exit(exitCode);
  };
  process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM received"); });
  process.on("SIGINT", () => { void gracefulShutdown("SIGINT received"); });

  process.on("uncaughtException", (err) => {
    console.error("[server] Uncaught exception:", err);
    void gracefulShutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[server] Unhandled rejection:", err);
    void gracefulShutdown("unhandledRejection", 1);
  });

  void startServer();
}
