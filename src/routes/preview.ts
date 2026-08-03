import { Router, type Request, type Response } from "express";
import http from "http";
import { getPreviewState, touchProcess } from "../app-process-manager.js";
import { getPreviewSession } from "./auth.js";

export const previewRouter = Router();

/**
 * A preview namespace (`/preview/<userId>/...`) is only ever served under the
 * viewer's OWN userId — shared projects are symlinked into the recipient's
 * workspace, so they too resolve under the recipient's id. The authorization
 * rule is therefore an identity match: the caller must have a valid session
 * whose userId equals the namespace owner. Mirrors enforceUserIdMatch on /api.
 */
export async function isPreviewAuthorized(req: Request, userId: string): Promise<boolean> {
  const session = await getPreviewSession(req);
  return !!session && session.userId === userId;
}

// Serve preview files from workspace (or proxy to running Node process)
// Route: ALL /preview/:userId/:projectId/*
previewRouter.all("/:userId/:projectId/{*filePath}", async (req: Request, res: Response) => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
  const rawPath = req.params.filePath;
  const filePath = (Array.isArray(rawPath) ? rawPath.join("/") : rawPath) || "index.html";

  if (!(await isPreviewAuthorized(req, userId))) {
    sendForbiddenPage(res);
    return;
  }

  const projectKey = `${userId}:${projectId}`;
  const previewState = getPreviewState(projectKey);
  const appPort = previewState.status === "running" ? previewState.port : null;
  if (appPort) {
    proxyToApp(req, res, appPort, filePath, userId, projectId);
    return;
  }

  if (previewState.status === "starting") {
    sendStatusPage(res, "Preview is starting", "The app process is being started. Reload the preview in a moment.");
    return;
  }

  if (previewState.status === "stopping") {
    sendStatusPage(res, "Preview is restarting", "The app process is being restarted. Reload the preview in a moment.");
    return;
  }

  if (previewState.status === "crashed") {
    sendErrorPage(res, previewState.lastError);
    return;
  }

  if (previewState.hasProcess) {
    sendErrorPage(res, previewState.lastError);
    return;
  }

  sendPlaceholderPage(res);
});

/**
 * Proxy a request to a running app process.
 */
export function proxyToApp(req: Request, res: Response, port: number, filePath: string, userId: string, projectId: string): void {
  touchProcess(`${userId}:${projectId}`);
  const qs = req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "";
  const proxyPath = `/${filePath}${qs}`;
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  headers.host = `localhost:${port}`;
  delete headers["accept-encoding"];

  const proxyReq = http.request(
    {
      hostname: "localhost",
      port,
      path: proxyPath,
      method: req.method,
      headers: headers as http.OutgoingHttpHeaders,
    },
    (proxyRes) => {
      const resHeaders = { ...proxyRes.headers };
      resHeaders["cache-control"] = "no-cache, no-store, must-revalidate";
      res.writeHead(proxyRes.statusCode || 500, resHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", () => {
    sendErrorPage(res);
  });

  if (req.method !== "GET" && req.method !== "HEAD") {
    // express.json() (mounted globally in server.ts) consumes the stream
    // ONLY for application/json bodies. For everything else the stream is
    // intact and must be piped through — otherwise binary uploads (PDF,
    // multipart form-data, octet-stream, etc.) arrive at the child with
    // 0 bytes despite a non-zero Content-Length.
    if (req.is("application/json") && req.body && typeof req.body === "object") {
      const bodyStr = JSON.stringify(req.body);
      proxyReq.setHeader("content-type", "application/json");
      proxyReq.setHeader("content-length", Buffer.byteLength(bodyStr));
      proxyReq.end(bodyStr);
    } else {
      req.on("error", (err) => proxyReq.destroy(err));
      req.pipe(proxyReq);
    }
  } else {
    proxyReq.end();
  }
}

const THEME_SCRIPT = `<script>
  var t = "dark";
  try { t = localStorage.getItem("vca-theme") || "dark"; } catch(e) {}
  document.documentElement.setAttribute("data-theme", t);
  window.addEventListener("storage", function(e) {
    if (e.key === "vca-theme") document.documentElement.setAttribute("data-theme", e.newValue || "dark");
  });
</script>`;

const BASE_STYLE = `<style>
  html[data-theme="dark"] { --bg: #1a1a2e; --fg: #8888aa; --heading: #6c6c9c; }
  html[data-theme="light"] { --bg: #f5f5f7; --fg: #888899; --heading: #6060a0; }
  body { background: var(--bg); color: var(--fg); display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: system-ui; }
  .content { text-align: center; }
  h2 { color: var(--heading); }
</style>`;

function sendStatusPage(res: Response, title: string, message: string): void {
  res.setHeader("Content-Type", "text/html");
  res.status(200).send(`<!DOCTYPE html>
<html>
<head>${BASE_STYLE}
${THEME_SCRIPT}
</head>
<body>
  <div class="content">
    <h2>${title}</h2>
    <p>${message}</p>
  </div>
</body>
</html>`);
}

function sendErrorPage(res: Response, details?: string | null): void {
  const detailHtml = details ? `<p><small>${escapeHtml(details)}</small></p>` : "";
  res.setHeader("Content-Type", "text/html");
  res.status(502).send(`<!DOCTYPE html>
<html>
<head>${BASE_STYLE}
${THEME_SCRIPT}
</head>
<body>
  <div class="content">
    <h2>Preview process is not running</h2>
    <p>The app process stopped or crashed. Use <strong>Run</strong> or <strong>Restart</strong> to start it again.</p>
    ${detailHtml}
  </div>
</body>
</html>`);
}

export function sendForbiddenPage(res: Response): void {
  res.setHeader("Content-Type", "text/html");
  res.status(403).send(`<!DOCTYPE html>
<html>
<head>${BASE_STYLE}
${THEME_SCRIPT}
</head>
<body>
  <div class="content">
    <h2>Not authorized</h2>
    <p>This preview belongs to another account. Sign in as its owner to view it.</p>
  </div>
</body>
</html>`);
}

function sendPlaceholderPage(res: Response): void {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html>
<head>${BASE_STYLE}
${THEME_SCRIPT}
</head>
<body>
  <div class="content">
    <h2>No preview yet</h2>
    <p>Send a prompt to start building your app</p>
  </div>
</body>
</html>`);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
