// Model-list lookup for the admin Settings model picker. Fetches the live
// model list from providers that expose one (OpenRouter, OpenAI, OpenAI-
// compatible servers, Anthropic, Azure OpenAI) and falls back to pi's builtin
// catalog for providers without a list API (azure-ai-foundry, openai-codex) or
// when the live call can't be made. Runs server-side only: the stored API key
// never reaches the browser, so the picker's fetch must be proxied through here.
import { createHash } from "node:crypto";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getCachedVcaSettings, UNCHANGED_SECRET_SENTINEL } from "./admin-settings.js";
import { DEFAULT_AZURE_API_VERSION } from "./web-tools-config.js";

export interface NormalizedModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  // USD per 1M tokens
  pricing?: { input: number; output: number };
  inputModalities?: string[];
  reasoning?: boolean;
}

export interface ModelListResult {
  models: NormalizedModel[];
  source: "live" | "catalog";
  // Present when the result is degraded (catalog instead of live, or live
  // fetch failed). The frontend maps the code to a translated banner.
  warning?: { code: "CATALOG_ONLY" | "KEY_MISSING" | "UPSTREAM_AUTH" | "UPSTREAM_ERROR" | "UPSTREAM_UNREACHABLE" };
}

export class ModelListError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) {
    super(message);
  }
}

const SUPPORTED_PROVIDERS = new Set([
  "anthropic", "azure-ai-foundry", "azure-openai", "google", "kimi-coding", "openai", "openai-codex", "openai-compatible", "openrouter",
]);

// Providers whose image-generation models can be listed live. Google has no
// public model-list API worth exposing here, so the picker is not offered.
const IMAGE_LIST_PROVIDERS = new Set(["openai", "openrouter"]);

const DEFAULT_ENDPOINTS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

const FETCH_TIMEOUT_MS = 20_000;
const DESCRIPTION_MAX_CHARS = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;

// OpenAI's /v1/models mixes chat models with embeddings/speech/image ids that
// make no sense as a coding-agent model. Applied to the "openai" provider
// only — openai-compatible servers use arbitrary local names.
const OPENAI_NON_CHAT_RE = /(embed|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe)/i;

// Inverse concern for the image-model picker: OpenAI's /v1/models mixes image
// generators in with everything else — keep only those.
const OPENAI_IMAGE_RE = /(gpt-image|dall-e)/i;

const listCache = new Map<string, { value: ModelListResult; expiresAt: number }>();

function cacheGet(key: string, now: number): ModelListResult | undefined {
  const hit = listCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  if (hit) listCache.delete(key);
  return undefined;
}

function cacheSet(key: string, value: ModelListResult, now: number): void {
  listCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
}

