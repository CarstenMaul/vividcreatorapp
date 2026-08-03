import fs from "fs/promises";
import path from "path";

/**
 * Single source of truth for the vca data-path layout.
 *
 * The data root is `WORKSPACES_ROOT` — required at runtime. Deployment
 * sets it via `ENV WORKSPACES_ROOT=/mnt/storage` in the Dockerfile;
 * local dev must set it explicitly (a missing env var trips the
 * fail-fast assertion below).
 *
 * Layout under the root:
 *
 *   admin/                       vca-managed config (auth, groups, MCP, …)
 *     skills/                    admin-authored system skills (no git involved)
 *     skill-repos.json           extra skill repo URLs added by admins
 *     systemprompt/              optional admin-authored system prompt (overrides git)
 *       SYSTEM_PROMPT.md
 *     system-prompt-repo.json    optional {url} for a git-sourced system prompt
 *     app-templates/             admin-authored project templates (one dir per template)
 *       <name>/                  optional template.yaml + package.json + source tree
 *     vca-settings.json          deployment-wide Settings (LLM, DevOps, theme, lang)
 *   _system/                     system-wide caches (skill/template repos)
 *   .vca-sessions/             session-store files
 *   <userId>/                    per-user workspace
 *     user.json                  profile
 *     user-prefs.json            theme/lang/thinkingLevel (per-user UX)
 *     projects.json              project list
 *     links.json                 inbound links (gallery links)
 *     skills/                    user-authored skills
 *     <projectId>/               project workspace
 *       project.yaml             metadata (name, creator_email, …)
 *       .vca-*.json            vca-internal state (kept dot-prefixed so the
 *                                user's repo tree stays clean)
 *       .vca-skills/           project-scoped skill copies
 *       .vca-chats/            chat history + SDK working dirs
 */

export const WORKSPACES_ROOT: string = (() => {
  const v = process.env.WORKSPACES_ROOT;
  if (!v) {
    throw new Error(
      "WORKSPACES_ROOT env var is required. Set it to the workspace mount path " +
      "(production: /mnt/storage; local dev: e.g. C:\\local\\vca-data).",
    );
  }
  // Resolve to absolute so paths derived from this root stay stable when
  // consumers (notably the agent SDK) re-resolve them against a different cwd.
  // A relative root like "./.vca-data" otherwise produces doubled paths once
  // the workspace itself becomes the cwd.
  return path.resolve(v);
})();

/**
 * Top-level names under WORKSPACES_ROOT that are NOT user folders.
 * Used by callers that iterate users (identity migration, project enumeration).
 */
export const RESERVED_DIRS: ReadonlySet<string> = new Set([
  "admin",
  "_system",
  ".vca-sessions",
]);

export const adminPaths = {
  dir:                () => path.join(WORKSPACES_ROOT, "admin"),
  authConfig:         () => path.join(WORKSPACES_ROOT, "admin", "auth-config.json"),
  vcaGroups:        () => path.join(WORKSPACES_ROOT, "admin", "vca-groups.json"),
  vcaBootstrap:     () => path.join(WORKSPACES_ROOT, "admin", "vca-bootstrap.json"),
  usersIndex:         () => path.join(WORKSPACES_ROOT, "admin", "users-index.json"),
  mcpServers:         () => path.join(WORKSPACES_ROOT, "admin", "mcp-servers.json"),
  skillsDir:          () => path.join(WORKSPACES_ROOT, "admin", "skills"),
  skillRepos:         () => path.join(WORKSPACES_ROOT, "admin", "skill-repos.json"),
  systemPromptDir:    () => path.join(WORKSPACES_ROOT, "admin", "systemprompt"),
  systemPromptFile:   () => path.join(WORKSPACES_ROOT, "admin", "systemprompt", "SYSTEM_PROMPT.md"),
  systemPromptRepo:   () => path.join(WORKSPACES_ROOT, "admin", "system-prompt-repo.json"),
  appTemplatesDir:    () => path.join(WORKSPACES_ROOT, "admin", "app-templates"),
  vcaSettings:        () => path.join(WORKSPACES_ROOT, "admin", "vca-settings.json"),
  llmProfiles:        () => path.join(WORKSPACES_ROOT, "admin", "llm-profiles.json"),
  vcsProfiles:        () => path.join(WORKSPACES_ROOT, "admin", "vcs-profiles.json"),
  envVars:            () => path.join(WORKSPACES_ROOT, "admin", "env-vars.json"),
  // Auto-generated AES master key for admin env-var secrets. Dot-prefixed and
  // never exposed by any route. See src/secret-crypto.ts.
  envSecretsKey:      () => path.join(WORKSPACES_ROOT, "admin", ".env-secrets-key"),
  // Encrypted ChatGPT/Codex OAuth credential store (pi-ai CredentialStore
  // file; locking creates a sibling codex-auth.json.lock). See src/codex-auth.ts.
  codexAuth:          () => path.join(WORKSPACES_ROOT, "admin", "codex-auth.json"),
  // Encrypted Kimi Code (subscription) OAuth credential store. Same encrypted,
  // file-locked pi-ai CredentialStore, one file per provider. See src/kimi-auth.ts.
  kimiAuth:           () => path.join(WORKSPACES_ROOT, "admin", "kimi-auth.json"),
  // Encrypted OpenRouter OAuth credential store (the minted, non-expiring API
  // key from the PKCE browser flow). See src/openrouter-auth.ts.
  openrouterAuth:     () => path.join(WORKSPACES_ROOT, "admin", "openrouter-auth.json"),
} as const;

