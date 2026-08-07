import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { resolveLlmModelParts, getLLMConfig, sendSSEEvent, type ManagedSession, type UserLLMConfig } from "./agent-manager.js";
import { getLlmProfile, listLlmProfiles, type LlmProfile } from "./llm-profiles.js";
import { describeProfileCapabilities } from "./model-capabilities.js";
import { hasOpenRouterCredential } from "./openrouter-auth.js";
import { getCachedVcaSettings } from "./admin-settings.js";

// Tools that let the running agent change its own LLM profile (model/provider)
// and/or reasoning effort mid-conversation, WITHOUT stopping. The switch is
// scoped to this chat's live session: we register the target profile's key on
// the session's existing ModelRuntime and call session.setModel()/setThinkingLevel(),
// which only mutate agent.state and are picked up on the next turn — the run
// continues. Nothing here rewrites the deployment-wide vca-settings.json or the
// active-profile pointer, so other chats/users are unaffected. Profile secrets
// stay server-side and are never surfaced to the model.

/**
 * Why a profile can't be hot-swapped into a live chat, or "" when it can.
 * Predicts the `credentials` refusal set_llm_config performs below: providers
 * whose auth lives in a shared OAuth credential store can't have it injected
 * into a session's already-created runtime (and codex's SSE transport is fixed
 * at session creation). Reporting it up front saves the agent a dead call.
 *
 * The key check mirrors mergeLlmConfigWithSettings: a profile with no key of
 * its own inherits the deployment's — but only when the deployment runs the
 * same provider.
 */
function notSwitchableReason(p: LlmProfile): string {
  const bound = (name: string) =>
    `Provider "${p.llmProvider}" signs in with a session-bound ${name} credential — switching to it needs a new chat.`;
  if (p.llmProvider === "openai-codex") return bound("ChatGPT OAuth");
  if (p.llmProvider === "kimi-coding") return bound("Kimi Code OAuth");
  if (p.llmProvider === "openrouter") {
    const stored = getCachedVcaSettings();
    const effectiveKey = p.apiKey || (stored.llmProvider === "openrouter" ? stored.apiKey : "");
    if (!effectiveKey && hasOpenRouterCredential()) return bound("OpenRouter OAuth");
  }
  return "";
}

