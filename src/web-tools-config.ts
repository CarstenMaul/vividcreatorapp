import { getCachedVcaSettings } from "./admin-settings.js";

/**
 * Resolves which provider backend the web_search / web_fetch agent tools use.
 *
 * The web tools ride on the configured LLM provider's native web tooling:
 *   - openai        → OpenAI Responses API `web_search` tool
 *   - azure-openai  → Azure OpenAI Responses API `web_search` tool (Bing-grounded)
 *   - openrouter    → OpenRouter server tools `openrouter:web_search` / `openrouter:web_fetch`
 *   - anthropic     → Anthropic Messages API server tools `web_search_20250305` / `web_fetch_20250910`
 *
 * Providers without native web tooling (azure-ai-foundry, openai-compatible)
 * fall back to the AZURE_OPENAI_* env config when present (the pre-settings
 * behavior); otherwise web_search is unavailable. web_fetch always works via
 * direct HTTP fetch + extraction with the session model, and additionally uses
 * the provider's native fetch tool when OpenRouter or Anthropic is active
 * (Anthropic falls back to direct fetch on native-fetch failures).
 *
 * Mirrors getLLMConfig()'s precedence: env server-config (Foundry, then Azure
 * OpenAI) beats vca-settings.json, which beats PROVIDER/MODEL env defaults.
 * Resolution reads getCachedVcaSettings() so it is cheap enough to run on
 * every tool execution and picks up Settings changes live.
 */

export type WebToolsProviderKind = "openai" | "azure-openai" | "openrouter" | "anthropic" | "none";

export const DEFAULT_AZURE_API_VERSION = "2025-04-01-preview";
export const DEFAULT_ANTHROPIC_ENDPOINT = "https://api.anthropic.com";
export const MAX_ALLOWED_DOMAINS = 100;

const SEARCH_ENGINES = new Set(["native", "exa", "firecrawl", "parallel", "perplexity"]);
const FETCH_ENGINES = new Set(["native", "openrouter", "exa", "parallel"]);
const CONTEXT_SIZES = new Set(["low", "medium", "high"]);

