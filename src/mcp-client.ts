import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "./mcp-servers.js";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "vca", version: "1.0.0" };
const DEFAULT_TIMEOUT_MS = 15_000;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private readonly server: Pick<McpServerConfig, "url" | "authType" | "apiKey">) {}

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.server.authType === "apiKey" && this.server.apiKey) {
      headers.Authorization = `Bearer ${this.server.apiKey}`;
    }
    return headers;
  }

  private async send(
    message: JsonRpcRequest | JsonRpcRequest[],
    signal: AbortSignal,
  ): Promise<JsonRpcResponse | null> {
    const res = await fetch(this.server.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(message),
      signal,
    });

    const newSid = res.headers.get("Mcp-Session-Id");
    if (newSid) this.sessionId = newSid;

    if (res.status === 202 || res.status === 204) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }

    const contentType = res.headers.get("Content-Type") || "";
    const wantsId = Array.isArray(message) ? undefined : message.id;
    if (contentType.includes("text/event-stream")) {
      return await readSseResponse(res, wantsId);
    }
    if (contentType.includes("application/json") || contentType === "") {
      const text = await res.text();
      if (!text) return null;
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? findResponseForId(parsed, wantsId) : (parsed as JsonRpcResponse);
    }
    throw new Error(`Unexpected MCP response Content-Type: ${contentType}`);
  }

  async connect(signal: AbortSignal): Promise<void> {
    const initId = this.nextId++;
    const initResponse = await this.send(
      {
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      },
      signal,
    );
    if (!initResponse || initResponse.error) {
      const msg = initResponse?.error?.message || "no result";
      throw new Error(`MCP initialize failed: ${msg}`);
    }

    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
  }

  async listTools(signal: AbortSignal): Promise<McpTool[]> {
    const id = this.nextId++;
    const res = await this.send(
      { jsonrpc: "2.0", id, method: "tools/list", params: {} },
      signal,
    );
    if (!res) throw new Error("MCP tools/list: empty response");
    if (res.error) throw new Error(`MCP tools/list error: ${res.error.message}`);
    const result = res.result as { tools?: unknown };
    if (!result || !Array.isArray(result.tools)) return [];
    return result.tools
      .filter((t: any) => t && typeof t.name === "string")
      .map((t: any) => ({
        name: t.name,
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : undefined,
      }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean }> {
    const id = this.nextId++;
    const res = await this.send(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      signal,
    );
    if (!res) throw new Error("MCP tools/call: empty response");
    if (res.error) throw new Error(`MCP tools/call error: ${res.error.message}`);
    const result = res.result as { content?: unknown[]; isError?: boolean };
    const content = Array.isArray(result?.content)
      ? (result.content as Array<{ type: string; text?: string }>)
      : [];
    return { content, isError: !!result?.isError };
  }

  async close(signal: AbortSignal): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.server.url, {
        method: "DELETE",
        headers: this.buildHeaders(),
        signal,
      });
    } catch {
      // best effort
    } finally {
      this.sessionId = null;
    }
  }
}

function findResponseForId(arr: JsonRpcResponse[], id: number | string | undefined): JsonRpcResponse | null {
  if (id === undefined) return arr[0] ?? null;
  return arr.find((r) => r.id === id) ?? null;
}

async function readSseResponse(
  res: Response,
  wantsId: number | string | undefined,
): Promise<JsonRpcResponse | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // Process complete events (terminated by blank line)
      while ((nl = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const dataLines: string[] = [];
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }
        if (Array.isArray(parsed)) {
          const match = findResponseForId(parsed, wantsId);
          if (match) {
            await reader.cancel().catch(() => {});
            return match;
          }
        } else if (parsed && parsed.jsonrpc === "2.0" && (parsed.result !== undefined || parsed.error !== undefined)) {
          if (wantsId === undefined || parsed.id === wantsId) {
            await reader.cancel().catch(() => {});
            return parsed;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return null;
}

// ─── Probe cache ───────────────────────────────────────────────

interface ProbeResult {
  ok: boolean;
  tools?: McpTool[];
  error?: string;
  fetchedAt: number;
}

const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const probeCache = new Map<string, ProbeResult>();

function cacheKey(server: Pick<McpServerConfig, "id" | "url" | "authType" | "apiKey" | "updatedAt">): string {
  return `${server.id}:${server.updatedAt}`;
}

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`MCP request timed out after ${ms}ms`)), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

