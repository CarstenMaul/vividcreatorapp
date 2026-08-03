import { syncSystemPrompt } from "./system-prompt-sync.js";
import {
  syncSkillRepos,
  setSkillRepoMap,
} from "./skill-repo-sync.js";
import { syncAppTemplates } from "./app-templates-sync.js";
import { setAppTemplates } from "./app-templates.js";
import { setActiveSystemPrompt } from "./system-prompt.js";
import { setSkillsSrcDir, invalidateSystemSkillsCache } from "./default-skills.js";
import { listAdminSkillRepos } from "./admin-skill-repos.js";

export interface SyncReport {
  ok: boolean;
  error?: string;
  systemPromptVersion?: string;
  skillsSource?: "git" | "bundled";
  appTemplates?: { name: string; description: string }[];
}

/**
 * Resolve system prompt + app templates from admin-managed sources and clone
 * any admin-listed skill repos. Applies the results to module-level "active"
 * state used by the rest of the app.
 *
 * Returns a SyncReport that the caller can pass to clients (HTTP responses,
 * startup logs, /api/config errors).
 */
export async function syncAllSystemContent(): Promise<SyncReport> {
  // VCA_OFFLINE forces the bundled/local path: no git ls-remote/clone at all.
  // The packaged "fully offline" build sets this so an unreachable corporate
  // git host can never stall startup; app templates still resolve from disk.
  const offline = process.env.VCA_OFFLINE === "1";
  const pat = offline ? undefined : process.env.AZURE_DEVOPS_PAT;
  if (offline) {
    console.log("[startup] VCA_OFFLINE=1 — skipping git system-content sync (bundled fallback)");
  }

  const skillUrls = await listAdminSkillRepos();

  const [
    promptResult,
    skillsDir,
    appTemplates,
  ] = await Promise.all([
    offline
      ? Promise.resolve(null)
      : syncSystemPrompt(pat).catch((err) => {
          console.error("[system-prompt] sync failed:", err);
          return null;
        }),
    !offline && pat
      ? syncSkillRepos(skillUrls, pat).catch((err) => {
          console.error("[skill-sync] sync failed:", err);
          return null;
        })
      : Promise.resolve(null),
    syncAppTemplates().catch((err) => {
      console.error("[app-templates] sync failed:", err);
      return [];
    }),
  ]);

  if (promptResult) {
    setActiveSystemPrompt(promptResult.prompt, promptResult.version);
  }
  if (skillsDir) {
    setSkillsSrcDir(skillsDir);
  }
  // Always invalidate the system-skills cache so admin-only changes (no git
  // sync needed) are picked up by the next getSystemSkillNames() call.
  invalidateSystemSkillsCache();
  setSkillRepoMap(skillUrls);

  setAppTemplates(appTemplates);

  return {
    ok: true,
    systemPromptVersion: promptResult?.version,
    skillsSource: skillsDir ? "git" : "bundled",
    appTemplates: appTemplates.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  };
}
