import { Router, type Request, type Response } from "express";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
import archiver from "archiver";
import { startAppProcess, stopAppProcess, restartAppProcess, getAppProcessLogs, clearAppProcessLogs, getPreviewState, subscribePreviewEvents } from "../app-process-manager.js";
import {
  createProject,
  initializeProject,
  listProjects,
  deleteProject,
  renameProject,
  setProjectFolder,
  reassignProjectFolder,
  sendPrompt,
  abortSession,
  getSessionStatus,
  getStreamingResume,
  getProjectActiveChatId,
  rollback,
  getCommits,
  checkoutCommit,
  checkoutLatest,
  getMessages,
  addSSEClient,
  removeSSEClient,
  attachSSEClientToLock,
  detachSSEClientFromLock,
  acquireProjectLock,
  releaseProjectLock,
  takeOverProjectLock,
  getProjectLockHolder,
  listActiveUsers,
  isProjectOwner,
  requireLockHeld,
  type PublicProjectLockHolder,
  createAndSetRemote,
  connectRemote,
  gitPush,
  gitPull,
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  SkillValidationError,
  getSkillLoadStatus,
  getDeployStatus,
  getActiveSkills,
  setActiveSkills,
  getUseCaseData,
  setUseCaseData,
  parseMermaidToUseCaseData,
  generateUseCaseMermaid,
  getDeploymentData,
  setDeploymentData,
  parseMermaidToDeploymentData,
  generateDeploymentMermaid,
  hasGitRemote,
  getGitRemote,
  getLLMConfig,
  getAppConfig,
  getGoogleApiKey,
  resetUserSessions,
  compactSession,
  clearChatMessages,
  listChats,
  createChat,
  renameChatById,
  deleteChatById,
  generateChatSummary,
  listUserdata,
  uploadUserdata,
  unzipUserdata,
  mkdirUserdata,
  renameUserdata,
  moveUserdata,
  deleteUserdata,
  downloadUserdataPath,
  listRelease,
  downloadReleasePath,
  getReleaseDir,
  getWorkspacePathForProject,
  readProjectSettings,
  setProjectSettings,
  readProjectIcon,
  writeProjectIcon,
  deleteProjectIcon,
  getAppVersionInfo,
  setAppMainMinor,
  validateProjectSettings,
  getComponentData,
  setComponentData,
  parseMermaidToComponentData,
  generateComponentMermaid,
  listActivityDiagrams,
  createActivityDiagram,
  deleteActivityDiagram,
  renameActivityDiagram,
  getActivityData,
  setActivityData,
  generateActivityMermaid,
  parseMermaidToActivityData,
  listERDiagrams,
  createERDiagram,
  deleteERDiagram,
  renameERDiagram,
  getERData,
  setERData,
  generateERMermaid,
  parseMermaidToERData,
  getRequirements,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  answerQuestion,
  resolveScreenshotResult,
  reseedAllSessions,
  reloadSkillsForUser,
  broadcastSSEEvent,
  enumerateUsersWithProjects,
  linkProject,
  unlinkProject,
  transferProjectOwnership,
  listPublicProjects,
  type UserLLMConfig,
} from "../agent-manager.js";
import { syncAllSystemContent } from "../system-content-sync.js";
import {
  listAdminSkills,
  getAdminSkill,
  createAdminSkill,
  updateAdminSkill,
  deleteAdminSkill,
} from "../admin-skills.js";
import {
  listAdminSkillRepos,
  addAdminSkillRepo,
  removeAdminSkillRepo,
} from "../admin-skill-repos.js";
import {
  getLocalSystemPrompt,
  setLocalSystemPrompt,
  deleteLocalSystemPrompt,
  getSystemPromptRepoConfig,
  setSystemPromptRepoConfig,
  clearSystemPromptRepoConfig,
} from "../admin-system-prompt.js";
import {
  listLocalTemplates,
  createLocalTemplate,
  updateLocalTemplate,
  deleteLocalTemplate,
  installTemplateFromZip,
  parseTemplateDeploymentOption,
} from "../admin-app-templates.js";
import {
  installSkillFromZip,
  installUserSkillFromRepo,
  refreshUserSkillRepos,
  SkillExistsError,
  SkillInstallError,
} from "../skill-install.js";
import { getUserSkillRepos, setUserSkillRepo } from "../user-skill-repos.js";
import {
  listProjectFolders,
  createProjectFolder,
  renameProjectFolder,
  moveProjectFolder,
  deleteProjectFolder,
  FolderValidationError,
} from "../project-folders.js";
import { getSystemPromptVersion } from "../system-prompt.js";
import { getSystemPromptRepoUrl } from "../system-prompt-sync.js";
import { invalidateSystemSkillsCache } from "../default-skills.js";
import { getSessionEmail, getSessionUserId, getSessionIsAdmin } from "./auth.js";
import {
  isGraphConfigured,
  searchUsers,
  searchGraphGroups,
} from "../graph-org.js";
import {
  hasAdminGroup,
  isAdminUser,
  listVcaGroups,
  getVcaGroup,
  createVcaGroup,
  updateVcaGroup,
  deleteVcaGroup,
  addManualMember,
  removeManualMember,
  linkToGraphGroup,
  unlinkFromGraphGroup,
  syncLinkedGroup,
  type UnlinkMode,
} from "../vca-groups.js";
import {
  listUsers,
  loadPublicUser,
  createLocalUser,
  createEntraUser,
  updateUser,
  setLocalPassword,
  deleteUser,
  getUserHasProjects,
  countLocalAdmins,
} from "../user-store.js";
import {
  readMcpServers,
  addMcpServer,
  updateMcpServer,
  deleteMcpServer,
  getMcpServer,
  type McpServerConfig,
} from "../mcp-servers.js";
import { probeMcpServer, invalidateMcpProbeCache } from "../mcp-client.js";
import {
  getAuthConfig,
  saveAuthConfig,
  redact,
  testAuthConfig,
  UNCHANGED_SECRET_SENTINEL,
} from "../auth-config.js";
import { platformReleaseRouter } from "./platform-release.js";
import {
  getCachedVcaSettings,
  loadVcaSettings,
  writeVcaSettings,
  redact as redactVcaSettings,
  publicView as publicVcaSettings,
  type VcaSettings,
} from "../admin-settings.js";
import {
  listLlmProfiles,
  getLlmProfile,
  createLlmProfile,
  updateLlmProfile,
  deleteLlmProfile,
  setActiveLlmProfileId,
  redactLlmProfile,
  type LlmProfile,
} from "../llm-profiles.js";
import { describeProfileCapabilities } from "../model-capabilities.js";
import {
  listVcsProfiles,
  createVcsProfile,
  updateVcsProfile,
  deleteVcsProfile,
  redactVcsProfile,
  type ClientVcsProfile,
} from "../vcs-profiles.js";
import {
  buildConfigExport,
  decryptConfigEnvelope,
  summarizeConfigPayload,
  applyConfigPayload,
  isConfigCategory,
  ConfigTransferError,
} from "../config-transfer.js";
import { applyTlsVerification } from "../tls-config.js";
import {
  loadEnvVars,
  getCachedEnvVars,
  writeEnvVars,
  redactEnvVars,
  applyEnvVarsToProcess,
  validateEnvKeys,
  type ClientEnvVar,
} from "../env-vars-store.js";
import {
  readUserPrefsRecord,
  writeUserPrefs,
  type UserPrefs,
} from "../user-prefs.js";
import { listLlmModels, ModelListError } from "../llm-models.js";
import { testLlmConnection } from "../llm-test-connection.js";
import { getProviderAuthManager } from "../provider-auth-registry.js";
import { OAuthLoginPendingError } from "../provider-oauth.js";
import { readProjectCost } from "../project-cost.js";

export const apiRouter = Router();

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

// Guard wrapper for mutation endpoints. Resolves the canonical owner of the
// project, checks the session user holds the lock, and on failure writes a
// 409 with the current holder's identity so the frontend can flip the UI to
// the "bumped" overlay. Returns true when the route may proceed.
async function ensureProjectLockHeld(req: Request, res: Response, projectId: string): Promise<boolean> {
  const userId = getSessionUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return false;
  }
  try {
    await requireLockHeld(userId, projectId);
    return true;
  } catch (err: any) {
    if (err?.code === "PROJECT_LOCK_NOT_HELD") {
      res.status(409).json({ error: err.message, code: err.code, holder: err.holder || null });
      return false;
    }
    if (err?.code === "PROJECT_NOT_FOUND") {
      res.status(404).json({ error: err.message, code: err.code });
      return false;
    }
    res.status(err?.status || 500).json({ error: err?.message || String(err) });
    return false;
  }
}

