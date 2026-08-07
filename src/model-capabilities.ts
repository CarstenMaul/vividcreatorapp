import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { LlmProfile } from "./llm-profiles.js";

/**
 * What a profile's LLM can actually do — modalities, reasoning support, size,
 * cost tier. Derived offline from pi's builtin catalog: no network call, no API
 * key, so it works for OAuth-only providers (codex/kimi) and costs nothing to
 * compute per request. Surfaced to the agent by list_llm_profiles (so it can
 * pick a profile that fits the step) and to the admin in Settings.
 *
 * Image GENERATION is deliberately not described here. A profile bundles an
 * image provider/model, but set_llm_config only swaps the LLM — image
 * generation keeps following the deployment-wide vca-settings.json. Reporting
 * it as a profile modality would make the agent switch expecting image output
 * and get none.
 */
export interface ModelCapabilities {
  /** Modalities the model accepts. "image" ⇒ it can read screenshots/images. */
  input: ("text" | "image")[];
  /** Modalities the model emits. LLM profiles are text-out (see note above). */
  output: "text"[];
  reasoning: boolean;
  /**
   * The reasoning efforts set_llm_config can actually reach on this model,
   * i.e. pi's supported thinking levels intersected with the tool's options.
   * Anything outside this list is clamped by session.setModel/setThinkingLevel.
   */
  reasoningEfforts: ReasoningEffort[];
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per 1M tokens. Absent for subscription plans and unpriced endpoints. */
  costPerMTokUsd?: { input: number; output: number };
  costTier: CostTier;
  /**
   * "catalog" — the model id is known to pi, the numbers are its real metadata.
   * "fallback" — an id pi doesn't ship (custom Azure deployment name, local
   * model, a model newer than pi's catalog); the numbers are provider-shaped
   * estimates, the same ones resolveLlmModelParts runs the request on.
   */
  metadataSource: "catalog" | "fallback";
}

export type ReasoningEffort = "medium" | "high" | "xhigh" | "max";
export type CostTier = "free" | "budget" | "standard" | "premium" | "subscription" | "unknown";

// The efforts set_llm_config exposes. pi knows finer levels (off/minimal/low)
// but the tool doesn't offer them, so listing them would mislead the agent.
const TOOL_EFFORTS: ReasoningEffort[] = ["medium", "high", "xhigh", "max"];

// VCA provider id → the pi catalog that holds its models. Mirrors the branches
// of resolveLlmModelParts (agent-manager.ts): Foundry hosts Claude models on
// pi's anthropic catalog, Azure OpenAI uses the responses catalog, and an
// openai-compatible endpoint is looked up against OpenAI's ids.
const CATALOG_PROVIDER: Record<string, string> = {
  "anthropic": "anthropic",
  "azure-ai-foundry": "anthropic",
  "azure-openai": "azure-openai-responses",
  "openai": "openai",
  "openai-compatible": "openai",
  "google": "google",
  "openai-codex": "openai-codex",
  "kimi-coding": "kimi-coding",
  "openrouter": "openrouter",
};

// Ids pi doesn't know still have to be described. Where resolveLlmModelParts
// falls back to a catalog-shaped template we use the same template, so the
// reported numbers match what the request would actually run on; the rest reuse
// its hand-picked per-provider constants.
const FALLBACK_TEMPLATE: Record<string, string> = {
  "google": "gemini-2.5-pro",
  "openai-codex": "gpt-5.5",
  "kimi-coding": "k3",
};

interface Fallback {
  contextWindow: number;
  maxOutputTokens: number;
  cost?: { input: number; output: number };
}

const FALLBACK: Record<string, Fallback> = {
  "anthropic": { contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 3, output: 15 } },
  "azure-ai-foundry": { contextWindow: 200000, maxOutputTokens: 64000, cost: { input: 3, output: 15 } },
  "azure-openai": { contextWindow: 128000, maxOutputTokens: 16384, cost: { input: 2.5, output: 10 } },
  "openai": { contextWindow: 128000, maxOutputTokens: 16384, cost: { input: 2.5, output: 10 } },
  // Local servers and gateways price per deployment — no meaningful default.
  "openai-compatible": { contextWindow: 128000, maxOutputTokens: 16384 },
  "openrouter": { contextWindow: 128000, maxOutputTokens: 16384 },
  "google": { contextWindow: 1048576, maxOutputTokens: 65536 },
  "openai-codex": { contextWindow: 272000, maxOutputTokens: 128000 },
  "kimi-coding": { contextWindow: 262144, maxOutputTokens: 65536 },
};

