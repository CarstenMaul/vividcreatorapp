import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { atomicWriteJson } from "./fs-utils.js";
import { adminPaths } from "./paths.js";

export type McpAuthType = "none" | "apiKey";

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  authType: McpAuthType;
  apiKey?: string;
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface McpServersFile {
  servers: McpServerConfig[];
}

function isValidServer(s: any): s is McpServerConfig {
  if (!s || typeof s !== "object") return false;
  if (typeof s.id !== "string" || !s.id) return false;
  if (typeof s.name !== "string" || !s.name.trim()) return false;
  if (typeof s.url !== "string" || !s.url.trim()) return false;
  if (s.authType !== "none" && s.authType !== "apiKey") return false;
  if (typeof s.enabled !== "boolean") return false;
  return true;
}

export async function readMcpServers(): Promise<McpServerConfig[]> {
  try {
    const raw = await fs.readFile(adminPaths.mcpServers(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<McpServersFile> | McpServerConfig[];
    const servers = Array.isArray(parsed) ? parsed : parsed.servers;
    if (!Array.isArray(servers)) return [];
    return servers.filter(isValidServer);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeMcpServers(servers: McpServerConfig[]): Promise<void> {
  const filePath = adminPaths.mcpServers();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, { servers } as McpServersFile, 2);
}

export interface McpServerInput {
  name: string;
  url: string;
  authType?: McpAuthType;
  apiKey?: string;
  enabled?: boolean;
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL must use http or https");
    }
    return trimmed;
  } catch (e: any) {
    throw new Error(`Invalid URL: ${e?.message || e}`);
  }
}

function normalizeIncoming(input: McpServerInput): { name: string; url: string; authType: McpAuthType; apiKey?: string; enabled: boolean } {
  if (typeof input !== "object" || !input) throw new Error("server payload must be an object");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("name is required");
  const url = typeof input.url === "string" ? normalizeUrl(input.url) : "";
  if (!url) throw new Error("url is required");
  const authType: McpAuthType = input.authType === "apiKey" ? "apiKey" : "none";
  let apiKey: string | undefined;
  if (authType === "apiKey") {
    apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey) throw new Error("apiKey is required when authType is apiKey");
  }
  const enabled = input.enabled === undefined ? true : !!input.enabled;
  return { name, url, authType, apiKey, enabled };
}

export async function addMcpServer(input: McpServerInput, adminUserId: string): Promise<McpServerConfig> {
  const norm = normalizeIncoming(input);
  const servers = await readMcpServers();
  const nowIso = new Date().toISOString();
  const server: McpServerConfig = {
    id: randomUUID(),
    ...norm,
    createdBy: adminUserId,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  servers.push(server);
  await writeMcpServers(servers);
  return server;
}

export async function updateMcpServer(id: string, input: Partial<McpServerInput>): Promise<McpServerConfig> {
  const servers = await readMcpServers();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx === -1) {
    const err = new Error(`No MCP server with id ${id}`);
    (err as any).code = "NOT_FOUND";
    throw err;
  }
  const existing = servers[idx];
  const merged: McpServerInput = {
    name: input.name ?? existing.name,
    url: input.url ?? existing.url,
    authType: input.authType ?? existing.authType,
    apiKey: input.authType === "apiKey"
      ? (input.apiKey ?? existing.apiKey)
      : input.apiKey,
    enabled: input.enabled ?? existing.enabled,
  };
  const norm = normalizeIncoming(merged);
  servers[idx] = {
    ...existing,
    ...norm,
    updatedAt: new Date().toISOString(),
  };
  await writeMcpServers(servers);
  return servers[idx];
}

export async function deleteMcpServer(id: string): Promise<void> {
  const servers = await readMcpServers();
  const next = servers.filter((s) => s.id !== id);
  if (next.length === servers.length) {
    const err = new Error(`No MCP server with id ${id}`);
    (err as any).code = "NOT_FOUND";
    throw err;
  }
  await writeMcpServers(next);
}

export async function getMcpServer(id: string): Promise<McpServerConfig | null> {
  const servers = await readMcpServers();
  return servers.find((s) => s.id === id) ?? null;
}

/**
 * Wholesale replacement of the MCP server list (encrypted config-file import).
 * Each entry is defensively coerced — invalid URLs, missing names, or apiKey
 * auth without a key are dropped. Ids are preserved when present (nothing
 * cross-instance references them, but round-trip fidelity is nice) and minted
 * otherwise. Real apiKeys ride in untouched (the import payload is decrypted
 * server-side, same as add/update).
 */
export async function replaceMcpServers(rawServers: unknown[]): Promise<McpServerConfig[]> {
  const nowIso = new Date().toISOString();
  const out: McpServerConfig[] = [];
  for (const raw of Array.isArray(rawServers) ? rawServers : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    let url: string;
    try {
      url = typeof r.url === "string" ? normalizeUrl(r.url) : "";
    } catch {
      continue;
    }
    if (!url) continue;
    const authType: McpAuthType = r.authType === "apiKey" ? "apiKey" : "none";
    let apiKey: string | undefined;
    if (authType === "apiKey") {
      apiKey = typeof r.apiKey === "string" ? r.apiKey : "";
      if (!apiKey) continue;
    }
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : randomUUID(),
      name,
      url,
      authType,
      apiKey,
      enabled: r.enabled === undefined ? true : !!r.enabled,
      createdBy: typeof r.createdBy === "string" ? r.createdBy : undefined,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : nowIso,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : nowIso,
    });
  }
  await writeMcpServers(out);
  return out;
}
