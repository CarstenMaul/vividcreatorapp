import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { complete, type Model, type Api } from "@earendil-works/pi-ai/compat";
import { Type } from "@earendil-works/pi-ai";
import axios, { type AxiosResponse } from "axios";
import { isPreapprovedHost } from "./webfetch-preapproved.js";
import { resolveWebToolsConfig, type WebToolsConfig } from "./web-tools-config.js";
import { extractOpenRouterCitations } from "./websearch-tool.js";
import { runAnthropicServerToolTurn, toolResultErrorCode } from "./anthropic-web.js";

/**
 * web_fetch agent tool.
 *   - OpenRouter provider → server tool `openrouter:web_fetch` (fetch + extraction
 *     happen provider-side; handles JS-rendered pages and returns citations).
 *   - Anthropic provider → server tool `web_fetch_20250910` (fetch + extraction
 *     provider-side; supports PDFs), falling back to the direct path on failure.
 *   - Every other provider → direct HTTP fetch, HTML→markdown conversion, and
 *     prompt-scoped extraction with the chat session's own model.
 */

const MAX_URL_LENGTH = 2000;
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const PROVIDER_FETCH_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 10;
const MAX_MARKDOWN_LENGTH = 100_000;

const USER_AGENT = "vca-webfetch/1.0";

type RedirectInfo = {
  type: "redirect";
  originalUrl: string;
  redirectUrl: string;
  statusCode: number;
};

type FetchedContent = {
  type: "content";
  content: string;
  bytes: number;
  status: number;
  statusText: string;
  contentType: string;
};

class EgressBlockedError extends Error {
  constructor(public readonly hostname: string) {
    super(`Access to ${hostname} is blocked by the network egress proxy.`);
    this.name = "EgressBlockedError";
  }
}

class BinaryContentError extends Error {
  constructor(public readonly contentType: string) {
    super(`Binary content (${contentType}) is not supported.`);
    this.name = "BinaryContentError";
  }
}

// Lazy turndown singleton — defers the ~1.4MB import until the first HTML
// fetch and reuses one instance across calls.
type TurndownCtor = typeof import("turndown");
let turndownPromise: Promise<InstanceType<TurndownCtor>> | undefined;
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownPromise ??= import("turndown").then((m) => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default;
    return new Turndown();
  }));
}