export async function probeMcpServer(
  server: McpServerConfig,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const key = cacheKey(server);
  if (!opts.force) {
    const cached = probeCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < PROBE_CACHE_TTL_MS) return cached;
  }
  const { signal, cancel } = withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const client = new McpHttpClient(server);
  try {
    await client.connect(signal);
    const tools = await client.listTools(signal);
    const result: ProbeResult = { ok: true, tools, fetchedAt: Date.now() };
    probeCache.set(key, result);
    void client.close(new AbortController().signal).catch(() => {});
    return result;
  } catch (e: any) {
    const result: ProbeResult = {
      ok: false,
      error: e?.message || String(e),
      fetchedAt: Date.now(),
    };
    probeCache.set(key, result);
    return result;
  } finally {
    cancel();
  }
}

export function invalidateMcpProbeCache(serverId?: string): void {
  if (!serverId) {
    probeCache.clear();
    return;
  }
  for (const key of probeCache.keys()) {
    if (key.startsWith(`${serverId}:`)) probeCache.delete(key);
  }
}

// ─── Tool wrappers for pi-agent ────────────────────────────────

function slugifyServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
}

function wrapMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${slugifyServerName(serverName)}__${toolName}`;
}

function buildToolDefinition(server: McpServerConfig, tool: McpTool): ToolDefinition {
  const wrappedName = wrapMcpToolName(server.name, tool.name);
  // The MCP-provided inputSchema is a JSON Schema; pi-agent's TSchema is
  // structurally JSON-Schema-compatible, so we can pass it through.
  const parameters = (tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema
    : { type: "object", properties: {} }) as unknown as ToolDefinition["parameters"];

  return {
    name: wrappedName,
    label: `MCP: ${server.name} — ${tool.name}`,
    description: tool.description || `MCP tool ${tool.name} from server ${server.name}`,
    // Without a promptSnippet, pi-coding-agent (>=0.59.0) omits SDK tools from
    // the system prompt's "Available tools" section. Synthesize a one-line
    // snippet so MCP tools stay discoverable to the model.
    promptSnippet: `${wrappedName} — ${(tool.description || `MCP tool from ${server.name}`)
      .split("\n")[0]
      .trim()
      .slice(0, 200)}`,
    parameters,
    async execute(_toolCallId, params, signal) {
      const ctrl = signal ? undefined : new AbortController();
      const useSignal = signal ?? ctrl!.signal;
      const client = new McpHttpClient(server);
      try {
        await client.connect(useSignal);
        const result = await client.callTool(tool.name, (params || {}) as Record<string, unknown>, useSignal);
        const textParts = result.content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string);
        const otherParts = result.content
          .filter((c) => c.type !== "text")
          .map((c) => `[${c.type} content omitted]`);
        const text = [...textParts, ...otherParts].join("\n").trim();
        return {
          content: [
            {
              type: "text" as const,
              text: text || "(no content)",
            },
          ],
          details: { mcpServer: server.name, mcpTool: tool.name, isError: !!result.isError },
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `MCP call to ${server.name}/${tool.name} failed: ${e?.message || e}`,
            },
          ],
          details: { mcpServer: server.name, mcpTool: tool.name, error: e?.message || String(e) },
        };
      } finally {
        void client.close(new AbortController().signal).catch(() => {});
      }
    },
  } as ToolDefinition;
}

export async function loadMcpToolsForAllEnabled(servers: McpServerConfig[]): Promise<ToolDefinition[]> {
  const enabled = servers.filter((s) => s.enabled);
  if (!enabled.length) return [];
  const results = await Promise.all(enabled.map((s) => probeMcpServer(s).then((r) => ({ s, r }))));
  const tools: ToolDefinition[] = [];
  for (const { s, r } of results) {
    if (!r.ok || !r.tools) {
      console.warn(`[mcp] Skipping server ${s.name} (${s.url}): ${r.error || "no tools"}`);
      continue;
    }
    for (const t of r.tools) {
      tools.push(buildToolDefinition(s, t));
    }
  }
  return tools;
}
