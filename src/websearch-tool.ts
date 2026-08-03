import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import axios from "axios";
import {
  MAX_ALLOWED_DOMAINS,
  resolveWebToolsConfig,
  type WebToolsConfig,
} from "./web-tools-config.js";
import { runAnthropicServerToolTurn, toolResultErrorCode } from "./anthropic-web.js";

/**
 * web_search agent tool. Dispatches to the native web-search tooling of the
 * configured LLM provider (see web-tools-config.ts):
 *   - OpenAI / Azure OpenAI → Responses API `web_search` tool
 *   - OpenRouter            → server tool `openrouter:web_search` (chat completions)
 *   - Anthropic             → Messages API server tool `web_search_20250305`
 */

const REQUEST_TIMEOUT_MS = 120_000;

type Citation = { url: string; title: string };

type UrlCitation = {
  type: "url_citation";
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
};

type ResponseItem =
  | {
      type: "web_search_call";
      id?: string;
      status?: string;
      action?: { type: string; query?: string };
    }
  | {
      type: "message";
      content?: Array<{
        type: string;
        text?: string;
        annotations?: UrlCitation[];
      }>;
    }
  | { type: string };

function extractCitationsAndText(
  items: ResponseItem[],
): { text: string; citations: Citation[]; searchQueries: string[] } {
  const textParts: string[] = [];
  const citations: Citation[] = [];
  const seenUrls = new Set<string>();
  const searchQueries: string[] = [];

  for (const item of items) {
    if (item.type === "web_search_call") {
      const q = (item as { action?: { query?: string } }).action?.query;
      if (q) searchQueries.push(q);
      continue;
    }
    if (item.type === "message") {
      const content = (item as { content?: Array<{ type: string; text?: string; annotations?: UrlCitation[] }> }).content;
      if (!content) continue;
      for (const block of content) {
        if (block.type === "output_text" || block.type === "text") {
          if (block.text) textParts.push(block.text);
          if (block.annotations) {
            for (const a of block.annotations) {
              if (a.type === "url_citation" && a.url && !seenUrls.has(a.url)) {
                seenUrls.add(a.url);
                citations.push({ url: a.url, title: a.title || a.url });
              }
            }
          }
        }
      }
    }
  }
  return { text: textParts.join("\n\n").trim(), citations, searchQueries };
}

// OpenRouter surfaces citations as OpenAI-style message annotations. The
// documented shape nests the fields under `url_citation`; accept a flat
// variant too since the Responses-style items use that.
export function extractOpenRouterCitations(annotations: unknown): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(annotations)) return citations;
  for (const a of annotations) {
    if (!a || typeof a !== "object" || (a as { type?: string }).type !== "url_citation") continue;
    const nested = (a as { url_citation?: { url?: string; title?: string } }).url_citation;
    const url = nested?.url || (a as { url?: string }).url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, title: nested?.title || (a as { title?: string }).title || url });
  }
  return citations;
}

function formatResult(
  query: string,
  text: string,
  citations: Citation[],
  searchQueries: string[],
): string {
  const lines: string[] = [];
  lines.push(`Web search results for: "${query}"`);
  if (searchQueries.length) {
    lines.push("");
    lines.push(`Searches performed: ${searchQueries.map((q) => `"${q}"`).join(", ")}`);
  }
  lines.push("");
  lines.push(text || "(model returned no text)");
  if (citations.length) {
    lines.push("");
    lines.push("Sources:");
    for (const c of citations) lines.push(`- [${c.title}](${c.url})`);
  }
  return lines.join("\n");
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> };