// App config (LLM, Container App, Google)
apiRouter.get("/config", async (_req: Request, res: Response) => {
  try {
    res.json(await getAppConfig());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Public read of vca-settings.json (any authenticated user). Secrets are
// stripped — chat sessions construct their LLM client server-side using
// the cached file directly, so the browser never needs the raw keys.
apiRouter.get("/vca-settings", async (_req: Request, res: Response) => {
  try {
    await loadVcaSettings();
    res.json({ settings: publicVcaSettings(getCachedVcaSettings()) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: full vca-settings.json (secrets returned as UNCHANGED sentinel so
// the PUT round-trip below can preserve them without ever exposing them).
apiRouter.get("/admin/vca-settings", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await loadVcaSettings();
    res.json({ settings: redactVcaSettings(getCachedVcaSettings()) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: merge-update vca-settings.json. Send the UNCHANGED sentinel on a
// secret field to preserve the stored value; send "" to clear it.
apiRouter.put("/admin/vca-settings", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const actor = getSessionUserId(req) || null;
    const body = (req.body || {}) as Partial<VcaSettings>;
    const keys = Object.keys(body);
    console.log(`[vca-settings] PUT by ${actor || "unknown"} updating: ${keys.join(", ") || "(empty body)"}`);
    const saved = await writeVcaSettings(body, actor);
    res.json({ settings: redactVcaSettings(saved) });
  } catch (err: any) {
    console.error("[vca-settings] PUT failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: encrypted config export/import ──────────────────────
// Password-encrypted transfer of admin configuration between deployments
// (see src/config-transfer.ts). Real secrets only ever exist inside the
// encrypted payload, assembled/applied server-side. Client errors are 400
// with a distinct `code` — never 401, which api() reads as session expiry.
// The password itself must never be logged.

apiRouter.post("/admin/vca-settings/export", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const body = (req.body || {}) as { password?: unknown; categories?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters", code: "PASSWORD_TOO_SHORT" });
      return;
    }
    const categories = Array.isArray(body.categories) ? body.categories.filter(isConfigCategory) : [];
    if (categories.length === 0) {
      res.status(400).json({ error: "Select at least one category", code: "CATEGORIES_REQUIRED" });
      return;
    }
    const { filename, envelope } = await buildConfigExport(categories, password);
    console.log(`[config-transfer] export by ${getSessionUserId(req) || "unknown"}: ${categories.join(", ")}`);
    res.json({ ok: true, filename, envelope });
  } catch (err: any) {
    if (err instanceof ConfigTransferError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    console.error("[config-transfer] export failed:", err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

apiRouter.post("/admin/vca-settings/import", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const body = (req.body || {}) as { password?: unknown; envelope?: unknown; dryRun?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    const decrypted = decryptConfigEnvelope(body.envelope, password);
    const preview = summarizeConfigPayload(decrypted);
    if (body.dryRun === true) {
      res.json({ ok: true, preview });
      return;
    }
    const actor = getSessionUserId(req) || null;
    const { applied } = await applyConfigPayload(decrypted.payload, actor);
    console.log(`[config-transfer] import by ${actor || "unknown"} applied: ${applied.join(", ")}`);
    await loadVcaSettings();

    // Apply the imported settings to the running server so they take effect
    // without a restart, mirroring what each area's own admin route does.
    if (applied.includes("network")) {
      applyTlsVerification(getCachedVcaSettings().tlsVerificationEnabled);
    }
    if (applied.includes("skills")) {
      invalidateSystemSkillsCache();
    }
    if (applied.some((c) => c === "systemPrompt" || c === "appTemplates" || c === "skills")) {
      try {
        const report = await syncAllSystemContent();
        if (report.ok) await reseedAllSessions();
      } catch (e: any) {
        console.warn("[config-transfer] post-import content sync failed:", e?.message || e);
      }
    }

    const out: Record<string, unknown> = {
      ok: true,
      applied,
      preview,
      settings: redactVcaSettings(getCachedVcaSettings()),
    };
    if (applied.includes("profiles")) {
      const data = await listLlmProfiles();
      out.profiles = data.profiles.map(toClientProfile);
      out.activeProfileId = data.activeProfileId;
    }
    res.json(out);
  } catch (err: any) {
    if (err instanceof ConfigTransferError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    console.error("[config-transfer] import failed:", err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ─── Admin: LLM configuration profiles ─────────────────────────
// Named snapshots of the AI Model Config form (LLM + image config; web tools
// follow the provider automatically). Secrets in create/update bodies may be
// the UNCHANGED sentinel — resolved server-side so keys never round-trip.

// The client view of a profile: secrets masked, plus the capabilities derived
// from pi's catalog (offline — see src/model-capabilities.ts) so Settings and
// the sidebar switcher can show modalities/context/cost without a second call.
function toClientProfile(p: LlmProfile) {
  return { ...redactLlmProfile(p), capabilities: describeProfileCapabilities(p) };
}

function pickProfileFields(body: Record<string, unknown>): Omit<LlmProfile, "id"> {
  const str = (k: string) => (typeof body[k] === "string" ? body[k] as string : "");
  const num = (k: string) => {
    const n = Number(body[k]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  return {
    name: str("name"),
    strengths: str("strengths"),
    apiKey: str("apiKey"),
    llmProvider: str("llmProvider"),
    llmModelId: str("llmModelId"),
    llmEndpoint: str("llmEndpoint"),
    llmApiVersion: str("llmApiVersion"),
    llmContextWindow: num("llmContextWindow"),
    llmMaxTokens: num("llmMaxTokens"),
    imageProvider: str("imageProvider"),
    imageModelId: str("imageModelId"),
    imageApiKey: str("imageApiKey"),
    imageUseLlmKey: body.imageUseLlmKey === true,
  };
}

apiRouter.get("/admin/llm-profiles", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const data = await listLlmProfiles();
    res.json({ profiles: data.profiles.map(toClientProfile), activeProfileId: data.activeProfileId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/admin/llm-profiles", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await loadVcaSettings();
    const stored = getCachedVcaSettings();
    const data = await createLlmProfile(pickProfileFields(req.body || {}), {
      apiKey: stored.apiKey,
      imageApiKey: stored.imageApiKey,
    });
    res.json({ profiles: data.profiles.map(toClientProfile), activeProfileId: data.activeProfileId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put("/admin/llm-profiles/:profileId", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const data = await updateLlmProfile(param(req, "profileId"), pickProfileFields(req.body || {}));
    res.json({ profiles: data.profiles.map(toClientProfile), activeProfileId: data.activeProfileId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete("/admin/llm-profiles/:profileId", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const data = await deleteLlmProfile(param(req, "profileId"));
    res.json({ profiles: data.profiles.map(toClientProfile), activeProfileId: data.activeProfileId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Admin: version-control profiles ───────────────────────────
// Named global VCS credential/host profiles (GitHub or Azure DevOps). The PAT
// is encrypted at rest and redacted to the sentinel in every response; projects
// reference a profile by id (see project settings + git-remote/create).

function pickVcsProfileFields(body: Record<string, unknown>): Omit<ClientVcsProfile, "id"> {
  const str = (k: string) => (typeof body[k] === "string" ? body[k] as string : "");
  const provider = body.provider === "azure-devops" ? "azure-devops" : "github";
  return {
    name: str("name"),
    provider,
    host: str("host"),
    organization: str("organization"),
    project: str("project"),
    username: str("username"),
    pat: str("pat"),
  };
}

apiRouter.get("/admin/vcs-profiles", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    res.json({ profiles: (await listVcsProfiles()).map(redactVcsProfile) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/admin/vcs-profiles", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    res.json({ profiles: await createVcsProfile(pickVcsProfileFields(req.body || {})) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put("/admin/vcs-profiles/:profileId", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    res.json({ profiles: await updateVcsProfile(param(req, "profileId"), pickVcsProfileFields(req.body || {})) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete("/admin/vcs-profiles/:profileId", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    res.json({ profiles: await deleteVcsProfile(param(req, "profileId")) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Non-admin: the profile picker in Project Settings needs id+name+provider only
// (no host/org/secret). Any authenticated user who can open project settings.
apiRouter.get("/vcs-profiles", async (_req: Request, res: Response) => {
  try {
    const profiles = (await listVcsProfiles()).map((p) => ({ id: p.id, name: p.name, provider: p.provider }));
    res.json({ profiles });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Apply a profile: copy its fields into vca-settings.json server-side (the
// real secrets live in the profile store, so nothing round-trips through the
// client). Web tool options are reset to the provider-driven defaults.
apiRouter.post("/admin/llm-profiles/:profileId/apply", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const profile = await getLlmProfile(param(req, "profileId"));
    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }
    const actor = getSessionUserId(req) || null;
    const saved = await writeVcaSettings({
      apiKey: profile.apiKey,
      llmProvider: profile.llmProvider,
      llmModelId: profile.llmModelId,
      llmEndpoint: profile.llmEndpoint,
      llmApiVersion: profile.llmApiVersion,
      llmContextWindow: profile.llmContextWindow,
      llmMaxTokens: profile.llmMaxTokens,
      imageProvider: profile.imageProvider,
      imageModelId: profile.imageModelId,
      imageApiKey: profile.imageApiKey,
      imageUseLlmKey: profile.imageUseLlmKey,
      webSearchEnabled: true,
      webFetchEnabled: true,
      webSearchModelId: "",
      webSearchContextSize: "",
      webSearchEngine: "",
      webSearchMaxResults: 0,
      webFetchEngine: "",
    }, actor);
    await setActiveLlmProfileId(profile.id);
    console.log(`[llm-profiles] ${actor || "unknown"} applied profile "${profile.name}"`);
    res.json({ settings: redactVcaSettings(saved) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: available-models lookup for the Settings model picker. POST so the
// dialog's current (possibly unsaved) endpoint/apiKey can ride in the body;
// an empty or UNCHANGED-sentinel apiKey falls back to the stored key server-
// side. Must never return a bare 401 — the frontend api() helper reads that
// as session expiry — so upstream auth failures surface as 502 + code or a
// 200 catalog degrade.
apiRouter.post("/admin/llm-models", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await loadVcaSettings();
    const body = (req.body || {}) as { provider?: unknown; endpoint?: unknown; apiKey?: unknown; apiVersion?: unknown; noCache?: unknown; images?: unknown };
    if (typeof body.provider !== "string" || !body.provider) {
      res.status(400).json({ error: "provider is required", code: "PROVIDER_REQUIRED" });
      return;
    }
    res.json(await listLlmModels({
      provider: body.provider,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      apiVersion: typeof body.apiVersion === "string" ? body.apiVersion : undefined,
      noCache: body.noCache === true,
      images: body.images === true,
    }));
  } catch (err: any) {
    if (err instanceof ModelListError) {
      res.status(err.httpStatus).json({ error: err.message, code: err.code });
      return;
    }
    console.error("[llm-models] failed:", err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Admin: live connection test for the setup wizard. Sends one tiny real
// inference request through the same resolver a chat turn uses (see
// src/llm-test-connection.ts) so a green result actually means chat will work.
//
// A failed probe is a *successful* test, so it comes back 200 with
// { ok: false, code }. Non-2xx is reserved for "the test could not be run at
// all". That also makes it structurally impossible to leak an upstream 401
// into the frontend api() helper's session-expiry path.
apiRouter.post("/admin/llm-test-connection", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await loadVcaSettings();
    const body = (req.body || {}) as { provider?: unknown; modelId?: unknown; apiKey?: unknown; endpoint?: unknown; apiVersion?: unknown };
    if (typeof body.provider !== "string" || !body.provider) {
      res.status(400).json({ error: "provider is required", code: "PROVIDER_REQUIRED" });
      return;
    }
    res.json(await testLlmConnection({
      provider: body.provider,
      modelId: typeof body.modelId === "string" ? body.modelId.trim() : "",
      apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
      endpoint: typeof body.endpoint === "string" ? body.endpoint.trim() : "",
      apiVersion: typeof body.apiVersion === "string" ? body.apiVersion.trim() : "",
    }));
  } catch (err: any) {
    console.error("[llm-test] failed:", err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Admin: provider subscription sign-in (OAuth). One route group per provider,
// registered from a single factory keyed by a short slug:
//   - "codex"      → ChatGPT/Codex (browser PKCE w/ localhost:1455 callback +
//                    manual paste, and device code)
//   - "kimi"       → Kimi Code (device code only)
//   - "openrouter" → OpenRouter (browser PKCE w/ ephemeral loopback; desktop)
// The OAuth flow itself (callback server, device polling, refresh) runs inside
// pi via src/provider-oauth.ts — these routes only orchestrate it. Token
// material never leaves the server; the browser sees URLs, device codes, and
// status flags. All 403 (never bare 401 — the SPA's api() helper reads 401 as
// VCA-session expiry).
// ---------------------------------------------------------------------------

function registerProviderAuthRoutes(slug: string, logTag: string): void {
  const base = `/admin/${slug}-auth`;
  const manager = () => {
    const m = getProviderAuthManager(slug);
    if (!m) throw new Error(`Unknown provider auth slug: ${slug}`);
    return m;
  };

  // Sign-in status + current login-flow state. Without ?verify=1 this is a
  // cheap poll target (in-memory reads, no token refresh). With ?verify=1 —
  // used when the Settings card opens — it actively probes the credential:
  // pi refreshes an expired access token in place (persisted), and a failed
  // refresh reports healthy:false so the card can prompt for a re-sign-in.
  apiRouter.get(base, async (req: Request, res: Response) => {
    if (!getSessionIsAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const m = manager();
    const status = m.getStatus();
    if (query(req, "verify") === "1" && status.signedIn) {
      const v = await m.verify();
      // Re-read: a successful verify may have refreshed expiry in place.
      res.json({ ...m.getStatus(), login: m.getLoginState(), healthy: v.healthy, ...(v.error ? { authError: v.error } : {}) });
      return;
    }
    res.json({ ...status, login: m.getLoginState() });
  });

  // Start a sign-in. Responds once the auth URL (browser method) or user code
  // (device method) is known; the flow keeps running server-side and is
  // observed via GET <base>. 409 while another sign-in is pending.
  apiRouter.post(`${base}/login`, async (req: Request, res: Response) => {
    if (!getSessionIsAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    try {
      const rawMethod = (req.body || {}).method;
      // Pass a recognized method through; anything else lets the manager pick
      // the provider's default (and clamp unsupported methods).
      const method = rawMethod === "device_code" ? "device_code" : rawMethod === "browser" ? "browser" : undefined;
      const state = await manager().startLogin(method);
      // Packaged desktop: the server and the admin share the machine — open the
      // system browser directly (same pattern as the release-folder open below).
      // browserOpened tells the SPA not to window.open a second copy; it still
      // shows the URL for the copy/paste path. Device flows have no authUrl, so
      // the SPA shows the verification link + user code instead.
      let browserOpened = false;
      if (process.env.VCA_PACKAGED === "1" && state.status === "pending" && state.authUrl) {
        try {
          const { shell } = await import("electron");
          void shell.openExternal(state.authUrl);
          browserOpened = true;
        } catch (err) {
          console.warn(`[${logTag}] Could not open the system browser:`, err);
        }
      }
      res.json({ ...state, browserOpened });
    } catch (err: any) {
      if (err instanceof OAuthLoginPendingError) {
        res.status(409).json({ error: err.message, code: "LOGIN_PENDING" });
        return;
      }
      console.error(`[${logTag}] login start failed:`, err);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Manual completion: the admin pastes the redirect URL (or bare authorization
  // code) shown by the browser. Codex-only in practice (the path for
  // remote/Docker deployments and port-1455 conflicts); Kimi/OpenRouter never
  // prompt for a code, so this simply reports "no login waiting" for them.
  apiRouter.post(`${base}/login/code`, (req: Request, res: Response) => {
    if (!getSessionIsAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const code = (req.body || {}).code;
    if (typeof code !== "string" || !code.trim()) {
      res.status(400).json({ error: "code is required" });
      return;
    }
    try {
      const m = manager();
      m.submitLoginCode(code.trim());
      res.json(m.getLoginState());
    } catch (err: any) {
      res.status(409).json({ error: err?.message || String(err), code: "NO_LOGIN_WAITING" });
    }
  });

  apiRouter.get(`${base}/login/status`, (req: Request, res: Response) => {
    if (!getSessionIsAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    res.json(manager().getLoginState());
  });

  apiRouter.post(`${base}/login/cancel`, (req: Request, res: Response) => {
    if (!getSessionIsAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const m = manager();
    m.cancelLogin();
    res.json(m.getLoginState());
  });

  // Sign out: removes the stored credential. Cached sessions fail on their next
  // prompt via classifyLlmError, which surfaces an actionable "sign in again"
  // error bubble (CODEX_AUTH_REQUIRED for codex, otherwise LLM_AUTH_ERROR).
  apiRouter.post(`${base}/logout`, async (req: Request, res: Response) => {
    if (!getSessionIsAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    try {
      await manager().logout();
      res.json({ signedIn: false });
    } catch (err: any) {
      console.error(`[${logTag}] logout failed:`, err);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}

registerProviderAuthRoutes("codex", "codex-auth");
registerProviderAuthRoutes("kimi", "kimi-auth");
registerProviderAuthRoutes("openrouter", "openrouter-auth");

// Admin: network settings. Currently just the global TLS certificate
// verification toggle (default on). No secrets, so returned in the clear.
apiRouter.get("/admin/network-settings", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await loadVcaSettings();
    res.json({ tlsVerificationEnabled: getCachedVcaSettings().tlsVerificationEnabled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: set the global TLS posture. Persisted to vca-settings.json and applied
// to the running process immediately (affects subsequent outbound connections).
apiRouter.put("/admin/network-settings", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const enabled = (req.body || {}).tlsVerificationEnabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "tlsVerificationEnabled (boolean) is required" });
      return;
    }
    const actor = getSessionUserId(req) || null;
    const saved = await writeVcaSettings({ tlsVerificationEnabled: enabled }, actor);
    applyTlsVerification(saved.tlsVerificationEnabled);
    console.log(`[network-settings] TLS verification set to ${saved.tlsVerificationEnabled} by ${actor || "unknown"}`);
    res.json({ tlsVerificationEnabled: saved.tlsVerificationEnabled });
  } catch (err: any) {
    console.error("[network-settings] PUT failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: platform environment variables (Settings → Environment). Secret values
// are AES-encrypted at rest and never returned — the redacted view sends the
// UNCHANGED sentinel for set secrets so the client can round-trip on save.
apiRouter.get("/admin/env-vars", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await loadEnvVars();
    res.json({ vars: redactEnvVars(getCachedEnvVars()) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put("/admin/env-vars", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const rawVars = (req.body || {}).vars;
    if (!Array.isArray(rawVars)) {
      res.status(400).json({ error: "Body must be { vars: [...] }" });
      return;
    }
    const vars: ClientEnvVar[] = rawVars.map((v: any) => ({
      key: String(v?.key ?? "").trim(),
      secret: v?.secret === true,
      value: typeof v?.value === "string" ? v.value : "",
    }));
    const invalid = validateEnvKeys(vars);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    const actor = getSessionUserId(req) || null;
    const saved = await writeEnvVars(vars, actor);
    // Reflect changes onto the running server immediately (mirrors tls-config).
    await applyEnvVarsToProcess(saved);
    console.log(`[env-vars] PUT by ${actor || "unknown"}: ${saved.vars.length} var(s)`);
    res.json({ vars: redactEnvVars(saved) });
  } catch (err: any) {
    console.error("[env-vars] PUT failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Proxy for Google Generative AI when key is server-configured
apiRouter.post("/google-ai/generate", async (req: Request, res: Response) => {
  const key = getGoogleApiKey();
  if (!key) {
    res.status(404).json({ error: "No server-configured Google API key" });
    return;
  }
  try {
    const { model, body } = req.body;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || "gemini-3.1-flash-image-preview"}:generateContent?key=${key}`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Unified image-generation proxy. Reads provider + model + key from the
// cached vca-settings.json so secrets never reach the browser. Body shape:
//   { prompt: string, imageDataUrl: string }
// Response on success: { dataUrl: string }. On failure: { error: string }.
apiRouter.post("/image/generate", async (req: Request, res: Response) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const imageDataUrl = typeof req.body?.imageDataUrl === "string" ? req.body.imageDataUrl : "";
    if (!prompt.trim()) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    if (!imageDataUrl.startsWith("data:image/")) {
      res.status(400).json({ error: "imageDataUrl must be a data:image/... URL" });
      return;
    }

    const stored = getCachedVcaSettings();
    const provider = stored.imageProvider || "google";
    // Per-provider key resolution: "use LLM key" reuses the chat key; Google
    // falls back to the env var so the legacy single-key setup keeps working.
    // openai-codex has no reusable API key (ChatGPT OAuth token), so "use LLM
    // key" is treated as off there.
    const useLlmKey = stored.imageUseLlmKey && stored.llmProvider !== "openai-codex";
    const configuredKey = useLlmKey ? stored.apiKey : stored.imageApiKey;
    const apiKey = configuredKey || (provider === "google" ? (getGoogleApiKey() || "") : "");

    if (provider === "google") {
      if (!apiKey) {
        res.status(400).json({ error: "Google API key not configured" });
        return;
      }
      const model = stored.imageModelId || "gemini-3.1-flash-image-preview";
      const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: base64 } }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
        },
      );
      const data: any = await upstream.json();
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: data?.error?.message || `Upstream error ${upstream.status}` });
        return;
      }
      const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p) => p.inlineData || p.inline_data);
      const imgData = imagePart?.inlineData || imagePart?.inline_data;
      if (!imgData) {
        res.status(502).json({ error: "Upstream returned no image" });
        return;
      }
      res.json({ dataUrl: `data:${imgData.mimeType || imgData.mime_type};base64,${imgData.data}` });
      return;
    }

    if (provider === "openrouter") {
      if (!apiKey) {
        res.status(400).json({ error: "OpenRouter API key not configured" });
        return;
      }
      const model = stored.imageModelId || "google/gemini-2.5-flash-image-preview";
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          modalities: ["image", "text"],
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          }],
        }),
      });
      const data: any = await upstream.json();
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: data?.error?.message || `Upstream error ${upstream.status}` });
        return;
      }
      const msg = data?.choices?.[0]?.message;
      const imgUrl = msg?.images?.[0]?.image_url?.url
        || (typeof msg?.content === "string" && msg.content.startsWith("data:image") ? msg.content : null);
      if (!imgUrl) {
        res.status(502).json({ error: "Upstream returned no image" });
        return;
      }
      res.json({ dataUrl: imgUrl });
      return;
    }

    res.status(400).json({ error: `Image provider "${provider}" is not yet supported by the proxy` });
  } catch (err: any) {
    console.error("[image/generate] failed:", err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Create project
apiRouter.post("/projects", async (req: Request, res: Response) => {
  try {
    const { userId, name, apiKey, llmConfig, appTemplate } = req.body;
    if (!userId || !name) {
      res.status(400).json({ error: "userId and name are required" });
      return;
    }
    const effectiveLlmConfig: UserLLMConfig | undefined = llmConfig || (apiKey ? { provider: "anthropic", apiKey } : undefined);
    const creatorEmail = getSessionEmail(req);
    const projectId = await createProject(userId, name, apiKey, effectiveLlmConfig, creatorEmail, appTemplate);
    res.json({ projectId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize project workspace (phase 2 of creation — sends SSE progress events)
apiRouter.post("/projects/:projectId/initialize", async (req: Request, res: Response) => {
  try {
    const { userId, name, creatorEmail } = req.body;
    const projectId = param(req, "projectId");
    if (!userId || !projectId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    await initializeProject(userId, projectId, name || "", creatorEmail || getSessionEmail(req));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List user's projects
apiRouter.get("/users/:userId/projects", async (req: Request, res: Response) => {
  try {
    const projects = await listProjects(param(req, "userId"));
    res.json(projects);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Per-user prefs (theme, lang, thinkingLevel). enforceUserIdMatch in the
// auth middleware already restricts every `/users/:userId/*` call to the
// session's own userId, so no extra admin gate is needed here.
apiRouter.get("/users/:userId/prefs", async (req: Request, res: Response) => {
  try {
    // isNew = no prefs file yet, i.e. this user's first launch. The client
    // uses it to apply one-time defaults (desktop language) exactly once.
    const { prefs, exists } = await readUserPrefsRecord(param(req, "userId"));
    res.json({ prefs, isNew: !exists });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put("/users/:userId/prefs", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Partial<UserPrefs>;
    const prefs = await writeUserPrefs(param(req, "userId"), body);
    res.json({ prefs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Virtual project folders ───────────────────────────────────
// Per-user display hierarchy for the project list (project-folders.ts).
// Folder assignments live on projects.json entries; nothing moves on disk.

function sendFolderError(res: Response, err: any): void {
  if (err instanceof FolderValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err.message });
}

apiRouter.get("/users/:userId/project-folders", async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    res.json({ folders: await listProjectFolders(userId) });
  } catch (err: any) {
    sendFolderError(res, err);
  }
});

apiRouter.post("/users/:userId/project-folders", async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    const parentId = typeof req.body?.parentId === "string" && req.body.parentId ? req.body.parentId : null;
    const result = await createProjectFolder(userId, req.body?.name, parentId);
    res.json(result);
  } catch (err: any) {
    sendFolderError(res, err);
  }
});

apiRouter.patch("/users/:userId/project-folders/:folderId", async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    const folders = await renameProjectFolder(userId, param(req, "folderId"), req.body?.name);
    res.json({ folders });
  } catch (err: any) {
    sendFolderError(res, err);
  }
});

// Re-parent a virtual folder (parentId null/"" → top level). Metadata-only:
// nothing on disk moves. Cycle-guarded in moveProjectFolder.
apiRouter.put("/users/:userId/project-folders/:folderId/parent", async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    const parentId = typeof req.body?.parentId === "string" && req.body.parentId ? req.body.parentId : null;
    const folders = await moveProjectFolder(userId, param(req, "folderId"), parentId);
    res.json({ folders });
  } catch (err: any) {
    sendFolderError(res, err);
  }
});

apiRouter.delete("/users/:userId/project-folders/:folderId", async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    const folderId = param(req, "folderId");
    const { parentId, folders } = await deleteProjectFolder(userId, folderId);
    // Projects filed under the deleted folder move to its parent, mirroring
    // what happens to its child folders.
    await reassignProjectFolder(userId, folderId, parentId);
    res.json({ folders });
  } catch (err: any) {
    sendFolderError(res, err);
  }
});

// File a project under a virtual folder (folderId null/"" → top level).
apiRouter.put("/projects/:projectId/folder", async (req: Request, res: Response) => {
  try {
    const { userId, folderId } = req.body || {};
    if (!userId || getSessionUserId(req) !== userId) {
      res.status(403).json({ error: "userId does not match authenticated session" });
      return;
    }
    const target = typeof folderId === "string" && folderId ? folderId : null;
    if (target) {
      const folders = await listProjectFolders(userId);
      if (!folders.some((f) => f.id === target)) {
        res.status(400).json({ error: "Folder not found" });
        return;
      }
    }
    await setProjectFolder(userId, param(req, "projectId"), target);
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.message === "Project not found") {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// Reset user sessions (used when LLM config changes)
apiRouter.post("/users/:userId/reset-sessions", async (req: Request, res: Response) => {
  try {
    await resetUserSessions(param(req, "userId"));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Re-resolve the admin-managed system prompt + app templates and re-clone
// any admin-listed skill repos, then reseed active sessions so the change
// is live without a restart.
apiRouter.post("/admin/sync-all", async (_req: Request, res: Response) => {
  try {
    const report = await syncAllSystemContent();
    if (report.ok) await reseedAllSessions();
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Admin: system skills (authored locally, no git) ───────────
// CRUD lives at admin/skills/<name>/SKILL.md. Mutations invalidate the
// system-skills cache and reseed live sessions so changes are visible
// without a /admin/sync-all roundtrip.

apiRouter.get("/admin/skills", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const skills = await listAdminSkills();
    res.json({ skills });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/admin/skills/:skillName", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const skill = await getAdminSkill(param(req, "skillName"));
    if (!skill) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(skill);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/admin/skills", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const { name, description, content } = req.body || {};
    await createAdminSkill(name, description, content || "");
    invalidateSystemSkillsCache();
    await reseedAllSessions();
    res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof SkillValidationError) {
      res.status(400).json({ error: err.message, code: err.code, field: err.field });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put("/admin/skills/:skillName", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const { description, content } = req.body || {};
    await updateAdminSkill(param(req, "skillName"), description, content || "");
    invalidateSystemSkillsCache();
    await reseedAllSessions();
    res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof SkillValidationError) {
      res.status(400).json({ error: err.message, code: err.code, field: err.field });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete("/admin/skills/:skillName", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await deleteAdminSkill(param(req, "skillName"));
    invalidateSystemSkillsCache();
    await reseedAllSessions();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Shared by the skill zip/repo install routes (admin + user tiers). The
// stable `code` lets the client distinguish "exists → offer replace" from
// hard failures.
function sendSkillInstallError(res: Response, err: any): void {
  if (err instanceof SkillExistsError) {
    res.status(409).json({ error: err.message, code: err.code, skillName: err.skillName });
    return;
  }
  if (err instanceof SkillInstallError) {
    const status = err.code === "offline" ? 503 : err.code === "system-collision" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof SkillValidationError) {
    res.status(400).json({ error: err.message, code: err.code, field: err.field });
    return;
  }
  res.status(500).json({ error: err.message });
}

apiRouter.post("/admin/skills/install-zip", upload.single("file"), async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "A zip file is required" });
      return;
    }
    const fallbackName = (file.originalname || "").replace(/^.*[\\/]/, "");
    const result = await installSkillFromZip(file.buffer, {
      tier: "admin",
      fallbackName,
      replace: req.query.replace === "1",
    });
    invalidateSystemSkillsCache();
    await reseedAllSessions();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    sendSkillInstallError(res, err);
  }
});

// ─── Admin: skill repo URLs ────────────────────────────────────
// Persisted in admin/skill-repos.json. Cloned by /admin/sync-all (POST
// triggers a sync automatically; DELETE leaves the next sync to clean up).

apiRouter.get("/admin/skill-repos", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const urls = await listAdminSkillRepos();
    res.json({ urls });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/admin/skill-repos", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const url = req.body && typeof req.body.url === "string" ? req.body.url : "";
    if (!url.trim()) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const urls = await addAdminSkillRepo(url);
    // Sync immediately so the new repo's skills are visible without a
    // separate /admin/sync-all click.
    const report = await syncAllSystemContent();
    if (report.ok) await reseedAllSessions();
    res.json({ urls, sync: report });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete("/admin/skill-repos", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const url = req.body && typeof req.body.url === "string" ? req.body.url : "";
    if (!url.trim()) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const urls = await removeAdminSkillRepo(url);
    // Sync + reseed immediately (mirrors the POST handler) so the removed
    // repo's skill disappears now — the sync prunes _system/skills-active and
    // the repo cache, and the reseed prunes the per-user copies — instead of
    // lingering until the next unrelated sync.
    const report = await syncAllSystemContent();
    if (report.ok) await reseedAllSessions();
    res.json({ urls, sync: report });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: system prompt (local file + optional repo URL) ─────
// Local override wins when both are configured (matches default-skills.ts
// merge precedence). Mutations resync system content and reseed sessions
// so the new prompt is live without a restart.

apiRouter.get("/admin/system-prompt", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const local = await getLocalSystemPrompt();
    const repo = await getSystemPromptRepoConfig();
    const activeUrl = getSystemPromptRepoUrl();
    res.json({
      local: local !== null ? { content: local } : null,
      repo: repo ? { url: repo.url } : null,
      activeSource: local !== null ? "local" : (repo ? "repo" : null),
      activeVersion: getSystemPromptVersion(),
      activeRepoUrl: activeUrl,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put("/admin/system-prompt/local", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const content = req.body && typeof req.body.content === "string" ? req.body.content : null;
    if (content === null) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    await setLocalSystemPrompt(content);
    const report = await syncAllSystemContent();
    if (report.ok) await reseedAllSessions();
    res.json({ ok: true, sync: report });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete("/admin/system-prompt/local", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await deleteLocalSystemPrompt();
    const report = await syncAllSystemContent();
    if (report.ok) await reseedAllSessions();
    res.json({ ok: true, sync: report });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put("/admin/system-prompt/repo", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const url = req.body && typeof req.body.url === "string" ? req.body.url : "";
    if (!url.trim()) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    await setSystemPromptRepoConfig({ url: url.trim() });
    const report = await syncAllSystemContent();
    if (report.ok) await reseedAllSessions();
    res.json({ ok: true, sync: report });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete("/admin/system-prompt/repo", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await clearSystemPromptRepoConfig();
    const report = await syncAllSystemContent();
    if (report.ok) await reseedAllSessions();
    res.json({ ok: true, sync: report });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: app templates (local dirs + optional repo URL list) ─

apiRouter.get("/admin/app-templates", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const local = await listLocalTemplates();
    res.json({
      local: local.map(t => ({
        name: t.name,
        description: t.description,
        appType: t.appType,
        deploymentOption: t.deploymentOption,
        dirName: t.dirName,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/admin/app-templates", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const name = req.body && typeof req.body.name === "string" ? req.body.name : "";
    const description = req.body && typeof req.body.description === "string" ? req.body.description : "";
    const appType = req.body?.appType === "web" ? "web" : "node";
    const deploymentOption = parseTemplateDeploymentOption(req.body?.deploymentOption);
    if (!name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const created = await createLocalTemplate(name, description, appType, deploymentOption);
    const report = await syncAllSystemContent();
    res.json({ template: created, sync: report });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put("/admin/app-templates/:dirName", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const dirName = param(req, "dirName");
    const description = req.body && typeof req.body.description === "string" ? req.body.description : "";
    // appType only changes when explicitly sent; otherwise the stored flag is kept.
    const appType = req.body?.appType === "web" ? "web" as const
      : req.body?.appType === "node" ? "node" as const
      : undefined;
    // deploymentOption: key absent = keep stored value; null or an
    // unparseable explicit value = clear; valid value = replace.
    const deploymentOption = !("deploymentOption" in (req.body ?? {}))
      ? undefined
      : req.body.deploymentOption === null
        ? null
        : (parseTemplateDeploymentOption(req.body.deploymentOption) ?? null);
    await updateLocalTemplate(dirName, description, appType, deploymentOption);
    const report = await syncAllSystemContent();
    res.json({ ok: true, sync: report });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete("/admin/app-templates/:dirName", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    await deleteLocalTemplate(param(req, "dirName"));
    const report = await syncAllSystemContent();
    res.json({ ok: true, sync: report });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Install a template from an uploaded zip. No userId here: the admin gate in
// apiAuthMiddleware runs before multer parses the multipart body.
apiRouter.post(
  "/admin/app-templates/install",
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!getSessionIsAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ error: "A zip file is required" });
        return;
      }
      const fallbackName = (file.originalname || "")
        .replace(/^.*[\\/]/, "")
        .replace(/\.zip$/i, "");
      const replace = req.query.replace === "1";
      const template = await installTemplateFromZip(file.buffer, { fallbackName, replace });
      const report = await syncAllSystemContent();
      res.json({ template, sync: report });
    } catch (err: any) {
      if (err?.code === "exists") {
        res.status(409).json({ error: err.message, code: "exists", templateName: err.templateName });
        return;
      }
      res.status(400).json({ error: err.message });
    }
  },
);

// Download a template as a zip (dependencies and build output excluded).
apiRouter.get("/admin/app-templates/:dirName/export", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const dirName = param(req, "dirName");
    const tpl = (await listLocalTemplates()).find((t) => t.dirName === dirName);
    if (!tpl) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    res.attachment(`${dirName}.zip`);
    const archive = archiver("zip", { zlib: { level: 5 } });
    archive.on("error", (err) => res.destroy(err));
    archive.pipe(res);
    // .vca/ (skills + instructions) must be included — hence dot: true.
    archive.glob("**/*", { cwd: tpl.dir, ignore: [".git/**", "node_modules/**"], dot: true });
    await archive.finalize();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: list all other users with their projects (display names, not UUIDs).
apiRouter.get("/admin/users-with-projects", async (req: Request, res: Response) => {
  try {
    const adminUserId = getSessionUserId(req) || query(req, "userId");
    if (!adminUserId) {
      res.status(400).json({ error: "Cannot resolve admin userId" });
      return;
    }
    const users = await enumerateUsersWithProjects(adminUserId);
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: symlink another user's project workspace into this admin's folder.
apiRouter.post("/admin/projects/link", async (req: Request, res: Response) => {
  try {
    const adminUserId = getSessionUserId(req) || (req.body && req.body.userId);
    const { targetUserId, projectId } = req.body || {};
    if (!adminUserId || !targetUserId || !projectId) {
      res.status(400).json({ error: "adminUserId, targetUserId, and projectId are required" });
      return;
    }
    await linkProject(adminUserId, targetUserId, projectId);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err && err.code === "ALREADY_LINKED" ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── Admin: MCP servers (used by PI agent) ─────────────────────
// MCP servers are configured globally by admins. Tool listings are probed
// from each server on demand (cached 5 minutes per id+updatedAt) so the
// admin UI can always show what tools each configured server exposes.

function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 4) return "••••";
  return `${"•".repeat(Math.max(0, key.length - 4))}${key.slice(-4)}`;
}

function publicMcpServer(s: McpServerConfig) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    authType: s.authType,
    apiKeyMasked: s.authType === "apiKey" ? maskApiKey(s.apiKey) : undefined,
    enabled: s.enabled,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

apiRouter.get("/admin/active-users", (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const users = listActiveUsers();
  res.json({ count: users.length, users });
});

apiRouter.get("/admin/mcp-servers", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const servers = await readMcpServers();
    const probed = await Promise.all(
      servers.map(async (s) => {
        const base = publicMcpServer(s);
        if (!s.enabled) return { ...base, tools: [], probe: { ok: true, skipped: true } };
        const probe = await probeMcpServer(s);
        return {
          ...base,
          tools: probe.tools || [],
          probe: { ok: probe.ok, error: probe.error, fetchedAt: probe.fetchedAt },
        };
      }),
    );
    res.json({ servers: probed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/admin/mcp-servers", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const adminUserId = getSessionUserId(req) || "unknown";
    const server = await addMcpServer(req.body || {}, adminUserId);
    const probe = server.enabled ? await probeMcpServer(server, { force: true }) : { ok: true, tools: [] as any[] };
    res.json({
      server: {
        ...publicMcpServer(server),
        tools: probe.tools || [],
        probe: { ok: probe.ok, error: (probe as any).error, fetchedAt: (probe as any).fetchedAt },
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put("/admin/mcp-servers/:id", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const id = param(req, "id");
  try {
    invalidateMcpProbeCache(id);
    const server = await updateMcpServer(id, req.body || {});
    const probe = server.enabled ? await probeMcpServer(server, { force: true }) : { ok: true, tools: [] as any[] };
    res.json({
      server: {
        ...publicMcpServer(server),
        tools: probe.tools || [],
        probe: { ok: probe.ok, error: (probe as any).error, fetchedAt: (probe as any).fetchedAt },
      },
    });
  } catch (err: any) {
    const status = err && err.code === "NOT_FOUND" ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.delete("/admin/mcp-servers/:id", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const id = param(req, "id");
  try {
    await deleteMcpServer(id);
    invalidateMcpProbeCache(id);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err && err.code === "NOT_FOUND" ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

apiRouter.post("/admin/mcp-servers/:id/probe", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const id = param(req, "id");
  try {
    const server = await getMcpServer(id);
    if (!server) {
      res.status(404).json({ error: `No MCP server with id ${id}` });
      return;
    }
    const probe = await probeMcpServer(server, { force: true });
    res.json({
      server: {
        ...publicMcpServer(server),
        tools: probe.tools || [],
        probe: { ok: probe.ok, error: probe.error, fetchedAt: probe.fetchedAt },
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: runtime OAuth (Entra) config ───────────────────────────
// Source of truth lives in ${WORKSPACES_ROOT}/admin/auth-config.json,
// loaded by src/auth-config.ts with env-var fallback. Env vars are read
// only when the file is absent; once an admin saves here, the file wins.

apiRouter.get("/admin/auth-config", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const snap = await getAuthConfig();
    res.json({ config: redact(snap) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

apiRouter.put("/admin/auth-config", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const body = req.body || {};
    const enabled = body.enabled === true;
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
    const scopes = Array.isArray(body.scopes) ? body.scopes : undefined;

    // Preflight when enabling: bail early so the admin never gets booted to
    // an Entra screen they can't escape from.
    if (enabled) {
      const current = await getAuthConfig();
      const effectiveSecret = clientSecret === UNCHANGED_SECRET_SENTINEL ? current.clientSecret : clientSecret;
      const verdict = await testAuthConfig(tenantId, clientId, effectiveSecret);
      if (!verdict.ok) {
        res.status(400).json({
          error: `Preflight failed at ${verdict.stage}: ${verdict.message}`,
          code: "AUTH_PREFLIGHT_FAILED",
          stage: verdict.stage,
        });
        return;
      }
    } else {
      // Lockout guard when disabling OAuth: refuse if every existing admin
      // would lose login (no local user with admin rights remains).
      const current = await getAuthConfig();
      if (current.enabled) {
        const localAdmins = await countLocalAdmins(isAdminUser);
        if (localAdmins === 0) {
          res.status(409).json({
            error: "Cannot disable OAuth — no local admin users exist. Create a local admin first.",
            code: "NO_LOCAL_ADMIN",
          });
          return;
        }
      }
    }

    const actor = getSessionUserId(req) || null;
    const saved = await saveAuthConfig({ enabled, tenantId, clientId, clientSecret, scopes }, actor);
    res.json({ config: redact(saved) });
  } catch (err: any) {
    const status = err && (err.code === "INVALID_TENANT_ID" || err.code === "INVALID_CLIENT_ID" || err.code === "INVALID_CLIENT_SECRET") ? 400 : 500;
    res.status(status).json({ error: err?.message || String(err), code: err?.code });
  }
});

// ─── Admin: user management ────────────────────────────────────────
// File-backed user records under <WORKSPACES_ROOT>/<userId>/user.json.
// Local users (authType==="local") have username+password and can log in via
// /auth/login-local. Entra users (authType==="entra") log in via OAuth and
// are auto-provisioned on first /auth/callback hit; admins can also create
// them ahead of time by OID for pre-registration.

function mapUserStoreError(err: any): { status: number; body: any } {
  const code = err?.code;
  const codeToStatus: Record<string, number> = {
    NOT_FOUND: 404,
    DUPLICATE_USERNAME: 409,
    NOT_LOCAL_USER: 409,
    INVALID_USERNAME: 400,
    INVALID_PASSWORD: 400,
    INVALID_EMAIL: 400,
    INVALID_FIRSTNAME: 400,
    INVALID_LASTNAME: 400,
    INVALID_USER_ID: 400,
    SELF_DELETE: 409,
    HAS_PROJECTS: 409,
  };
  const status = (code && codeToStatus[code]) || 500;
  const body: any = { error: err?.message || String(err) };
  if (code) body.code = code;
  return { status, body };
}

apiRouter.get("/admin/users", async (_req: Request, res: Response) => {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (err: any) {
    const { status, body } = mapUserStoreError(err);
    res.status(status).json(body);
  }
});

apiRouter.get("/admin/users/:targetUserId", async (req: Request, res: Response) => {
  try {
    const user = await loadPublicUser(param(req, "targetUserId"));
    if (!user) {
      res.status(404).json({ error: "User not found", code: "NOT_FOUND" });
      return;
    }
    res.json({ user });
  } catch (err: any) {
    const { status, body } = mapUserStoreError(err);
    res.status(status).json(body);
  }
});

apiRouter.post("/admin/users", async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const authType = body.authType === "local" ? "local" : body.authType === "entra" ? "entra" : null;
    if (!authType) {
      res.status(400).json({ error: "authType must be 'local' or 'entra'", code: "INVALID_AUTH_TYPE" });
      return;
    }

    let user;
    if (authType === "local") {
      user = await createLocalUser({
        username: body.username,
        firstName: body.firstName ?? "",
        lastName: body.lastName ?? "",
        email: body.email ?? "",
        password: body.password,
      });
    } else {
      // Body field is `entraOid` (not `userId`) so the global per-request
      // enforceUserIdMatch guard doesn't reject admins creating other users.
      user = await createEntraUser({
        userId: typeof body.entraOid === "string" ? body.entraOid : "",
        username: body.username,
        firstName: body.firstName ?? "",
        lastName: body.lastName ?? "",
        email: body.email ?? "",
      });
    }

    // Bootstrap the first admin: when no admin group exists yet, create one
    // and add this user. Lets a fresh install bring up its first admin without
    // env-var gymnastics or OAuth being preconfigured.
    let promotedToAdmin = false;
    try {
      if (!(await hasAdminGroup())) {
        const group = await createVcaGroup(
          { kind: "admin", name: "Administrators", description: "Created automatically with the first user" },
          user.userId,
        );
        await addManualMember(group.id, {
          userId: user.userId,
          displayName: user.displayName,
          email: user.email,
        }, "__bootstrap__");
        promotedToAdmin = true;
      }
    } catch (groupErr) {
      console.warn("[admin/users] first-admin bootstrap failed:", groupErr);
    }

    res.status(201).json({ user, promotedToAdmin });
  } catch (err: any) {
    const { status, body } = mapUserStoreError(err);
    res.status(status).json(body);
  }
});

apiRouter.put("/admin/users/:targetUserId", async (req: Request, res: Response) => {
  try {
    const targetUserId = param(req, "targetUserId");
    const body = req.body || {};
    const user = await updateUser(targetUserId, {
      username: body.username,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
    });
    res.json({ user });
  } catch (err: any) {
    const { status, body } = mapUserStoreError(err);
    res.status(status).json(body);
  }
});

apiRouter.post("/admin/users/:targetUserId/password", async (req: Request, res: Response) => {
  try {
    const targetUserId = param(req, "targetUserId");
    const body = req.body || {};
    await setLocalPassword(targetUserId, body.password);
    res.json({ ok: true });
  } catch (err: any) {
    const { status, body } = mapUserStoreError(err);
    res.status(status).json(body);
  }
});

apiRouter.delete("/admin/users/:targetUserId", async (req: Request, res: Response) => {
  try {
    const targetUserId = param(req, "targetUserId");
    const sessionUserId = getSessionUserId(req);
    if (targetUserId === sessionUserId) {
      res.status(409).json({ error: "You cannot delete your own account", code: "SELF_DELETE" });
      return;
    }
    const force = query(req, "force") === "1";
    if (!force) {
      const hasProjects = await getUserHasProjects(targetUserId);
      if (hasProjects) {
        res.status(409).json({
          error: "User has projects. Transfer them first or retry with ?force=1.",
          code: "HAS_PROJECTS",
        });
        return;
      }
    }
    await deleteUser(targetUserId);
    res.json({ ok: true });
  } catch (err: any) {
    const { status, body } = mapUserStoreError(err);
    res.status(status).json(body);
  }
});

apiRouter.post("/admin/auth-config/test-connection", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const body = req.body || {};
    const current = await getAuthConfig();
    const tenantId = typeof body.tenantId === "string" && body.tenantId.trim() ? body.tenantId.trim() : current.tenantId;
    const clientId = typeof body.clientId === "string" && body.clientId.trim() ? body.clientId.trim() : current.clientId;
    const submittedSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
    const clientSecret = submittedSecret && submittedSecret !== UNCHANGED_SECRET_SENTINEL
      ? submittedSecret
      : current.clientSecret;
    const verdict = await testAuthConfig(tenantId, clientId, clientSecret);
    if (verdict.ok) {
      res.json({
        ok: true,
        authorizationEndpoint: verdict.discovery.authorization_endpoint,
        tokenEndpoint: verdict.discovery.token_endpoint,
      });
    } else {
      res.json({ ok: false, stage: verdict.stage, message: verdict.message });
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Admin: drop the symlink (and projects.json entry) for a previously linked project.
apiRouter.post("/admin/projects/unlink", async (req: Request, res: Response) => {
  try {
    const adminUserId = getSessionUserId(req) || (req.body && req.body.userId);
    const { projectId } = req.body || {};
    if (!adminUserId || !projectId) {
      res.status(400).json({ error: "adminUserId and projectId are required" });
      return;
    }
    await unlinkProject(adminUserId, projectId);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err && err.code === "NOT_A_LINK" ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Admin: move full project ownership from one user to another. Workspace
// rename + projects.json + inbound-link records + every existing share's
// symlink/sourceUserId are re-pointed to the new owner. Refuses if the
// project is currently open by anyone.
apiRouter.post("/admin/projects/transfer", async (req: Request, res: Response) => {
  if (!getSessionIsAdmin(req)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  try {
    const { fromUserId, toUserId, projectId } = req.body || {};
    if (!fromUserId || !toUserId || !projectId) {
      res.status(400).json({ error: "fromUserId, toUserId, and projectId are required" });
      return;
    }
    const result = await transferProjectOwnership(fromUserId, toUserId, projectId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const codeToStatus: Record<string, number> = {
      INVALID_ARGS: 400,
      SELF_TRANSFER: 400,
      PROJECT_NOT_FOUND: 404,
      NOT_OWNER: 409,
      NOT_OWNER_DIR: 409,
      PROJECT_LOCKED: 409,
      TARGET_HAS_REAL_DIR: 409,
      PARTIAL_TRANSFER_ROLLED_BACK: 500,
      PARTIAL_TRANSFER_UNRECOVERABLE: 500,
    };
    const status = (err && err.code && codeToStatus[err.code]) || err?.status || 500;
    const body: any = { error: err?.message || String(err) };
    if (err?.code) body.code = err.code;
    if (err?.holder) body.holder = err.holder;
    res.status(status).json(body);
  }
});

// ─── Admin: vca-managed groups (admin + users) ──────────────
// Replaces the previous Graph-driven AZURE_ENTRA_ADMIN_GROUP_ID and
// VCA_USERS_GROUP_ID env-var checks. Membership lives in
// ${WORKSPACES_ROOT}/admin/vca-groups.json; a group may optionally be
// linked to a Microsoft Graph group, in which case Graph drives membership
// and admins can trigger a full re-sync from the UI.

function mapVcaGroupError(err: any): { status: number; body: any } {
  const code = err?.code;
  const codeToStatus: Record<string, number> = {
    NOT_FOUND: 404,
    DUPLICATE_GROUP: 409,
    GROUP_IS_LINKED: 409,
    LAST_ADMIN: 409,
    LAST_ADMIN_GROUP: 409,
    NOT_LINKED: 409,
    INVALID_NAME: 400,
    INVALID_KIND: 400,
    INVALID_USER_ID: 400,
    INVALID_GRAPH_GROUP_ID: 400,
    GRAPH_INSUFFICIENT_PERMISSIONS: 403,
  };
  const status = (code && codeToStatus[code]) || err?.status || 500;
  const body: any = { error: err?.message || String(err) };
  if (code) body.code = code;
  return { status, body };
}

apiRouter.get("/admin/vca-groups", async (_req: Request, res: Response) => {
  try {
    const groups = await listVcaGroups();
    res.json({ groups });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.get("/admin/vca-groups/:groupId", async (req: Request, res: Response) => {
  try {
    const group = await getVcaGroup(param(req, "groupId"));
    if (!group) {
      res.status(404).json({ error: "Group not found", code: "NOT_FOUND" });
      return;
    }
    res.json({ group });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.post("/admin/vca-groups", async (req: Request, res: Response) => {
  try {
    const adminUserId = getSessionUserId(req) || "unknown";
    const { kind, name, description } = req.body || {};
    const group = await createVcaGroup({ kind, name, description }, adminUserId);
    res.json({ group });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.patch("/admin/vca-groups/:groupId", async (req: Request, res: Response) => {
  try {
    const group = await updateVcaGroup(param(req, "groupId"), req.body || {});
    res.json({ group });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.delete("/admin/vca-groups/:groupId", async (req: Request, res: Response) => {
  try {
    await deleteVcaGroup(param(req, "groupId"));
    res.json({ ok: true });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.post("/admin/vca-groups/:groupId/members", async (req: Request, res: Response) => {
  try {
    const adminUserId = getSessionUserId(req) || "unknown";
    const { userId, displayName, email } = req.body || {};
    const member = await addManualMember(param(req, "groupId"), { userId, displayName, email }, adminUserId);
    res.json({ member });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.delete("/admin/vca-groups/:groupId/members/:memberUserId", async (req: Request, res: Response) => {
  try {
    await removeManualMember(param(req, "groupId"), param(req, "memberUserId"));
    res.json({ ok: true });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.post("/admin/vca-groups/:groupId/link", async (req: Request, res: Response) => {
  try {
    const adminUserId = getSessionUserId(req) || "unknown";
    const { graphGroupId, graphGroupName } = req.body || {};
    if (typeof graphGroupId !== "string" || !graphGroupId.trim()) {
      res.status(400).json({ error: "graphGroupId is required" });
      return;
    }
    const linked = await linkToGraphGroup(
      param(req, "groupId"),
      graphGroupId.trim(),
      typeof graphGroupName === "string" ? graphGroupName : "",
      adminUserId,
    );
    let syncResult: { added: number; removed: number; kept: number } | null = null;
    try {
      syncResult = await syncLinkedGroup(linked.id);
    } catch (syncErr: any) {
      // Linking succeeded; sync failure surfaces in lastSyncStatus + UI banner.
      const { body } = mapVcaGroupError(syncErr);
      res.json({ group: await getVcaGroup(linked.id), sync: { ok: false, ...body } });
      return;
    }
    res.json({ group: await getVcaGroup(linked.id), sync: { ok: true, ...syncResult } });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.post("/admin/vca-groups/:groupId/unlink", async (req: Request, res: Response) => {
  try {
    const mode: UnlinkMode = req.body?.mode === "drop" ? "drop" : "keep";
    const group = await unlinkFromGraphGroup(param(req, "groupId"), mode);
    res.json({ group });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.post("/admin/vca-groups/:groupId/sync", async (req: Request, res: Response) => {
  try {
    const result = await syncLinkedGroup(param(req, "groupId"));
    res.json({ ok: true, ...result, group: await getVcaGroup(param(req, "groupId")) });
  } catch (err: any) {
    const { status, body } = mapVcaGroupError(err);
    res.status(status).json(body);
  }
});

apiRouter.get("/admin/graph-groups/search", async (req: Request, res: Response) => {
  try {
    const q = query(req, "q");
    const limitRaw = parseInt(query(req, "limit") || "10", 10);
    const groups = await searchGraphGroups(q, Number.isFinite(limitRaw) ? limitRaw : 10);
    res.json({ groups });
  } catch (err: any) {
    if (err?.code === "GRAPH_INSUFFICIENT_PERMISSIONS" || err?.status === 403) {
      res.status(403).json({
        error: err?.message || "Graph permission required",
        code: "GRAPH_INSUFFICIENT_PERMISSIONS",
        requiredRole: "GroupMember.Read.All",
      });
      return;
    }
    if (err?.code === "GRAPH_NOT_CONFIGURED") {
      res.status(503).json({ error: err.message, code: err.code });
      return;
    }
    res.status(err?.status || 500).json({ error: err?.message || String(err) });
  }
});

// List another user's owned projects. Any authenticated vca user may call this.
apiRouter.get("/users/:userId/public-projects", async (req: Request, res: Response) => {
  try {
    const requesterUserId = getSessionUserId(req) || query(req, "userId");
    const targetUserId = param(req, "userId");
    if (!requesterUserId) {
      res.status(400).json({ error: "Cannot resolve requester userId" });
      return;
    }
    const projects = await listPublicProjects(targetUserId);
    res.json(projects);
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err?.message || String(err) });
  }
});

// Link another user's project into the requester's gallery.
apiRouter.post("/projects/:projectId/link", async (req: Request, res: Response) => {
  try {
    const requesterUserId = getSessionUserId(req) || (req.body && req.body.userId);
    const projectId = param(req, "projectId");
    const sourceUserId = req.body?.sourceUserId;
    if (!requesterUserId || !sourceUserId || !projectId) {
      res.status(400).json({ error: "userId, sourceUserId, and projectId are required" });
      return;
    }
    await linkProject(requesterUserId, sourceUserId, projectId);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err?.code === "ALREADY_LINKED" ? 409 : (err?.status || 500);
    res.status(status).json({ error: err?.message || String(err) });
  }
});

apiRouter.post("/projects/:projectId/unlink", async (req: Request, res: Response) => {
  try {
    const requesterUserId = getSessionUserId(req) || (req.body && req.body.userId);
    const projectId = param(req, "projectId");
    if (!requesterUserId || !projectId) {
      res.status(400).json({ error: "userId and projectId are required" });
      return;
    }
    await unlinkProject(requesterUserId, projectId);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err?.code === "NOT_A_LINK" ? 400 : (err?.status || 500);
    res.status(status).json({ error: err?.message || String(err) });
  }
});

// ─── People search ──────────────────────────────────────────────
// Search Microsoft Graph for users by name / email / UPN prefix. Used by the
// transfer-ownership recipient autocomplete.
apiRouter.get("/people/search", async (req: Request, res: Response) => {
  try {
    if (!isGraphConfigured()) {
      res.status(503).json({ error: "Microsoft Graph is not configured" });
      return;
    }
    const q = query(req, "q");
    const limitRaw = parseInt(query(req, "limit") || "10", 10);
    const users = await searchUsers(q, Number.isFinite(limitRaw) ? limitRaw : 10);
    res.json({ users });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err?.message || String(err) });
  }
});

// ─── Project lock (single-writer across users for shared projects) ───
// Acquire the canonical lock on a project. Called by the frontend on every
// SELECT_PROJECT before the project view is loaded. Returns 200 on success
// or 409 with the current holder so the UI can render the "in use" modal.
apiRouter.post("/projects/:projectId/lock", async (req: Request, res: Response) => {
  try {
    const userId = getSessionUserId(req) || (req.body && req.body.userId);
    const projectId = param(req, "projectId");
    if (!userId || !projectId) {
      res.status(400).json({ error: "userId and projectId are required" });
      return;
    }
    const displayName = req.vcaSession?.displayName || userId;
    const email = getSessionEmail(req);
    const result = await acquireProjectLock(userId, displayName, email, projectId);
    if (result.ok) {
      res.json({ ok: true, holder: result.holder });
    } else {
      res.status(409).json({ ok: false, error: "Project is in use", code: "PROJECT_IN_USE", holder: result.holder });
    }
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err?.message || String(err), code: err?.code });
  }
});

// Read the current holder. Used to refresh the "in use" modal after a 409.
apiRouter.get("/projects/:projectId/lock", async (req: Request, res: Response) => {
  try {
    const userId = getSessionUserId(req) || query(req, "userId");
    const projectId = param(req, "projectId");
    if (!userId || !projectId) {
      res.status(400).json({ error: "userId and projectId are required" });
      return;
    }
    const holder = await getProjectLockHolder(userId, projectId);
    const owner = await isProjectOwner(userId, projectId);
    res.json({ holder, isOwner: owner });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err?.message || String(err), code: err?.code });
  }
});

// Explicit release. Fire-and-forget on project switch and via sendBeacon on
// tab close. Idempotent — releasing a lock you don't hold is a no-op (200).
apiRouter.post("/projects/:projectId/lock/release", async (req: Request, res: Response) => {
  try {
    const userId = getSessionUserId(req) || (req.body && req.body.userId);
    const projectId = param(req, "projectId");
    if (!userId || !projectId) {
      res.status(400).json({ error: "userId and projectId are required" });
      return;
    }
    await releaseProjectLock(userId, projectId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err?.message || String(err), code: err?.code });
  }
});

// Owner-only force takeover. Aborts the previous holder's in-flight agent
// sessions and pushes a lock_taken_over SSE event to their browser.
apiRouter.post("/projects/:projectId/lock/take-over", async (req: Request, res: Response) => {
  try {
    const userId = getSessionUserId(req) || (req.body && req.body.userId);
    const projectId = param(req, "projectId");
    if (!userId || !projectId) {
      res.status(400).json({ error: "userId and projectId are required" });
      return;
    }
    const displayName = req.vcaSession?.displayName || userId;
    const email = getSessionEmail(req);
    const result = await takeOverProjectLock(userId, displayName, email, projectId);
    res.json(result);
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err?.message || String(err), code: err?.code });
  }
});

// Delete project
apiRouter.delete("/projects/:projectId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    await deleteProject(userId, param(req, "projectId"));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update project (rename)
apiRouter.patch("/projects/:projectId", async (req: Request, res: Response) => {
  try {
    const { userId, name } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    if (name === undefined || !name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const projectId = param(req, "projectId");
    await renameProject(userId, projectId, name);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Read this project's settings. Available to anyone who can list the project —
// dialog uses it to refresh on open in case another admin edited the values
// since the gallery last loaded.
apiRouter.get("/projects/:projectId/settings", async (req: Request, res: Response) => {
  try {
    const userId = getSessionUserId(req) || query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const projectId = param(req, "projectId");
    const workspacePath = await getWorkspacePathForProject(userId, projectId);
    const settings = await readProjectSettings(workspacePath);
    // Monitoring data for the dialog's read-only Usage section; never writable.
    const cost = await readProjectCost(workspacePath);
    // The project's folder on disk (owner-resolved for links/shares). Shown
    // read-only in the settings dialog's Folder path section so the user can
    // copy it and open the workspace directly.
    res.json({ settings, cost, workspacePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update this project's settings. Admin-only. Bypasses the single-writer lock
// by design: settings only affect the next deploy, not the active workspace, so
// an admin can change them without coordinating with whoever currently has the
// project open.
apiRouter.patch("/projects/:projectId/settings", async (req: Request, res: Response) => {
  try {
    if (!getSessionIsAdmin(req)) {
      res.status(403).json({ error: "Admin privileges required" });
      return;
    }
    const userId = req.body?.userId || getSessionUserId(req);
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const projectId = param(req, "projectId");
    const workspacePath = await getWorkspacePathForProject(userId, projectId);
    // The stored app_type gates which deployment options are legal
    // ("web-export" is web-app-only) — resolve it before validating.
    const current = await readProjectSettings(workspacePath);
    const { value, errors } = await validateProjectSettings({
      deploymentOption: req.body?.deploymentOption,
      vcsProfileId: req.body?.vcsProfileId,
      repoUrl: req.body?.repoUrl,
      vcsOverrideUsername: req.body?.vcsOverrideUsername,
      vcsOverridePat: req.body?.vcsOverridePat,
    }, current.appType);
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }
    await setProjectSettings(userId, projectId, value);
    // Re-read so the response carries the REDACTED override PAT, never the raw
    // value the client just submitted.
    const settings = await readProjectSettings(workspacePath);
    res.json({ settings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Read this project's app version (main.minor.build). Available to anyone who
// can list the project. Returns { version: null } for apps without a version.
apiRouter.get("/projects/:projectId/version", async (req: Request, res: Response) => {
  try {
    const userId = getSessionUserId(req) || query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const info = await getAppVersionInfo(userId, param(req, "projectId"));
    res.json(info ?? { version: null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Set this project's main & minor version manually (build resets to 0).
// Owner-initiated (scoped to the caller's own project), not admin-gated.
apiRouter.patch("/projects/:projectId/version", async (req: Request, res: Response) => {
  try {
    const userId = req.body?.userId || getSessionUserId(req);
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const main = Number(req.body?.main);
    const minor = Number(req.body?.minor);
    if (!Number.isInteger(main) || main < 0 || !Number.isInteger(minor) || minor < 0) {
      res.status(400).json({ error: "main and minor must be non-negative integers" });
      return;
    }
    const info = await setAppMainMinor(userId, param(req, "projectId"), main, minor);
    res.json(info);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      res.status(400).json({ error: "This app has no package.json to version" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── App icon ────────────────────────────────────────────────────────────
// Owner-scoped (like rename/version, NOT admin-gated): the person building the
// app owns its icon. The icon is a single square PNG master; its presence is
// the whole state (see readProjectSettings → hasIcon). Deployment derives the
// Electron installer/app icon and the web favicon from it. apiAuthMiddleware
// already forces any userId to equal the session user, so an owner cannot
// reach another user's project.

// Serve the project's icon (PNG). 404 when unset so the gallery/preview can
// fall back to the default folder glyph.
apiRouter.get("/projects/:projectId/icon", async (req: Request, res: Response) => {
  try {
    const userId = getSessionUserId(req) || query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const buffer = await readProjectIcon(userId, param(req, "projectId"));
    if (!buffer) {
      res.status(404).json({ error: "No icon" });
      return;
    }
    res.type("image/png");
    // Icons change in place; never let a stale one persist past an edit/remove.
    res.set("Cache-Control", "no-cache");
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Set the project's icon from a base64 PNG data URL (generated or uploaded,
// normalized to a square PNG client-side). Owner-scoped.
apiRouter.put("/projects/:projectId/icon", async (req: Request, res: Response) => {
  try {
    const userId = req.body?.userId || getSessionUserId(req);
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const dataUrl = req.body?.dataUrl;
    const m = typeof dataUrl === "string"
      ? dataUrl.match(/^data:image\/png;base64,(.+)$/s)
      : null;
    if (!m) {
      res.status(400).json({ error: "dataUrl must be a base64 PNG data URL" });
      return;
    }
    const buffer = Buffer.from(m[1], "base64");
    if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
      res.status(400).json({ error: "Icon must be a non-empty PNG under 10 MB" });
      return;
    }
    await writeProjectIcon(userId, param(req, "projectId"), buffer);
    res.json({ ok: true, hasIcon: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Remove the project's icon (revert to the default). Owner-scoped, idempotent.
apiRouter.delete("/projects/:projectId/icon", async (req: Request, res: Response) => {
  try {
    const userId = req.body?.userId || getSessionUserId(req);
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    await deleteProjectIcon(userId, param(req, "projectId"));
    res.json({ ok: true, hasIcon: false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Send prompt
apiRouter.post("/projects/:projectId/prompt", async (req: Request, res: Response) => {
  try {
    const { userId, chatId, text, apiKey, images, llmConfig, displayText } = req.body;
    if (!userId || !chatId || !text) {
      res.status(400).json({ error: "userId, chatId, and text are required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    // Project-level prompt gate: only one chat per project may have an agent
    // running at a time. Pre-check before fire-and-forget so the user gets an
    // immediate, actionable error rather than a silent no-op.
    const activeChatId = getProjectActiveChatId(userId, projectId);
    if (activeChatId && activeChatId !== chatId) {
      res.status(409).json({
        error: "Another chat in this project is currently running an agent task. Wait for it to finish or abort it first.",
        code: "PROJECT_BUSY",
        activeChatId,
      });
      return;
    }
    const effectiveLlmConfig: UserLLMConfig | undefined = llmConfig || (apiKey ? { provider: "anthropic", apiKey } : undefined);
    // Display name of the user who submitted this prompt — persisted per message
    // so shared-project chats show the actual submitter, not the current viewer.
    const authorName = req.vcaSession?.displayName;
    // Don't await - let it stream via SSE
    sendPrompt(userId, projectId, chatId, text, apiKey, images, effectiveLlmConfig, displayText, authorName).catch((err) => {
      console.error("Prompt error:", err);
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Abort
apiRouter.post("/projects/:projectId/abort", async (req: Request, res: Response) => {
  try {
    const { userId, chatId } = req.body;
    if (!userId || !chatId) {
      res.status(400).json({ error: "userId and chatId are required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await abortSession(userId, projectId, chatId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Session status (used by frontend to sync after SSE reconnect)
apiRouter.get("/projects/:projectId/status", (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    const chatId = query(req, "chatId");
    if (!userId || !chatId) {
      res.status(400).json({ error: "userId and chatId query params are required" });
      return;
    }
    res.json(getSessionStatus(userId, param(req, "projectId"), chatId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Answer a multiple choice question
apiRouter.post("/projects/:projectId/answer", async (req: Request, res: Response) => {
  try {
    const { userId, chatId, toolCallId, answer } = req.body;
    if (!userId || !chatId || !toolCallId || answer == null) {
      res.status(400).json({ error: "userId, chatId, toolCallId, and answer are required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    answerQuestion(userId, projectId, chatId, toolCallId, answer);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Browser posts the captured preview screenshot for a pending screenshot tool call
apiRouter.post("/projects/:projectId/screenshot-result", async (req: Request, res: Response) => {
  try {
    const { userId, chatId, toolCallId, ok, dataUrl, width, height, error } = req.body;
    if (!userId || !chatId || !toolCallId || typeof ok !== "boolean") {
      res.status(400).json({ error: "userId, chatId, toolCallId, and ok are required" });
      return;
    }
    if (ok && (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/"))) {
      res.status(400).json({ error: "dataUrl must be a data:image/* URL when ok is true" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    resolveScreenshotResult(
      userId,
      projectId,
      chatId,
      toolCallId,
      ok
        ? { ok: true, dataUrl, width: Number(width) || 0, height: Number(height) || 0 }
        : { ok: false, error: String(error || "capture failed") },
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compact context
apiRouter.post("/projects/:projectId/compact", async (req: Request, res: Response) => {
  try {
    const { userId, chatId } = req.body;
    if (!userId || !chatId) {
      res.status(400).json({ error: "userId and chatId are required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await compactSession(userId, projectId, chatId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Clear a chat's messages (does not delete the chat itself)
apiRouter.post("/projects/:projectId/clear", async (req: Request, res: Response) => {
  try {
    const { userId, chatId } = req.body;
    if (!userId || !chatId) {
      res.status(400).json({ error: "userId and chatId are required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await clearChatMessages(userId, projectId, chatId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Rollback
apiRouter.post("/projects/:projectId/rollback", async (req: Request, res: Response) => {
  try {
    const { userId, chatId, commitHash } = req.body;
    if (!userId || !chatId) {
      res.status(400).json({ error: "userId and chatId are required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const turnCount = await rollback(userId, projectId, chatId, commitHash);
    res.json({ ok: true, turnCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get commit history
apiRouter.get("/projects/:projectId/commits", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }
    const commits = await getCommits(userId, param(req, "projectId"));
    res.json(commits);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Checkout a specific commit (view mode)
apiRouter.post("/projects/:projectId/checkout", async (req: Request, res: Response) => {
  try {
    const { userId, commitHash } = req.body;
    if (!userId || !commitHash) {
      res.status(400).json({ error: "userId and commitHash are required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await checkoutCommit(userId, projectId, commitHash);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Return to latest commit
apiRouter.post("/projects/:projectId/checkout-latest", async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await checkoutLatest(userId, projectId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get message history
apiRouter.get("/projects/:projectId/messages", async (req: Request, res: Response) => {
  const userId = query(req, "userId");
  const chatId = query(req, "chatId");
  if (!userId || !chatId) {
    res.status(400).json({ error: "userId and chatId query params are required" });
    return;
  }
  try {
    const messages = await getMessages(userId, param(req, "projectId"), chatId);
    res.json(messages);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Full cost state for the project's cost list dialog (lifetime total plus
// per-day buckets). Read-only monitoring data, viewer-readable like the
// settings GET.
apiRouter.get("/projects/:projectId/cost", async (req: Request, res: Response) => {
  const userId = getSessionUserId(req) || query(req, "userId");
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    const workspacePath = await getWorkspacePathForProject(userId, param(req, "projectId"));
    res.json(await readProjectCost(workspacePath));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List chats for a project (auto-creates chat-1 if none exist; lazily migrates legacy .vca-messages.json)
apiRouter.get("/projects/:projectId/chats", async (req: Request, res: Response) => {
  const userId = query(req, "userId");
  if (!userId) {
    res.status(400).json({ error: "userId query param is required" });
    return;
  }
  try {
    const chats = await listChats(userId, param(req, "projectId"));
    res.json(chats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new chat
apiRouter.post("/projects/:projectId/chats", async (req: Request, res: Response) => {
  try {
    const { userId, name } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const chat = await createChat(userId, projectId, name);
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a chat
apiRouter.patch("/projects/:projectId/chats/:chatId", async (req: Request, res: Response) => {
  try {
    const { userId, name } = req.body;
    if (!userId || !name) {
      res.status(400).json({ error: "userId and name are required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await renameChatById(userId, projectId, param(req, "chatId"), name);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a chat (returns the new chat list; if last chat was deleted a fresh chat-1 is created)
apiRouter.delete("/projects/:projectId/chats/:chatId", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId") || (req.body && req.body.userId);
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const chats = await deleteChatById(userId, projectId, param(req, "chatId"));
    res.json({ chats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Generate a markdown summary of a chat
apiRouter.post("/projects/:projectId/chats/:chatId/summary", async (req: Request, res: Response) => {
  try {
    const { userId, apiKey, llmConfig } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const summary = await generateChatSummary(userId, param(req, "projectId"), param(req, "chatId"), apiKey, llmConfig);
    res.json({ summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function writeSSE(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// SSE events stream
apiRouter.get("/projects/:projectId/events", (req: Request, res: Response) => {
  const userId = query(req, "userId");
  const chatId = query(req, "chatId");
  if (!userId || !chatId) {
    res.status(400).json({ error: "userId and chatId query params are required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const projectId = param(req, "projectId");
  const projectKey = `${userId}:${projectId}`;
  const clientId = crypto.randomUUID();
  const client = { id: clientId, res };
  addSSEClient(userId, projectId, chatId, client);
  // Tie the lock's keepalive to this SSE connection. If the user holds the
  // lock, an attached client cancels any pending grace-timer release; the
  // detach in cleanup() restarts it.
  attachSSEClientToLock(userId, projectId, clientId).catch(() => {});
  // Seed the live cost readout on every connect (page load, chat switch) so
  // the client never needs a separate fetch for the running total.
  getWorkspacePathForProject(userId, projectId)
    .then((wp) => readProjectCost(wp))
    .then((c) => writeSSE(res, "project_cost", { totalUsd: c.totalUsd, tokens: c.tokens }))
    .catch(() => {});
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const unsubscribePreview = subscribePreviewEvents(projectKey, (event) => {
    try {
      if (event.type === "state") {
        writeSSE(res, "preview_state", event.state);
      } else if (event.type === "log") {
        writeSSE(res, "server_log", { line: event.line, stream: event.stream });
      } else if (event.type === "reload") {
        writeSSE(res, "files_changed", {});
      }
    } catch {
      cleanup();
    }
  });

  const cleanup = () => {
    if (keepalive) clearInterval(keepalive);
    unsubscribePreview();
    removeSSEClient(userId, projectId, chatId, clientId);
    detachSSEClientFromLock(userId, projectId, clientId).catch(() => {});
  };

  try {
    writeSSE(res, "preview_state", getPreviewState(projectKey));
    // If this client connected mid-turn (e.g. page reload during an agent run),
    // replay the in-flight assistant message so it can rebuild the live
    // streaming placeholder; subsequent deltas then append correctly.
    const resume = getStreamingResume(userId, projectId, chatId);
    if (resume) writeSSE(res, "stream_resume", resume);
  } catch {
    cleanup();
    return;
  }

  keepalive = setInterval(() => {
    try {
      res.write(":keepalive\n\n");
    } catch {
      cleanup();
    }
  }, 15000);

  res.on("error", cleanup);
  req.on("close", cleanup);
});

// Preview runtime state
apiRouter.get("/projects/:projectId/preview-state", (req: Request, res: Response) => {
  const userId = query(req, "userId");
  if (!userId) {
    res.status(400).json({ error: "userId query param is required" });
    return;
  }
  const projectKey = `${userId}:${param(req, "projectId")}`;
  res.json({ ...getPreviewState(projectKey), logs: getAppProcessLogs(projectKey) });
});

// Ensure preview process is running for the selected project
apiRouter.post("/projects/:projectId/ensure-preview-running", async (req: Request, res: Response) => {
  const userId = query(req, "userId");
  if (!userId) {
    res.status(400).json({ error: "userId query param is required" });
    return;
  }
  const projectId = param(req, "projectId");
  if (!(await ensureProjectLockHeld(req, res, projectId))) return;
  const projectKey = `${userId}:${projectId}`;
  const workspacePath = await getWorkspacePathForProject(userId, projectId);
  await startAppProcess(workspacePath, projectKey);
  res.json({ ...getPreviewState(projectKey), logs: getAppProcessLogs(projectKey) });
});

// Process status (for preview info panel)
apiRouter.get("/projects/:projectId/process-status", (req: Request, res: Response) => {
  const userId = query(req, "userId");
  if (!userId) {
    res.status(400).json({ error: "userId query param is required" });
    return;
  }
  const projectKey = `${userId}:${param(req, "projectId")}`;
  res.json({ ...getPreviewState(projectKey), logs: getAppProcessLogs(projectKey) });
});

// Stop app process (used on project switch)
apiRouter.post("/projects/:projectId/stop-process", async (req: Request, res: Response) => {
  const userId = query(req, "userId");
  if (!userId) {
    res.status(400).json({ error: "userId query param is required" });
    return;
  }
  const projectId = param(req, "projectId");
  if (!(await ensureProjectLockHeld(req, res, projectId))) return;
  const projectKey = `${userId}:${projectId}`;
  await stopAppProcess(projectKey);
  res.json({ ...getPreviewState(projectKey), logs: getAppProcessLogs(projectKey) });
});

// Clear the in-memory app-process log buffer for the project. The process
// keeps running; only the cached log lines are dropped.
apiRouter.post("/projects/:projectId/server-logs/clear", async (req: Request, res: Response) => {
  const userId = (req.body && req.body.userId) || query(req, "userId");
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const projectKey = `${userId}:${param(req, "projectId")}`;
  clearAppProcessLogs(projectKey);
  res.json({ ok: true });
});

// Restart app process (deterministic stop + fresh start)
apiRouter.post("/projects/:projectId/restart-process", async (req: Request, res: Response) => {
  const userId = query(req, "userId");
  if (!userId) {
    res.status(400).json({ error: "userId query param is required" });
    return;
  }
  const projectId = param(req, "projectId");
  if (!(await ensureProjectLockHeld(req, res, projectId))) return;
  const projectKey = `${userId}:${projectId}`;
  const workspacePath = await getWorkspacePathForProject(userId, projectId);
  await restartAppProcess(workspacePath, projectKey);
  res.json({ ...getPreviewState(projectKey), logs: getAppProcessLogs(projectKey) });
});

// Skills CRUD
apiRouter.get("/users/:userId/skills", async (req: Request, res: Response) => {
  console.log("[api] GET /users/:userId/skills hit, userId:", param(req, "userId"));
  res.setHeader("Cache-Control", "no-store");
  try {
    // Optional ?projectId= includes the project's template-delivered project skills.
    const projectId = (req.query.projectId as string) || undefined;
    const skills = await listSkills(param(req, "userId"), projectId);
    console.log("[api] listSkills returned:", skills.length, "skills");
    res.json(skills);
  } catch (err: any) {
    console.error("[api] listSkills error:", err);
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/users/:userId/skills/:skillName", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const skill = await getSkill(param(req, "userId"), param(req, "skillName"));
    if (!skill) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(skill);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/users/:userId/skills", async (req: Request, res: Response) => {
  try {
    const { name, description, content } = req.body;
    await createSkill(param(req, "userId"), name, description, content || "");
    res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof SkillValidationError) {
      res.status(400).json({ error: err.message, code: err.code, field: err.field });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put("/users/:userId/skills/:skillName", async (req: Request, res: Response) => {
  try {
    const { description, content } = req.body;
    const skillName = param(req, "skillName");
    await updateSkill(param(req, "userId"), skillName, description, content || "");
    res.json({ ok: true });
  } catch (err: any) {
    if (err instanceof SkillValidationError) {
      res.status(400).json({ error: err.message, code: err.code, field: err.field });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete("/users/:userId/skills/:skillName", async (req: Request, res: Response) => {
  try {
    await deleteSkill(param(req, "userId"), param(req, "skillName"));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// One-shot skill installs (zip upload / repo import). Unlike the JSON CRUD
// routes above, the userId here must be checked in-handler: apiAuthMiddleware
// runs at mount time where req.params is empty, and for the multipart route
// the body isn't parsed until multer runs — enforceUserIdMatch can't see
// either. (The client additionally sends userId in query/body as defense in
// depth for the middleware.)
function requireOwnUserId(req: Request, res: Response): string | null {
  const userId = param(req, "userId");
  if (getSessionUserId(req) !== userId) {
    res.status(403).json({ error: "userId does not match authenticated session" });
    return null;
  }
  return userId;
}

apiRouter.post("/users/:userId/skills/install-zip", upload.single("file"), async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "A zip file is required" });
      return;
    }
    const fallbackName = (file.originalname || "").replace(/^.*[\\/]/, "");
    const result = await installSkillFromZip(file.buffer, {
      tier: "user",
      userId,
      fallbackName,
      replace: req.query.replace === "1",
    });
    await reloadSkillsForUser(userId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    sendSkillInstallError(res, err);
  }
});

apiRouter.post("/users/:userId/skills/install-repo", async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const result = await installUserSkillFromRepo(userId, url, req.body?.replace === true);
    await reloadSkillsForUser(userId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    sendSkillInstallError(res, err);
  }
});

// Re-pull every repo-tracked user skill (latest vX.X.X tag or default branch
// per skill setting). Per-skill failures are reported in results, not thrown.
apiRouter.post("/users/:userId/skills/refresh-repos", async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    const results = await refreshUserSkillRepos(userId);
    await reloadSkillsForUser(userId);
    res.json({ results });
  } catch (err: any) {
    sendSkillInstallError(res, err);
  }
});

// Update the tag-mode setting of a repo-tracked user skill.
apiRouter.put("/users/:userId/skill-repos/:skillName", async (req: Request, res: Response) => {
  const userId = requireOwnUserId(req, res);
  if (!userId) return;
  try {
    const skillName = param(req, "skillName");
    const entry = (await getUserSkillRepos(userId))[skillName];
    if (!entry) {
      res.status(404).json({ error: "Skill is not tracked from a repository" });
      return;
    }
    await setUserSkillRepo(userId, skillName, { ...entry, useTags: req.body?.useTags === true });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Map a git-remote error `code` to an HTTP status. INVALID_PAT is the SCM
// credential being bad, not the vca session — must NOT collide with vca's
// session-expiry 401, so it maps to 403.
function gitRemoteStatusForCode(code: string): number {
  return code === "INVALID_PAT" ? 403
    : code === "PROJECT_NOT_FOUND" ? 404
    : code === "REPO_EXISTS" || code === "NO_CREDENTIAL" ? 409
    : code === "UNPARSEABLE_URL" || code === "BAD_REQUEST" || code === "NO_PROFILE" ? 400
    : 500;
}

// Auto-create a repository via the project's chosen VCS profile and wire it up
// as origin. Credentials are resolved server-side — the client sends only
// `userId`. Returns a stable `code` on failure so the UI can localize it.
apiRouter.post("/projects/:projectId/git-remote/create", async (req: Request, res: Response) => {
  try {
    const { userId } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: "userId is required", code: "BAD_REQUEST" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const result = await createAndSetRemote(userId, projectId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const code = err?.code || "DEVOPS_ERROR";
    res.status(gitRemoteStatusForCode(code)).json({ error: err?.message || String(err), code });
  }
});

// Wire an already-configured repository URL as origin, resolving credentials
// from the project's VCS profile (+ optional override) server-side.
apiRouter.post("/projects/:projectId/git-remote/connect", async (req: Request, res: Response) => {
  try {
    const { userId } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: "userId is required", code: "BAD_REQUEST" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const result = await connectRemote(userId, projectId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const code = err?.code || "DEVOPS_ERROR";
    res.status(gitRemoteStatusForCode(code)).json({ error: err?.message || String(err), code });
  }
});

// Check git remote status
apiRouter.get("/projects/:projectId/git-remote-status", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }
    const configured = await hasGitRemote(userId, param(req, "projectId"));
    res.json({ configured });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get git remote details (clean URL only — credentials are never returned).
apiRouter.get("/projects/:projectId/git-remote", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }
    const remote = await getGitRemote(userId, param(req, "projectId"));
    res.json(remote || { remoteUrl: "" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Git push
apiRouter.post("/projects/:projectId/git-push", async (req: Request, res: Response) => {
  try {
    const { userId, force } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const output = await gitPush(userId, projectId, force);
    res.json({ ok: true, output });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Git pull
apiRouter.post("/projects/:projectId/git-pull", async (req: Request, res: Response) => {
  try {
    const { userId, force } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const output = await gitPull(userId, projectId, force);
    res.json({ ok: true, output });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get active skills for a project
apiRouter.get("/projects/:projectId/active-skills", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }
    const activeSkills = await getActiveSkills(userId, param(req, "projectId"));
    res.json(activeSkills);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Set active skills for a project
apiRouter.put("/projects/:projectId/active-skills", async (req: Request, res: Response) => {
  try {
    const { userId, skills } = req.body;
    if (!userId || !Array.isArray(skills)) {
      res.status(400).json({ error: "userId and skills array are required" });
      return;
    }
    await setActiveSkills(userId, param(req, "projectId"), skills);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Per-skill load status (whether pi-coding-agent's ResourceLoader actually
// loaded each skill, or rejected it with a diagnostic).
apiRouter.get("/projects/:projectId/skills-status", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const userId = query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }
    const status = await getSkillLoadStatus(userId, param(req, "projectId"));
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get use-case diagram data for a project
apiRouter.get("/projects/:projectId/usecase", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }
    const data = await getUseCaseData(userId, param(req, "projectId"));
    res.json(data || { actors: [], useCases: [], connections: [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Save use-case diagram data for a project
apiRouter.put("/projects/:projectId/usecase", async (req: Request, res: Response) => {
  try {
    const { userId, data } = req.body;
    if (!userId || !data) {
      res.status(400).json({ error: "userId and data are required" });
      return;
    }
    await setUseCaseData(userId, param(req, "projectId"), data);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update use-case diagram from Mermaid text (for agent integration)
apiRouter.put("/projects/:projectId/usecase-mermaid", async (req: Request, res: Response) => {
  try {
    const { userId, mermaid } = req.body;
    if (!userId || !mermaid) {
      res.status(400).json({ error: "userId and mermaid are required" });
      return;
    }
    const projectId = param(req, "projectId");
    const existing = await getUseCaseData(userId, projectId);
    const parsed = parseMermaidToUseCaseData(mermaid);
    // Preserve positions from existing data if available
    if (existing) {
      for (const a of parsed.actors) {
        const ea = existing.actors.find(e => e.name === a.name);
        if (ea && ea.x != null) { a.x = ea.x; a.y = ea.y; }
      }
      for (const uc of parsed.useCases) {
        const eu = existing.useCases.find(e => e.name === uc.name);
        if (eu && eu.x != null) { uc.x = eu.x; uc.y = eu.y; }
      }
      if (existing.boundaries && parsed.boundaries) {
        for (const b of parsed.boundaries) {
          const eb = existing.boundaries.find(e => e.name === b.name);
          if (eb) { b.x = eb.x; b.y = eb.y; b.width = eb.width; b.height = eb.height; }
        }
      }
    }
    await setUseCaseData(userId, projectId, parsed);
    res.json({ ok: true, data: parsed, mermaid: generateUseCaseMermaid(parsed) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get deployment diagram data for a project
apiRouter.get("/projects/:projectId/deployment", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) {
      res.status(400).json({ error: "userId query param is required" });
      return;
    }
    const data = await getDeploymentData(userId, param(req, "projectId"));
    res.json(data || { actors: [], useCases: [], connections: [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Save deployment diagram data for a project
apiRouter.put("/projects/:projectId/deployment", async (req: Request, res: Response) => {
  try {
    const { userId, data } = req.body;
    if (!userId || !data) {
      res.status(400).json({ error: "userId and data are required" });
      return;
    }
    await setDeploymentData(userId, param(req, "projectId"), data);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update deployment diagram from Mermaid text (for agent integration)
apiRouter.put("/projects/:projectId/deployment-mermaid", async (req: Request, res: Response) => {
  try {
    const { userId, mermaid } = req.body;
    if (!userId || !mermaid) {
      res.status(400).json({ error: "userId and mermaid are required" });
      return;
    }
    const projectId = param(req, "projectId");
    const existing = await getDeploymentData(userId, projectId);
    const parsed = parseMermaidToDeploymentData(mermaid);
    if (existing) {
      for (const a of parsed.actors) {
        const ea = existing.actors.find(e => e.name === a.name);
        if (ea && ea.x != null) { a.x = ea.x; a.y = ea.y; }
      }
      for (const uc of parsed.useCases) {
        const eu = existing.useCases.find(e => e.name === uc.name);
        if (eu && eu.x != null) { uc.x = eu.x; uc.y = eu.y; }
      }
      if (existing.boundaries && parsed.boundaries) {
        for (const b of parsed.boundaries) {
          const eb = existing.boundaries.find(e => e.name === b.name);
          if (eb) { b.x = eb.x; b.y = eb.y; b.width = eb.width; b.height = eb.height; }
        }
      }
    }
    await setDeploymentData(userId, projectId, parsed);
    res.json({ ok: true, data: parsed, mermaid: generateDeploymentMermaid(parsed) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Component Diagram ───────────────────────────────────────

apiRouter.get("/projects/:projectId/component", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    const data = await getComponentData(userId, param(req, "projectId"));
    res.json(data || { actors: [], useCases: [], connections: [] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.put("/projects/:projectId/component", async (req: Request, res: Response) => {
  try {
    const { userId, data } = req.body;
    if (!userId || !data) { res.status(400).json({ error: "userId and data are required" }); return; }
    await setComponentData(userId, param(req, "projectId"), data);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.put("/projects/:projectId/component-mermaid", async (req: Request, res: Response) => {
  try {
    const { userId, mermaid } = req.body;
    if (!userId || !mermaid) { res.status(400).json({ error: "userId and mermaid are required" }); return; }
    const projectId = param(req, "projectId");
    const existing = await getComponentData(userId, projectId);
    const parsed = parseMermaidToComponentData(mermaid);
    if (existing) {
      for (const a of parsed.actors) {
        const ea = existing.actors.find(e => e.name === a.name);
        if (ea && ea.x != null) { a.x = ea.x; a.y = ea.y; }
      }
      for (const uc of parsed.useCases) {
        const eu = existing.useCases.find(e => e.name === uc.name);
        if (eu && eu.x != null) { uc.x = eu.x; uc.y = eu.y; }
      }
      if (existing.boundaries && parsed.boundaries) {
        for (const b of parsed.boundaries) {
          const eb = existing.boundaries.find(e => e.name === b.name);
          if (eb) { b.x = eb.x; b.y = eb.y; b.width = eb.width; b.height = eb.height; }
        }
      }
    }
    await setComponentData(userId, projectId, parsed);
    res.json({ ok: true, data: parsed, mermaid: generateComponentMermaid(parsed) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Activity Diagrams ───────────────────────────────────────

apiRouter.get("/projects/:projectId/activities", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    const list = await listActivityDiagrams(userId, param(req, "projectId"));
    res.json(list);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.post("/projects/:projectId/activities", async (req: Request, res: Response) => {
  try {
    const { userId, name } = req.body;
    if (!userId || !name) { res.status(400).json({ error: "userId and name are required" }); return; }
    const id = await createActivityDiagram(userId, param(req, "projectId"), name);
    res.json({ id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.get("/projects/:projectId/activities/:activityId", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    const data = await getActivityData(userId, param(req, "projectId"), param(req, "activityId"));
    res.json(data || { id: param(req, "activityId"), name: "", nodes: [], transitions: [] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.put("/projects/:projectId/activities/:activityId", async (req: Request, res: Response) => {
  try {
    const { userId, data } = req.body;
    if (!userId || !data) { res.status(400).json({ error: "userId and data are required" }); return; }
    await setActivityData(userId, param(req, "projectId"), param(req, "activityId"), data);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.patch("/projects/:projectId/activities/:activityId", async (req: Request, res: Response) => {
  try {
    const { userId, name } = req.body;
    if (!userId || !name) { res.status(400).json({ error: "userId and name are required" }); return; }
    await renameActivityDiagram(userId, param(req, "projectId"), param(req, "activityId"), name);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.delete("/projects/:projectId/activities/:activityId", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    await deleteActivityDiagram(userId, param(req, "projectId"), param(req, "activityId"));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.put("/projects/:projectId/activities/:activityId/mermaid", async (req: Request, res: Response) => {
  try {
    const { userId, mermaid } = req.body;
    if (!userId || !mermaid) { res.status(400).json({ error: "userId and mermaid are required" }); return; }
    const projectId = param(req, "projectId");
    const activityId = param(req, "activityId");
    const existing = await getActivityData(userId, projectId, activityId);
    const parsed = parseMermaidToActivityData(mermaid);
    if (existing) {
      // Preserve existing positions
      for (const node of parsed.nodes) {
        const en = existing.nodes.find(e => e.name === node.name && e.type === node.type);
        if (en && en.x != null) { node.x = en.x; node.y = en.y; }
      }
      parsed.id = existing.id;
      parsed.name = existing.name;
    }
    await setActivityData(userId, projectId, activityId, parsed);
    res.json({ ok: true, data: parsed, mermaid: generateActivityMermaid(parsed) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── ER Diagrams ─────────────────────────────────────────────

apiRouter.get("/projects/:projectId/er-diagrams", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    const list = await listERDiagrams(userId, param(req, "projectId"));
    res.json(list);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.post("/projects/:projectId/er-diagrams", async (req: Request, res: Response) => {
  try {
    const { userId, name } = req.body;
    if (!userId || !name) { res.status(400).json({ error: "userId and name are required" }); return; }
    const id = await createERDiagram(userId, param(req, "projectId"), name);
    res.json({ id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.get("/projects/:projectId/er-diagrams/:erDiagramId", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    const data = await getERData(userId, param(req, "projectId"), param(req, "erDiagramId"));
    res.json(data || { id: param(req, "erDiagramId"), name: "", entities: [], relationships: [] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.put("/projects/:projectId/er-diagrams/:erDiagramId", async (req: Request, res: Response) => {
  try {
    const { userId, data } = req.body;
    if (!userId || !data) { res.status(400).json({ error: "userId and data are required" }); return; }
    await setERData(userId, param(req, "projectId"), param(req, "erDiagramId"), data);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.patch("/projects/:projectId/er-diagrams/:erDiagramId", async (req: Request, res: Response) => {
  try {
    const { userId, name } = req.body;
    if (!userId || !name) { res.status(400).json({ error: "userId and name are required" }); return; }
    await renameERDiagram(userId, param(req, "projectId"), param(req, "erDiagramId"), name);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.delete("/projects/:projectId/er-diagrams/:erDiagramId", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    await deleteERDiagram(userId, param(req, "projectId"), param(req, "erDiagramId"));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.put("/projects/:projectId/er-diagrams/:erDiagramId/mermaid", async (req: Request, res: Response) => {
  try {
    const { userId, mermaid } = req.body;
    if (!userId || !mermaid) { res.status(400).json({ error: "userId and mermaid are required" }); return; }
    const projectId = param(req, "projectId");
    const erDiagramId = param(req, "erDiagramId");
    const existing = await getERData(userId, projectId, erDiagramId);
    const parsed = parseMermaidToERData(mermaid);
    if (existing) {
      for (const entity of parsed.entities) {
        const en = existing.entities.find(e => e.name === entity.name);
        if (en && en.x != null) { entity.x = en.x; entity.y = en.y; }
      }
      parsed.id = existing.id;
      parsed.name = existing.name;
    }
    await setERData(userId, projectId, erDiagramId, parsed);
    res.json({ ok: true, data: parsed, mermaid: generateERMermaid(parsed) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Requirements ────────────────────────────────────────────

apiRouter.get("/projects/:projectId/requirements", async (req: Request, res: Response) => {
  try {
    const userId = query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    const list = await getRequirements(userId, param(req, "projectId"));
    res.json(list);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.post("/projects/:projectId/requirements", async (req: Request, res: Response) => {
  try {
    const { userId, data } = req.body;
    if (!userId) { res.status(400).json({ error: "userId is required" }); return; }
    const created = await createRequirement(userId, param(req, "projectId"), data || {});
    res.json(created);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.put("/projects/:projectId/requirements/:reqId", async (req: Request, res: Response) => {
  try {
    const { userId, data } = req.body;
    if (!userId || !data) { res.status(400).json({ error: "userId and data are required" }); return; }
    const updated = await updateRequirement(userId, param(req, "projectId"), param(req, "reqId"), data);
    res.json(updated);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

apiRouter.delete("/projects/:projectId/requirements/:reqId", async (req: Request, res: Response) => {
  try {
    const userId = req.body?.userId || query(req, "userId");
    if (!userId) { res.status(400).json({ error: "userId is required" }); return; }
    await deleteRequirement(userId, param(req, "projectId"), param(req, "reqId"));
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Userdata file manager ───────────────────────────────────

apiRouter.get("/projects/:projectId/userdata", async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const p = (req.query.path as string) || "";
    if (!userId) { res.status(400).json({ error: "userId is required" }); return; }
    const items = await listUserdata(userId, param(req, "projectId"), p);
    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/projects/:projectId/userdata/upload", upload.array("files", 20), async (req: Request, res: Response) => {
  try {
    // userId must come from query — multipart body is parsed after apiAuthMiddleware,
    // so a body-only userId would slip past the session-match check.
    const userId = req.query.userId as string;
    const p = (req.query.path as string) || "";
    if (!userId) { res.status(400).json({ error: "userId query param is required" }); return; }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const files = (req as any).files as Express.Multer.File[];
    if (!files || files.length === 0) { res.status(400).json({ error: "No files" }); return; }
    for (const f of files) {
      await uploadUserdata(userId, projectId, p, f.originalname, f.buffer);
    }
    res.json({ ok: true, count: files.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/projects/:projectId/userdata/unzip", async (req: Request, res: Response) => {
  try {
    const { userId, path: p } = req.body;
    if (!userId || !p) { res.status(400).json({ error: "userId and path are required" }); return; }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    const result = await unzipUserdata(userId, projectId, p);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/projects/:projectId/userdata/mkdir", async (req: Request, res: Response) => {
  try {
    const { userId, path: p } = req.body;
    if (!userId || !p) { res.status(400).json({ error: "userId and path are required" }); return; }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await mkdirUserdata(userId, projectId, p);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/projects/:projectId/userdata/rename", async (req: Request, res: Response) => {
  try {
    const { userId, path: p, newName } = req.body;
    if (!userId || !p || !newName) { res.status(400).json({ error: "userId, path, and newName are required" }); return; }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await renameUserdata(userId, projectId, p, newName);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/projects/:projectId/userdata/move", async (req: Request, res: Response) => {
  try {
    const { userId, src, dest } = req.body;
    if (!userId || !src || !dest) { res.status(400).json({ error: "userId, src, and dest are required" }); return; }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await moveUserdata(userId, projectId, src, dest);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete("/projects/:projectId/userdata", async (req: Request, res: Response) => {
  try {
    const { userId, path: p } = req.body;
    if (!userId || !p) { res.status(400).json({ error: "userId and path are required" }); return; }
    const projectId = param(req, "projectId");
    if (!(await ensureProjectLockHeld(req, res, projectId))) return;
    await deleteUserdata(userId, projectId, p);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/projects/:projectId/userdata/download", async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const p = req.query.path as string;
    if (!userId || !p) { res.status(400).json({ error: "userId and path are required" }); return; }
    const absPath = await downloadUserdataPath(userId, param(req, "projectId"), p);
    res.download(absPath);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Release folder (Electron build / web export output) ─────
// Read-only browsing of a project's release/ folder for the Deploy dialog.

apiRouter.get("/projects/:projectId/release", async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const p = (req.query.path as string) || "";
    if (!userId) { res.status(400).json({ error: "userId is required" }); return; }
    const items = await listRelease(userId, param(req, "projectId"), p);
    res.json(items);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get("/projects/:projectId/release/download", async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const p = req.query.path as string;
    if (!userId || !p) { res.status(400).json({ error: "userId and path are required" }); return; }
    const absPath = await downloadReleasePath(userId, param(req, "projectId"), p);
    res.download(absPath);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Open the project's release/ folder in the OS file explorer. Only works in
// the packaged desktop app, where the server runs inside the Electron main
// process and can reach `shell`. No-ops (400) in web/cloud mode.
apiRouter.post("/projects/:projectId/release/open", async (req: Request, res: Response) => {
  try {
    if (process.env.VCA_PACKAGED !== "1") {
      res.status(400).json({ error: "Opening the release folder is only available in the desktop app" });
      return;
    }
    const userId = (req.body && req.body.userId) as string;
    if (!userId) { res.status(400).json({ error: "userId is required" }); return; }
    const dir = await getReleaseDir(userId, param(req, "projectId"));
    const { shell } = await import("electron");
    const errMsg = await shell.openPath(dir);
    if (errMsg) { res.status(500).json({ error: errMsg }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Download project as zip
apiRouter.get("/projects/:projectId/download", async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const name = req.query.name as string || "project";
    if (!userId) { res.status(400).json({ error: "userId is required" }); return; }
    const workspacePath = await getWorkspacePathForProject(userId, param(req, "projectId"));
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);

    const archive = archiver("zip", { zlib: { level: 5 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);
    archive.glob("**/*", {
      cwd: workspacePath,
      ignore: [".git/**", ".vca-*", ".vca-skills/**", "node_modules/**"],
      dot: true,
    });
    await archive.finalize();
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

apiRouter.use(platformReleaseRouter);