function validateURL(url: string): { ok: true } | { ok: false; reason: string } {
  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL exceeds ${MAX_URL_LENGTH} characters.` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "URL could not be parsed." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed." };
  }
  // Block obviously private/internal hostnames by requiring at least one dot.
  if (parsed.hostname.split(".").length < 2) {
    return { ok: false, reason: "Hostname must be publicly resolvable (must contain at least one dot)." };
  }
  return { ok: true };
}

// Same-origin redirect check. Allows adding/stripping "www." but disallows
// protocol/port changes, embedded credentials, and cross-origin hops.
function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const o = new URL(originalUrl);
    const r = new URL(redirectUrl);
    if (r.protocol !== o.protocol) return false;
    if (r.port !== o.port) return false;
    if (r.username || r.password) return false;
    const strip = (h: string) => h.replace(/^www\./, "");
    return strip(o.hostname) === strip(r.hostname);
  } catch {
    return false;
  }
}

async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
  }
  try {
    return await axios.get<ArrayBuffer>(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: "arraybuffer",
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
      headers: {
        Accept: "text/markdown, text/html, */*",
        "User-Agent": USER_AGENT,
      },
    });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response && [301, 302, 307, 308].includes(error.response.status)) {
      const location = error.response.headers.location;
      if (!location) throw new Error("Redirect missing Location header");
      const redirectUrl = new URL(location, url).toString();
      if (isPermittedRedirect(url, redirectUrl)) {
        return getWithPermittedRedirects(redirectUrl, signal, depth + 1);
      }
      return { type: "redirect", originalUrl: url, redirectUrl, statusCode: error.response.status };
    }
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.headers["x-proxy-error"] === "blocked-by-allowlist"
    ) {
      throw new EgressBlockedError(new URL(url).hostname);
    }
    throw error;
  }
}

function isRedirectInfo(r: AxiosResponse<ArrayBuffer> | RedirectInfo): r is RedirectInfo {
  return (r as RedirectInfo).type === "redirect";
}

function isBinaryContentType(contentType: string): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/")) return false;
  if (ct.startsWith("application/json")) return false;
  if (ct.startsWith("application/xml")) return false;
  if (ct.startsWith("application/xhtml+xml")) return false;
  if (ct.startsWith("application/javascript")) return false;
  if (ct.startsWith("application/x-yaml") || ct.startsWith("application/yaml")) return false;
  return true;
}

async function fetchAndConvert(
  inputUrl: string,
  signal: AbortSignal,
): Promise<RedirectInfo | FetchedContent> {
  // Upgrade http → https
  let upgradedUrl = inputUrl;
  const parsed = new URL(inputUrl);
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
    upgradedUrl = parsed.toString();
  }

  const result = await getWithPermittedRedirects(upgradedUrl, signal);
  if (isRedirectInfo(result)) return result;
  const response: AxiosResponse<ArrayBuffer> = result;

  const rawBuffer = Buffer.from(response.data);
  const contentType = (response.headers["content-type"] ?? "") as string;

  if (isBinaryContentType(contentType)) {
    throw new BinaryContentError(contentType);
  }

  const bytes = rawBuffer.length;
  const text = rawBuffer.toString("utf-8");
  let markdown: string;
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    markdown = (await getTurndownService()).turndown(text);
  } else {
    markdown = text;
  }

  return {
    type: "content",
    content: markdown,
    bytes,
    status: response.status,
    statusText: response.statusText,
    contentType,
  };
}

async function applyPromptToMarkdown(
  model: Model<Api>,
  apiKey: string | undefined,
  userPrompt: string,
  markdown: string,
  signal: AbortSignal,
): Promise<string> {
  const truncated =
    markdown.length > MAX_MARKDOWN_LENGTH
      ? markdown.slice(0, MAX_MARKDOWN_LENGTH) + "\n\n[Content truncated due to length...]"
      : markdown;
  const userText = `Web page content:\n---\n${truncated}\n---\n\n${userPrompt}\n\nProvide a concise response based only on the content above.`;
  const assistant = await complete(
    model,
    {
      systemPrompt:
        "You extract information from a web page. The user provides the page content (markdown) and a question. Answer using only the provided content. Be concise.",
      messages: [{ role: "user", content: userText, timestamp: Date.now() }],
    },
    { signal, ...(apiKey ? { apiKey } : {}) },
  );
  const textBlock = assistant.content.find((c): c is { type: "text"; text: string } => c.type === "text");
  return textBlock?.text ?? "No response from model.";
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// OpenRouter: chat completions with the `openrouter:web_fetch` server tool —
// fetch and extraction run provider-side.
// ---------------------------------------------------------------------------
async function fetchViaOpenRouter(
  cfg: WebToolsConfig,
  url: string,
  userPrompt: string,
  signal: AbortSignal,
  start: number,
): Promise<ToolResult> {
  const parameters: Record<string, unknown> = { max_content_tokens: 50_000 };
  if (cfg.fetchEngine) parameters.engine = cfg.fetchEngine;

  const body = {
    model: cfg.modelId,
    messages: [
      {
        role: "system",
        content:
          "You extract information from a web page. Use the web fetch tool to retrieve the URL the user provides, then answer their extraction prompt using only the fetched content. Be concise.",
      },
      { role: "user", content: `Fetch this URL: ${url}\n\nThen answer: ${userPrompt}` },
    ],
    tools: [{ type: "openrouter:web_fetch", parameters }],
  };

  const response = await axios.post(`${cfg.endpoint}/chat/completions`, body, {
    signal,
    timeout: PROVIDER_FETCH_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "VCA",
    },
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const errBody = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    return {
      content: [
        {
          type: "text" as const,
          text: `WebFetch failed: OpenRouter returned ${response.status}.\n${errBody.slice(0, 1000)}`,
        },
      ],
      details: { url, error: "HttpError", status: response.status, provider: "openrouter", durationMs: Date.now() - start },
    };
  }

  const message = response.data?.choices?.[0]?.message;
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  const citations = extractOpenRouterCitations(message?.annotations);

  if (!text) {
    return {
      content: [
        {
          type: "text" as const,
          text: `WebFetch returned no usable content for ${url}. The model may not have called the fetch tool — try again or check the URL.`,
        },
      ],
      details: { url, provider: "openrouter", model: cfg.modelId, durationMs: Date.now() - start },
    };
  }

  const lines = [text];
  if (citations.length) {
    lines.push("", "Sources:");
    for (const c of citations) lines.push(`- [${c.title}](${c.url})`);
  }
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      url,
      provider: "openrouter",
      model: cfg.modelId,
      citationCount: citations.length,
      usedLLM: true,
      durationMs: Date.now() - start,
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic: Messages API with the `web_fetch_20250910` server tool — fetch
// and extraction run provider-side. Returns null when the caller should fall
// back to the direct-fetch path, so behavior never regresses.
// ---------------------------------------------------------------------------
async function fetchViaAnthropic(
  cfg: WebToolsConfig,
  url: string,
  userPrompt: string,
  signal: AbortSignal,
  start: number,
): Promise<ToolResult | null> {
  const maxContentTokens = cfg.contextSize === "low" ? 25_000 : cfg.contextSize === "high" ? 100_000 : 50_000;
  const tool: Record<string, unknown> = {
    type: "web_fetch_20250910",
    name: "web_fetch",
    max_uses: 2,
    max_content_tokens: maxContentTokens,
  };

  try {
    const result = await runAnthropicServerToolTurn({
      cfg,
      system:
        "You extract information from a web page. Use the web fetch tool to retrieve the URL the user provides, then answer their extraction prompt using only the fetched content. Be concise.",
      userText: `Fetch this URL: ${url}\n\nThen answer: ${userPrompt}`,
      tool,
      signal,
    });
    if (!result.ok) {
      console.warn(
        `[webfetch] Anthropic-native fetch failed (HTTP ${result.status}); falling back to direct fetch.`,
      );
      return null;
    }

    let toolErrorCode: string | undefined;
    const textParts: string[] = [];
    for (const block of result.blocks) {
      if (block.type === "web_fetch_tool_result") {
        toolErrorCode = toolResultErrorCode(block) ?? toolErrorCode;
      } else if (block.type === "text" && block.text) {
        textParts.push(block.text);
      }
    }
    const text = textParts.join("").trim();
    if (toolErrorCode || !text) {
      console.warn(
        `[webfetch] Anthropic-native fetch ${toolErrorCode ? `returned error "${toolErrorCode}"` : "produced no text"}; falling back to direct fetch.`,
      );
      return null;
    }

    return {
      content: [{ type: "text" as const, text }],
      details: {
        url,
        provider: "anthropic",
        model: cfg.modelId,
        usedLLM: true,
        durationMs: Date.now() - start,
      },
    };
  } catch (err) {
    const e = err as Error;
    console.warn(`[webfetch] Anthropic-native fetch failed (${e.message}); falling back to direct fetch.`);
    return null;
  }
}

export interface WebFetchToolOptions {
  /** The chat session's resolved model — used for prompt-scoped extraction on the direct-fetch path. */
  model: Model<Api>;
  /**
   * Resolves the key matching the session model at call time (may be empty
   * for header-authenticated models). A getter rather than a captured string:
   * OAuth-backed providers (openai-codex) rotate access tokens mid-session
   * and the auth storage refreshes on read.
   */
  getApiKey?: () => Promise<string | undefined>;
}

export function createWebFetchTool(options: WebFetchToolOptions): ToolDefinition | null {
  const cfg = resolveWebToolsConfig();
  if (!cfg.fetchEnabled) {
    console.log("[webfetch] Web fetch is disabled in Settings. WebFetch tool not registered.");
    return null;
  }
  console.log(
    `[webfetch] Registered (${
      cfg.fetchViaProvider && cfg.provider === "anthropic"
        ? `provider: anthropic (native, direct-fetch fallback), model: ${cfg.modelId}`
        : cfg.fetchViaProvider
          ? `provider: openrouter, model: ${cfg.modelId}`
          : `direct fetch, extraction model: ${options.model.id}`
    })`,
  );

  const tool: ToolDefinition = {
    name: "web_fetch",
    label: "Fetch web page",
    description:
      "Fetch a public URL and extract information from the page content using a prompt. Uses the configured LLM provider's native web fetch tooling when available (OpenRouter, Anthropic — the Anthropic path also supports PDFs), otherwise fetches directly and extracts with the chat model. http URLs are auto-upgraded to https. Cross-origin redirects are surfaced so you can decide whether to refetch.",
    promptSnippet: "web_fetch — fetch a URL and extract info matching a prompt",
    promptGuidelines: [
      "Use this tool to read a public web page when the user references a URL or asks to look something up online.",
      "The 'prompt' parameter scopes what to extract — be specific (e.g. 'list the install commands', 'find the request schema'). Vague prompts produce vague answers.",
      "If a cross-origin redirect is reported, decide whether the new URL is what you want before refetching — don't follow blindly.",
      "URLs over 2000 characters, URLs with embedded credentials, and internal/single-label hostnames are rejected.",
      "Binary content (images, archives) is not supported. PDFs work only when a provider-native fetch path (Anthropic, OpenRouter) is active; the direct-fetch path rejects them.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch (http or https). Maximum 2000 characters." }),
      prompt: Type.String({ description: "What to extract from the fetched page content." }),
    }),
    async execute(_toolCallId, params: any, signal) {
      const start = Date.now();
      const url: string = params.url;
      const userPrompt: string = params.prompt;
      const abortSignal = signal ?? new AbortController().signal;

      const validation = validateURL(url);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: `WebFetch failed: ${validation.reason}` }],
          details: { url, error: "InvalidUrl", durationMs: Date.now() - start },
        };
      }

      const liveCfg = resolveWebToolsConfig();
      if (!liveCfg.fetchEnabled) {
        return {
          content: [{ type: "text" as const, text: "WebFetch failed: web fetch has been disabled in Settings." }],
          details: { url, error: "Disabled" },
        };
      }

      try {
        // Provider-native path: OpenRouter fetches and extracts server-side.
        if (liveCfg.fetchViaProvider && liveCfg.provider === "openrouter") {
          return await fetchViaOpenRouter(liveCfg, url, userPrompt, abortSignal, start);
        }

        // Provider-native path: Anthropic web_fetch server tool. Pre-approved
        // hosts keep the zero-LLM-cost raw-markdown direct path; any native
        // failure falls through to the direct path below.
        if (liveCfg.fetchViaProvider && liveCfg.provider === "anthropic") {
          const parsedUrl = new URL(url);
          if (!isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)) {
            const native = await fetchViaAnthropic(liveCfg, url, userPrompt, abortSignal, start);
            if (native) return native;
          }
        }

        // Direct path: fetch + markdown conversion here, extraction with the
        // session's own chat model.
        const fetched = await fetchAndConvert(url, abortSignal);
        const durationMs = Date.now() - start;

        if (fetched.type === "redirect") {
          const statusText =
            fetched.statusCode === 301
              ? "Moved Permanently"
              : fetched.statusCode === 308
                ? "Permanent Redirect"
                : fetched.statusCode === 307
                  ? "Temporary Redirect"
                  : "Found";
          const message =
            `REDIRECT DETECTED: The URL redirects to a different host.\n\n` +
            `Original URL: ${fetched.originalUrl}\n` +
            `Redirect URL: ${fetched.redirectUrl}\n` +
            `Status: ${fetched.statusCode} ${statusText}\n\n` +
            `If you want to follow this redirect, call web_fetch again with url="${fetched.redirectUrl}".`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: {
              redirected: true,
              originalUrl: fetched.originalUrl,
              redirectUrl: fetched.redirectUrl,
              statusCode: fetched.statusCode,
              durationMs,
            },
          };
        }

        const parsed = new URL(url);
        const preapproved = isPreapprovedHost(parsed.hostname, parsed.pathname);
        const isMarkdownish =
          fetched.contentType.includes("text/markdown") ||
          fetched.contentType.includes("text/plain") ||
          fetched.contentType === "";

        let result: string;
        let usedLLM: boolean;
        if (preapproved && isMarkdownish && fetched.content.length < MAX_MARKDOWN_LENGTH) {
          result = fetched.content;
          usedLLM = false;
        } else {
          const apiKey = options.getApiKey ? await options.getApiKey() : undefined;
          result = await applyPromptToMarkdown(options.model, apiKey, userPrompt, fetched.content, abortSignal);
          usedLLM = true;
        }

        return {
          content: [{ type: "text" as const, text: result }],
          details: {
            url,
            status: fetched.status,
            contentType: fetched.contentType,
            bytes: fetched.bytes,
            durationMs: Date.now() - start,
            usedLLM,
            preapproved,
          },
        };
      } catch (err) {
        const e = err as Error;
        let text: string;
        if (e instanceof EgressBlockedError) {
          text = `WebFetch blocked: ${e.message} (host: ${e.hostname})`;
        } else if (e instanceof BinaryContentError) {
          text = `WebFetch failed: ${e.message} Only text/HTML/JSON/XML/YAML responses are supported.`;
        } else {
          text = `WebFetch failed: ${e.message}`;
        }
        return {
          content: [{ type: "text" as const, text }],
          details: { url, error: e.name || "Error", message: e.message, durationMs: Date.now() - start },
        };
      }
    },
  } as ToolDefinition;

  return tool;
}
