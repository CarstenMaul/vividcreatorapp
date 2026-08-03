import axios from "axios";
import type { WebToolsConfig } from "./web-tools-config.js";

/**
 * Shared sidecar helper for the Anthropic-native web tools: runs one Messages
 * API turn with a server tool (`web_search_20250305` / `web_fetch_20250910`)
 * and resumes bounded `pause_turn` continuations. The basic tool versions are
 * used deliberately — the dynamic-filtering variants require ≥4.6-family
 * models, while the sidecar model is user-configurable.
 *
 * Anthropic server-tool errors arrive as HTTP 200 with a `*_tool_result_error`
 * object inside the result block; HTTP ≥ 400 means a request-level failure
 * (bad model, bad key, endpoint without server-tool support).
 */

export const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_CONTINUATIONS = 3;
// Models with adaptive thinking spend thinking tokens against max_tokens when
// `thinking` is omitted — leave headroom beyond the visible answer.
const DEFAULT_MAX_TOKENS = 8192;

export type AnthropicTextCitation = {
  type?: string;
  url?: string;
  title?: string;
  cited_text?: string;
};

export type AnthropicWebSearchResult = {
  type: "web_search_result";
  url: string;
  title?: string;
  page_age?: string;
};

export type AnthropicContentBlock = {
  type: string;
  // text blocks
  text?: string;
  citations?: AnthropicTextCitation[];
  // server_tool_use blocks
  name?: string;
  input?: { query?: string; url?: string };
  // web_search_tool_result / web_fetch_tool_result blocks: content is a list
  // of results on success, or a single `*_tool_result_error` object on error.
  content?: AnthropicWebSearchResult[] | { type?: string; error_code?: string; url?: string };
};

export type AnthropicTurnResult =
  | { ok: true; blocks: AnthropicContentBlock[]; stopReason?: string }
  | { ok: false; status: number; errorBody: string };

/** Extract the error code when a server-tool result block carries an error object. */
export function toolResultErrorCode(block: AnthropicContentBlock): string | undefined {
  const content = block.content;
  if (!content || Array.isArray(content)) return undefined;
  return typeof content.error_code === "string" ? content.error_code : undefined;
}

export async function runAnthropicServerToolTurn(opts: {
  cfg: WebToolsConfig;
  system: string;
  userText: string;
  tool: Record<string, unknown>;
  maxTokens?: number;
  signal: AbortSignal | undefined;
}): Promise<AnthropicTurnResult> {
  const { cfg, signal } = opts;
  const url = `${cfg.endpoint}/v1/messages`;
  const headers = {
    "x-api-key": cfg.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
  };
  const messages: Array<{ role: string; content: unknown }> = [
    { role: "user", content: opts.userText },
  ];

  const blocks: AnthropicContentBlock[] = [];
  for (let attempt = 0; ; attempt++) {
    const response = await axios.post(
      url,
      {
        model: cfg.modelId,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: opts.system,
        messages,
        tools: [opts.tool],
      },
      { signal, timeout: REQUEST_TIMEOUT_MS, headers, validateStatus: () => true },
    );
    if (response.status >= 400) {
      const errorBody = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      return { ok: false, status: response.status, errorBody };
    }

    const data = response.data as { content?: AnthropicContentBlock[]; stop_reason?: string };
    if (Array.isArray(data.content)) blocks.push(...data.content);
    if (data.stop_reason !== "pause_turn" || attempt >= MAX_CONTINUATIONS) {
      return { ok: true, blocks, stopReason: data.stop_reason };
    }
    // pause_turn: echo the assistant content back unchanged (required for
    // thinking/server-tool block replay) and let the server resume.
    messages.push({ role: "assistant", content: data.content });
  }
}