export interface WebToolsConfig {
  /** Backend used for the web_search tool (and OpenRouter's native web_fetch). */
  provider: WebToolsProviderKind;
  /** When provider === "none": human-readable reason for logs / tool errors. */
  reason?: string;
  /** Base URL without trailing slash (Responses base for Azure/OpenAI, /api/v1 for OpenRouter). */
  endpoint: string;
  apiKey: string;
  /** Model (or Azure deployment name) used for provider-side web tool calls. */
  modelId: string;
  /** Azure only: api-version query parameter. */
  apiVersion: string;
  searchEnabled: boolean;
  fetchEnabled: boolean;
  /** "" = provider default. */
  contextSize: "" | "low" | "medium" | "high";
  /** OpenRouter only ("" = auto). */
  searchEngine: string;
  /** OpenRouter only (0 = provider default). */
  maxResults: number;
  /** OpenRouter only ("" = auto). */
  fetchEngine: string;
  /** True when web_fetch should call the provider's native fetch tool (OpenRouter). */
  fetchViaProvider: boolean;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function resolveWebToolsConfig(): WebToolsConfig {
  const stored = getCachedVcaSettings();
  const base: Omit<WebToolsConfig, "provider" | "endpoint" | "apiKey" | "modelId" | "apiVersion" | "fetchViaProvider"> = {
    searchEnabled: stored.webSearchEnabled,
    fetchEnabled: stored.webFetchEnabled,
    contextSize: CONTEXT_SIZES.has(stored.webSearchContextSize) ? (stored.webSearchContextSize as "low" | "medium" | "high") : "",
    searchEngine: SEARCH_ENGINES.has(stored.webSearchEngine) ? stored.webSearchEngine : "",
    maxResults: stored.webSearchMaxResults >= 1 ? Math.min(stored.webSearchMaxResults, 25) : 0,
    fetchEngine: FETCH_ENGINES.has(stored.webFetchEngine) ? stored.webFetchEngine : "",
  };
  const overrideModel = stored.webSearchModelId.trim();

  // Azure OpenAI env config — the server-configured mode and the fallback for
  // chat providers without native web tooling.
  const azureEnv = (): WebToolsConfig | null => {
    const endpoint = process.env.AZURE_OPENAI_BASE_URL?.trim();
    const apiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
    if (!endpoint || !apiKey) return null;
    return {
      ...base,
      provider: "azure-openai",
      endpoint: normalizeBaseUrl(endpoint),
      apiKey,
      modelId: overrideModel || process.env.AZURE_OPENAI_MODEL?.trim() || "gpt-5.5",
      apiVersion: process.env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_API_VERSION,
      fetchViaProvider: false,
    };
  };

  const unavailable = (reason: string): WebToolsConfig => ({
    ...base,
    provider: "none",
    reason,
    endpoint: "",
    apiKey: "",
    modelId: "",
    apiVersion: "",
    fetchViaProvider: false,
  });

  // Env server-configured modes win over Settings (same precedence as chat).
  if (process.env.AZURE_AI_FOUNDRY_ENDPOINT) {
    return azureEnv() ?? unavailable(
      "The AI Foundry provider has no native web tooling and AZURE_OPENAI_BASE_URL / AZURE_OPENAI_API_KEY are not set.",
    );
  }
  if (process.env.AZURE_OPENAI_BASE_URL) {
    return azureEnv() ?? unavailable("AZURE_OPENAI_BASE_URL is set but AZURE_OPENAI_API_KEY is missing.");
  }

  // Settings-configured providers.
  const provider = stored.llmProvider;
  if (provider === "openai" || provider === "openrouter") {
    const apiKey = stored.apiKey || (provider === "openai" ? process.env.OPENAI_API_KEY?.trim() || "" : "");
    if (!apiKey) return unavailable(`No API key configured for the ${provider} provider in Settings.`);
    const endpoint = normalizeBaseUrl(stored.llmEndpoint)
      || (provider === "openai" ? "https://api.openai.com/v1" : "https://openrouter.ai/api/v1");
    return {
      ...base,
      provider,
      endpoint,
      apiKey,
      modelId: overrideModel || stored.llmModelId.trim()
        || (provider === "openai" ? "gpt-5.5" : "openrouter/auto"),
      apiVersion: "",
      fetchViaProvider: provider === "openrouter",
    };
  }
  if (provider === "azure-openai") {
    const endpoint = normalizeBaseUrl(stored.llmEndpoint);
    if (!endpoint) return unavailable("No endpoint configured for the Azure OpenAI provider in Settings.");
    if (!stored.apiKey) return unavailable("No API key configured for the Azure OpenAI provider in Settings.");
    return {
      ...base,
      provider: "azure-openai",
      endpoint,
      apiKey: stored.apiKey,
      modelId: overrideModel || stored.llmModelId.trim() || "gpt-5.5",
      apiVersion: stored.llmApiVersion.trim() || DEFAULT_AZURE_API_VERSION,
      fetchViaProvider: false,
    };
  }
  if (provider === "anthropic") {
    const apiKey = stored.apiKey || process.env.ANTHROPIC_API_KEY?.trim() || "";
    if (!apiKey) {
      return azureEnv() ?? unavailable(
        "No API key configured for the Anthropic provider in Settings, and ANTHROPIC_API_KEY is not set.",
      );
    }
    return {
      ...base,
      provider: "anthropic",
      endpoint: normalizeBaseUrl(stored.llmEndpoint) || DEFAULT_ANTHROPIC_ENDPOINT,
      apiKey,
      modelId: overrideModel || stored.llmModelId.trim() || "claude-sonnet-5",
      apiVersion: "",
      fetchViaProvider: true,
    };
  }
  if (provider === "openai-codex") {
    return azureEnv() ?? unavailable(
      "The OpenAI Codex (ChatGPT subscription) provider has no native web tooling and " +
      "AZURE_OPENAI_BASE_URL / AZURE_OPENAI_API_KEY are not set. web_fetch still works via direct fetch.",
    );
  }
  if (provider) {
    return azureEnv() ?? unavailable(
      `The "${provider}" provider has no native web tooling. Web search supports Anthropic, OpenAI, Azure OpenAI, and OpenRouter.`,
    );
  }

  // No Settings provider: PROVIDER/MODEL env defaults (dev convenience).
  if ((process.env.PROVIDER || "anthropic") === "openai" && process.env.OPENAI_API_KEY) {
    return {
      ...base,
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY.trim(),
      modelId: overrideModel || process.env.MODEL?.trim() || "gpt-5.5",
      apiVersion: "",
      fetchViaProvider: false,
    };
  }
  if ((process.env.PROVIDER || "anthropic") === "anthropic" && process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      ...base,
      provider: "anthropic",
      endpoint: DEFAULT_ANTHROPIC_ENDPOINT,
      apiKey: process.env.ANTHROPIC_API_KEY.trim(),
      modelId: overrideModel || process.env.MODEL?.trim() || "claude-sonnet-5",
      apiVersion: "",
      fetchViaProvider: true,
    };
  }
  return azureEnv() ?? unavailable("No LLM provider with web tooling is configured.");
}

/** Non-secret status view for the frontend (/config → Settings dialog). */
export function getWebToolsStatus(): {
  searchProvider: WebToolsProviderKind;
  searchEnabled: boolean;
  fetchEnabled: boolean;
  fetchViaProvider: boolean;
  modelId: string;
  reason?: string;
} {
  const cfg = resolveWebToolsConfig();
  return {
    searchProvider: cfg.provider,
    searchEnabled: cfg.searchEnabled && cfg.provider !== "none",
    fetchEnabled: cfg.fetchEnabled,
    fetchViaProvider: cfg.fetchViaProvider,
    modelId: cfg.provider === "none" ? "" : cfg.modelId,
    ...(cfg.reason ? { reason: cfg.reason } : {}),
  };
}