function errorResult(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ status: number; data: any }> {
  const response = await axios.post(url, body, {
    signal,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { "Content-Type": "application/json", ...headers },
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data };
}

// ---------------------------------------------------------------------------
// OpenAI / Azure OpenAI: Responses API with the `web_search` tool.
// ---------------------------------------------------------------------------
async function searchViaResponsesApi(
  cfg: WebToolsConfig,
  query: string,
  allowedDomains: string[] | undefined,
  country: string | undefined,
  signal: AbortSignal | undefined,
  start: number,
): Promise<ToolResult> {
  const isAzure = cfg.provider === "azure-openai";
  const url = isAzure
    ? `${cfg.endpoint}/responses?api-version=${encodeURIComponent(cfg.apiVersion)}`
    : `${cfg.endpoint}/responses`;
  const headers: Record<string, string> = isAzure
    ? { "api-key": cfg.apiKey }
    : { Authorization: `Bearer ${cfg.apiKey}` };

  const webSearchTool: Record<string, unknown> = { type: "web_search" };
  if (allowedDomains?.length) {
    webSearchTool.filters = { allowed_domains: allowedDomains };
  }
  if (country) {
    webSearchTool.user_location = { type: "approximate", country };
  }
  if (cfg.contextSize) {
    webSearchTool.search_context_size = cfg.contextSize;
  }

  const body = {
    model: cfg.modelId,
    input: query,
    tools: [webSearchTool],
    tool_choice: "auto" as const,
    include: ["web_search_call.action.sources"],
  };

  const response = await postJson(url, body, headers, signal);
  if (response.status >= 400) {
    const errBody = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    return errorResult(
      `WebSearch failed: ${isAzure ? "Azure OpenAI" : "OpenAI"} Responses API returned ${response.status}.\n${errBody.slice(0, 1000)}`,
      { error: "HttpError", status: response.status, provider: cfg.provider, durationMs: Date.now() - start },
    );
  }

  // Successful Responses API payload shape: { output: [...items], output_text?: string, ... }
  // Some versions return the array at the top level; handle both defensively.
  const data = response.data as { output?: ResponseItem[] } | ResponseItem[];
  const items: ResponseItem[] = Array.isArray(data) ? data : data.output ?? [];
  const { text, citations, searchQueries } = extractCitationsAndText(items);

  if (!text && citations.length === 0) {
    return errorResult(
      `Web search returned no usable content for "${query}". The model may not have called the search tool — try a more explicit query.`,
      { query, provider: cfg.provider, model: cfg.modelId, searchQueries, durationMs: Date.now() - start },
    );
  }

  return {
    content: [{ type: "text" as const, text: formatResult(query, text, citations, searchQueries) }],
    details: {
      query,
      provider: cfg.provider,
      model: cfg.modelId,
      searchQueries,
      citationCount: citations.length,
      citations,
      durationMs: Date.now() - start,
    },
  };
}

// ---------------------------------------------------------------------------
// OpenRouter: chat completions with the `openrouter:web_search` server tool.
// ---------------------------------------------------------------------------
async function searchViaOpenRouter(
  cfg: WebToolsConfig,
  query: string,
  allowedDomains: string[] | undefined,
  country: string | undefined,
  signal: AbortSignal | undefined,
  start: number,
): Promise<ToolResult> {
  const parameters: Record<string, unknown> = {};
  if (cfg.searchEngine) parameters.engine = cfg.searchEngine;
  if (cfg.maxResults >= 1) parameters.max_results = cfg.maxResults;
  if (cfg.contextSize) parameters.search_context_size = cfg.contextSize;
  if (allowedDomains?.length) parameters.allowed_domains = allowedDomains;
  if (country) parameters.user_location = { country };

  const body = {
    model: cfg.modelId,
    messages: [
      {
        role: "system",
        content:
          "You are a web research assistant. Use the web search tool to research the user's query, then answer concisely and ground every claim in the search results.",
      },
      { role: "user", content: query },
    ],
    tools: [
      Object.keys(parameters).length
        ? { type: "openrouter:web_search", parameters }
        : { type: "openrouter:web_search" },
    ],
  };

  const response = await postJson(
    `${cfg.endpoint}/chat/completions`,
    body,
    { Authorization: `Bearer ${cfg.apiKey}`, "X-Title": "VCA" },
    signal,
  );
  if (response.status >= 400) {
    const errBody = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    return errorResult(
      `WebSearch failed: OpenRouter returned ${response.status}.\n${errBody.slice(0, 1000)}`,
      { error: "HttpError", status: response.status, provider: "openrouter", durationMs: Date.now() - start },
    );
  }

  const message = response.data?.choices?.[0]?.message;
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  const citations = extractOpenRouterCitations(message?.annotations);
  const searchCount = response.data?.usage?.server_tool_use?.web_search_requests;

  if (!text && citations.length === 0) {
    return errorResult(
      `Web search returned no usable content for "${query}". The model may not have called the search tool — try a more explicit query.`,
      { query, provider: "openrouter", model: cfg.modelId, durationMs: Date.now() - start },
    );
  }

  return {
    content: [{ type: "text" as const, text: formatResult(query, text, citations, []) }],
    details: {
      query,
      provider: "openrouter",
      model: cfg.modelId,
      ...(typeof searchCount === "number" ? { searchRequests: searchCount } : {}),
      citationCount: citations.length,
      citations,
      durationMs: Date.now() - start,
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic: Messages API with the `web_search_20250305` server tool.
// ---------------------------------------------------------------------------
async function searchViaAnthropic(
  cfg: WebToolsConfig,
  query: string,
  allowedDomains: string[] | undefined,
  country: string | undefined,
  signal: AbortSignal | undefined,
  start: number,
): Promise<ToolResult> {
  const tool: Record<string, unknown> = { type: "web_search_20250305", name: "web_search", max_uses: 5 };
  if (allowedDomains?.length) tool.allowed_domains = allowedDomains;
  if (country) tool.user_location = { type: "approximate", country };

  const result = await runAnthropicServerToolTurn({
    cfg,
    system:
      "You are a web research assistant. Use the web search tool to research the user's query, then answer concisely and ground every claim in the search results.",
    userText: query,
    tool,
    signal,
  });
  if (!result.ok) {
    return errorResult(
      `WebSearch failed: Anthropic Messages API returned ${result.status}.\n${result.errorBody.slice(0, 1000)}`,
      { error: "HttpError", status: result.status, provider: "anthropic", durationMs: Date.now() - start },
    );
  }

  const textParts: string[] = [];
  const citations: Citation[] = [];
  const seenUrls = new Set<string>();
  const searchQueries: string[] = [];
  const rawResults: Citation[] = [];
  let toolErrorCode: string | undefined;

  for (const block of result.blocks) {
    if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) {
      searchQueries.push(block.input.query);
    } else if (block.type === "web_search_tool_result") {
      if (Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.url) rawResults.push({ url: r.url, title: r.title || r.url });
        }
      } else {
        toolErrorCode = toolResultErrorCode(block) ?? toolErrorCode;
      }
    } else if (block.type === "text" && block.text) {
      textParts.push(block.text);
      for (const c of block.citations ?? []) {
        if (c.url && !seenUrls.has(c.url)) {
          seenUrls.add(c.url);
          citations.push({ url: c.url, title: c.title || c.url });
        }
      }
    }
    // thinking and unknown block types: skip
  }
  const text = textParts.join("").trim();
  if (!citations.length) {
    for (const r of rawResults) {
      if (citations.length >= 10) break;
      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        citations.push(r);
      }
    }
  }

  if (!text && citations.length === 0) {
    if (toolErrorCode) {
      return errorResult(
        `WebSearch failed: Anthropic web_search returned error "${toolErrorCode}".`,
        { query, error: toolErrorCode, provider: "anthropic", model: cfg.modelId, durationMs: Date.now() - start },
      );
    }
    return errorResult(
      `Web search returned no usable content for "${query}". The model may not have called the search tool — try a more explicit query.`,
      { query, provider: "anthropic", model: cfg.modelId, searchQueries, durationMs: Date.now() - start },
    );
  }

  return {
    content: [{ type: "text" as const, text: formatResult(query, text, citations, searchQueries) }],
    details: {
      query,
      provider: "anthropic",
      model: cfg.modelId,
      searchQueries,
      citationCount: citations.length,
      citations,
      durationMs: Date.now() - start,
    },
  };
}