function truncateDescription(text: unknown): string | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const t = text.trim();
  return t.length > DESCRIPTION_MAX_CHARS ? `${t.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : t;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

// Sorted, deduped-by-id copy — one shape regardless of source.
function finalize(models: NormalizedModel[], source: "live" | "catalog", warning?: ModelListResult["warning"]): ModelListResult {
  const seen = new Set<string>();
  const deduped = models.filter((m) => {
    if (!m.id || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  deduped.sort((a, b) => a.name.localeCompare(b.name));
  return { models: deduped, source, ...(warning ? { warning } : {}) };
}

type CatalogProvider = "anthropic" | "google" | "kimi-coding" | "openai" | "openai-codex" | "openrouter" | "azure-openai-responses";

function catalogModels(provider: CatalogProvider): NormalizedModel[] {
  // getBuiltinModels is generically typed over provider literals — a switch
  // keeps inference working without casts.
  const models = (() => {
    switch (provider) {
      case "anthropic": return getBuiltinModels("anthropic");
      case "google": return getBuiltinModels("google");
      case "kimi-coding": return getBuiltinModels("kimi-coding");
      case "openai": return getBuiltinModels("openai");
      case "openai-codex": return getBuiltinModels("openai-codex");
      case "openrouter": return getBuiltinModels("openrouter");
      case "azure-openai-responses": return getBuiltinModels("azure-openai-responses");
    }
  })();
  return models.map((m: any): NormalizedModel => ({
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.contextWindow || undefined,
    maxTokens: m.maxTokens || undefined,
    // pi catalog cost is already USD per 1M tokens
    ...(m.cost && (m.cost.input > 0 || m.cost.output > 0)
      ? { pricing: { input: m.cost.input, output: m.cost.output } }
      : {}),
    ...(Array.isArray(m.input) && m.input.length ? { inputModalities: m.input } : {}),
    ...(m.reasoning ? { reasoning: true } : {}),
  }));
}

function catalogResult(provider: CatalogProvider, warningCode: NonNullable<ModelListResult["warning"]>["code"]): ModelListResult {
  return finalize(catalogModels(provider), "catalog", { code: warningCode });
}

// Enrich a sparse live entry (id-only lists) with catalog metadata when the
// id matches a known model.
function enrichFromCatalog(model: NormalizedModel, catalog: Map<string, NormalizedModel>): NormalizedModel {
  const known = catalog.get(model.id);
  if (!known) return model;
  return {
    ...known,
    ...model,
    name: model.name !== model.id ? model.name : known.name,
    description: model.description ?? known.description,
  };
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err: any) {
    throw new ModelListError("UPSTREAM_UNREACHABLE", `Could not reach ${url}: ${err?.message || String(err)}`, 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ModelListError("UPSTREAM_AUTH", `Provider rejected the API key (HTTP ${res.status})`, 502);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ModelListError("UPSTREAM_ERROR", `Provider returned HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`, 502);
  }
  try {
    return await res.json();
  } catch {
    throw new ModelListError("UPSTREAM_ERROR", "Provider returned a non-JSON response", 502);
  }
}

async function fetchOpenRouterModels(endpoint: string, apiKey: string | undefined, imagesOnly = false): Promise<NormalizedModel[]> {
  // The list endpoint is public; send auth only when a key resolved so a
  // stale stored key can't break browsing.
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const body = await fetchJson(`${endpoint}/models`, headers);
  let data = Array.isArray(body?.data) ? body.data : [];
  if (imagesOnly) {
    data = data.filter((m: any) =>
      Array.isArray(m?.architecture?.output_modalities) && m.architecture.output_modalities.includes("image"));
  }
  return data.map((m: any): NormalizedModel => {
    const input = Number(m?.pricing?.prompt) * 1e6;
    const output = Number(m?.pricing?.completion) * 1e6;
    return {
      id: m.id,
      name: m.name || m.id,
      description: truncateDescription(m.description),
      contextWindow: m.context_length || m.top_provider?.context_length || undefined,
      maxTokens: m.top_provider?.max_completion_tokens || undefined,
      // OpenRouter reports -1 / non-numeric prices for dynamically routed models
      ...(Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0
        ? { pricing: { input, output } }
        : {}),
      ...(Array.isArray(m.architecture?.input_modalities) && m.architecture.input_modalities.length
        ? { inputModalities: m.architecture.input_modalities }
        : {}),
      ...(m.reasoning?.supported_efforts?.length || (Array.isArray(m.supported_parameters) && m.supported_parameters.includes("reasoning"))
        ? { reasoning: true }
        : {}),
    };
  });
}

async function fetchOpenAiStyleModels(endpoint: string, apiKey: string | undefined, filterNonChat: boolean, imagesOnly = false): Promise<NormalizedModel[]> {
  // Local openai-compatible servers often accept any non-empty key; the
  // placeholder mirrors resolveLlmModel's convention.
  const headers = { Authorization: `Bearer ${apiKey || "not-needed"}` };
  const body = await fetchJson(`${endpoint}/models`, headers);
  const data = Array.isArray(body?.data) ? body.data : [];
  const catalog = new Map(catalogModels("openai").map((m) => [m.id, m]));
  return data
    .filter((m: any) => typeof m?.id === "string" && m.id)
    .filter((m: any) => imagesOnly ? OPENAI_IMAGE_RE.test(m.id) : (!filterNonChat || !OPENAI_NON_CHAT_RE.test(m.id)))
    .map((m: any) => enrichFromCatalog({ id: m.id, name: m.id }, catalog));
}

async function fetchAnthropicModels(endpoint: string, apiKey: string): Promise<NormalizedModel[]> {
  // Default page size is 20 — request everything in one page.
  const headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const body = await fetchJson(`${endpoint}/v1/models?limit=1000`, headers);
  const data = Array.isArray(body?.data) ? body.data : [];
  const catalog = new Map(catalogModels("anthropic").map((m) => [m.id, m]));
  return data
    .filter((m: any) => typeof m?.id === "string" && m.id)
    .map((m: any) => enrichFromCatalog({ id: m.id, name: m.display_name || m.id }, catalog));
}

// Azure OpenAI "Models - List" (GET {endpoint}/openai/models?api-version=…,
// api-key header). The stored endpoint already includes the `/openai` segment
// (same convention the Responses web-search URL relies on), so `/models` is
// appended directly. The list mixes chat models with embeddings/speech/image/
// completion-only ids — Azure flags each via capabilities.chat_completion, so
// that boolean is the primary filter. Ids are base model ids (not deployment
// names), but Azure deployments are conventionally named after the base model,
// so they double as deployment-name suggestions.
function isAzureChatModel(m: any): boolean {
  const caps = m?.capabilities;
  if (caps && typeof caps === "object" && typeof caps.chat_completion === "boolean") {
    return caps.chat_completion === true;
  }
  // A gateway that returns a reduced shape without capabilities: fall back to
  // dropping only the ids that are unmistakably non-chat.
  return !OPENAI_NON_CHAT_RE.test(String(m?.id || ""));
}

async function fetchAzureOpenAiModels(endpoint: string, apiKey: string, apiVersion: string): Promise<NormalizedModel[]> {
  const url = `${endpoint}/models?api-version=${encodeURIComponent(apiVersion)}`;
  const body = await fetchJson(url, { "api-key": apiKey });
  const data = Array.isArray(body?.data) ? body.data : [];
  const catalog = new Map(catalogModels("azure-openai-responses").map((m) => [m.id, m]));
  return data
    .filter((m: any) => typeof m?.id === "string" && m.id)
    .filter((m: any) => isAzureChatModel(m))
    .map((m: any) => enrichFromCatalog({ id: m.id, name: m.id }, catalog));
}

export async function listLlmModels(opts: {
  provider: string;
  endpoint?: string;
  apiKey?: string;
  // Azure OpenAI only: api-version query parameter for the /openai/models call.
  // Falls back to the stored setting, then DEFAULT_AZURE_API_VERSION.
  apiVersion?: string;
  noCache?: boolean;
  // List image-generation models instead of chat models. Only openai and
  // openrouter support this (see IMAGE_LIST_PROVIDERS).
  images?: boolean;
}): Promise<ModelListResult> {
  const provider = opts.provider;
  const images = opts.images === true;
  if (images ? !IMAGE_LIST_PROVIDERS.has(provider) : !SUPPORTED_PROVIDERS.has(provider)) {
    throw new ModelListError("UNSUPPORTED_PROVIDER", `Unknown ${images ? "image" : "LLM"} provider "${provider}"`, 400);
  }

  const stored = getCachedVcaSettings();
  // Stored endpoint/key only apply when the requested provider matches the
  // stored one (same guard as mergeLlmConfigWithSettings) — never send
  // provider A's key to provider B. Image mode resolves against the image
  // settings (honoring "use the LLM key" when that option is on).
  const sameAsStored = provider === (images ? stored.imageProvider : stored.llmProvider);
  // "Use the LLM key" cannot apply when the LLM provider is openai-codex — its
  // credential is a ChatGPT OAuth token, not an OpenAI API key.
  const imageLlmKey = stored.imageUseLlmKey && stored.llmProvider !== "openai-codex" ? stored.apiKey : "";
  const storedKey = images
    ? (stored.imageUseLlmKey ? imageLlmKey : stored.imageApiKey)
    : stored.apiKey;

  // No live list API on these paths — offer pi's catalog as suggestions.
  // Foundry hosts Claude models with no list endpoint; openai-codex's ChatGPT
  // backend has none either. Both must return before the endpoint/key
  // resolution below — neither has a DEFAULT_ENDPOINTS entry nor an API key.
  // (azure-openai does expose a live list and is handled further down.)
  if (!images) {
    if (provider === "azure-ai-foundry") return catalogResult("anthropic", "CATALOG_ONLY");
    if (provider === "openai-codex") return catalogResult("openai-codex", "CATALOG_ONLY");
    // Google AI Studio (Gemini) has a live list API, but we surface pi's
    // bundled Gemini catalog (already comprehensive) rather than a separate
    // fetch path — same treatment as the other keyed-but-catalog providers.
    if (provider === "google") return catalogResult("google", "CATALOG_ONLY");
    // Kimi Code (subscription) has no live model-list API and its auth is the
    // OAuth Bearer credential, not an endpoint/api-key — offer pi's catalog.
    if (provider === "kimi-coding") return catalogResult("kimi-coding", "CATALOG_ONLY");
  }

  const endpoint = normalizeBaseUrl(
    opts.endpoint?.trim() || (sameAsStored && !images ? stored.llmEndpoint : "") || DEFAULT_ENDPOINTS[provider] || "",
  );
  if (!endpoint) {
    throw new ModelListError("ENDPOINT_REQUIRED", "This provider requires an endpoint (base URL) before models can be listed", 400);
  }

  const requestKey = opts.apiKey && opts.apiKey !== UNCHANGED_SECRET_SENTINEL ? opts.apiKey : "";
  const envKey = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY
    : provider === "openai" ? process.env.OPENAI_API_KEY
    : undefined;
  const apiKey = requestKey || (sameAsStored ? storedKey : "") || envKey || "";

  // Azure OpenAI api-version: request value wins, then the stored setting (only
  // when the requested provider is the stored one), then the shared default.
  const apiVersion = opts.apiVersion?.trim()
    || (sameAsStored ? stored.llmApiVersion?.trim() : "")
    || DEFAULT_AZURE_API_VERSION;

  // openai/anthropic/azure-openai can't be listed without a key — degrade to
  // the catalog rather than erroring, the picker is still useful. There is no
  // image-model catalog, so image mode degrades to an empty list with the same
  // hint. Azure maps to the azure-openai-responses catalog.
  if (!apiKey && (provider === "openai" || provider === "anthropic")) {
    if (images) return finalize([], "catalog", { code: "KEY_MISSING" });
    return catalogResult(provider, "KEY_MISSING");
  }
  if (!apiKey && provider === "azure-openai") {
    return catalogResult("azure-openai-responses", "KEY_MISSING");
  }

  const now = Date.now();
  const keyHash = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 16) : "";
  // Azure's list can vary by api-version, so it participates in the cache key.
  const cacheKey = `${provider}|${endpoint}|${keyHash}${images ? "|images" : ""}${provider === "azure-openai" ? `|${apiVersion}` : ""}`;
  if (!opts.noCache) {
    const cached = cacheGet(cacheKey, now);
    if (cached) return cached;
  }

  try {
    let models: NormalizedModel[];
    if (provider === "openrouter") {
      models = await fetchOpenRouterModels(endpoint, apiKey || undefined, images);
    } else if (provider === "anthropic") {
      models = await fetchAnthropicModels(endpoint, apiKey);
    } else if (provider === "azure-openai") {
      models = await fetchAzureOpenAiModels(endpoint, apiKey, apiVersion);
    } else {
      models = await fetchOpenAiStyleModels(endpoint, apiKey || undefined, provider === "openai", images);
    }
    const result = finalize(models, "live");
    cacheSet(cacheKey, result, now);
    return result;
  } catch (err) {
    const code = err instanceof ModelListError
      ? (err.code as NonNullable<ModelListResult["warning"]>["code"])
      : "UPSTREAM_ERROR";
    console.warn(`[llm-models] Live model list failed for ${provider} (${code}): ${(err as Error)?.message}`);
    // openai-compatible has no meaningful catalog — surface the error so the
    // admin can fix the endpoint/key. Image mode has no catalog at all.
    if (provider === "openai-compatible" || images) throw err;
    const catalogProvider: CatalogProvider = provider === "azure-openai" ? "azure-openai-responses" : (provider as CatalogProvider);
    return catalogResult(catalogProvider, code);
  }
}