export function createLlmConfigTools(getManagedSession: () => ManagedSession): ToolDefinition[] {
  const errResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: {},
    isError: true,
  });

  const listProfilesTool: ToolDefinition = {
    name: "list_llm_profiles",
    label: "List LLM Profiles",
    description:
      "List the LLM profiles you can switch to with set_llm_config. Each entry carries the id/name/provider/model, the model's capabilities (input modalities — \"image\" means it can read screenshots; reasoning support and the efforts it actually reaches; context window; max output tokens; cost per 1M tokens and a cost tier), the admin's note on what the profile is good at, and whether it can be hot-swapped into this chat. Never returns secrets.",
    promptSnippet: "list_llm_profiles — list the LLM profiles you can switch to, with their modalities, cost and strengths",
    promptGuidelines: [
      "Call list_llm_profiles before set_llm_config to get a valid profile id — never guess ids.",
      "Choose by capability, not by name: a profile whose capabilities.input includes \"image\" for work involving screenshots or images, a reasoning/premium one for a hard reasoning step, a budget one for mechanical edits. The `strengths` note is the admin's own guidance — follow it.",
      "Only pass a reasoningEffort that appears in that profile's capabilities.reasoningEfforts; anything higher is silently clamped.",
      "Profiles marked switchable:false cannot be hot-swapped into this chat — don't try, the reason is in notSwitchableReason.",
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal) {
      try {
        const { profiles, activeProfileId } = await listLlmProfiles();
        // An env-configured deployment ignores per-request config entirely, so
        // nothing is switchable — say so once here instead of letting the agent
        // discover it by calling set_llm_config.
        const serverConfigured = getLLMConfig().mode === "server-configured";
        const list = profiles.map((p) => {
          const blocked = serverConfigured
            ? "This deployment's LLM is configured server-side, so profiles can't be switched."
            : notSwitchableReason(p);
          return {
            id: p.id,
            name: p.name,
            provider: p.llmProvider,
            model: p.llmModelId,
            ...(p.strengths ? { strengths: p.strengths } : {}),
            capabilities: describeProfileCapabilities(p),
            switchable: !blocked,
            ...(blocked ? { notSwitchableReason: blocked } : {}),
          };
        });
        // The deployment pointer and this chat's model can differ: the agent may
        // already have switched mid-run, and only the latter says what it is
        // running right now.
        const currentProfileId = getManagedSession().activeProfileId ?? null;
        return {
          content: [{
            type: "text" as const,
            text: list.length === 0
              ? "No LLM profiles are configured."
              : JSON.stringify({ activeProfileId, currentProfileId, profiles: list }, null, 2),
          }],
          details: { count: list.length, activeProfileId },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to list LLM profiles: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  const setConfigTool: ToolDefinition = {
    name: "set_llm_config",
    label: "Set LLM Config",
    description:
      "Switch the LLM profile (model/provider) and/or the reasoning effort for THIS chat, live, without interrupting your work. The change applies on your next turn and you keep going. Use it to move to a stronger model + higher effort for a hard step, or a lighter/faster one for simple work. The switch affects only this chat, not other users or the deployment settings.",
    promptSnippet: "set_llm_config — switch this chat's LLM profile and/or reasoning effort without stopping",
    promptGuidelines: [
      "Call list_llm_profiles first to obtain a valid `profile` id — do not guess ids.",
      "Base the choice on that listing's `capabilities` and `strengths`: switch to a profile whose capabilities.input includes \"image\" before working with screenshots or images, to a reasoning/premium profile for a hard reasoning step, to a budget one for mechanical work.",
      "In the SAME message where you call set_llm_config, announce the switch to the user: which profile/model and reasoning effort you are moving to, and the purpose (the `reason` you pass). Then continue the task.",
      "Switching does NOT stop you — after the tool returns, keep working on the user's request on the new configuration.",
      "Only switch when it genuinely helps (a hard reasoning step, or to save cost/time on simple work) — don't switch gratuitously.",
      "Reasoning effort options are medium, high, xhigh, max; the effort is clamped to what the target model supports, so prefer one the profile lists in capabilities.reasoningEfforts.",
    ],
    parameters: Type.Object({
      reason: Type.String({
        description: "Short, user-facing explanation of why you are switching and what you'll use the new configuration for. Announce this to the user in the same message.",
      }),
      profile: Type.Optional(Type.String({
        description: "Profile id to switch to (from list_llm_profiles). Omit to change only the reasoning effort.",
      })),
      reasoningEffort: Type.Optional(Type.Union([
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ], { description: "New reasoning effort. Omit to keep the current effort." })),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const reason: string = typeof params?.reason === "string" ? params.reason.trim() : "";
        const profileId: string | undefined = params?.profile ? String(params.profile) : undefined;
        const effort: string | undefined = params?.reasoningEffort ? String(params.reasoningEffort) : undefined;

        if (!reason) {
          return errResult("Provide a `reason` explaining why you are switching — it is shown to the user.");
        }
        if (!profileId && !effort) {
          return errResult("Nothing to change: pass `profile` and/or `reasoningEffort`.");
        }

        const managed = getManagedSession();
        const session = managed.session;
        const changes: string[] = [];

        if (profileId) {
          // When the deployment's LLM is env-configured (server-managed), the
          // resolver ignores per-request config and always builds the env model,
          // so a "profile switch" would be a no-op/misleading. Refuse cleanly.
          if (getLLMConfig().mode === "server-configured") {
            return errResult("This deployment's LLM is configured server-side, so profiles can't be switched. You can still change the reasoning effort.");
          }

          const p = await getLlmProfile(profileId);
          if (!p) {
            return errResult(`Unknown profile id "${profileId}". Call list_llm_profiles to see valid ids.`);
          }

          const cfg: UserLLMConfig = {
            provider: p.llmProvider as UserLLMConfig["provider"],
            apiKey: p.apiKey,
            modelId: p.llmModelId || undefined,
            endpoint: p.llmEndpoint || undefined,
            apiVersion: p.llmApiVersion || undefined,
          };
          const { model, runtimeApiKeys, credentials } = await resolveLlmModelParts(p.apiKey || undefined, cfg);

          // OAuth providers (openai-codex / kimi-coding / openrouter-OAuth) carry
          // a shared credential store that can't be injected into this session's
          // already-created runtime (and codex's SSE transport is fixed at session
          // creation). Refuse gracefully — the run continues on the current model.
          if (credentials) {
            return errResult(`Profile "${p.name}" uses provider "${p.llmProvider}", which signs in with a session-bound credential. Switching to it needs a new chat — I can't hot-swap it mid-conversation. The current model is unchanged.`);
          }

          // resolveLlmModelParts reads context/output overrides from vca-settings.json,
          // not from the profile we passed; carry the profile's own overrides so the
          // context window / max tokens match the profile the agent asked for.
          if (p.llmContextWindow > 0) model.contextWindow = p.llmContextWindow;
          if (p.llmMaxTokens > 0) model.maxTokens = p.llmMaxTokens;

          // Register the target provider's key on THIS session's live runtime first
          // (setModel validates auth against that same runtime), then swap the model.
          // Neither call aborts the run; the new model is used on the next turn.
          for (const [prov, key] of runtimeApiKeys) {
            await session.modelRuntime.setRuntimeApiKey(prov, key);
          }
          try {
            await session.setModel(model);
          } catch (e) {
            return errResult(`Could not switch to profile "${p.name}": ${(e as Error).message}. The current model is unchanged.`);
          }
          // Record which profile this chat is now running so the sidebar switcher
          // can highlight it (session-local; the deployment pointer is untouched).
          managed.activeProfileId = profileId;
          changes.push(`profile "${p.name}" (${p.llmProvider}${model?.id ? ` · ${model.id}` : ""})`);
        }

        if (effort) {
          // setModel above re-clamps effort to the new model, so apply the
          // requested effort AFTER the model switch.
          session.setThinkingLevel(effort as UserLLMConfig["thinkingLevel"] as any);
          changes.push(`reasoning effort "${effort}"`);
        }

        // Keep the message tag (message_end → model:reasoning) in sync with the
        // level actually applied after clamping.
        managed.thinkingLevel = session.thinkingLevel;

        // Tell this chat's UI to re-sync its sidebar controls (effort dropdown +
        // profile switcher) to the config the session is now actually running,
        // so pressing them shows the current settings — not the stale defaults.
        const model = session.model as any;
        sendSSEEvent(managed, "llm_config_changed", {
          thinkingLevel: session.thinkingLevel,
          activeProfileId: managed.activeProfileId ?? null,
          provider: model?.provider ?? null,
          modelId: model?.id ?? null,
        });

        const summary = `Switched to ${changes.join(" and ")}. Purpose: ${reason}. This did not interrupt the run — continue the task now, and make sure your reply told the user about this switch.`;
        return {
          content: [{ type: "text" as const, text: summary }],
          details: { profile: profileId, reasoningEffort: effort ? session.thinkingLevel : undefined, reason },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to change LLM config: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  return [listProfilesTool, setConfigTool];
}