export function createWebSearchTool(): ToolDefinition | null {
  // Fail closed at registration time if no provider config is available. The
  // config is re-resolved on every call, so key/endpoint edits apply live.
  const cfg = resolveWebToolsConfig();
  if (!cfg.searchEnabled) {
    console.log("[websearch] Web search is disabled in Settings. WebSearch tool not registered.");
    return null;
  }
  if (cfg.provider === "none") {
    console.warn(`[websearch] ${cfg.reason} WebSearch tool not registered.`);
    return null;
  }
  console.log(`[websearch] Registered (provider: ${cfg.provider}, model: ${cfg.modelId})`);

  const tool: ToolDefinition = {
    name: "web_search",
    label: "Search the web",
    description:
      "Search the public web via the configured LLM provider's native web search tooling (OpenAI / Azure OpenAI web_search, OpenRouter agentic web search, or Anthropic web_search server tool). Returns a synthesized answer with inline source citations. Use for current events, recent docs, and information past the model's knowledge cutoff.",
    promptSnippet: "web_search — search the web and return a grounded answer with citations",
    promptGuidelines: [
      "Use this tool when the user asks about current events, recent releases, or information that may have changed since the training cutoff.",
      "Phrase the query like a search engine query (keywords + intent), not a conversational sentence.",
      "Use 'allowed_domains' to scope results to authoritative sources (max 100 entries, e.g. ['microsoft.com', 'learn.microsoft.com']). Subdomains are included automatically.",
      "Use 'country' (2-letter ISO, e.g. 'DE', 'US') to bias results to a region when locality matters.",
      "After receiving results, surface the cited URLs to the user using markdown hyperlinks — never strip the Sources section.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query (keywords + intent, like a Google query)." }),
      allowed_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: `Optional allow-list of domains (max ${MAX_ALLOWED_DOMAINS}). Format like 'microsoft.com' (no scheme). Subdomains included.`,
        }),
      ),
      country: Type.Optional(
        Type.String({ description: "Optional 2-letter ISO country/region code (e.g. 'US', 'DE', 'IN') to bias results." }),
      ),
    }),
    async execute(_toolCallId, params: any, signal) {
      const start = Date.now();
      const query: string = params.query;
      const allowedDomains: string[] | undefined = params.allowed_domains;
      const country: string | undefined = params.country;

      if (!query || query.trim().length < 2) {
        return errorResult("WebSearch failed: query must be at least 2 characters.", { error: "InvalidQuery" });
      }
      if (allowedDomains && allowedDomains.length > MAX_ALLOWED_DOMAINS) {
        return errorResult(
          `WebSearch failed: allowed_domains exceeds the limit of ${MAX_ALLOWED_DOMAINS} entries.`,
          { error: "TooManyDomains" },
        );
      }

      const liveCfg = resolveWebToolsConfig();
      if (!liveCfg.searchEnabled) {
        return errorResult("WebSearch failed: web search has been disabled in Settings.", { error: "Disabled" });
      }
      if (liveCfg.provider === "none") {
        return errorResult(`WebSearch failed: ${liveCfg.reason}`, { error: "Misconfigured" });
      }

      try {
        if (liveCfg.provider === "anthropic") {
          return await searchViaAnthropic(liveCfg, query, allowedDomains, country, signal, start);
        }
        if (liveCfg.provider === "openrouter") {
          return await searchViaOpenRouter(liveCfg, query, allowedDomains, country, signal, start);
        }
        return await searchViaResponsesApi(liveCfg, query, allowedDomains, country, signal, start);
      } catch (err) {
        const e = err as Error;
        return errorResult(`WebSearch failed: ${e.message}`, {
          error: e.name || "Error",
          message: e.message,
          provider: liveCfg.provider,
          durationMs: Date.now() - start,
        });
      }
    },
  } as ToolDefinition;

  return tool;
}