// Billed by subscription, not per token — pi's catalog still carries list
// prices for them, but the deployment isn't charged those.
const SUBSCRIPTION_PROVIDERS = new Set(["openai-codex", "kimi-coding"]);

// Same guard as builtinModel() in agent-manager.ts: pi's lookup is generically
// typed over provider/model literals and throws on unknown providers.
// Duplicated rather than imported — importing agent-manager here would close a
// cycle (agent-manager → llm-config-tools → this module).
function catalogModel(provider: string, modelId: string): Model<Api> | undefined {
  if (!provider || !modelId) return undefined;
  try { return getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined; } catch { return undefined; }
}

/**
 * USD per 1M output tokens → a coarse label the agent can reason about.
 * Cut points sit in the gaps of the real catalogs: mini/nano/flash tiers land
 * in "budget", the everyday workhorses (haiku 4.5, sonnet 5, gpt-5.1,
 * gemini 2.5 pro — all ≤ $10) in "standard", and the deliberate-use models
 * (sonnet 4.5 at $15, opus at $25, the pro tiers) in "premium".
 */
function costTierFor(outputCost: number | undefined): CostTier {
  if (outputCost === undefined) return "unknown";
  if (outputCost <= 0) return "free";
  if (outputCost < 2) return "budget";
  if (outputCost < 12) return "standard";
  return "premium";
}

function supportedEfforts(model: Model<Api> | undefined, reasoning: boolean): ReasoningEffort[] {
  if (!reasoning) return [];
  // No catalog entry to ask: the model still accepts the tool's efforts (they
  // just clamp at the provider), so offer them all rather than reporting an
  // empty list, which would read as "reasoning can't be raised here".
  if (!model) return TOOL_EFFORTS;
  let levels: string[];
  try { levels = getSupportedThinkingLevels(model) as string[]; } catch { return TOOL_EFFORTS; }
  const supported = TOOL_EFFORTS.filter((e) => levels.includes(e));
  return supported.length ? supported : TOOL_EFFORTS;
}

/**
 * Describe the LLM a profile would run on. Never throws and never touches the
 * network: an unrecognised provider or model id degrades to provider-shaped
 * estimates flagged via metadataSource.
 */
export function describeProfileCapabilities(p: LlmProfile): ModelCapabilities {
  const provider = p.llmProvider;
  const catalogProvider = CATALOG_PROVIDER[provider] ?? provider;
  const model = catalogModel(catalogProvider, p.llmModelId)
    // Same rescue resolveLlmModelParts performs: describe the id on a
    // catalog-shaped template so a model newer than pi's catalog isn't blank.
    ?? catalogModel(catalogProvider, FALLBACK_TEMPLATE[provider] ?? "");
  const exact = !!catalogModel(catalogProvider, p.llmModelId);
  const fallback = FALLBACK[provider] ?? { contextWindow: 128000, maxOutputTokens: 16384 };

  const cost = SUBSCRIPTION_PROVIDERS.has(provider)
    ? undefined
    : model?.cost
      ? { input: model.cost.input, output: model.cost.output }
      : fallback.cost;

  // Admin overrides (Settings → AI Model Config, stored per profile) win over
  // the catalog for exactly the reason they exist: a custom deployment can have
  // a bigger context window than the id suggests. Same rule as the one
  // set_llm_config applies when it hot-swaps the model.
  const contextWindow = p.llmContextWindow > 0 ? p.llmContextWindow : (model?.contextWindow ?? fallback.contextWindow);
  const maxOutputTokens = p.llmMaxTokens > 0 ? p.llmMaxTokens : (model?.maxTokens ?? fallback.maxOutputTokens);
  // Same optimistic default resolveLlmModelParts uses for unknown ids: assume
  // a current model until the catalog says otherwise.
  const reasoning = model?.reasoning ?? true;

  return {
    input: model?.input ? [...model.input] : ["text", "image"],
    output: ["text"],
    reasoning,
    reasoningEfforts: supportedEfforts(model, reasoning),
    contextWindow,
    maxOutputTokens,
    ...(cost ? { costPerMTokUsd: cost } : {}),
    costTier: SUBSCRIPTION_PROVIDERS.has(provider) ? "subscription" : costTierFor(cost?.output),
    metadataSource: exact ? "catalog" : "fallback",
  };
}
