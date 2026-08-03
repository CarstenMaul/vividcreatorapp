import { Router, type Request, type Response } from "express";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import archiver from "archiver";
import { getSessionUserId } from "./auth.js";
import { buildSingleHtml, hasPublicIndex, StaticExportError } from "../static-export.js";
import {
  startElectronBuild,
  startGitRelease,
  cancelJob,
  getProjectActiveJobs,
  getJobByIdState,
  getJobLogBuffer,
  getJobLogPath,
  subscribePlatformReleaseEvents,
  readProjectDeployInfo,
  slugifyAppName,
  type JobKind,
  type JobEvent,
  type BumpKind,
  type ElectronWinFormat,
} from "../platform-release-runner.js";
import { readProjectSettings, getWorkspacePathForProject } from "../agent-manager.js";

export const platformReleaseRouter = Router();

function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}

function query(req: Request, name: string): string {
  const v = req.query[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

function writeSSE(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Owner-aware: sharing is metadata-only, so a share recipient's deploy state
// and release builds must resolve to the OWNER's physical workspace dir.
function workspacePathFor(userId: string, projectId: string): Promise<string> {
  return getWorkspacePathForProject(userId, projectId);
}

function projectKeyFor(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
}

function asJobKind(v: unknown): JobKind | null {
  const kinds: JobKind[] = ["electron-win", "electron-mac", "electron-linux", "git-release"];
  return kinds.includes(v as JobKind) ? (v as JobKind) : null;
}

function asBumpKind(v: unknown): BumpKind | null {
  const bumps: BumpKind[] = ["patch", "minor", "major", "custom"];
  return bumps.includes(v as BumpKind) ? (v as BumpKind) : null;
}

function mapStartError(err: any, res: Response): void {
  const code = err?.code as string | undefined;
  switch (code) {
    case "JOB_ALREADY_RUNNING":
      res.status(409).json({ error: err.message, code, activeJob: err.activeJob || null });
      return;
    case "WORKSPACE_MISSING":
    case "NOT_GIT_REPO":
    case "MISSING_PACKAGE_JSON":
    case "INVALID_PACKAGE_JSON":
    case "INVALID_VERSION":
    case "TAG_EXISTS":
      res.status(400).json({ error: err.message, code, ...(err.existingTag ? { existingTag: err.existingTag } : {}) });
      return;
    default:
      res.status(500).json({ error: err?.message || String(err), code: code || null });
  }
}

// ─── Per-project deploy status + actions ───────────────────────────────

platformReleaseRouter.get("/projects/:projectId/deploy/state", async (req: Request, res: Response) => {
  const userId = query(req, "userId") || getSessionUserId(req) || "";
  const projectId = param(req, "projectId");
  if (!userId || !projectId) {
    res.status(400).json({ error: "userId and projectId required" });
    return;
  }
  try {
    const workspacePath = await workspacePathFor(userId, projectId);
    const projectKey = projectKeyFor(userId, projectId);
    const [info, settings] = await Promise.all([
      readProjectDeployInfo(workspacePath),
      readProjectSettings(workspacePath).catch(() => null),
    ]);
    const isWebApp = settings?.appType === "web";
    res.json({
      info,
      deploymentOption: settings?.deploymentOption || "",
      activeJobs: getProjectActiveJobs(projectKey),
      // Static web export readiness (web-app projects only) — lets the Deploy
      // dialog disable the download buttons while public/index.html is absent.
      webExport: isWebApp ? { hasIndexHtml: await hasPublicIndex(workspacePath) } : null,
      // True when running inside the packaged desktop app — lets the Deploy
      // dialog open the release folder in the OS file explorer instead of the
      // in-app browser.
      isPackaged: process.env.VCA_PACKAGED === "1",
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ─── Static web export (appType "web" projects) ────────────────────────
// Synchronous, no job runner: the artifact is assembled on the fly from the
// workspace's public/ dir and written into release/ as <appname>-<version>
// (same folder and naming convention as the Electron builds), where the
// Deploy dialog's release-folder browser picks it up. Gated on the project's
// app_type so full-stack projects can't export their (server-rendered)
// public dir.

async function guardWebExport(
  req: Request,
  res: Response,
): Promise<{ workspacePath: string; releaseDir: string; baseName: string } | null> {
  const userId = (req.body && req.body.userId) || getSessionUserId(req) || "";
  const projectId = param(req, "projectId");
  if (!userId || !projectId) {
    res.status(400).json({ error: "userId and projectId required" });
    return null;
  }
  const workspacePath = await workspacePathFor(userId, projectId);
  const settings = await readProjectSettings(workspacePath).catch(() => null);
  if (settings?.appType !== "web") {
    res.status(400).json({ error: "Static export is only available for client-side web apps", code: "NOT_WEB_APP" });
    return null;
  }
  if (!(await hasPublicIndex(workspacePath))) {
    res.status(400).json({ error: "public/index.html not found — nothing to export yet", code: "NO_INDEX_HTML" });
    return null;
  }
  const slug = slugifyAppName(typeof req.body?.name === "string" ? req.body.name : "");
  let version = "";
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(workspacePath, "package.json"), "utf-8"));
    if (typeof pkg?.version === "string") version = pkg.version.trim().replace(/[^0-9A-Za-z._-]+/g, "-");
  } catch { /* no package.json — artifact name goes unversioned */ }
  const releaseDir = path.join(workspacePath, "release");
  await fs.mkdir(releaseDir, { recursive: true });
  return { workspacePath, releaseDir, baseName: version ? `${slug}-${version}` : slug };
}

platformReleaseRouter.post("/projects/:projectId/deploy/export/zip", async (req: Request, res: Response) => {
  try {
    const guarded = await guardWebExport(req, res);
    if (!guarded) return;
    const fileName = `${guarded.baseName}.zip`;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(path.join(guarded.releaseDir, fileName));
      const archive = archiver("zip", { zlib: { level: 5 } });
      out.on("close", () => resolve());
      out.on("error", reject);
      archive.on("error", reject);
      archive.pipe(out);
      // The app is everything under public/ — server.js, project.yaml, .vca*
      // and .git live outside it and are excluded by construction.
      archive.glob("**/*", { cwd: path.join(guarded.workspacePath, "public"), dot: true });
      archive.finalize().catch(reject);
    });
    res.json({ ok: true, fileName });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

platformReleaseRouter.post("/projects/:projectId/deploy/export/html", async (req: Request, res: Response) => {
  try {
    const guarded = await guardWebExport(req, res);
    if (!guarded) return;
    const { html, warnings } = await buildSingleHtml(path.join(guarded.workspacePath, "public"));
    if (warnings.length > 0) {
      console.warn(`[static-export] ${param(req, "projectId")}: ${warnings.join(" | ")}`);
    }
    const fileName = `${guarded.baseName}.html`;
    await fs.writeFile(path.join(guarded.releaseDir, fileName), html, "utf-8");
    res.json({ ok: true, fileName, warnings });
  } catch (err: any) {
    if (err instanceof StaticExportError) {
      res.status(err.code === "EXPORT_TOO_LARGE" ? 413 : 400).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: err?.message || String(err) });
  }
});

platformReleaseRouter.post("/projects/:projectId/deploy/electron", async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || getSessionUserId(req) || "";
  const projectId = param(req, "projectId");
  const target = req.body?.target;
  const format = req.body?.format;
  if (!userId || !projectId) { res.status(400).json({ error: "userId and projectId required" }); return; }
  if (target !== "win" && target !== "mac" && target !== "linux") {
    res.status(400).json({ error: "target must be 'win', 'mac', or 'linux'" });
    return;
  }
  if (format !== undefined && format !== "installer" && format !== "portable") {
    res.status(400).json({ error: "format must be 'installer' or 'portable'" });
    return;
  }
  try {
    const actor = getSessionUserId(req) || null;
    // Packaging format only applies to Windows (installer vs portable exe).
    const winFormat: ElectronWinFormat | undefined = target === "win" ? (format || "installer") : undefined;
    const result = await startElectronBuild({
      workspacePath: await workspacePathFor(userId, projectId),
      projectKey: projectKeyFor(userId, projectId),
      target,
      winFormat,
      actor,
    });
    res.status(202).json({ ...result, kind: `electron-${target}`, ...(winFormat ? { format: winFormat } : {}) });
  } catch (err: any) {
    mapStartError(err, res);
  }
});

platformReleaseRouter.post("/projects/:projectId/deploy/git-tag", async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || getSessionUserId(req) || "";
  const projectId = param(req, "projectId");
  const bump = asBumpKind(req.body?.bump);
  if (!userId || !projectId) { res.status(400).json({ error: "userId and projectId required" }); return; }
  if (!bump) {
    res.status(400).json({ error: "bump must be 'patch', 'minor', 'major', or 'custom'" });
    return;
  }
  try {
    const actor = getSessionUserId(req) || null;
    const result = await startGitRelease({
      workspacePath: await workspacePathFor(userId, projectId),
      projectKey: projectKeyFor(userId, projectId),
      bump,
      customVersion: typeof req.body?.customVersion === "string" ? req.body.customVersion : undefined,
      branchOverride: typeof req.body?.branchOverride === "string" ? req.body.branchOverride : undefined,
      actor,
    });
    res.status(202).json({ ...result, kind: "git-release" });
  } catch (err: any) {
    mapStartError(err, res);
  }
});

platformReleaseRouter.post("/projects/:projectId/deploy/cancel", async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || getSessionUserId(req) || "";
  const projectId = param(req, "projectId");
  const kind = asJobKind(req.body?.kind);
  if (!userId || !projectId) { res.status(400).json({ error: "userId and projectId required" }); return; }
  if (!kind) { res.status(400).json({ error: "kind is required" }); return; }
  try {
    const state = await cancelJob(projectKeyFor(userId, projectId), kind);
    if (!state) { res.status(404).json({ error: `No active job for kind ${kind}` }); return; }
    res.json({ state });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

platformReleaseRouter.get("/projects/:projectId/deploy/events", (req: Request, res: Response) => {
  const jobId = typeof req.query?.jobId === "string" ? req.query.jobId : "";
  if (!jobId) {
    res.status(400).json({ error: "jobId query param is required" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const current = getJobByIdState(jobId);
  if (current) writeSSE(res, "state", current);
  for (const line of getJobLogBuffer(jobId)) {
    writeSSE(res, "log", { line, stream: "stdout" });
  }

  const listener = (event: JobEvent) => {
    try {
      if (event.type === "state") writeSSE(res, "state", event.state);
      else if (event.type === "log") writeSSE(res, "log", { line: event.line, stream: event.stream });
    } catch {
      cleanup();
    }
  };
  const unsubscribe = subscribePlatformReleaseEvents(jobId, listener);

  let keepalive: ReturnType<typeof setInterval> | null = setInterval(() => {
    try { res.write(":keepalive\n\n"); } catch { cleanup(); }
  }, 15000);

  const cleanup = () => {
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
    unsubscribe();
  };
  res.on("error", cleanup);
  req.on("close", cleanup);
});

platformReleaseRouter.get("/projects/:projectId/deploy/logs", async (req: Request, res: Response) => {
  const jobId = typeof req.query?.jobId === "string" ? req.query.jobId : "";
  if (!jobId) { res.status(400).json({ error: "jobId query param is required" }); return; }
  if (!/^[a-zA-Z0-9-]+$/.test(jobId)) { res.status(400).json({ error: "invalid jobId" }); return; }
  try {
    const data = await fs.readFile(getJobLogPath(jobId), "utf-8");
    res.setHeader("Content-Type", "text/plain");
    res.send(data);
  } catch (err: any) {
    if (err?.code === "ENOENT") res.status(404).json({ error: "Log file not found" });
    else res.status(500).json({ error: err?.message || String(err) });
  }
});