export const userPaths = {
  dir:                (userId: string) => path.join(WORKSPACES_ROOT, userId),
  profile:            (userId: string) => path.join(WORKSPACES_ROOT, userId, "user.json"),
  projects:           (userId: string) => path.join(WORKSPACES_ROOT, userId, "projects.json"),
  links:              (userId: string) => path.join(WORKSPACES_ROOT, userId, "links.json"),
  skillsDir:          (userId: string) => path.join(WORKSPACES_ROOT, userId, "skills"),
  skillRepos:         (userId: string) => path.join(WORKSPACES_ROOT, userId, "skill-repos.json"),
  projectFolders:     (userId: string) => path.join(WORKSPACES_ROOT, userId, "project-folders.json"),
  prefs:              (userId: string) => path.join(WORKSPACES_ROOT, userId, "user-prefs.json"),
} as const;

/**
 * Per-project app icon: a square PNG "master" the owner sets in project
 * settings. Its mere presence is the icon's state (see readProjectSettings);
 * deployment derives the platform icons/favicon from it. Dot-prefixed so it
 * stays out of the user's repo tree and is excluded from packaging (!**\/.vca-*).
 */
export const PROJECT_ICON_FILENAME = ".vca-icon.png";

export const projectPaths = {
  workspace:           (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId),
  projectYaml:         (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, "project.yaml"),
  icon:                (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, PROJECT_ICON_FILENAME),
  useCase:             (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-usecase.json"),
  // Per-project version-control credential override (username + encrypted PAT).
  // Dot-prefixed so the workspace .gitignore (.vca-*) keeps it out of the repo.
  vcs:                 (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-vcs.json"),
  deployment:          (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-deployment.json"),
  component:           (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-component.json"),
  requirements:        (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-requirements.json"),
  activeSkills:        (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-active-skills.json"),
  projectSkillsDir:    (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-skills"),
  // Template-delivered "project skills" live under the committed .vca/ hook dir
  // (copied into the workspace at init, like .vca/project-instructions.md).
  projectTemplateSkillsDir: (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca", "skills"),
  activityIndex:       (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-activity-index.json"),
  activityDiagram:     (userId: string, projectId: string, diagramId: string) => path.join(WORKSPACES_ROOT, userId, projectId, `.vca-activity-${diagramId}.json`),
  erIndex:             (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-er-index.json"),
  erDiagram:           (userId: string, projectId: string, diagramId: string) => path.join(WORKSPACES_ROOT, userId, projectId, `.vca-er-${diagramId}.json`),
  legacyMessages:      (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-messages.json"),
  chatsDir:            (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-chats"),
  chatsIndex:          (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-chats", "chats.json"),
  chatMessages:        (userId: string, projectId: string, chatId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-chats", `chat-${chatId}.json`),
  chatSdkRootDir:      (userId: string, projectId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-chats", "sdk"),
  chatSdkDir:          (userId: string, projectId: string, chatId: string) => path.join(WORKSPACES_ROOT, userId, projectId, ".vca-chats", "sdk", chatId),
} as const;

export const systemPaths = {
  dir:                          () => path.join(WORKSPACES_ROOT, "_system"),
  skillRepoCache:               () => path.join(WORKSPACES_ROOT, "_system", "skill-repos-cache"),
  skillsActive:                 () => path.join(WORKSPACES_ROOT, "_system", "skills-active"),
  systemPromptCache:            () => path.join(WORKSPACES_ROOT, "_system", "system-prompt-repo-cache"),
  platformReleaseLogs:          () => path.join(WORKSPACES_ROOT, "_system", "platform-release-logs"),
} as const;

export const sessionPaths = {
  dir: () => path.join(WORKSPACES_ROOT, ".vca-sessions"),
  // The caller is responsible for validating sessionId (see session-store-file.ts's
  // SESSION_ID_RE) BEFORE invoking this — a malformed id could traverse out of
  // the sessions dir via path.join.
  file: (validatedSessionId: string) => path.join(WORKSPACES_ROOT, ".vca-sessions", `${validatedSessionId}.json`),
} as const;

/**
 * Read WORKSPACES_ROOT and return the names of entries that look like user
 * directories: not in RESERVED_DIRS, not dot-prefixed, and an actual directory
 * (not a stray file or broken symlink). Order matches readdir's order; callers
 * that need a stable sort should sort the result.
 *
 * Returns [] if the root itself can't be read (e.g. brand-new install before
 * any user has logged in).
 */
export async function listUserDirs(): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !RESERVED_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name);
}
