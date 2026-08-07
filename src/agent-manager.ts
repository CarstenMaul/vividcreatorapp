import { createAgentSession, SessionManager, SettingsManager, ModelRuntime, DefaultResourceLoader, type AgentSession, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { complete, Type, type Model, type Api } from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCodexCredentialStore, hasCodexCredential } from "./codex-auth.js";
import { getKimiCredentialStore, hasKimiCredential } from "./kimi-auth.js";
import { getOpenRouterCredentialStore, hasOpenRouterCredential } from "./openrouter-auth.js";
import { bundledBashExe } from "./bundled-runtime.js";
import { git, tryGit } from "./exec-utils.js";
import { acquireLease, releaseLease, describeSelf, leasingEnabled } from "./project-lock.js";
import { resolveWorkspaceRealRoot, buildHardenedToolDefinitions } from "./agent-sandbox.js";
import { atomicWriteJson, copyDir } from "./fs-utils.js";
import { addProjectCost, readProjectCostIfExists } from "./project-cost.js";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "os";
import { stringify as yamlStringify } from "yaml";
import { getSystemPrompt, getSystemPromptVersion } from "./system-prompt.js";
import { createRequirementTools } from "./requirement-tools.js";
import { createSkillTools } from "./skill-tools.js";
import { createLlmConfigTools } from "./llm-config-tools.js";
import { createWebFetchTool } from "./webfetch-tool.js";
import { createWebSearchTool } from "./websearch-tool.js";
import { createScreenshotTool, type ScreenshotClientResult } from "./screenshot-tool.js";
import { getWebToolsStatus } from "./web-tools-config.js";
import { getSessionStore } from "./session-store.js";
import { getAuthConfigSnapshot } from "./auth-config.js";
import { getSkillRepoMap } from "./skill-repo-sync.js";
import { getUserSkillRepos, removeUserSkillRepo } from "./user-skill-repos.js";
import { withGitLock } from "./git-lock.js";
import { DEFAULT_APP_VERSION, readAppVersion, writeAppVersion, bumpBuild, parseVersion, withMainMinor } from "./app-version.js";
import { getSystemPromptRepoUrl } from "./system-prompt-sync.js";
import { getCachedVcaSettings, type VcaSettings } from "./admin-settings.js";
import {
  getAppTemplates,
  getAppTemplateByName,
  getDefaultAppTemplate,
} from "./app-templates.js";
import { seedDefaultSkills, getSystemSkillNames, getSystemSkillSource } from "./default-skills.js";
import { startAppProcess, stopAppProcess, restartAppProcess, releasePort, rmRetry, getAppProcessLogs } from "./app-process-manager.js";
import { ensureDependencies, removeNodeModulesStore, seedNodeModulesFromDir, ensureNodeModulesSymlink } from "./node-modules-store.js";
import { createDevOpsRepo } from "./devops-repo.js";
import { createGitHubRepo } from "./github-repo.js";
import { resolveProfileCredentials } from "./vcs-profiles.js";
import { encryptSecret } from "./secret-crypto.js";
import { UNCHANGED_SECRET_SENTINEL } from "./auth-config.js";
import { readMcpServers } from "./mcp-servers.js";
import { loadMcpToolsForAllEnabled } from "./mcp-client.js";
import { userPaths, projectPaths, listUserDirs, PROJECT_ICON_FILENAME } from "./paths.js";
import { loadPublicUser, createEntraUser, type PublicUser } from "./user-store.js";

const execFileAsync = promisify(execFile);

function getSkillsDir(userId: string): string {
  return userPaths.skillsDir(userId);
}

export interface SkillMeta {
  name: string;
  dirName: string;
  description: string;
  version: string;
  system: boolean;
  repoUrl?: string;
  // For kind "user" with a repoUrl: whether refresh pulls the latest vX.X.X
  // tag (true) or the default branch (false). From the per-user skill-repos
  // store — never from frontmatter (a version:/system: line in a user-dir
  // SKILL.md would get the skill pruned as a stale system skill).
  useTags?: boolean;
  kind?: "system" | "user" | "project";
  // Where the skill came from.
  // For kind "system": "git" (cloned from a configured skill repo, read-only)
  //   or "admin" (authored locally in admin/skills/, admin-editable).
  // For kind "project": "template" (delivered by the project template, read-only).
  source?: "git" | "admin" | "template";
}

// ─── Use-Case Diagram ──────────────────────────────────────────

export interface UseCaseActor { id: string; name: string; x?: number; y?: number; }
export interface UseCaseItem { id: string; name: string; x?: number; y?: number; }
export interface UseCaseConnection { id?: string; actorId: string; useCaseId: string; label?: string; type?: string; }
export interface UseCaseRelationship { id: string; fromUseCaseId: string; toUseCaseId: string; type: "extend" | "include" | "association"; }
export interface SystemBoundary { id: string; name: string; x: number; y: number; width: number; height: number; }
export interface UseCaseData {
  actors: UseCaseActor[];
  useCases: UseCaseItem[];
  connections: UseCaseConnection[];
  relationships?: UseCaseRelationship[];
  systemBoundary?: SystemBoundary | null; // deprecated, kept for migration
  boundaries?: SystemBoundary[];
}

function migrateUseCaseData(data: UseCaseData): UseCaseData {
  if (data.systemBoundary && (!data.boundaries || data.boundaries.length === 0)) {
    const b = data.systemBoundary;
    if (!b.id) b.id = crypto.randomUUID().slice(0, 8);
    data.boundaries = [b];
  }
  if (!data.boundaries) data.boundaries = [];
  delete data.systemBoundary;
  return data;
}

async function getUseCasePath(userId: string, projectId: string): Promise<string> {
  return projectPaths.useCase(await resolveOwnerUserId(userId, projectId), projectId);
}

export async function getUseCaseData(userId: string, projectId: string): Promise<UseCaseData | null> {
  try {
    const data = await fs.readFile(await getUseCasePath(userId, projectId), "utf-8");
    return migrateUseCaseData(JSON.parse(data));
  } catch {
    return null;
  }
}

export async function setUseCaseData(userId: string, projectId: string, data: UseCaseData): Promise<void> {
  const wsPath = await getWorkspacePath(userId, projectId);
  await atomicWriteJson(await getUseCasePath(userId, projectId), data, 2);
  // Also write Mermaid representation to repo
  const mermaid = generateUseCaseMermaid(data);
  if (mermaid) {
    await fs.writeFile(path.join(wsPath, "usecase.md"), `# Use-Case Diagram\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
  }
}

function sanitizeMermaidLabel(name: string): string {
  return name.replace(/[()[\]|{}]/g, " ").replace(/\s+/g, " ").trim();
}

function findContainingBoundary(uc: UseCaseItem, boundaries: SystemBoundary[]): SystemBoundary | null {
  let best: SystemBoundary | null = null;
  let bestArea = Infinity;
  for (const b of boundaries) {
    if (uc.x != null && uc.y != null && uc.x >= b.x && uc.x <= b.x + b.width && uc.y >= b.y && uc.y <= b.y + b.height) {
      const area = b.width * b.height;
      if (area < bestArea) { best = b; bestArea = area; }
    }
  }
  return best;
}

export function generateUseCaseMermaid(data: UseCaseData): string {
  if (!data || (data.actors.length === 0 && data.useCases.length === 0)) return "";
  const lines = ["graph LR"];
  const boundaries = data.boundaries || [];
  if (boundaries.length > 0) {
    // Group use cases by containing boundary
    const grouped = new Map<string, UseCaseItem[]>();
    const uncontained: UseCaseItem[] = [];
    for (const uc of data.useCases) {
      const b = findContainingBoundary(uc, boundaries);
      if (b) {
        if (!grouped.has(b.id)) grouped.set(b.id, []);
        grouped.get(b.id)!.push(uc);
      } else {
        uncontained.push(uc);
      }
    }
    for (const b of boundaries) {
      lines.push(`  subgraph b_${b.id}["${sanitizeMermaidLabel(b.name)}"]`);
      for (const uc of (grouped.get(b.id) || [])) lines.push(`    uc_${uc.id}[${sanitizeMermaidLabel(uc.name)}]`);
      lines.push("  end");
    }
    for (const uc of uncontained) lines.push(`  uc_${uc.id}[${sanitizeMermaidLabel(uc.name)}]`);
  } else {
    for (const uc of data.useCases) lines.push(`  uc_${uc.id}[${sanitizeMermaidLabel(uc.name)}]`);
  }
  for (const a of data.actors) lines.push(`  actor_${a.id}([${sanitizeMermaidLabel(a.name)}])`);
  for (const c of data.connections) {
    const label = c.label ? ` -->|${sanitizeMermaidLabel(c.label)}|` : " -->";
    lines.push(`  actor_${c.actorId}${label} uc_${c.useCaseId}`);
  }
  if (data.relationships) {
    for (const r of data.relationships) {
      if (r.type === "association") {
        lines.push(`  uc_${r.fromUseCaseId} --> uc_${r.toUseCaseId}`);
      } else {
        lines.push(`  uc_${r.fromUseCaseId} -.->|<<${r.type}>>| uc_${r.toUseCaseId}`);
      }
    }
  }
  return lines.join("\n");
}

export function parseMermaidToUseCaseData(mermaid: string): UseCaseData {
  const actors: UseCaseActor[] = [];
  const useCases: UseCaseItem[] = [];
  const connections: UseCaseConnection[] = [];
  const relationships: UseCaseRelationship[] = [];
  const boundaries: SystemBoundary[] = [];
  const boundaryUcMap = new Map<string, string[]>(); // boundary id -> uc ids
  let currentBoundaryId: string | null = null;

  const lines = mermaid.split("\n").map(l => l.trim());
  for (const line of lines) {
    // Boundary: subgraph b_ID["Name"] or legacy subgraph boundary["Name"]
    const boundaryMatch = line.match(/^subgraph\s+(?:b_)?(\w+)\["(.+?)"\]/);
    if (boundaryMatch) {
      const id = boundaryMatch[1] === "boundary" ? crypto.randomUUID().slice(0, 8) : boundaryMatch[1];
      boundaries.push({ id, name: boundaryMatch[2], x: 0, y: 0, width: 500, height: 400 });
      currentBoundaryId = id;
      boundaryUcMap.set(id, []);
      continue;
    }
    if (line === "end") { currentBoundaryId = null; continue; }
    // Actor: actor_ID([Name])
    const actorMatch = line.match(/^actor_(\w+)\(\[(.+?)\]\)/);
    if (actorMatch) {
      actors.push({ id: actorMatch[1], name: actorMatch[2] });
      continue;
    }
    // Use case: uc_ID[Name]
    const ucMatch = line.match(/^uc_(\w+)\[(.+?)\]/);
    if (ucMatch) {
      useCases.push({ id: ucMatch[1], name: ucMatch[2] });
      if (currentBoundaryId) boundaryUcMap.get(currentBoundaryId)!.push(ucMatch[1]);
      continue;
    }
    // Connection: actor_ID -->|label| uc_ID  or  actor_ID --> uc_ID
    const connMatch = line.match(/^actor_(\w+)\s+-->(?:\|(.+?)\|)?\s*uc_(\w+)/);
    if (connMatch) {
      connections.push({ actorId: connMatch[1], useCaseId: connMatch[3], label: connMatch[2] || "" });
      continue;
    }
    // Relationship (dashed): uc_ID -.->|<<extend>>| uc_ID2
    const relMatch = line.match(/^uc_(\w+)\s+-\.->(?:\|<<(extend|include)>>\|)?\s*uc_(\w+)/);
    if (relMatch) {
      relationships.push({
        id: crypto.randomUUID().slice(0, 8),
        fromUseCaseId: relMatch[1],
        toUseCaseId: relMatch[3],
        type: (relMatch[2] as "extend" | "include" | "association") || "extend",
      });
      continue;
    }
    // Relationship (solid association): uc_ID --> uc_ID2
    const ucAssocMatch = line.match(/^uc_(\w+)\s+-->\s*uc_(\w+)/);
    if (ucAssocMatch) {
      relationships.push({
        id: crypto.randomUUID().slice(0, 8),
        fromUseCaseId: ucAssocMatch[1],
        toUseCaseId: ucAssocMatch[2],
        type: "association",
      });
      continue;
    }
  }

  // Auto-layout positions
  actors.forEach((a, i) => { a.x = 80; a.y = i * 120 + 100; });

  // Layout boundaries side by side
  boundaries.forEach((b, i) => {
    b.x = 200 + i * 550;
    b.y = 50;
    const ucIds = boundaryUcMap.get(b.id) || [];
    ucIds.forEach((ucId, j) => {
      const uc = useCases.find(u => u.id === ucId);
      if (uc) { uc.x = b.x + 60 + (j % 2) * 180; uc.y = b.y + 60 + Math.floor(j / 2) * 100; }
    });
  });

  // Layout uncontained use cases
  const containedIds = new Set([...boundaryUcMap.values()].flat());
  const uncontained = useCases.filter(uc => !containedIds.has(uc.id));
  const defaultX = boundaries.length > 0 ? 200 + boundaries.length * 550 : 280;
  uncontained.forEach((uc, i) => {
    if (uc.x == null || uc.x === 0) { uc.x = defaultX + (i % 2) * 180; uc.y = 80 + Math.floor(i / 2) * 100; }
  });

  return { actors, useCases, connections, relationships: relationships.length > 0 ? relationships : undefined, boundaries };
}

// ─── Deployment Diagram (reuses UseCaseData shape) ──────────────────

async function getDeploymentPath(userId: string, projectId: string): Promise<string> {
  return projectPaths.deployment(await resolveOwnerUserId(userId, projectId), projectId);
}

export async function getDeploymentData(userId: string, projectId: string): Promise<UseCaseData | null> {
  try {
    const data = await fs.readFile(await getDeploymentPath(userId, projectId), "utf-8");
    return migrateUseCaseData(JSON.parse(data));
  } catch {
    return null;
  }
}

export async function setDeploymentData(userId: string, projectId: string, data: UseCaseData): Promise<void> {
  const wsPath = await getWorkspacePath(userId, projectId);
  await atomicWriteJson(await getDeploymentPath(userId, projectId), data, 2);
  const mermaid = generateDeploymentMermaid(data);
  if (mermaid) {
    await fs.writeFile(path.join(wsPath, "deployment.md"), `# Deployment Diagram\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
  }
}

export function generateDeploymentMermaid(data: UseCaseData): string {
  return generateUseCaseMermaid(data);
}

export function parseMermaidToDeploymentData(mermaid: string): UseCaseData {
  return parseMermaidToUseCaseData(mermaid);
}

// ─── Component Diagram (reuses UseCaseData shape) ────────────────────

async function getComponentPath(userId: string, projectId: string): Promise<string> {
  return projectPaths.component(await resolveOwnerUserId(userId, projectId), projectId);
}

export async function getComponentData(userId: string, projectId: string): Promise<UseCaseData | null> {
  try {
    const data = await fs.readFile(await getComponentPath(userId, projectId), "utf-8");
    return migrateUseCaseData(JSON.parse(data));
  } catch {
    return null;
  }
}

export async function setComponentData(userId: string, projectId: string, data: UseCaseData): Promise<void> {
  const wsPath = await getWorkspacePath(userId, projectId);
  await atomicWriteJson(await getComponentPath(userId, projectId), data, 2);
  const mermaid = generateComponentMermaid(data);
  if (mermaid) {
    await fs.writeFile(path.join(wsPath, "component.md"), `# Component Diagram\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
  }
}

export function generateComponentMermaid(data: UseCaseData): string {
  return generateUseCaseMermaid(data);
}

export function parseMermaidToComponentData(mermaid: string): UseCaseData {
  return parseMermaidToUseCaseData(mermaid);
}

// ─── Activity Diagrams (multiple per project) ────────────────────────

export interface ActivityNode {
  id: string;
  type: "start" | "end" | "action" | "decision" | "fork" | "join";
  name: string;
  x: number;
  y: number;
}

export interface ActivityTransition {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
}

export interface ActivityDiagramData {
  id: string;
  name: string;
  nodes: ActivityNode[];
  transitions: ActivityTransition[];
}

interface ActivityDiagramIndexEntry {
  id: string;
  name: string;
}

async function getActivityIndexPath(userId: string, projectId: string): Promise<string> {
  return projectPaths.activityIndex(await resolveOwnerUserId(userId, projectId), projectId);
}

async function getActivityDiagramPath(userId: string, projectId: string, diagramId: string): Promise<string> {
  return projectPaths.activityDiagram(await resolveOwnerUserId(userId, projectId), projectId, diagramId);
}

export async function listActivityDiagrams(userId: string, projectId: string): Promise<ActivityDiagramIndexEntry[]> {
  try {
    const data = await fs.readFile(await getActivityIndexPath(userId, projectId), "utf-8");
    const index = JSON.parse(data);
    return index.diagrams || [];
  } catch {
    return [];
  }
}

async function saveActivityIndex(userId: string, projectId: string, diagrams: ActivityDiagramIndexEntry[]): Promise<void> {
  await atomicWriteJson(await getActivityIndexPath(userId, projectId), { diagrams }, 2);
}

export async function createActivityDiagram(userId: string, projectId: string, name: string): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8);
  const diagrams = await listActivityDiagrams(userId, projectId);
  diagrams.push({ id, name });
  await saveActivityIndex(userId, projectId, diagrams);
  const data: ActivityDiagramData = { id, name, nodes: [], transitions: [] };
  await atomicWriteJson(await getActivityDiagramPath(userId, projectId, id), data, 2);
  return id;
}

export async function deleteActivityDiagram(userId: string, projectId: string, diagramId: string): Promise<void> {
  const diagrams = await listActivityDiagrams(userId, projectId);
  await saveActivityIndex(userId, projectId, diagrams.filter(d => d.id !== diagramId));
  try {
    await fs.unlink(await getActivityDiagramPath(userId, projectId, diagramId));
  } catch { /* ignore */ }
  try {
    await fs.unlink(path.join(await getWorkspacePath(userId, projectId), `activity-${diagramId}.md`));
  } catch { /* ignore */ }
}

export async function renameActivityDiagram(userId: string, projectId: string, diagramId: string, newName: string): Promise<void> {
  const diagrams = await listActivityDiagrams(userId, projectId);
  const entry = diagrams.find(d => d.id === diagramId);
  if (entry) entry.name = newName;
  await saveActivityIndex(userId, projectId, diagrams);
  // Also update the diagram data file
  const data = await getActivityData(userId, projectId, diagramId);
  if (data) {
    data.name = newName;
    await setActivityData(userId, projectId, diagramId, data);
  }
}

export async function getActivityData(userId: string, projectId: string, diagramId: string): Promise<ActivityDiagramData | null> {
  try {
    const raw = await fs.readFile(await getActivityDiagramPath(userId, projectId, diagramId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setActivityData(userId: string, projectId: string, diagramId: string, data: ActivityDiagramData): Promise<void> {
  const wsPath = await getWorkspacePath(userId, projectId);
  await atomicWriteJson(await getActivityDiagramPath(userId, projectId, diagramId), data, 2);
  const mermaid = generateActivityMermaid(data);
  if (mermaid) {
    await fs.writeFile(path.join(wsPath, `activity-${diagramId}.md`), `# Activity Diagram: ${data.name}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
  }
}

export function generateActivityMermaid(data: ActivityDiagramData): string {
  if (!data.nodes.length) return "";
  const lines: string[] = ["stateDiagram-v2"];
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_ ]/g, "").trim();

  for (const node of data.nodes) {
    const sid = `s_${node.id}`;
    if (node.type === "start") {
      // [*] handled via transitions
    } else if (node.type === "end") {
      // [*] handled via transitions
    } else if (node.type === "action") {
      lines.push(`  state "${sanitize(node.name)}" as ${sid}`);
    } else if (node.type === "decision") {
      lines.push(`  state ${sid} <<choice>>`);
    } else if (node.type === "fork") {
      lines.push(`  state ${sid} <<fork>>`);
    } else if (node.type === "join") {
      lines.push(`  state ${sid} <<join>>`);
    }
  }

  for (const t of data.transitions) {
    const fromNode = data.nodes.find(n => n.id === t.fromNodeId);
    const toNode = data.nodes.find(n => n.id === t.toNodeId);
    if (!fromNode || !toNode) continue;
    const from = fromNode.type === "start" ? "[*]" : `s_${fromNode.id}`;
    const to = toNode.type === "end" ? "[*]" : `s_${toNode.id}`;
    if (t.label) {
      lines.push(`  ${from} --> ${to}: ${sanitize(t.label)}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  return lines.join("\n");
}

export function parseMermaidToActivityData(mermaid: string): ActivityDiagramData {
  const nodes: ActivityNode[] = [];
  const transitions: ActivityTransition[] = [];
  const idMap = new Map<string, string>(); // mermaid id -> our id
  let yOffset = 50;

  function ensureNode(mermaidId: string, type: ActivityNode["type"], name: string): string {
    if (idMap.has(mermaidId)) return idMap.get(mermaidId)!;
    const id = crypto.randomUUID().slice(0, 8);
    idMap.set(mermaidId, id);
    nodes.push({ id, type, name, x: 300, y: yOffset });
    yOffset += 80;
    return id;
  }

  const lines = mermaid.split("\n").map(l => l.trim());
  for (const line of lines) {
    // state "Name" as s_xxx
    const stateMatch = line.match(/^state\s+"(.+?)"\s+as\s+(\w+)/);
    if (stateMatch) {
      ensureNode(stateMatch[2], "action", stateMatch[1]);
      continue;
    }
    // state s_xxx <<choice>>
    const choiceMatch = line.match(/^state\s+(\w+)\s+<<choice>>/);
    if (choiceMatch) {
      ensureNode(choiceMatch[1], "decision", "");
      continue;
    }
    // state s_xxx <<fork>> or <<join>>
    const forkMatch = line.match(/^state\s+(\w+)\s+<<(fork|join)>>/);
    if (forkMatch) {
      ensureNode(forkMatch[1], forkMatch[2] as "fork" | "join", "");
      continue;
    }
    // Transitions: [*] --> s_xxx or s_xxx --> [*] or s_xxx --> s_yyy: label
    const transMatch = line.match(/^(\[\*\]|\w+)\s+-->\s+(\[\*\]|\w+)(?:\s*:\s*(.+))?/);
    if (transMatch) {
      const fromMid = transMatch[1];
      const toMid = transMatch[2];
      const label = transMatch[3]?.trim() || "";
      const fromId = fromMid === "[*]" ? ensureNode("__start__", "start", "") : (idMap.get(fromMid) || ensureNode(fromMid, "action", fromMid));
      const toId = toMid === "[*]" ? ensureNode("__end__", "end", "") : (idMap.get(toMid) || ensureNode(toMid, "action", toMid));
      transitions.push({ id: crypto.randomUUID().slice(0, 8), fromNodeId: fromId, toNodeId: toId, label: label || undefined });
    }
  }

  return { id: crypto.randomUUID().slice(0, 8), name: "Activity", nodes, transitions };
}

// ─── ER Diagrams ─────────────────────────────────────────────

export interface ERAttribute {
  name: string;
  type: string;
  pk?: boolean;
  fk?: boolean;
}

export interface EREntity {
  id: string;
  name: string;
  attributes: ERAttribute[];
  x: number;
  y: number;
}

export interface ERRelationship {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  fromCardinality: string;
  toCardinality: string;
  label?: string;
}

export interface ERDiagramData {
  id: string;
  name: string;
  entities: EREntity[];
  relationships: ERRelationship[];
}

interface ERDiagramIndexEntry {
  id: string;
  name: string;
}

async function getERIndexPath(userId: string, projectId: string): Promise<string> {
  return projectPaths.erIndex(await resolveOwnerUserId(userId, projectId), projectId);
}

async function getERDiagramPath(userId: string, projectId: string, diagramId: string): Promise<string> {
  return projectPaths.erDiagram(await resolveOwnerUserId(userId, projectId), projectId, diagramId);
}

export async function listERDiagrams(userId: string, projectId: string): Promise<ERDiagramIndexEntry[]> {
  try {
    const data = await fs.readFile(await getERIndexPath(userId, projectId), "utf-8");
    const index = JSON.parse(data);
    return index.diagrams || [];
  } catch {
    return [];
  }
}

async function saveERIndex(userId: string, projectId: string, diagrams: ERDiagramIndexEntry[]): Promise<void> {
  await atomicWriteJson(await getERIndexPath(userId, projectId), { diagrams }, 2);
}

export async function createERDiagram(userId: string, projectId: string, name: string): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8);
  const diagrams = await listERDiagrams(userId, projectId);
  diagrams.push({ id, name });
  await saveERIndex(userId, projectId, diagrams);
  const data: ERDiagramData = { id, name, entities: [], relationships: [] };
  await atomicWriteJson(await getERDiagramPath(userId, projectId, id), data, 2);
  return id;
}

export async function deleteERDiagram(userId: string, projectId: string, diagramId: string): Promise<void> {
  const diagrams = await listERDiagrams(userId, projectId);
  await saveERIndex(userId, projectId, diagrams.filter(d => d.id !== diagramId));
  try {
    await fs.unlink(await getERDiagramPath(userId, projectId, diagramId));
  } catch { /* ignore */ }
  try {
    await fs.unlink(path.join(await getWorkspacePath(userId, projectId), `er-${diagramId}.md`));
  } catch { /* ignore */ }
}

export async function renameERDiagram(userId: string, projectId: string, diagramId: string, newName: string): Promise<void> {
  const diagrams = await listERDiagrams(userId, projectId);
  const entry = diagrams.find(d => d.id === diagramId);
  if (entry) entry.name = newName;
  await saveERIndex(userId, projectId, diagrams);
  const data = await getERData(userId, projectId, diagramId);
  if (data) {
    data.name = newName;
    await setERData(userId, projectId, diagramId, data);
  }
}

export async function getERData(userId: string, projectId: string, diagramId: string): Promise<ERDiagramData | null> {
  try {
    const raw = await fs.readFile(await getERDiagramPath(userId, projectId, diagramId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setERData(userId: string, projectId: string, diagramId: string, data: ERDiagramData): Promise<void> {
  const wsPath = await getWorkspacePath(userId, projectId);
  await atomicWriteJson(await getERDiagramPath(userId, projectId, diagramId), data, 2);
  const mermaid = generateERMermaid(data);
  if (mermaid) {
    await fs.writeFile(path.join(wsPath, `er-${diagramId}.md`), `# ER Diagram: ${data.name}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
  }
}

export function generateERMermaid(data: ERDiagramData): string {
  if (!data.entities.length) return "";
  const lines: string[] = ["erDiagram"];
  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "").trim();

  for (const entity of data.entities) {
    const eName = sanitize(entity.name) || "Entity";
    if (entity.attributes.length > 0) {
      lines.push(`  ${eName} {`);
      for (const attr of entity.attributes) {
        const aType = sanitize(attr.type) || "string";
        const aName = sanitize(attr.name) || "field";
        const markers: string[] = [];
        if (attr.pk) markers.push("PK");
        if (attr.fk) markers.push("FK");
        lines.push(`    ${aType} ${aName}${markers.length ? " " + markers.join(",") : ""}`);
      }
      lines.push("  }");
    } else {
      lines.push(`  ${eName} {`);
      lines.push("  }");
    }
  }

  for (const rel of data.relationships) {
    const fromEntity = data.entities.find(e => e.id === rel.fromEntityId);
    const toEntity = data.entities.find(e => e.id === rel.toEntityId);
    if (!fromEntity || !toEntity) continue;
    const fromName = sanitize(fromEntity.name) || "Entity";
    const toName = sanitize(toEntity.name) || "Entity";
    const fromCard = cardinalityToMermaid(rel.fromCardinality, "left");
    const toCard = cardinalityToMermaid(rel.toCardinality, "right");
    const label = rel.label ? `"${rel.label}"` : '""';
    lines.push(`  ${fromName} ${fromCard}--${toCard} ${toName} : ${label}`);
  }

  return lines.join("\n");
}

function cardinalityToMermaid(card: string, side: "left" | "right"): string {
  // Mermaid ER notation: ||  exactly one, o|  zero or one, }|  one or more, }o  zero or more
  // Left side symbols read left-to-right, right side symbols read right-to-left
  switch (card) {
    case "1": return side === "left" ? "||" : "||";
    case "0..1": return side === "left" ? "|o" : "o|";
    case "1..*": return side === "left" ? "}|" : "|{";
    case "0..*": case "*": return side === "left" ? "}o" : "o{";
    default: return side === "left" ? "||" : "||";
  }
}

export function parseMermaidToERData(mermaid: string): ERDiagramData {
  const entities: EREntity[] = [];
  const relationships: ERRelationship[] = [];
  const entityMap = new Map<string, EREntity>();
  let xOffset = 100;

  function ensureEntity(name: string): EREntity {
    if (entityMap.has(name)) return entityMap.get(name)!;
    const entity: EREntity = { id: crypto.randomUUID().slice(0, 8), name, attributes: [], x: xOffset, y: 100 };
    xOffset += 300;
    entityMap.set(name, entity);
    entities.push(entity);
    return entity;
  }

  const lines = mermaid.split("\n").map(l => l.trim());
  let currentEntity: EREntity | null = null;

  for (const line of lines) {
    if (line === "erDiagram" || line === "" || line.startsWith("%%")) continue;

    // Entity block start: EntityName {
    const entityStart = line.match(/^([A-Za-z_]\w*)\s*\{/);
    if (entityStart) {
      currentEntity = ensureEntity(entityStart[1]);
      continue;
    }

    // Entity block end
    if (line === "}" && currentEntity) {
      currentEntity = null;
      continue;
    }

    // Attribute inside entity block: type name PK,FK
    if (currentEntity) {
      const attrMatch = line.match(/^(\w+)\s+(\w+)(?:\s+((?:PK|FK)(?:,(?:PK|FK))*))?$/);
      if (attrMatch) {
        const markers = attrMatch[3] ? attrMatch[3].split(",") : [];
        currentEntity.attributes.push({
          type: attrMatch[1],
          name: attrMatch[2],
          pk: markers.includes("PK") || undefined,
          fk: markers.includes("FK") || undefined,
        });
      }
      continue;
    }

    // Relationship: Entity1 ||--o{ Entity2 : "label"
    const relMatch = line.match(/^([A-Za-z_]\w*)\s+([|o}{]{2})--([|o}{]{2})\s+([A-Za-z_]\w*)\s*:\s*"?([^"]*)"?$/);
    if (relMatch) {
      const fromEntity = ensureEntity(relMatch[1]);
      const toEntity = ensureEntity(relMatch[4]);
      relationships.push({
        id: crypto.randomUUID().slice(0, 8),
        fromEntityId: fromEntity.id,
        toEntityId: toEntity.id,
        fromCardinality: mermaidToCardinality(relMatch[2], "left"),
        toCardinality: mermaidToCardinality(relMatch[3], "right"),
        label: relMatch[5]?.trim() || undefined,
      });
    }
  }

  return { id: crypto.randomUUID().slice(0, 8), name: "ER Diagram", entities, relationships };
}

function mermaidToCardinality(symbol: string, side: "left" | "right"): string {
  const s = symbol.trim();
  if (s === "||") return "1";
  if (side === "left") {
    if (s === "|o") return "0..1";
    if (s === "}|") return "1..*";
    if (s === "}o") return "0..*";
  } else {
    if (s === "o|") return "0..1";
    if (s === "|{") return "1..*";
    if (s === "o{") return "0..*";
  }
  return "1";
}

// ─── Requirements ────────────────────────────────────────────

export interface Requirement {
  id: string;
  title: string;
  description: string;
  type: "functional" | "non-functional";
  priority: "must" | "should" | "could" | "wont";
  status: "draft" | "approved" | "implemented" | "rejected" | "deferred";
  createdAt: string;
  updatedAt: string;
}

async function getRequirementsPath(userId: string, projectId: string): Promise<string> {
  return projectPaths.requirements(await resolveOwnerUserId(userId, projectId), projectId);
}

export async function getRequirements(userId: string, projectId: string): Promise<Requirement[]> {
  try {
    const raw = await fs.readFile(await getRequirementsPath(userId, projectId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function nextRequirementId(existing: Requirement[], type: "functional" | "non-functional"): string {
  const prefix = type === "functional" ? "FR" : "R";
  const re = new RegExp(`^${prefix}(\\d{5})$`);
  let max = 0;
  for (const r of existing) {
    const m = r.id.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(5, "0")}`;
}

export async function createRequirement(userId: string, projectId: string, data: Partial<Requirement>): Promise<Requirement> {
  const requirements = await getRequirements(userId, projectId);
  const now = new Date().toISOString();
  const type = data.type || "functional";
  const req: Requirement = {
    id: nextRequirementId(requirements, type),
    title: data.title || "",
    description: data.description || "",
    type,
    priority: data.priority || "should",
    status: data.status || "draft",
    createdAt: now,
    updatedAt: now,
  };
  requirements.push(req);
  await atomicWriteJson(await getRequirementsPath(userId, projectId), requirements, 2);
  return req;
}

export async function updateRequirement(userId: string, projectId: string, reqId: string, data: Partial<Requirement>): Promise<Requirement> {
  const requirements = await getRequirements(userId, projectId);
  const idx = requirements.findIndex(r => r.id === reqId);
  if (idx === -1) throw new Error("Requirement not found");
  const updated = { ...requirements[idx], ...data, id: reqId, updatedAt: new Date().toISOString() };
  requirements[idx] = updated;
  await atomicWriteJson(await getRequirementsPath(userId, projectId), requirements, 2);
  return updated;
}

export async function deleteRequirement(userId: string, projectId: string, reqId: string): Promise<void> {
  const requirements = await getRequirements(userId, projectId);
  await atomicWriteJson(await getRequirementsPath(userId, projectId), requirements.filter(r => r.id !== reqId), 2);
}

function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const lines = frontmatter.split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rawValue = m[2];
    const block = rawValue.match(/^([|>])([-+]?)\s*$/);
    if (block) {
      const folded = block[1] === ">";
      const chomp = block[2];
      const collected: string[] = [];
      let baseIndent = -1;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() === "") { collected.push(""); j++; continue; }
        const indented = next.match(/^( +)(.*)$/);
        if (!indented) break;
        const indent = indented[1].length;
        if (baseIndent < 0) baseIndent = indent;
        if (indent < baseIndent) break;
        collected.push(next.slice(baseIndent));
        j++;
      }
      while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
      let joined: string;
      if (folded) {
        const result: string[] = [];
        let buffer: string[] = [];
        for (const l of collected) {
          if (l === "") {
            if (buffer.length) { result.push(buffer.join(" ")); buffer = []; }
            result.push("");
          } else {
            buffer.push(l);
          }
        }
        if (buffer.length) result.push(buffer.join(" "));
        joined = result.join("\n");
      } else {
        joined = collected.join("\n");
      }
      if (chomp === "+") joined += "\n";
      out[key] = joined;
      i = j - 1;
    } else {
      let value = rawValue.trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  }
  return out;
}

export function parseSkillFrontmatter(content: string): { name: string; description: string; version: string; body: string } {
  // CRLF-tolerant: SKILL.md files cloned or zipped on Windows commonly carry
  // \r\n endings (git core.autocrlf), which a \n-only match would reject —
  // the skill would then look description-less and fail validation.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { name: "", description: "", version: "", body: content };
  const fields = parseFrontmatterFields(match[1]);
  return {
    name: fields.name ?? "",
    description: fields.description ?? "",
    version: fields.version ?? "",
    body: match[2],
  };
}

export function buildSkillMd(name: string, description: string, content: string): string {
  // Use yaml.stringify so multi-line descriptions / colons / brackets / quotes
  // produce valid YAML. pi-coding-agent parses frontmatter with `yaml.parse`
  // and silently rejects skills whose frontmatter throws or yields an empty
  // description; naked interpolation here was breaking user skills with
  // multi-line descriptions.
  const fm = yamlStringify({ name, description: description.trim() });
  return `---\n${fm}---\n${content}`;
}

export class SkillValidationError extends Error {
  code = "SKILL_VALIDATION";
  field: "name" | "description";
  constructor(field: "name" | "description", message: string) {
    super(message);
    this.field = field;
  }
}

// Mirror pi-coding-agent's validateName rules from
// node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js so we reject
// at create-time instead of producing skills the agent silently drops.
export function validateSkillInput(name: string, description: string): void {
  if (!name || !name.trim()) {
    throw new SkillValidationError("name", "Skill name is required");
  }
  if (name.length > 64) {
    throw new SkillValidationError("name", "Skill name must be 64 characters or fewer");
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new SkillValidationError("name", "Skill name must be lowercase letters, digits, and hyphens only");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    throw new SkillValidationError("name", "Skill name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    throw new SkillValidationError("name", "Skill name must not contain consecutive hyphens");
  }
  if (!description || !description.trim()) {
    throw new SkillValidationError("description", "Skill description is required");
  }
}

export async function listSkills(userId: string, projectId?: string): Promise<SkillMeta[]> {
  const dir = getSkillsDir(userId);
  console.log("[skills] listSkills called for userId:", userId, "dir:", dir);
  await fs.mkdir(dir, { recursive: true });
  await seedDefaultSkills(dir);
  const skills: SkillMeta[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    console.log("[skills] User skill dirs found:", dirs);
    const systemNames = await getSystemSkillNames();
    const repoMap = getSkillRepoMap();
    const userRepoMap = await getUserSkillRepos(userId);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const content = await fs.readFile(path.join(dir, entry.name, "SKILL.md"), "utf-8");
        const { name, description, version } = parseSkillFrontmatter(content);
        const isSystem = systemNames.includes(entry.name);
        const source = isSystem ? (await getSystemSkillSource(entry.name) ?? undefined) : undefined;
        // Repo-tracked user skills carry their version in the skill-repos
        // store, not in frontmatter (which would trip the system-skill prune).
        const userRepo = isSystem ? undefined : userRepoMap[entry.name];
        skills.push({
          name: name || entry.name,
          dirName: entry.name,
          description,
          version: version || userRepo?.version || "",
          system: isSystem,
          kind: isSystem ? "system" : "user",
          source,
          repoUrl: isSystem ? (source === "git" ? repoMap[entry.name] : undefined) : userRepo?.url,
          useTags: userRepo ? userRepo.useTags : undefined,
        });
      } catch (err) {
        console.log(`[skills]   ${entry.name}: failed to read SKILL.md:`, err);
      }
    }
  } catch (err) {
    console.warn("[skills] listSkills failed:", err);
  }

  // Project skills: delivered by the project template into <workspace>/.vca/skills.
  // Project-scoped, so they only surface when a projectId is supplied. On a name
  // collision with a user/system skill, the project skill wins for this project.
  if (projectId) {
    const projDir = projectPaths.projectTemplateSkillsDir(await resolveOwnerUserId(userId, projectId), projectId);
    try {
      const entries = await fs.readdir(projDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const content = await fs.readFile(path.join(projDir, entry.name, "SKILL.md"), "utf-8");
          const { name, description, version } = parseSkillFrontmatter(content);
          const idx = skills.findIndex(s => s.dirName === entry.name);
          if (idx !== -1) skills.splice(idx, 1); // project precedence on name collision
          skills.push({
            name: name || entry.name,
            dirName: entry.name,
            description,
            version,
            system: false,
            kind: "project",
            source: "template",
          });
        } catch (err) {
          console.log(`[skills]   project ${entry.name}: failed to read SKILL.md:`, err);
        }
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn(`[skills] listSkills: cannot enumerate ${projDir}`, err);
    }
  }

  console.log("[skills] Returning skills:", skills.map(s => `${s.name} (${s.kind || (s.system ? 'system' : 'user')})`));
  return skills;
}

export async function getSkill(userId: string, skillName: string): Promise<{ name: string; description: string; content: string; repoUrl?: string; useTags?: boolean } | null> {
  const filePath = path.join(getSkillsDir(userId), skillName, "SKILL.md");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const { name, description, body } = parseSkillFrontmatter(raw);
    // Surface the repo link + tag mode so the editor can show the source
    // settings for repo-tracked user skills.
    const repo = (await getUserSkillRepos(userId))[skillName];
    return {
      name: name || skillName,
      description,
      content: body,
      repoUrl: repo?.url,
      useTags: repo ? repo.useTags : undefined,
    };
  } catch {
    return null;
  }
}

export async function createSkill(userId: string, name: string, description: string, content: string): Promise<void> {
  validateSkillInput(name, description);
  const skillDir = path.join(getSkillsDir(userId), name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), buildSkillMd(name, description, content));
  await reloadSkillsForUser(userId);
}

export async function updateSkill(userId: string, name: string, description: string, content: string): Promise<void> {
  validateSkillInput(name, description);
  const skillDir = path.join(getSkillsDir(userId), name);
  // mkdir mirrors createSkill so an edit is create-or-update safe even if the
  // skill folder is missing (e.g. pruned by a sync race) — avoids a raw ENOENT.
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), buildSkillMd(name, description, content));
  await reloadSkillsForUser(userId);
}

export async function deleteSkill(userId: string, skillName: string): Promise<void> {
  const skillDir = path.join(getSkillsDir(userId), skillName);
  await fs.rm(skillDir, { recursive: true, force: true });
  await removeUserSkillRepo(userId, skillName);
  await reloadSkillsForUser(userId);
}

export async function reloadSkillsForUser(userId: string): Promise<void> {
  for (const [key, managed] of sessions) {
    if (managed.userId === userId) {
      // Per-session best-effort: one project's sync failure must not block the
      // user's other sessions from picking up the skill change.
      try {
        await syncProjectSkills(userId, managed.projectId);
        await managed.session.reload();
      } catch (err) {
        console.warn(`[skills] reload failed for session ${key}:`, err);
      }
    }
  }
}

export async function reseedAllSessions(): Promise<void> {
  for (const [key, managed] of sessions) {
    try {
      const skillsDir = getSkillsDir(managed.userId);
      await fs.mkdir(skillsDir, { recursive: true });
      await seedDefaultSkills(skillsDir);
      await syncProjectSkills(managed.userId, managed.projectId);
      await managed.session.reload();
    } catch (err) {
      console.warn(`[skills] reseed failed for session ${key}:`, err);
    }
  }
  console.log(`[skills] Reseeded ${sessions.size} active session(s)`);
}

// Per-project active skills
async function getActiveSkillsPath(userId: string, projectId: string): Promise<string> {
  return projectPaths.activeSkills(await resolveOwnerUserId(userId, projectId), projectId);
}

async function getProjectSkillsDir(userId: string, projectId: string): Promise<string> {
  return projectPaths.projectSkillsDir(await resolveOwnerUserId(userId, projectId), projectId);
}

export async function getActiveSkills(userId: string, projectId: string): Promise<string[]> {
  try {
    const data = await fs.readFile(await getActiveSkillsPath(userId, projectId), "utf-8");
    return JSON.parse(data);
  } catch {
    // Default (no saved selection yet): system skills and template-delivered
    // project skills are active; user skills must be opted in per project.
    const allSkills = await listSkills(userId, projectId);
    return allSkills.filter(s => s.system || s.kind === "project").map(s => s.name);
  }
}

export async function setActiveSkills(userId: string, projectId: string, skillNames: string[]): Promise<void> {
  await atomicWriteJson(await getActiveSkillsPath(userId, projectId), skillNames);
  await syncProjectSkills(userId, projectId);
  // Reload skills in every active chat session for this project.
  for (const managed of sessions.values()) {
    if (managed.userId === userId && managed.projectId === projectId) {
      await managed.session.reload();
    }
  }
}

async function syncProjectSkills(userId: string, projectId: string): Promise<void> {
  const activeNames = await getActiveSkills(userId, projectId);
  const ownerId = await resolveOwnerUserId(userId, projectId);
  const projectSkillsDir = projectPaths.projectSkillsDir(ownerId, projectId);
  const userSkillsDir = getSkillsDir(userId);
  const templateSkillsDir = projectPaths.projectTemplateSkillsDir(ownerId, projectId);

  // Build map: skill identifier (frontmatter name OR dir name) → absolute source dir.
  // User/system skills come from the user dir; template-delivered project skills
  // come from the workspace's .vca/skills and take precedence (overwrite) on a
  // name collision, so the template's copy wins for this project.
  const idToSrc = new Map<string, string>();
  const addSkillsFromDir = async (sourceDir: string, overwrite: boolean) => {
    let entries;
    try {
      entries = await fs.readdir(sourceDir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn(`[skills] sync: cannot enumerate ${sourceDir}`, err);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = path.join(sourceDir, entry.name);
      try {
        const content = await fs.readFile(path.join(src, "SKILL.md"), "utf-8");
        const { name } = parseSkillFrontmatter(content);
        const skillName = name || entry.name;
        if (overwrite || !idToSrc.has(skillName)) idToSrc.set(skillName, src);
        if (overwrite || !idToSrc.has(entry.name)) idToSrc.set(entry.name, src);
      } catch (err) {
        console.warn(`[skills] sync: unreadable SKILL.md at ${src}`, err);
      }
    }
  };
  await addSkillsFromDir(userSkillsDir, false);
  await addSkillsFromDir(templateSkillsDir, true);

  // Reconcile the project skills dir against the active set — never wipe it.
  // This runs on every session creation (i.e. every message send), and a full
  // rm/rebuild maximizes rmdir churn against exactly the filesystem that
  // handles it worst: on an SMB share (network WORKSPACES_ROOT) file deletes
  // are delete-on-close, so the rmdir of a just-emptied dir routinely fails
  // with EPERM long past rmRetry's budget and killed the whole message send.
  // In the steady state (active set unchanged) this performs no deletes and
  // no copies at all, so there is nothing left to fail.
  await fs.mkdir(projectSkillsDir, { recursive: true });

  // Desired on-disk state: dest dir basename → source dir.
  const desired = new Map<string, string>();
  for (const name of activeNames) {
    const src = idToSrc.get(name);
    if (!src) {
      console.warn(`[skills] sync: active skill "${name}" not found in user skills dir`);
      continue;
    }
    desired.set(path.basename(src), src);
  }

  // Remove skills that are no longer active (rare; best-effort). Unlink
  // SKILL.md first: if the dir removal is then denied by a lingering SMB
  // handle, the leftover dir no longer parses as a skill, the agent doesn't
  // load it, and the next sync retries the removal. No rename-aside — a
  // renamed dir still containing SKILL.md would keep loading as a skill.
  let currentEntries: import("fs").Dirent[] = [];
  try {
    currentEntries = await fs.readdir(projectSkillsDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[skills] sync: cannot enumerate ${projectSkillsDir}`, err);
  }
  for (const entry of currentEntries) {
    if (desired.has(entry.name)) continue;
    const stale = path.join(projectSkillsDir, entry.name);
    try {
      if (entry.isDirectory()) await fs.rm(path.join(stale, "SKILL.md"), { force: true }).catch(() => {});
      await rmRetry(stale, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[skills] sync: could not remove deactivated skill at ${stale} (will retry next sync):`, err);
    }
  }

  // Copy in missing or changed skills. "Changed" is detected by comparing
  // SKILL.md bytes — every edit flow (update_skill, the skills editor,
  // template sync) rewrites SKILL.md, so it doubles as the freshness marker
  // and keeps the steady state down to one small read per active skill.
  for (const [destName, src] of desired) {
    const dest = path.join(projectSkillsDir, destName);
    try {
      const [srcMd, destMd] = await Promise.all([
        fs.readFile(path.join(src, "SKILL.md")).catch(() => null),
        fs.readFile(path.join(dest, "SKILL.md")).catch(() => null),
      ]);
      if (srcMd && destMd && srcMd.equals(destMd)) continue; // up to date
      // Prefer an exact mirror (drop stale aux files), but if the share still
      // holds the dir, degrade to an overwrite copy rather than failing.
      await rmRetry(dest, { recursive: true, force: true }).catch(() => {});
      await fs.cp(src, dest, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[skills] sync: failed to copy skill from ${src} to ${dest}`, err);
    }
  }
}

export interface SkillLoadStatus {
  loaded: boolean;
  errors: string[];
}

// Returns per-skill-directory load status by asking pi-coding-agent's
// ResourceLoader what it actually loaded for this project. Used by the UI
// to surface skills that pi-coding-agent silently rejected (e.g., empty
// description, frontmatter parse error) so users can see WHY their skill
// isn't reaching the agent.
export async function getSkillLoadStatus(userId: string, projectId: string): Promise<Record<string, SkillLoadStatus>> {
  // Make sure projectSkillsDir reflects the latest .vca-active-skills.json.
  await syncProjectSkills(userId, projectId);
  const projectSkillsDir = await getProjectSkillsDir(userId, projectId);

  // Prefer the live session's loader so we report exactly what the agent
  // currently sees. Fall back to a transient loader if there's no session.
  let loader: DefaultResourceLoader | null = null;
  for (const managed of sessions.values()) {
    if (managed.userId === userId && managed.projectId === projectId) {
      loader = managed.resourceLoader;
      break;
    }
  }
  if (!loader) {
    loader = new DefaultResourceLoader({
      cwd: await getWorkspacePath(userId, projectId),
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory(),
      // Only getSkills() is consumed here — skip reading shared/global
      // context files entirely.
      noContextFiles: true,
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [projectSkillsDir],
    });
    await loader.reload();
  }

  const { skills, diagnostics } = loader.getSkills();
  const result: Record<string, SkillLoadStatus> = {};

  for (const s of skills) {
    const dirName = path.basename(path.dirname(s.filePath));
    result[dirName] = { loaded: true, errors: [] };
  }

  for (const d of diagnostics) {
    if (!d.path) continue;
    const dirName = d.path.endsWith("SKILL.md")
      ? path.basename(path.dirname(d.path))
      : path.basename(d.path);
    if (!result[dirName]) {
      result[dirName] = { loaded: false, errors: [] };
    }
    result[dirName].errors.push(d.message);
  }

  return result;
}

interface SSEClient {
  id: string;
  res: {
    write: (data: string) => boolean;
    on: (event: string, cb: () => void) => void;
  };
}

export interface ManagedSession {
  session: AgentSession;
  // The chat's session store (also reachable as session.sessionManager). The
  // display history is derived from ITS entry tree — never from
  // session.messages, which is the LLM context and loses everything a
  // compaction summarized away. See parseSessionMessages.
  sessionManager: SessionManager;
  resourceLoader: DefaultResourceLoader;
  sseClients: Map<string, SSEClient>;
  projectId: string;
  chatId: string;
  userId: string;
  workspacePath: string;
  pendingQuestions: Map<string, { resolve: (answer: string) => void; reject: (err: Error) => void }>;
  // Preview screenshot captures in flight, keyed by toolCallId. The
  // screenshot tool blocks on these; the browser resolves them by POSTing to
  // /projects/:id/screenshot-result (→ resolveScreenshotResult).
  pendingScreenshots: Map<string, { resolve: (result: ScreenshotClientResult) => void; reject: (err: Error) => void }>;
  userDisplayTexts: string[];
  // Display name of the user who submitted each user-role message, aligned by
  // userIdx (same mechanism as userDisplayTexts). Lets shared-project chats show
  // the actual submitter — not the current viewer — on every message.
  userAuthors: string[];
  // Reasoning effort (thinking level) this session was created with. Attached
  // to each assistant message so the chat can show model:reasoning.
  thinkingLevel?: string;
  // Set when the agent switches THIS chat's LLM profile mid-run via
  // set_llm_config (session-local — the deployment's active profile pointer is
  // untouched). Lets the sidebar profile switcher highlight the profile this
  // chat is actually running. Undefined ⇒ still on the deployment's active profile.
  activeProfileId?: string;
  // An LLM error from the current turn that hasn't been shown to the chat yet.
  // Buffered because a transient error may be auto-retried — it is only
  // surfaced to the chat if it turns out to be final (retries exhausted, or the
  // turn ending without a retry). See forwardAgentEvent / the prompt handler.
  pendingLlmError?: { message: string; status: string; code?: string };
  // vca-driven retry for failed compaction. The SDK does not retry the
  // summarization call (unlike normal agent turns), so a single transient
  // provider error fails compaction outright. We re-invoke session.compact()
  // with backoff before surfacing the error. `active` suppresses the per-attempt
  // error SSE so the chat only sees a final failure. See forwardAgentEvent.
  compactionRetry?: { attempts: number; active: boolean; timer?: NodeJS.Timeout };
  // The assistant message currently being streamed (not yet committed to
  // session.messages — the SDK only pushes it there at message_end). Captured
  // from message_start/message_update so a client that connects mid-turn (page
  // reload) can be sent a stream_resume snapshot and rebuild the live placeholder
  // instead of losing the partial text/thinking. Cleared at message_end/agent_end.
  streamingMessage?: Extract<AgentSessionEvent, { type: "message_start" }>["message"];
  currentMessageStartTime?: number;
}

type PersistedChatMessage = {
  role: string;
  content: any;
  ts?: string;
  author?: string;
  displayText?: string;
  // USD cost of this assistant message (pi's usage.cost.total) — the per-message
  // "delta" cost. Surfaced in the message meta row and the chat CSV export.
  costUsd?: number;
  // Model id / provider that produced this assistant message. Shown in the meta
  // row alongside the delta cost. Older messages predating this field lack it.
  model?: string;
  provider?: string;
  // Reasoning effort (thinking level) the session ran with, e.g. "medium" /
  // "high". Shown as model:reasoning in the meta row. Absent on older messages
  // and on SDK-healed history.
  reasoning?: string;
};

interface ProjectMetadata {
  id: string;
  name: string;
  createdAt: string;
  appTemplate?: string;
  // Persisted: id of the VIRTUAL folder this entry is filed under in the
  // viewer's project list (see project-folders.ts). Purely display metadata —
  // moving a project between folders never touches its on-disk location.
  // Absent/unknown id → shown at the top level. Per-user: link/transfer
  // targets build fresh entries, so assignments never leak across users.
  folderId?: string;
  isLink?: boolean;
  // Set on link entries: userId of the project's owner. Lets `listProjects`
  // dereference the live source name and `unlinkProject` find the inbound
  // links file to update.
  sourceUserId?: string;
  // Set on link entries when the source has been deleted/privatized — UI
  // can render the card as stale instead of crashing.
  staleSource?: boolean;
  // Owner-side: how many other users have linked this project. Computed by
  // `listProjects` from the owner's links.json; not persisted on the entry.
  inboundLinkCount?: number;
  // Link-entry only: display name of the source project's owner. Filled in
  // by `listProjects` from the source user's profile so the UI can label
  // linked projects with who they belong to. Not persisted on the entry.
  sourceDisplayName?: string;
  // Live deployment status, read from .vca-deploy.json by listProjects /
  // listPublicProjects. Not persisted on the entry.
  deployment?: {
    deployed: boolean;
    url?: string;
    deployedAt?: string;
    provider?: string;
    version?: string;
  };
  // Per-project settings read from project.yaml at list time. Always populated
  // with defaults so the frontend can render without additional fetches.
  settings?: ProjectSettings;
  // Lifetime LLM spend, read from .vca-cost.json by listProjects /
  // listPublicProjects (resolves through symlinks for linked projects).
  // Undefined when the project has never accrued cost. Not persisted on
  // the entry.
  cost?: { totalUsd: number; updatedAt?: string };
}

export interface ChatMetadata {
  id: string;
  name: string;
  createdAt: string;
}

// Session-related maps are keyed at chat granularity: `${userId}:${projectId}:${chatId}`.
// Project-level concerns (app process, deploy, git, diagrams) keep using
// `${userId}:${projectId}` — see `makeProjectKey`.
const sessions = new Map<string, ManagedSession>();
const pendingSSEClients = new Map<string, Map<string, SSEClient>>();
// In-flight getOrCreateSession promises keyed by chat-level key.
// Without this, two concurrent requests for the same chat both fall through
// the "not in `sessions`" branch and each run the full init (npm install, git
// clone, agent creation), overwriting each other in `sessions`.
const sessionCreationLocks = new Map<string, Promise<ManagedSession>>();

function makeSessionKey(userId: string, projectId: string, chatId: string): string {
  return `${userId}:${projectId}:${chatId}`;
}

export function makeProjectKey(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
}
// Serializes concurrent read-modify-write operations on each user's projects.json.
const projectListLocks = new Map<string, Promise<void>>();
// Serializes concurrent operations on each project's chats.json + chat-*.json
// files (migration, create/rename/delete). Keyed by `${userId}:${projectId}`.
const chatsIndexLocks = new Map<string, Promise<void>>();
// Serializes concurrent writes of an individual chat's message file. Per-chat
// so two chats in the same project don't block each other. Keyed by
// makeSessionKey(userId, projectId, chatId). Fire-and-forget message_end saves
// can land in any order from the event loop's perspective — the lock forces
// FIFO so the latest save observed by atomicWriteJson is the latest state.
const chatSaveLocks = new Map<string, Promise<void>>();
// Row-count baseline per chat (makeSessionKey) for saveChatMessagesToDisk's
// shrink guard, seeded lazily from the on-disk file. Chat history is
// append-only from the user's point of view — a save with fewer rows than the
// file means a bug upstream (the pre-fix compaction truncation was exactly
// that), so it is refused unless the caller explicitly allows shrinking
// (rollback, clear chat).
const chatSavedRowCounts = new Map<string, number>();
// Project-level prompt gate. At most one chat per project may have an agent
// prompt in flight, so concurrent agents in different chats can't race on
// workspace files, diagram .md writes, or shell commands. `count` refcounts
// same-chat re-entry (followUp prompts within one logical turn).
const projectPromptOwners = new Map<string, { chatId: string; startedAt: number; count: number }>();

// ─── Project lock (single-writer across users for shared projects) ───
// When a project is shared (symlinked into multiple recipients' workspaces),
// every user references the same physical directory. Without coordination,
// concurrent agent prompts, git ops, npm installs etc. would corrupt the
// workspace. This module keeps an in-memory holder per canonical project
// (keyed by the owner's userId + projectId). Acquisition is eager (on
// project open). Release is tied to the holder's SSE clients — when the
// last connection drops, a short grace period elapses before the lock is
// freed, so brief network blips don't cause flapping.
//
// In-memory only: vca runs as a single Container App instance, so a
// process restart drops all locks (acceptable — no live browser tabs
// survive a restart either). Horizontal scaling would need this moved
// to a shared store.

interface ProjectLockHolder {
  userId: string;
  displayName: string;
  email: string;
  acquiredAt: number;
  sseClientIds: Set<string>;
  releaseTimer: NodeJS.Timeout | null;
}

export interface PublicProjectLockHolder {
  userId: string;
  displayName: string;
  email: string;
  acquiredAt: number;
}

const projectLocks = new Map<string, ProjectLockHolder>();
const PROJECT_LOCK_GRACE_MS = 20 * 1000;
const PROJECT_LOCK_IDLE_MS = 30 * 60 * 1000;

function publicLockHolder(h: ProjectLockHolder): PublicProjectLockHolder {
  return { userId: h.userId, displayName: h.displayName, email: h.email, acquiredAt: h.acquiredAt };
}

export async function resolveCanonicalProjectKey(userId: string, projectId: string): Promise<{ ownerUserId: string; projectId: string; key: string }> {
  // Strict load: a transient read failure must surface as an error, NOT as
  // PROJECT_NOT_FOUND — resolveOwnerUserId falls back to the viewer only on
  // genuine not-found, and misclassifying a transient failure would silently
  // reroute a shared project's file I/O into the viewer's own directory.
  const projects = await loadProjectListStrict(userId);
  const entry = projects.find(p => p.id === projectId);
  if (!entry) {
    const err: any = new Error("Project not found in user's gallery");
    err.code = "PROJECT_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  const ownerUserId = entry.sourceUserId || userId;
  return { ownerUserId, projectId, key: `${ownerUserId}:${projectId}` };
}

// Resolve a viewer's access to a project to the physical OWNER's user id. Shared
// projects have no on-disk link — a recipient's file access must be redirected to
// the owner's real dir. For an owned project the owner IS the viewer; for a project
// not yet in the viewer's list (mid-creation) the viewer is the owner. This is the
// funnel that replaces the former workspace junction; keep it out of link/unlink/
// transfer, which operate on explicit per-user physical paths.
//
// Only PROJECT_NOT_FOUND falls back to the viewer. Anything else (a transient
// metadata read failure) rethrows: failing the operation loudly is always safer
// than writing a shared project's data into the wrong user's directory.
async function resolveOwnerUserId(viewerUserId: string, projectId: string): Promise<string> {
  try {
    return (await resolveCanonicalProjectKey(viewerUserId, projectId)).ownerUserId;
  } catch (err: any) {
    if (err?.code === "PROJECT_NOT_FOUND") return viewerUserId;
    throw err;
  }
}

export async function isProjectOwner(userId: string, projectId: string): Promise<boolean> {
  const projects = await loadProjectList(userId);
  const entry = projects.find(p => p.id === projectId);
  if (!entry) return false;
  return !entry.sourceUserId;
}

export async function acquireProjectLock(
  userId: string,
  displayName: string,
  email: string,
  projectId: string,
): Promise<{ ok: true; holder: PublicProjectLockHolder } | { ok: false; holder: PublicProjectLockHolder }> {
  const { key } = await resolveCanonicalProjectKey(userId, projectId);
  const existing = projectLocks.get(key);
  if (existing) {
    if (existing.userId === userId) {
      // Idempotent re-acquire (second tab, refresh, etc.).
      return { ok: true, holder: publicLockHolder(existing) };
    }
    return { ok: false, holder: publicLockHolder(existing) };
  }
  const holder: ProjectLockHolder = {
    userId,
    displayName: displayName || userId,
    email: email || "",
    acquiredAt: Date.now(),
    sseClientIds: new Set(),
    releaseTimer: null,
  };
  projectLocks.set(key, holder);
  return { ok: true, holder: publicLockHolder(holder) };
}

export async function releaseProjectLock(userId: string, projectId: string, opts: { force?: boolean } = {}): Promise<void> {
  let key: string;
  try {
    key = (await resolveCanonicalProjectKey(userId, projectId)).key;
  } catch {
    // projects.json may no longer list the entry (e.g. share was revoked).
    // Sweep any lock keyed by projectId whose holder is this user.
    for (const [k, holder] of projectLocks) {
      if (k.endsWith(`:${projectId}`) && holder.userId === userId) {
        if (holder.releaseTimer) clearTimeout(holder.releaseTimer);
        projectLocks.delete(k);
      }
    }
    return;
  }
  const existing = projectLocks.get(key);
  if (!existing) return;
  if (!opts.force && existing.userId !== userId) return;
  if (existing.releaseTimer) clearTimeout(existing.releaseTimer);
  projectLocks.delete(key);
}

export async function takeOverProjectLock(
  userId: string,
  displayName: string,
  email: string,
  projectId: string,
): Promise<{ ok: true; previousHolder: PublicProjectLockHolder | null }> {
  const owner = await isProjectOwner(userId, projectId);
  if (!owner) {
    const err: any = new Error("Only the project owner can take over the lock");
    err.code = "NOT_OWNER";
    err.status = 403;
    throw err;
  }
  const { key } = await resolveCanonicalProjectKey(userId, projectId);
  const existing = projectLocks.get(key);
  let previousHolder: PublicProjectLockHolder | null = null;
  if (existing) {
    if (existing.userId === userId) {
      return { ok: true, previousHolder: null };
    }
    previousHolder = publicLockHolder(existing);
    if (existing.releaseTimer) clearTimeout(existing.releaseTimer);
    // Abort any in-flight agent prompts the previous holder still has running
    // on this project so their writes don't overlap the new holder's work.
    const prevPrefix = `${existing.userId}:${projectId}:`;
    for (const sessionKey of sessions.keys()) {
      if (sessionKey.startsWith(prevPrefix)) {
        const [, , prevChatId] = sessionKey.split(":");
        abortSession(existing.userId, projectId, prevChatId).catch(() => {});
      }
    }
    try {
      broadcastSSEEvent(existing.userId, projectId, "lock_taken_over", {
        newHolder: { userId, displayName: displayName || userId, email: email || "" },
      });
    } catch { /* best-effort */ }
  }
  const next: ProjectLockHolder = {
    userId,
    displayName: displayName || userId,
    email: email || "",
    acquiredAt: Date.now(),
    sseClientIds: new Set(),
    releaseTimer: null,
  };
  projectLocks.set(key, next);
  return { ok: true, previousHolder };
}

export async function getProjectLockHolder(userId: string, projectId: string): Promise<PublicProjectLockHolder | null> {
  try {
    const { key } = await resolveCanonicalProjectKey(userId, projectId);
    const existing = projectLocks.get(key);
    return existing ? publicLockHolder(existing) : null;
  } catch {
    return null;
  }
}

// Distinct users who currently have a project open (hold a live lock). A lock in
// its grace window still counts; the idle sweep removes truly dead ones.
export function listActiveUsers(): Array<{ userId: string; displayName: string }> {
  const byUserId = new Map<string, { userId: string; displayName: string }>();
  for (const holder of projectLocks.values()) {
    if (!byUserId.has(holder.userId)) {
      byUserId.set(holder.userId, { userId: holder.userId, displayName: holder.displayName });
    }
  }
  return [...byUserId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );
}

export async function requireLockHeld(userId: string, projectId: string): Promise<void> {
  const { key } = await resolveCanonicalProjectKey(userId, projectId);
  const existing = projectLocks.get(key);
  if (!existing || existing.userId !== userId) {
    const err: any = new Error("This project is locked by another user");
    err.code = "PROJECT_LOCK_NOT_HELD";
    err.status = 409;
    err.holder = existing ? publicLockHolder(existing) : null;
    throw err;
  }
}

export async function attachSSEClientToLock(userId: string, projectId: string, sseClientId: string): Promise<void> {
  try {
    const { key } = await resolveCanonicalProjectKey(userId, projectId);
    const existing = projectLocks.get(key);
    if (existing && existing.userId === userId) {
      existing.sseClientIds.add(sseClientId);
      if (existing.releaseTimer) {
        clearTimeout(existing.releaseTimer);
        existing.releaseTimer = null;
      }
    }
  } catch { /* best-effort */ }
}

export async function detachSSEClientFromLock(userId: string, projectId: string, sseClientId: string): Promise<void> {
  try {
    const { key } = await resolveCanonicalProjectKey(userId, projectId);
    const existing = projectLocks.get(key);
    if (existing && existing.userId === userId) {
      existing.sseClientIds.delete(sseClientId);
      if (existing.sseClientIds.size === 0 && !existing.releaseTimer) {
        existing.releaseTimer = setTimeout(() => {
          const current = projectLocks.get(key);
          if (current && current === existing && current.sseClientIds.size === 0) {
            projectLocks.delete(key);
          }
        }, PROJECT_LOCK_GRACE_MS);
      }
    }
  } catch { /* best-effort */ }
}

// Defensive sweep: any lock that's been held longer than PROJECT_LOCK_IDLE_MS
// AND has no live SSE clients AND no pending release timer is orphaned. The
// grace-timer path normally catches everything; this is the safety net for
// pathological cases (e.g. SSE client never attached because the route
// raced with a process restart).
setInterval(() => {
  const now = Date.now();
  for (const [key, holder] of projectLocks) {
    if (holder.sseClientIds.size === 0 && !holder.releaseTimer && (now - holder.acquiredAt) > PROJECT_LOCK_IDLE_MS) {
      projectLocks.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

async function getWorkspacePath(userId: string, projectId: string): Promise<string> {
  return projectPaths.workspace(await resolveOwnerUserId(userId, projectId), projectId);
}

function getUserDir(userId: string): string {
  return userPaths.dir(userId);
}

function getMetadataPath(userId: string): string {
  return userPaths.projects(userId);
}

// ─── Userdata file manager ───────────────────────────────────

async function getUserdataRoot(userId: string, projectId: string): Promise<string> {
  const dir = path.resolve(await getWorkspacePath(userId, projectId), "userdata");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function validateRelativePath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error("Invalid path");
  }
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root)) {
    throw new Error("Invalid path");
  }
  return resolved;
}

export async function listUserdata(userId: string, projectId: string, relativePath: string): Promise<Array<{ name: string; type: string; size: number }>> {
  const root = await getUserdataRoot(userId, projectId);
  const target = validateRelativePath(root, relativePath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const result: Array<{ name: string; type: string; size: number }> = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const stat = await fs.stat(path.join(target, e.name));
    result.push({ name: e.name, type: e.isDirectory() ? "directory" : "file", size: stat.size });
  }
  result.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
  return result;
}

export async function uploadUserdata(userId: string, projectId: string, relativePath: string, fileName: string, buffer: Buffer): Promise<void> {
  const root = await getUserdataRoot(userId, projectId);
  const dir = validateRelativePath(root, relativePath);
  await fs.mkdir(dir, { recursive: true });
  const filePath = validateRelativePath(root, path.join(relativePath, fileName));
  await fs.writeFile(filePath, buffer);
}

// ─── App icon (per-project) ──────────────────────────────────
// The owner sets a square PNG "master" in project settings. Its presence is the
// whole state: readProjectSettings derives `hasIcon` from it, and deployment
// derives the Electron installer/app icon and the web favicon from it. The
// filename is a fixed constant (projectPaths.icon), so there is no user-supplied
// path segment to validate.

export async function readProjectIcon(userId: string, projectId: string): Promise<Buffer | null> {
  try {
    const ownerId = await resolveOwnerUserId(userId, projectId);
    return await fs.readFile(projectPaths.icon(ownerId, projectId));
  } catch {
    return null;
  }
}

export async function writeProjectIcon(userId: string, projectId: string, buffer: Buffer): Promise<void> {
  const ownerId = await resolveOwnerUserId(userId, projectId);
  await fs.mkdir(projectPaths.workspace(ownerId, projectId), { recursive: true });
  await fs.writeFile(projectPaths.icon(ownerId, projectId), buffer);
}

export async function deleteProjectIcon(userId: string, projectId: string): Promise<void> {
  const ownerId = await resolveOwnerUserId(userId, projectId);
  await fs.rm(projectPaths.icon(ownerId, projectId), { force: true });
}

export async function unzipUserdata(
  userId: string,
  projectId: string,
  relativePath: string,
): Promise<{ extractedTo: string; entryCount: number }> {
  const root = await getUserdataRoot(userId, projectId);
  const zipFilePath = validateRelativePath(root, relativePath);

  const parentRel = path.dirname(relativePath);
  const baseName = path.basename(relativePath, path.extname(relativePath));
  const join = (rel: string) => path.join(parentRel === "." ? "" : parentRel, rel);
  let targetRel = join(baseName);
  let attempt = 1;
  while (await pathExists(validateRelativePath(root, targetRel))) {
    targetRel = join(`${baseName}-${attempt++}`);
  }
  const targetAbs = validateRelativePath(root, targetRel);
  await fs.mkdir(targetAbs, { recursive: true });

  // execFile (no shell) + `--` sentinel: filenames cannot be parsed as flags or shell metacharacters.
  // Info-ZIP unzip rejects entries with absolute paths or `..` segments, and targetAbs is anchored
  // inside the project's userdata root via validateRelativePath.
  await execFileAsync("unzip", ["-o", "-q", "--", zipFilePath, "-d", targetAbs]);

  const entries = await fs.readdir(targetAbs);
  return { extractedTo: targetRel, entryCount: entries.length };
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

export async function mkdirUserdata(userId: string, projectId: string, relativePath: string): Promise<void> {
  const root = await getUserdataRoot(userId, projectId);
  const target = validateRelativePath(root, relativePath);
  await fs.mkdir(target, { recursive: true });
}

export async function renameUserdata(userId: string, projectId: string, relativePath: string, newName: string): Promise<void> {
  if (newName.includes("/") || newName.includes("\\") || newName.includes("..")) throw new Error("Invalid name");
  const root = await getUserdataRoot(userId, projectId);
  const oldPath = validateRelativePath(root, relativePath);
  const newPath = validateRelativePath(root, path.join(path.dirname(relativePath), newName));
  await fs.rename(oldPath, newPath);
}

export async function moveUserdata(userId: string, projectId: string, srcPath: string, destPath: string): Promise<void> {
  const root = await getUserdataRoot(userId, projectId);
  const src = validateRelativePath(root, srcPath);
  const dest = validateRelativePath(root, destPath);
  await fs.rename(src, dest);
}

export async function deleteUserdata(userId: string, projectId: string, relativePath: string): Promise<void> {
  const root = await getUserdataRoot(userId, projectId);
  const target = validateRelativePath(root, relativePath);
  if (target === root) throw new Error("Cannot delete root");
  await rmRetry(target, { recursive: true, force: true });
}

export async function downloadUserdataPath(userId: string, projectId: string, relativePath: string): Promise<string> {
  const root = await getUserdataRoot(userId, projectId);
  return validateRelativePath(root, relativePath);
}

// ─── Release folder (read-only browser for build/export artifacts) ───
// The `release/` dir is where electron-builder writes installers/artifacts
// (see renderElectronBuilderYml: directories.output = release) and where the
// static web export drops its zip / single-file HTML. Reuses the userdata
// path-traversal guard so browsing stays sandboxed to the folder.

async function getReleaseRoot(userId: string, projectId: string): Promise<string> {
  const dir = path.resolve(await getWorkspacePath(userId, projectId), "release");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function listRelease(userId: string, projectId: string, relativePath: string): Promise<Array<{ name: string; type: string; size: number }>> {
  const root = await getReleaseRoot(userId, projectId);
  const target = validateRelativePath(root, relativePath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const result: Array<{ name: string; type: string; size: number }> = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const stat = await fs.stat(path.join(target, e.name));
    result.push({ name: e.name, type: e.isDirectory() ? "directory" : "file", size: stat.size });
  }
  result.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
  return result;
}

export async function downloadReleasePath(userId: string, projectId: string, relativePath: string): Promise<string> {
  const root = await getReleaseRoot(userId, projectId);
  return validateRelativePath(root, relativePath);
}

// Absolute path of the release root — used by the Electron "open in OS file
// explorer" route.
export async function getReleaseDir(userId: string, projectId: string): Promise<string> {
  return getReleaseRoot(userId, projectId);
}

// ─── Project list ────────────────────────────────────────────

async function withProjectListLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectListLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  projectListLocks.set(userId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (projectListLocks.get(userId) === next) {
      projectListLocks.delete(userId);
    }
  }
}

async function withChatsIndexLock<T>(userId: string, projectId: string, fn: () => Promise<T>): Promise<T> {
  const key = makeProjectKey(userId, projectId);
  const prev = chatsIndexLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  chatsIndexLocks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chatsIndexLocks.get(key) === next) {
      chatsIndexLocks.delete(key);
    }
  }
}

async function withChatSaveLock<T>(userId: string, projectId: string, chatId: string, fn: () => Promise<T>): Promise<T> {
  const key = makeSessionKey(userId, projectId, chatId);
  const prev = chatSaveLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  chatSaveLocks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chatSaveLocks.get(key) === next) {
      chatSaveLocks.delete(key);
    }
  }
}

// Atomically claim the project's prompt slot for `chatId`. Synchronous: no
// awaits between check and claim, so two concurrent callers can't both pass.
// Returns false if a different chat already owns the slot. Same-chat callers
// refcount, so followUp prompts within one logical turn don't double-release.
function tryClaimProjectPromptSlot(userId: string, projectId: string, chatId: string): boolean {
  const projectKey = makeProjectKey(userId, projectId);
  const owner = projectPromptOwners.get(projectKey);
  if (owner) {
    if (owner.chatId !== chatId) return false;
    owner.count++;
    return true;
  }
  projectPromptOwners.set(projectKey, { chatId, startedAt: Date.now(), count: 1 });
  return true;
}

function releaseProjectPromptSlot(userId: string, projectId: string, chatId: string): void {
  const projectKey = makeProjectKey(userId, projectId);
  const owner = projectPromptOwners.get(projectKey);
  if (!owner || owner.chatId !== chatId) return;
  owner.count--;
  if (owner.count <= 0) {
    projectPromptOwners.delete(projectKey);
  }
}

export function getProjectActiveChatId(userId: string, projectId: string): string | null {
  const owner = projectPromptOwners.get(makeProjectKey(userId, projectId));
  return owner ? owner.chatId : null;
}

async function loadProjectList(userId: string): Promise<ProjectMetadata[]> {
  try {
    const data = await fs.readFile(getMetadataPath(userId), "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Strict variant for owner resolution (resolveCanonicalProjectKey). Unlike
// loadProjectList — which treats any failure as "no projects", fine for
// listings — this distinguishes "file doesn't exist" (a real empty gallery)
// from a transient read failure (e.g. a Windows sharing violation while
// atomicWriteJson swaps the file). The Windows lock codes get a short retry;
// anything else throws, because callers use the result to route file I/O and
// a wrong answer writes into the wrong user's directory.
async function loadProjectListStrict(userId: string): Promise<ProjectMetadata[]> {
  const delays = [30, 100, 250];
  for (let i = 0; ; i++) {
    try {
      const data = await fs.readFile(getMetadataPath(userId), "utf-8");
      return JSON.parse(data);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      const transient = err?.code === "EPERM" || err?.code === "EACCES" || err?.code === "EBUSY";
      if (!transient || i >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

async function saveProjectList(userId: string, projects: ProjectMetadata[]): Promise<void> {
  await fs.mkdir(getUserDir(userId), { recursive: true });
  await atomicWriteJson(getMetadataPath(userId), projects, 2);
}

// ─── Inbound links (per project owner) ────────────────────────
// One file per owner: <userDir>/links.json shaped as
//   { "<projectId>": [ { userId, linkedAt } ] }
// Tracks who has linked each owned project. Display names are NOT stored
// — they're resolved from Microsoft Graph at read time.

export interface InboundLinkEntry {
  userId: string;
  linkedAt: string;
}

type InboundLinksFile = Record<string, InboundLinkEntry[]>;

const inboundLinksLocks = new Map<string, Promise<void>>();

async function withInboundLinksLock<T>(ownerUserId: string, fn: () => Promise<T>): Promise<T> {
  const prev = inboundLinksLocks.get(ownerUserId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  inboundLinksLocks.set(ownerUserId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (inboundLinksLocks.get(ownerUserId) === next) {
      inboundLinksLocks.delete(ownerUserId);
    }
  }
}

function getInboundLinksPath(ownerUserId: string): string {
  return userPaths.links(ownerUserId);
}

async function loadInboundLinks(ownerUserId: string): Promise<InboundLinksFile> {
  try {
    const data = await fs.readFile(getInboundLinksPath(ownerUserId), "utf-8");
    const parsed = JSON.parse(data);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    return {};
  }
}

async function saveInboundLinks(ownerUserId: string, links: InboundLinksFile): Promise<void> {
  await fs.mkdir(getUserDir(ownerUserId), { recursive: true });
  await atomicWriteJson(getInboundLinksPath(ownerUserId), links, 2);
}

// Tool results can carry image blocks (e.g. the screenshot tool) whose base64
// payload would push megabytes to every SSE client on tool_end — and the
// frontend never renders it. Returns a copy with image data blanked; never
// mutates the original, which pi keeps in the session history for the LLM.
function sanitizeToolResultForSSE<T extends { content?: unknown } | undefined>(result: T): T {
  if (!result || !Array.isArray((result as { content?: unknown }).content)) return result;
  const content = (result as { content: Array<Record<string, unknown>> }).content;
  if (!content.some((block) => block?.type === "image")) return result;
  return {
    ...result,
    content: content.map((block) =>
      block?.type === "image" ? { type: "image", mimeType: block.mimeType, data: "", omitted: true } : block,
    ),
  };
}

export function sendSSEEvent(managed: ManagedSession, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of managed.sseClients.entries()) {
    try {
      client.res.write(payload);
    } catch {
      managed.sseClients.delete(id);
    }
  }
}

export function broadcastSSEEvent(userId: string, projectId: string, event: string, data: unknown): void {
  // Project-scoped events (deploy, project-init logs, files_changed) need to
  // reach every chat's SSE clients in the project, plus any pending clients
  // waiting for sessions to be created.
  const projectPrefix = `${makeProjectKey(userId, projectId)}:`;
  for (const [key, managed] of sessions) {
    if (key.startsWith(projectPrefix)) {
      sendSSEEvent(managed, event, data);
    }
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [key, pending] of pendingSSEClients) {
    if (!key.startsWith(projectPrefix)) continue;
    for (const [id, client] of pending.entries()) {
      try {
        client.res.write(payload);
      } catch {
        pending.delete(id);
      }
    }
  }
}

async function readVcaHook(
  workspacePath: string,
  kind: "setup" | "instructions",
): Promise<string | null> {
  try {
    const content = (await fs.readFile(path.join(workspacePath, ".vca", `project-${kind}.md`), "utf-8")).trim();
    return content || null;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** True when an HTTP status (number or string) is 401/403. */
function isAuthErrorStatus(status: unknown): boolean {
  return status === 401 || status === 403 || status === "401" || status === "403";
}

/** Heuristic: detect auth-shaped errors when no numeric status is available
 *  (e.g. inside a streamed assistant message with stopReason=error). */
function looksLikeAuthMessage(message: string | undefined): boolean {
  if (!message) return false;
  // The last four shapes are ChatGPT/Codex OAuth failures: pi reports a
  // missing/unrefreshable token as "No API key for provider: openai-codex",
  // resolveLlmModel throws "Not signed in with ChatGPT", and the backend/
  // token endpoint answer with token_expired / invalid_grant.
  return /\b(401|403|unauthorized|forbidden|authentication\s+(?:failed|required|error)|no api key for provider|not signed in with chatgpt|token_expired|invalid_grant)\b/i.test(message);
}

/**
 * Split auth-shaped LLM failures into actionable error bubbles — never the VCA
 * session-expired reconnect modal. No LLM provider derives its credential from
 * the VCA/Entra user session (providers use an env key, a static admin apiKey,
 * or a provider OAuth store), so an LLM 401/403 never means the VCA session
 * expired. openai-codex gets a "sign in with ChatGPT" message
 * (CODEX_AUTH_REQUIRED); every other provider gets LLM_AUTH_ERROR (bad key,
 * wrong endpoint, or a model not available for the subscription). Both codes
 * drive an actionable assistant bubble in the SPA. Also rewrites pi's
 * misleading "No API key for provider: openai-codex" (its token refresh
 * failed and the real error was swallowed) into what the user must do.
 */
function classifyLlmError(
  provider: string | undefined,
  message: string,
  authShaped: boolean = looksLikeAuthMessage(message),
): { message: string; code?: string } {
  // A post-compaction continuation the pi SDK can't resume (the rebuilt context
  // ends on an assistant message). The compaction itself already succeeded and
  // the session is healthy — surface a calm notice, not a red "LLM error". See
  // agent.continue() in @earendil-works/pi-agent-core. Checked before the
  // authShaped gate because this message isn't auth-shaped.
  if (/Cannot continue from message role/i.test(message)) {
    return {
      code: "CONTEXT_COMPACTED",
      message: "Your conversation was compressed to free up context space.",
    };
  }
  if (!authShaped) return { message };
  if (provider === "openai-codex") {
    // resolveLlmModel's own message is already actionable — keep it verbatim.
    if (/not signed in with chatgpt/i.test(message)) return { message, code: "CODEX_AUTH_REQUIRED" };
    return {
      code: "CODEX_AUTH_REQUIRED",
      message: `Your ChatGPT sign-in has expired or was revoked. Open Settings → AI Model Config and sign in with ChatGPT again. (${message})`,
    };
  }
  return {
    code: "LLM_AUTH_ERROR",
    message:
      `The AI provider rejected this request. The selected model may be unavailable ` +
      `for your API key or subscription, or the key/endpoint is incorrect. ` +
      `Open Settings → AI Model Config to switch models or update the credentials. (${message})`,
  };
}

/** Extract detailed error info from any error, including the .cause chain */
function formatErrorDetail(err: any): string {
  const parts: string[] = [];

  // Error class name
  const name = err?.constructor?.name || err?.name || "Error";
  parts.push(`type=${name}`);

  // HTTP status (Anthropic APIError)
  if (err?.status != null) parts.push(`status=${err.status}`);

  // Request ID (Anthropic APIError)
  if (err?.requestID) parts.push(`requestId=${err.requestID}`);

  // Response body (Anthropic APIError .error is the parsed JSON body)
  if (err?.error && typeof err.error === "object") {
    try { parts.push(`body=${JSON.stringify(err.error)}`); } catch { /* skip */ }
  }

  // Message
  const msg = err?.message || String(err);
  parts.push(`message=${msg}`);

  // Cause chain (APIConnectionError wraps the real error in .cause)
  if (err?.cause) {
    const cause = err.cause;
    const causeName = cause?.constructor?.name || cause?.name || "Error";
    const causeMsg = cause?.message || String(cause);
    parts.push(`cause=${causeName}: ${causeMsg}`);
    if (cause?.code) parts.push(`causeCode=${cause.code}`);
    if (cause?.errno) parts.push(`causeErrno=${cause.errno}`);
    // syscall-level info (e.g. ECONNREFUSED, ENOTFOUND)
    if (cause?.syscall) parts.push(`syscall=${cause.syscall}`);
    if (cause?.hostname) parts.push(`hostname=${cause.hostname}`);
    if (cause?.port) parts.push(`port=${cause.port}`);
    // Nested cause (e.g. fetch → TypeError → socket error)
    if (cause?.cause) {
      const inner = cause.cause;
      parts.push(`innerCause=${inner?.constructor?.name || "Error"}: ${inner?.message || String(inner)}`);
      if (inner?.code) parts.push(`innerCode=${inner.code}`);
    }
  }

  return parts.join(", ");
}

function emitContextUsage(managed: ManagedSession): void {
  const usage = managed.session.getContextUsage();
  if (usage) {
    sendSSEEvent(managed, "context_usage", {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: usage.percent,
    });
  }
}

// Compaction summarization has no retry inside the SDK. We re-attempt it a few
// times with exponential backoff before giving up. Delays are indexed by the
// upcoming attempt number (1-based).
const MAX_COMPACTION_RETRIES = 3;
const COMPACTION_RETRY_DELAYS_MS = [1_000, 3_000, 7_000];

function compactionRetryDelay(attempt: number): number {
  const base = COMPACTION_RETRY_DELAYS_MS[Math.min(attempt, COMPACTION_RETRY_DELAYS_MS.length) - 1];
  // Small jitter so concurrent sessions don't retry in lockstep.
  return base + Math.floor(Math.random() * 500);
}

// Schedule another compaction attempt after a backoff. The resulting
// compaction_end event re-enters forwardAgentEvent, which counts the attempt
// and decides whether to retry again or surface a final error.
function scheduleCompactionRetry(managed: ManagedSession): void {
  const state = managed.compactionRetry;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  const delay = compactionRetryDelay(state.attempts);
  console.warn(`[LLM] Compaction failed — retry ${state.attempts}/${MAX_COMPACTION_RETRIES} in ${delay}ms`);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (!managed.compactionRetry?.active) return;
    // Don't compact while a turn is streaming or another compaction is running;
    // try again shortly.
    if (managed.session.isStreaming || managed.session.isCompacting) {
      scheduleCompactionRetry(managed);
      return;
    }
    // session.compact() emits its own compaction_start / compaction_end events,
    // which flow back through forwardAgentEvent and drive the loop. The throw is
    // already represented by that error event, so swallow it here.
    void managed.session.compact().catch(() => { /* surfaced via compaction_end */ });
  }, delay);
}

// Cancel any in-flight compaction retry sequence (e.g. a new turn started).
function clearCompactionRetry(managed: ManagedSession): void {
  if (managed.compactionRetry?.timer) clearTimeout(managed.compactionRetry.timer);
  managed.compactionRetry = undefined;
}

function forwardAgentEvent(managed: ManagedSession, event: AgentSessionEvent): void {
  switch (event.type) {
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        sendSSEEvent(managed, "text_delta", { delta: ame.delta });
      } else if (ame.type === "thinking_delta") {
        sendSSEEvent(managed, "thinking_delta", { delta: ame.delta });
      }
      if ((event.message as any)?.role === "assistant") {
        managed.streamingMessage = event.message;
      }
      break;
    }
    case "message_start": {
      const isAssistant = (event.message as any)?.role === "assistant";
      if (isAssistant) {
        managed.currentMessageStartTime = Date.now();
        managed.streamingMessage = event.message;
      }
      sendSSEEvent(managed, "message_start", isAssistant ? { startTime: managed.currentMessageStartTime } : {});
      break;
    }
    case "message_end": {
      const msg = event.message as any;
      managed.streamingMessage = undefined;
      managed.currentMessageStartTime = undefined;
      sendSSEEvent(managed, "message_end", {
        endTime: Date.now(),
        usage: msg?.usage ? { input: msg.usage.input, output: msg.usage.output, costUsd: msg.usage.cost?.total } : null,
        model: msg?.model,
        provider: msg?.provider,
        reasoning: managed.thinkingLevel,
      });
      emitContextUsage(managed);
      // Lifetime spend accounting. Fire-and-forget so streaming never blocks.
      // Failed retry attempts (stopReason=error) flow through here too and are
      // counted by design — their tokens were consumed.
      if (msg?.role === "assistant" && Number.isFinite(msg?.usage?.cost?.total)) {
        void addProjectCost(managed.workspacePath, msg.usage.cost.total, {
          input: msg.usage.input,
          output: msg.usage.output,
          cacheRead: msg.usage.cacheRead,
          cacheWrite: msg.usage.cacheWrite,
        }, {
          input: msg.usage.cost.input,
          output: msg.usage.cost.output,
          cacheRead: msg.usage.cost.cacheRead,
          cacheWrite: msg.usage.cost.cacheWrite,
        }, msg.model, msg.provider).then((state) => {
          broadcastSSEEvent(managed.userId, managed.projectId, "project_cost", {
            totalUsd: state.totalUsd,
            tokens: state.tokens,
          });
        }).catch((err) => {
          console.error(`[cost] accumulate failed — projectId=${managed.projectId}:`, err);
        });
      }
      // Buffer LLM errors rather than forwarding them straight to the chat: a
      // transient failure (overloaded/rate-limit/5xx/connection) is auto-retried
      // by the SDK, which emits message_end(stopReason=error) for EACH failed
      // attempt before deciding to retry. We only want the chat to show an error
      // if it's final, so we stash it and let auto_retry_start (retrying → drop)
      // or auto_retry_end(success=false) / turn-end (final → surface) decide.
      // Tag auth-shaped failures with a code so the SPA can show the right
      // recovery flow (Entra reconnect vs ChatGPT re-sign-in) instead of a
      // misleading red "LLM error" bubble.
      if (msg?.stopReason === "error" && msg?.errorMessage) {
        console.error(`[LLM] Assistant message error — stopReason=error, errorMessage=${msg.errorMessage}`);
        const classified = classifyLlmError(managed.session.model?.provider, msg.errorMessage);
        managed.pendingLlmError = { message: classified.message, status: "error", ...(classified.code ? { code: classified.code } : {}) };
      }
      break;
    }
    case "tool_execution_start":
      sendSSEEvent(managed, "tool_start", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      break;
    case "tool_execution_update":
      sendSSEEvent(managed, "tool_update", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: sanitizeToolResultForSSE(event.partialResult),
      });
      break;
    case "tool_execution_end":
      sendSSEEvent(managed, "tool_end", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        result: sanitizeToolResultForSSE(event.result),
      });
      break;
    case "agent_end":
      managed.streamingMessage = undefined;
      managed.currentMessageStartTime = undefined;
      sendSSEEvent(managed, "agent_end", {});
      break;
    case "agent_start":
      sendSSEEvent(managed, "agent_start", {});
      break;
    case "compaction_start":
      sendSSEEvent(managed, "compaction_start", {});
      break;
    case "compaction_end": {
      const compactionError = event.errorMessage;
      if (!compactionError) {
        // Success (possibly after one or more vca-driven retries).
        clearCompactionRetry(managed);
        sendSSEEvent(managed, "compaction_end", { error: null });
        // Persist the new compaction marker row now — a manual compact has no
        // following message_end to flush it (serialized via chatSaveLocks).
        void saveChatMessagesToDisk(managed.userId, managed.projectId, managed.chatId, parseSessionMessages(managed));
        emitContextUsage(managed);
        break;
      }
      if (event.aborted) {
        // User-cancelled — never retry, report as-is.
        clearCompactionRetry(managed);
        sendSSEEvent(managed, "compaction_end", { error: compactionError });
        emitContextUsage(managed);
        break;
      }
      console.error(`[LLM] Compaction error — ${compactionError}`);
      const retry = managed.compactionRetry ?? { attempts: 0, active: false };
      if (retry.attempts < MAX_COMPACTION_RETRIES) {
        retry.attempts += 1;
        retry.active = true;
        managed.compactionRetry = retry;
        // Suppress the per-attempt error; tell the UI we're retrying instead.
        sendSSEEvent(managed, "compaction_retry", { attempt: retry.attempts, maxAttempts: MAX_COMPACTION_RETRIES });
        scheduleCompactionRetry(managed);
      } else {
        // Retries exhausted — surface a final, actionable failure.
        console.error(`[LLM] Compaction failed after ${retry.attempts} retries — giving up`);
        clearCompactionRetry(managed);
        sendSSEEvent(managed, "compaction_end", { error: compactionError, final: true });
        emitContextUsage(managed);
      }
      break;
    }
    case "auto_retry_start":
      // The buffered error is being retried, so it isn't final — drop it so it
      // never reaches the chat unless the retries ultimately fail.
      managed.pendingLlmError = undefined;
      sendSSEEvent(managed, "retry_start", { attempt: event.attempt, maxAttempts: event.maxAttempts });
      console.error(`[LLM] Retry attempt ${event.attempt}/${event.maxAttempts} — ${event.errorMessage}`);
      break;
    case "auto_retry_end":
      sendSSEEvent(managed, "retry_end", { success: event.success });
      if (event.success) {
        // Recovered — discard any buffered error from the failed attempts.
        managed.pendingLlmError = undefined;
      } else {
        // Retries exhausted — now it's final, so surface it to the chat. A
        // buffered error was already classified when it was stashed; a raw
        // finalError gets classified here.
        console.error(`[LLM] All ${event.attempt} retry attempts exhausted — ${event.finalError}`);
        const buffered = managed.pendingLlmError;
        const classified = buffered?.code
          ? { message: buffered.message, code: buffered.code }
          : classifyLlmError(managed.session.model?.provider, event.finalError || buffered?.message || "LLM request failed after retries");
        sendSSEEvent(managed, "error", { message: classified.message, status: buffered?.status ?? "error", ...(classified.code ? { code: classified.code } : {}) });
        managed.pendingLlmError = undefined;
      }
      break;
  }
}

export type DeploymentOption = "" | "electron" | "git-tag" | "web-export";

/** Mirrors the template-level appType flag: "web" = pure client-side app. */
export type ProjectAppType = "node" | "web";

export interface ProjectSettings {
  deploymentOption: DeploymentOption;
  // Version control: the chosen global VCS profile + this project's repo URL
  // (both persisted in project.yaml — non-secret), plus an optional per-project
  // credential override (username persisted in .vca-vcs.json; the PAT is stored
  // there encrypted and only ever surfaced as the redaction sentinel).
  vcsProfileId: string;
  repoUrl: string;
  vcsOverrideUsername: string;
  vcsOverridePat: string; // read: sentinel|""; write: sentinel(keep)|new|""(clear)
  // Derived (not persisted in project.yaml): true when a .vca-icon.png master
  // exists in the workspace. Surfaced to the gallery via listProjects so a row
  // can render the custom icon instead of the default folder glyph.
  hasIcon?: boolean;
  // Read-only, from project.yaml's app_type (stamped at creation from the
  // template's appType flag). Gates the "web-export" deployment option.
  appType?: ProjectAppType;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  deploymentOption: "",
  vcsProfileId: "",
  repoUrl: "",
  vcsOverrideUsername: "",
  vcsOverridePat: "",
};

interface ProjectYamlData {
  applicationName: string;
  applicationUuid: string;
  creatorEmail: string;
  appType?: ProjectAppType;
  deploymentOption?: DeploymentOption;
  vcsProfileId?: string;
  repoUrl?: string;
}

function renderProjectYaml(data: ProjectYamlData): string {
  const esc = (s: string) => `"${(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  let yaml =
    `application_name: ${esc(data.applicationName)}\n` +
    `application_uuid: ${esc(data.applicationUuid)}\n` +
    `creator_email: ${esc(data.creatorEmail)}\n`;
  // "node" is the implicit default — only the web flag is persisted.
  if (data.appType === "web") yaml += `app_type: ${esc("web")}\n`;
  if (data.deploymentOption) yaml += `deployment_option: ${esc(data.deploymentOption)}\n`;
  // Non-secret VC fields only — project.yaml is committed to the user's repo.
  if (data.vcsProfileId) yaml += `vcs_profile_id: ${esc(data.vcsProfileId)}\n`;
  if (data.repoUrl) yaml += `repo_url: ${esc(data.repoUrl)}\n`;
  return yaml;
}

function matchString(yaml: string, key: string): string | undefined {
  const m = yaml.match(new RegExp(`^${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"));
  if (!m) return undefined;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// Parses a project.yaml file into the typed shape. Unknown keys are ignored.
// Returns a partial — callers apply defaults where needed.
async function readProjectYaml(workspacePath: string): Promise<Partial<ProjectYamlData>> {
  try {
    const yaml = await fs.readFile(path.join(workspacePath, "project.yaml"), "utf-8");
    const out: Partial<ProjectYamlData> = {};
    const name = matchString(yaml, "application_name");
    if (name !== undefined) out.applicationName = name;
    const uuid = matchString(yaml, "application_uuid");
    if (uuid !== undefined) out.applicationUuid = uuid;
    const email = matchString(yaml, "creator_email");
    if (email !== undefined) out.creatorEmail = email;
    const appType = matchString(yaml, "app_type");
    if (appType === "web") out.appType = "web";
    const opt = matchString(yaml, "deployment_option");
    if (opt === "electron" || opt === "git-tag" || opt === "web-export") out.deploymentOption = opt;
    const vcsProfileId = matchString(yaml, "vcs_profile_id");
    if (vcsProfileId !== undefined) out.vcsProfileId = vcsProfileId;
    const repoUrl = matchString(yaml, "repo_url");
    if (repoUrl !== undefined) out.repoUrl = repoUrl;
    return out;
  } catch {
    return {};
  }
}

// Resolves a project's settings, applying defaults for any missing field.
export async function readProjectSettings(workspacePath: string): Promise<ProjectSettings> {
  const yaml = await readProjectYaml(workspacePath);
  // The app icon has no YAML field — the master PNG's presence is the state.
  let hasIcon = false;
  try {
    await fs.access(path.join(workspacePath, PROJECT_ICON_FILENAME));
    hasIcon = true;
  } catch { /* no icon set */ }
  const override = redactProjectVcsOverride(await readProjectVcsOverride(workspacePath));
  const appType: ProjectAppType = yaml.appType === "web" ? "web" : "node";
  return {
    // Web apps auto-select the static export — an unset option resolves to
    // "web-export" so a fresh client-side project deploys without any setup.
    deploymentOption:
      yaml.deploymentOption ?? (appType === "web" ? "web-export" : DEFAULT_PROJECT_SETTINGS.deploymentOption),
    vcsProfileId: yaml.vcsProfileId ?? "",
    repoUrl: yaml.repoUrl ?? "",
    vcsOverrideUsername: override.username,
    vcsOverridePat: override.pat,
    hasIcon,
    appType,
  };
}

// Validates a settings payload from the PATCH route. `deploymentOption` is
// normalized to a known value; unrecognized input falls back to the default.
// "web-export" is only valid for web-app projects (app_type from project.yaml).
export async function validateProjectSettings(
  input: Partial<ProjectSettings>,
  appType: ProjectAppType = "node",
): Promise<{
  value: ProjectSettings;
  errors: string[];
}> {
  const errors: string[] = [];

  const rawOption = input.deploymentOption;
  const deploymentOption: DeploymentOption =
    rawOption === "electron" || rawOption === "git-tag" || rawOption === "" ||
    (rawOption === "web-export" && appType === "web")
      ? rawOption
      : DEFAULT_PROJECT_SETTINGS.deploymentOption;

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    value: {
      deploymentOption,
      vcsProfileId: str(input.vcsProfileId),
      repoUrl: str(input.repoUrl),
      vcsOverrideUsername: str(input.vcsOverrideUsername),
      // Pass the PAT through unmodified (sentinel|new|""); the writer applies
      // the keep/set/clear logic against the stored ciphertext.
      vcsOverridePat: typeof input.vcsOverridePat === "string" ? input.vcsOverridePat : "",
    },
    errors,
  };
}

async function writeProjectYaml(workspacePath: string, data: ProjectYamlData): Promise<void> {
  await fs.writeFile(path.join(workspacePath, "project.yaml"), renderProjectYaml(data), "utf-8");
}

// A reasonable default .gitignore for a project's local repo. Beyond VCA's
// internal files and dependencies, this keeps build output out of commits and
// pushes — most importantly the Electron `release/` folder, whose installers
// exceed Git host per-file size limits.
const PROJECT_GITIGNORE_PATTERNS = [
  ".vca-*",
  ".vca-skills/",
  "node_modules/",
  "release/",
  "dist/",
  "dist-electron/",
  "dist-web/",
  ".env",
  ".env.*",
  "!.env.example",
  "*.log",
  "npm-debug.log*",
  ".DS_Store",
  "Thumbs.db",
];

/**
 * Ensure the project's local repo has a sane .gitignore before the initial
 * commit. Merges any missing default patterns into an existing file (e.g. a
 * template's own .gitignore) without disturbing what is already there; writes
 * the full list when no .gitignore exists yet.
 */
async function ensureProjectGitignore(workspacePath: string): Promise<void> {
  const gitignorePath = path.join(workspacePath, ".gitignore");
  try {
    const existing = await fs.readFile(gitignorePath, "utf-8");
    const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = PROJECT_GITIGNORE_PATTERNS.filter((p) => !present.has(p));
    if (missing.length) {
      await fs.writeFile(
        gitignorePath,
        existing.trimEnd() + "\n\n# Added by VCA\n" + missing.join("\n") + "\n",
      );
    }
  } catch {
    await fs.writeFile(gitignorePath, PROJECT_GITIGNORE_PATTERNS.join("\n") + "\n");
  }
}

async function initWorkspace(workspacePath: string, projectId: string, projectMeta?: ProjectYamlData): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });
  try {
    await fs.access(path.join(workspacePath, ".git"));
  } catch {
    await git(["init"], { cwd: workspacePath });
    await git(["config", "user.email", "vca@local"], { cwd: workspacePath });
    await git(["config", "user.name", "VCA"], { cwd: workspacePath });

    // Copy template files into workspace. With no specific template
    // requested, fall back to the first entry in the admin templates list.
    // A missing list just means an empty workspace — initializeProject's
    // per-project path resolves the template by name.
    const defaultTemplate = getDefaultAppTemplate();
    if (defaultTemplate) {
      await copyDir(defaultTemplate.dir, workspacePath);
      // Seed the template's pre-built node_modules so the first preview
      // boots without waiting for npm install. In cloud this lands in the
      // overlay-disk store (off Azure Files); in Electron it lands directly
      // in the workspace.
      const srcModules = path.join(defaultTemplate.dir, "node_modules");
      try {
        await fs.access(srcModules);
        await seedNodeModulesFromDir(projectId, srcModules, workspacePath);
        await ensureNodeModulesSymlink(workspacePath, projectId);
      } catch {
        // No pre-installed node_modules in template — ensureDependencies will handle it
      }
      console.log(`[workspace] Copied template "${defaultTemplate.name}" to ${workspacePath}`);
    } else {
      console.warn("[workspace] No app template configured — admin/app-templates is empty");
    }

    // Write project metadata file (committed with the initial template),
    // keeping the template's appType flag and deployment preset (mirrors
    // initializeProject's per-project path).
    if (projectMeta) {
      const tplYaml = await readProjectYaml(workspacePath);
      const appType: ProjectAppType | undefined =
        projectMeta.appType === "web" || defaultTemplate?.appType === "web" || tplYaml.appType === "web"
          ? "web"
          : undefined;
      const gateOption = (opt: DeploymentOption | undefined) =>
        opt === "web-export" && appType !== "web" ? undefined : opt;
      const presetOption =
        projectMeta.deploymentOption ??
        gateOption(defaultTemplate?.defaultDeploymentOption) ??
        gateOption(tplYaml.deploymentOption);
      await writeProjectYaml(workspacePath, { ...projectMeta, appType, deploymentOption: presetOption });
    }

    // Ensure .gitignore excludes internal files + build output before commit
    await ensureProjectGitignore(workspacePath);

    // Initial commit with template
    await git(["add", "-A"], { cwd: workspacePath });
    await git(["commit", "-m", "Initial template"], { cwd: workspacePath });
  }
}

async function autoCommit(workspacePath: string, promptText: string): Promise<void> {
  return withGitLock(workspacePath, async () => {
    try {
      await git(["add", "-A"], { cwd: workspacePath });
      const { stdout } = await git(["status", "--porcelain"], { cwd: workspacePath });
      if (stdout.trim()) {
        // No shell-metacharacter stripping needed now that the message is a real
        // argv entry rather than part of a command string. The fallback matters:
        // a prompt made entirely of punctuation used to produce `-m ""`, which
        // git rejects, failing the whole commit.
        const msg = promptText.slice(0, 72).trim() || "Changes";
        await git(["commit", "-m", msg], { cwd: workspacePath });
        console.log(`[autoCommit] Committed: ${msg}`);

        // Auto-push if a remote is configured
        try {
          const { stdout: remoteUrl } = await git(["remote", "get-url", "origin"], { cwd: workspacePath });
          if (remoteUrl.trim()) {
            await git(["push", "-u", "origin", "HEAD"], { cwd: workspacePath });
            console.log("[autoCommit] Pushed to remote");
          }
        } catch {
          // No remote configured, skip push
        }
      } else {
        console.log("[autoCommit] No changes to commit");
      }
    } catch (err) {
      console.error("[autoCommit] Failed:", err);
    }
  });
}

const COMMIT_MSG_DIFF_BUDGET = 16_000;
const COMMIT_MSG_TIMEOUT_MS = 15_000;

const COMMIT_MSG_SYSTEM_PROMPT = [
  "You write git commit messages for an LLM-driven app builder.",
  "Output a subject line, then a blank line, then a body.",
  "Subject: one conventional, imperative-mood line describing the main user-visible app change. Maximum 72 characters. No trailing period, no quotes, no markdown, no code fences.",
  "Body: 1 to 5 short bullet points, each starting with \"- \", describing what was done and what changed, in plain language an app owner (not a developer) would understand. Keep each bullet under about 100 characters. No headings, no code fences, no file paths unless essential.",
  "The diff may include auto-generated UML documentation files (usecase.md, deployment.md, component.md, activity-*.md, er-*.md). These are byproducts of the agent's UML skill and are NOT the change. Never lead the subject with \"Update use-case\", \"Update deployment\", \"Update component\", \"Update activity\", \"Update ER\", or any list of diagram names. Mention diagrams only if the diff contains nothing else.",
  "Describe the actual code change (new feature, bug fix, refactor) in terms a user would recognize.",
].join(" ");

const COMMIT_MSG_BODY_BUDGET = 4_000;

function sanitizeCommitSubject(raw: string): string {
  const firstLine = raw.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? "";
  const stripped = firstLine
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```$/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\.+$/, "")
    .trim();
  return stripped.slice(0, 72).replace(/[`$"\\]/g, "");
}

// The body is written to a file and committed with `git commit -F`, so it needs
// no shell escaping — just tidy formatting: drop code fences, trim trailing
// whitespace, collapse blank-line runs, and cap the overall length.
function sanitizeCommitBody(raw: string): string {
  const cleaned = raw
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .split(/\r?\n/)
    .map(l => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.slice(0, COMMIT_MSG_BODY_BUDGET);
}

// Split an LLM commit message into its subject (first non-empty line) and body
// (everything after it).
function parseCommitMessage(raw: string): { subject: string; body: string } {
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  const subject = sanitizeCommitSubject(lines[i] ?? "");
  const body = sanitizeCommitBody(lines.slice(i + 1).join("\n"));
  return { subject, body };
}

function tryGetCommitMessageModel(): Model<Api> | null {
  if (!process.env.AZURE_OPENAI_API_KEY) return null;
  return builtinModel("azure-openai-responses", "gpt-5.5") ?? null;
}

async function generateCommitMessage(workspacePath: string, userPrompt: string): Promise<{ subject: string; body: string }> {
  const fallbackSubject = sanitizeCommitSubject(userPrompt) || "Update project";

  let diffText = "";
  let statText = "";
  try {
    const { stdout: stat } = await git(["diff", "--cached", "--stat"], { cwd: workspacePath, maxBuffer: 4 * 1024 * 1024 });
    const { stdout: full } = await git(["diff", "--cached"], { cwd: workspacePath, maxBuffer: 16 * 1024 * 1024 });
    statText = stat.trim();
    diffText = `${statText}\n\n${full}`;
  } catch (err) {
    console.warn("[commitMsg] git diff failed, using fallback:", err);
    return { subject: fallbackSubject, body: "" };
  }
  if (!diffText.trim()) return { subject: fallbackSubject, body: "" };
  if (diffText.length > COMMIT_MSG_DIFF_BUDGET) {
    diffText = diffText.slice(0, COMMIT_MSG_DIFF_BUDGET) + "\n\n[diff truncated]";
  }

  // Without an LLM we still want a description of what changed, so fall back to
  // the changed-files summary as the body.
  const fallback = { subject: fallbackSubject, body: sanitizeCommitBody(statText) };

  const model = tryGetCommitMessageModel();
  if (!model) return fallback;

  const userText = `User prompt:\n${userPrompt}\n\nStaged diff:\n---\n${diffText}\n---`;
  try {
    const assistant = await complete(
      model,
      {
        systemPrompt: COMMIT_MSG_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userText, timestamp: Date.now() }],
      },
      { signal: AbortSignal.timeout(COMMIT_MSG_TIMEOUT_MS), apiKey: process.env.AZURE_OPENAI_API_KEY },
    );
    // Attribute the helper call's spend to the project. No broadcast — there
    // is no userId in scope; the next SSE snapshot/turn update settles it.
    if (assistant.usage) {
      void addProjectCost(workspacePath, assistant.usage.cost?.total ?? 0, {
        input: assistant.usage.input,
        output: assistant.usage.output,
        cacheRead: assistant.usage.cacheRead,
        cacheWrite: assistant.usage.cacheWrite,
      }, assistant.usage.cost ? {
        input: assistant.usage.cost.input,
        output: assistant.usage.cost.output,
        cacheRead: assistant.usage.cost.cacheRead,
        cacheWrite: assistant.usage.cost.cacheWrite,
      } : undefined, assistant.model || model.id, assistant.provider || model.provider).catch((err) => console.error("[cost] commit-message attribution failed:", err));
    }
    const textBlock = assistant.content.find((c): c is { type: "text"; text: string } => c.type === "text");
    const { subject, body } = parseCommitMessage(textBlock?.text ?? "");
    if (!subject) return fallback;
    // Prefer the LLM body, but never lose the changed-files summary entirely.
    return { subject, body: body || fallback.body };
  } catch (err) {
    console.warn("[commitMsg] LLM call failed, using fallback:", err);
    return fallback;
  }
}

// Tags the current HEAD with `vX.Y.Z` for the given version and pushes the tag
// when an origin remote exists. Skips silently if the tag already exists (e.g. a
// manual version reset that revisits an earlier version). Never throws — tagging
// must not break the commit it annotates. Caller must already hold the git lock.
async function tagAppVersion(workspacePath: string, version: string): Promise<void> {
  const tag = `v${version}`;
  try {
    // `tag` derives from the generated app's package.json version, which the
    // agent can write — as an unquoted shell interpolation this was an injection
    // path. rev-parse also beats `tag -l`, whose argument is a glob: a version
    // containing `*` or `?` would have matched unrelated tags.
    const existing = await tryGit(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: workspacePath });
    if (existing.code === 0) {
      // Tag already exists locally (e.g. created earlier while no remote was
      // configured). Don't recreate it — but still fall through to the push so
      // the remote catches up.
      console.log(`[autoTag] Tag ${tag} already exists locally`);
    } else {
      await git(["tag", tag], { cwd: workspacePath });
      console.log(`[autoTag] Tagged ${tag}`);
    }
    // Always attempt to push the tag when a remote exists. Pushing a tag that is
    // already on the remote is a harmless no-op; this guarantees the version tag
    // reaches origin even if it was created earlier while offline.
    try {
      const { stdout: remoteUrl } = await git(["remote", "get-url", "origin"], { cwd: workspacePath });
      if (remoteUrl.trim()) {
        await git(["push", "origin", tag], { cwd: workspacePath });
        console.log(`[autoTag] Pushed tag ${tag}`);
      }
    } catch {
      // No remote configured or tag push failed — the tag still exists locally.
    }
  } catch (err) {
    console.warn(`[autoTag] Failed to tag ${tag}:`, err);
  }
}

async function autoCommitWithGeneratedMessage(workspacePath: string, userPrompt: string): Promise<void> {
  return withGitLock(workspacePath, async () => {
    try {
      await git(["add", "-A"], { cwd: workspacePath });
      const { stdout } = await git(["status", "--porcelain"], { cwd: workspacePath });
      if (!stdout.trim()) {
        console.log("[autoCommit] No changes to commit");
        return;
      }
      // The agent changed files this turn — bump the app's build number (the
      // 3rd version component) so it rides in this same commit. Skipped for
      // apps without a parseable package.json version. Never block the commit
      // on a version-write failure.
      let bumpedVersion: string | null = null;
      try {
        const current = await readAppVersion(workspacePath);
        if (current) {
          bumpedVersion = bumpBuild(current);
          await writeAppVersion(workspacePath, bumpedVersion);
          await git(["add", "package.json"], { cwd: workspacePath });
          console.log(`[autoCommit] Bumped build version ${current} -> ${bumpedVersion}`);
        }
      } catch (err) {
        bumpedVersion = null;
        console.warn("[autoCommit] Build version bump skipped:", err);
      }
      const { subject, body } = await generateCommitMessage(workspacePath, userPrompt);
      // Prefix the new version so each build is identifiable in git history.
      const finalSubject = bumpedVersion ? `v${bumpedVersion}: ${subject}` : subject;
      // Subject + a descriptive body of what changed. Commit via a temp message
      // file (`git commit -F`) so a multi-line body with arbitrary characters
      // needs no shell escaping. The file lives outside the workspace so it is
      // never swept into `git add -A`.
      const fullMessage = body ? `${finalSubject}\n\n${body}\n` : `${finalSubject}\n`;
      const msgFile = path.join(os.tmpdir(), `vca-commit-${process.pid}-${Date.now()}.txt`);
      await fs.writeFile(msgFile, fullMessage, "utf-8");
      try {
        await execFileAsync("git", ["commit", "-F", msgFile], { cwd: workspacePath });
      } finally {
        await fs.rm(msgFile, { force: true }).catch(() => {});
      }
      console.log(`[autoCommit] Committed: ${finalSubject}`);

      try {
        const { stdout: remoteUrl } = await git(["remote", "get-url", "origin"], { cwd: workspacePath });
        if (remoteUrl.trim()) {
          await git(["push", "-u", "origin", "HEAD"], { cwd: workspacePath });
          console.log("[autoCommit] Pushed to remote");
        }
      } catch {
        // No remote configured, skip push
      }

      // Tag this build (vX.Y.Z) so every version is checkout-able from history.
      if (bumpedVersion) {
        await tagAppVersion(workspacePath, bumpedVersion);
      }
    } catch (err) {
      console.error("[autoCommit] Failed:", err);
    }
  });
}

function getProviderAndModel(): { provider: string; modelId: string } {
  const provider = process.env.PROVIDER || "anthropic";
  // No hardcoded default model: an empty modelId means "not configured" and is
  // surfaced via getLLMConfig().configured / a descriptive resolveLlmModel error.
  const model = process.env.MODEL || "";
  return { provider, modelId: model };
}

export interface LLMConfig {
  mode: "user-key" | "server-configured";
  provider: string;
  modelId: string;
  displayName: string;
  // True when the backend has everything it needs to send a request: either
  // AZURE env vars are set (server-configured) or admin Settings has both a
  // provider and an apiKey persisted. Frontend uses this to skip the
  // "missing API key — open Settings" auto-open path.
  configured: boolean;
}

export interface UserLLMConfig {
  provider: "anthropic" | "azure-ai-foundry" | "azure-openai" | "google" | "kimi-coding" | "openai" | "openai-codex" | "openai-compatible" | "openrouter";
  apiKey: string;
  modelId?: string;
  endpoint?: string;
  apiVersion?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface AppConfig {
  llm: LLMConfig;
  containerApp: { configured: boolean };
  /**
   * Image generation provider/model surfaced for the frontend. `configured`
   * is true when either the env var (legacy GOOGLE_API_KEY) or the admin
   * Settings (vca-settings.json: imageApiKey) supplies a key. `maskedKey`
   * is non-empty only when the env-managed legacy mode is active.
   */
  image: {
    configured: boolean;
    serverManaged: boolean;
    provider: string;
    modelId: string;
    maskedKey: string;
  };
  auth: { enabled: boolean };
  sessionStore: { backend: "file"; description: string };
  /**
   * Effective web_search / web_fetch tool status derived from the LLM
   * provider config (Settings or env). Lets the Settings dialog show which
   * provider backend the web tools resolve to, including env-fallback cases
   * the browser can't infer.
   */
  webTools: {
    searchProvider: "openai" | "azure-openai" | "openrouter" | "anthropic" | "none";
    searchEnabled: boolean;
    fetchEnabled: boolean;
    fetchViaProvider: boolean;
    modelId: string;
    reason?: string;
  };
  appVersion: string;
  systemPromptVersion: string;
  systemPromptRepoUrl?: string;
  appTemplates: { name: string; description: string; appType: ProjectAppType }[];
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

/**
 * Does the stored config carry a usable credential for its provider?
 *
 * Not every provider authenticates with `apiKey`:
 *  - openai-codex / kimi-coding sign in with a deployment-wide OAuth credential
 *    and have NO key field in the UI at all;
 *  - openrouter accepts either a static key OR an OAuth-minted one;
 *  - openai-compatible servers (LM Studio, Ollama, vLLM) typically accept any
 *    key, so the endpoint is the real requirement.
 * Keying `configured` off `apiKey` alone left all of those permanently
 * "unconfigured", which re-opens first-run setup forever and makes the send
 * path bounce the user back to Settings instead of sending.
 */
function hasProviderCredential(stored: VcaSettings): boolean {
  switch (stored.llmProvider) {
    case "openai-codex":      return hasCodexCredential();
    case "kimi-coding":       return hasKimiCredential();
    case "openrouter":        return !!stored.apiKey || hasOpenRouterCredential();
    case "openai-compatible": return !!stored.llmEndpoint;
    default:                  return !!stored.apiKey;
  }
}

export function getLLMConfig(): LLMConfig {
  if (process.env.AZURE_AI_FOUNDRY_ENDPOINT) {
    const modelId = process.env.AZURE_AI_FOUNDRY_MODEL || process.env.MODEL || "";
    return {
      mode: "server-configured",
      provider: "anthropic",
      modelId,
      displayName: `AI Foundry Claude (${modelId || "model not set"})`,
      configured: !!modelId,
    };
  }
  if (process.env.AZURE_OPENAI_BASE_URL) {
    const modelId = process.env.AZURE_OPENAI_MODEL || process.env.MODEL || "";
    return {
      mode: "server-configured",
      provider: "azure-openai-responses",
      modelId,
      displayName: `Azure OpenAI (${modelId || "model not set"})`,
      configured: !!modelId,
    };
  }
  // vca-settings.json (admin Settings) overrides the env-var default. Cached
  // sync — populated by loadVcaSettings() during startup and refreshed on
  // every PUT, so this is safe to call from the listener log.
  const stored = getCachedVcaSettings();
  if (stored.llmProvider) {
    const modelId = stored.llmModelId || "";
    return {
      mode: "user-key",
      provider: stored.llmProvider,
      modelId,
      displayName: `${stored.llmProvider}${modelId ? ` / ${modelId}` : ""}`,
      // Several providers have no API key at all (OAuth sign-in, or a local
      // server) — see hasProviderCredential.
      configured: !!modelId && hasProviderCredential(stored),
    };
  }
  const { provider, modelId } = getProviderAndModel();
  return {
    mode: "user-key",
    provider,
    modelId,
    displayName: `${provider} / ${modelId || "model not set"}`,
    configured: !!getApiKeyFromEnv(provider) && !!modelId,
  };
}

let cachedAppVersion: string | null = null;
/** App version for display. Electron sets APP_VERSION from app.getVersion() before the
 *  server boots; server/container falls back to reading package.json (both src/ in dev and
 *  dist/ in the container sit one level below the repo root, so "../package.json" works). */
function getAppVersion(): string {
  if (cachedAppVersion !== null) return cachedAppVersion;
  let version = process.env.APP_VERSION || "";
  if (!version) {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf-8"));
      if (typeof pkg.version === "string") version = pkg.version;
    } catch {
      // Leave version as "" if package.json can't be read.
    }
  }
  cachedAppVersion = version;
  return version;
}

export async function getAppConfig(): Promise<AppConfig> {
  const googleKey = process.env.GOOGLE_API_KEY || "";
  const store = getSessionStore();
  const stored = getCachedVcaSettings();
  const imageProvider = stored.imageProvider || "google";
  const imageModelId = stored.imageModelId
    || (imageProvider === "google" ? "gemini-3.1-flash-image-preview"
      : imageProvider === "openai" ? "gpt-image-1"
      : "");
  // Same key resolution as the /image-ai route: "use LLM key" wins over the
  // dedicated image key; the Google env var is only the last resort.
  // "Use the LLM key" never applies to openai-codex — its credential is a
  // ChatGPT OAuth token, not an OpenAI API key.
  const imageUseLlmKey = stored.imageUseLlmKey && stored.llmProvider !== "openai-codex";
  const imageConfiguredKey = imageUseLlmKey ? stored.apiKey : stored.imageApiKey;
  const imageServerManaged = !!googleKey && imageProvider === "google" && !imageConfiguredKey;

  return {
    llm: getLLMConfig(),
    containerApp: {
      configured: false,
    },
    auth: {
      enabled: (() => {
        const snap = getAuthConfigSnapshot();
        return snap.enabled && !!(snap.tenantId && snap.clientId && snap.clientSecret);
      })(),
    },
    sessionStore: {
      backend: "file",
      description: store.describe(),
    },
    webTools: getWebToolsStatus(),
    image: {
      configured: !!(imageConfiguredKey || (imageProvider === "google" && googleKey)),
      serverManaged: imageServerManaged,
      provider: imageProvider,
      modelId: imageModelId,
      maskedKey: imageServerManaged ? maskSecret(googleKey) : "",
    },
    appVersion: getAppVersion(),
    systemPromptVersion: getSystemPromptVersion(),
    systemPromptRepoUrl: getSystemPromptRepoUrl() || undefined,
    appTemplates: getAppTemplates().map((t) => ({
      name: t.name,
      description: t.description,
      appType: t.appType,
    })),
  };
}

export function getGoogleApiKey(): string | null {
  return process.env.GOOGLE_API_KEY || null;
}

function getThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const level = process.env.THINKING_LEVEL || "medium";
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
    return level as any;
  }
  return "medium";
}

export async function createProject(
  userId: string,
  name: string,
  apiKey?: string,
  llmConfig?: UserLLMConfig,
  creatorEmail: string = "",
  appTemplate?: string,
): Promise<string> {
  const projectId = crypto.randomUUID();

  await withProjectListLock(userId, async () => {
    const projects = await loadProjectList(userId);
    projects.push({
      id: projectId,
      name,
      createdAt: new Date().toISOString(),
      ...(appTemplate ? { appTemplate } : {}),
    });
    await saveProjectList(userId, projects);
  });

  return projectId;
}

function sendProjectStep(userId: string, projectId: string, step: string, status: "in-progress" | "finished" | "failed", error?: string): void {
  broadcastSSEEvent(userId, projectId, "project_step", { step, status, ...(error ? { error } : {}) });
}

function sendProjectLog(userId: string, projectId: string, step: string, line: string): void {
  broadcastSSEEvent(userId, projectId, "project_log", { step, line });
}

export async function initializeProject(
  userId: string,
  projectId: string,
  name: string,
  creatorEmail: string = "",
): Promise<void> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  let currentStep = "create_workspace";

  try {
    // Step 1: Create workspace
    sendProjectStep(userId, projectId, "create_workspace", "in-progress");
    await fs.mkdir(workspacePath, { recursive: true });
    sendProjectLog(userId, projectId, "create_workspace", "Created workspace directory");
    await git(["init"], { cwd: workspacePath });
    await git(["config", "user.email", "vca@local"], { cwd: workspacePath });
    await git(["config", "user.name", "VCA"], { cwd: workspacePath });
    sendProjectLog(userId, projectId, "create_workspace", "Initialized git repository");
    sendProjectStep(userId, projectId, "create_workspace", "finished");

    // Step 2: Copy template files
    currentStep = "copy_template";
    sendProjectStep(userId, projectId, "copy_template", "in-progress");
    const projectsForLookup = await loadProjectList(userId);
    const projectRecord = projectsForLookup.find((p) => p.id === projectId);
    const requestedTemplate = projectRecord?.appTemplate;
    let resolvedTemplate = requestedTemplate ? getAppTemplateByName(requestedTemplate) : null;
    if (!resolvedTemplate) {
      if (requestedTemplate) {
        console.warn(
          `[workspace] template "${requestedTemplate}" not found for project ${projectId} — falling back to default`,
        );
      }
      resolvedTemplate = getDefaultAppTemplate();
    }
    if (resolvedTemplate) {
      await copyDir(resolvedTemplate.dir, workspacePath);
      sendProjectLog(userId, projectId, "copy_template", `Copied template files (${resolvedTemplate.name})`);
    } else {
      sendProjectLog(userId, projectId, "copy_template", "No app template configured — skipped");
    }
    sendProjectStep(userId, projectId, "copy_template", "finished");

    // Step 3: Install dependencies
    currentStep = "install_dependencies";
    sendProjectStep(userId, projectId, "install_dependencies", "in-progress");
    const packageJsonPath = path.join(workspacePath, "package.json");
    if (await fs.access(packageJsonPath).then(() => true).catch(() => false)) {
      sendProjectLog(userId, projectId, "install_dependencies", "Ensuring dependencies (overlay-disk node_modules)...");
      await ensureDependencies(workspacePath, projectId);
      sendProjectLog(userId, projectId, "install_dependencies", "Dependencies ready");
    } else {
      sendProjectLog(userId, projectId, "install_dependencies", "No package.json — skipped");
    }
    sendProjectStep(userId, projectId, "install_dependencies", "finished");

    // Step 4: Initial commit
    currentStep = "initial_commit";
    sendProjectStep(userId, projectId, "initial_commit", "in-progress");
    // Stamp the app's starting version (main.minor.build). The owner can change
    // main/minor later in Project Settings; VCA auto-bumps build on each change.
    // Skipped for templates without a package.json (nothing to version).
    if (await fs.access(packageJsonPath).then(() => true).catch(() => false)) {
      await writeAppVersion(workspacePath, DEFAULT_APP_VERSION).catch((err) =>
        console.warn(`[workspace] Failed to set initial version for ${projectId}:`, err),
      );
    }
    // The template's appType flag is stamped into the project, and the
    // template presets the deployment target: its template.yaml
    // deploymentOption (already resolved for container vs Electron runtime)
    // wins over a deployment_option preset in its bundled project.yaml
    // (e.g. web templates ship deployment_option: "web-export").
    const tplYaml = await readProjectYaml(workspacePath);
    const appType: ProjectAppType | undefined =
      resolvedTemplate?.appType === "web" || tplYaml.appType === "web" ? "web" : undefined;
    const gateOption = (opt: DeploymentOption | undefined) =>
      opt === "web-export" && appType !== "web" ? undefined : opt;
    const presetOption = gateOption(resolvedTemplate?.defaultDeploymentOption) ?? gateOption(tplYaml.deploymentOption);
    await writeProjectYaml(workspacePath, {
      applicationName: name,
      applicationUuid: projectId,
      creatorEmail,
      appType,
      deploymentOption: presetOption,
    });
    await ensureProjectGitignore(workspacePath);
    await git(["add", "-A"], { cwd: workspacePath });
    await git(["commit", "-m", "Initial template"], { cwd: workspacePath });
    sendProjectLog(userId, projectId, "initial_commit", "Created initial commit");
    sendProjectStep(userId, projectId, "initial_commit", "finished");

    // Step 5: Start preview process
    currentStep = "start_preview";
    sendProjectStep(userId, projectId, "start_preview", "in-progress");
    const projectKey = makeProjectKey(userId, projectId);
    const port = await startAppProcess(workspacePath, projectKey, (line, stream) => {
      sendProjectLog(userId, projectId, "start_preview", line);
    });
    if (port > 0) {
      sendProjectLog(userId, projectId, "start_preview", `Preview running on port ${port}`);
      broadcastSSEEvent(userId, projectId, "files_changed", {});
    } else {
      sendProjectLog(userId, projectId, "start_preview", "No runnable app detected — skipped");
    }
    sendProjectStep(userId, projectId, "start_preview", "finished");

    // Step 6: Run project-setup hook (.vca/project-setup.md) if present.
    // Fire-and-forget: initializeProject returns and the user lands in the
    // project with the Setup chat already streaming.
    currentStep = "project_setup";
    sendProjectStep(userId, projectId, "project_setup", "in-progress");
    const setupPrompt = await readVcaHook(workspacePath, "setup");
    if (setupPrompt) {
      try {
        const { chatId, name } = await startNewChat({
          userId,
          projectId,
          name: "Setup",
          prompt: setupPrompt,
          displayText: "Run project setup",
          awaitCompletion: false,
          autoSwitch: true,
        });
        sendProjectLog(userId, projectId, "project_setup", `Started "${name}" chat (${chatId})`);
      } catch (err: any) {
        sendProjectLog(userId, projectId, "project_setup", `Failed to start setup chat: ${err?.message || String(err)}`);
      }
    } else {
      sendProjectLog(userId, projectId, "project_setup", "No .vca/project-setup.md — skipped");
    }
    sendProjectStep(userId, projectId, "project_setup", "finished");
  } catch (err: any) {
    console.error(`[workspace] initializeProject failed at step ${currentStep}:`, err);
    sendProjectStep(userId, projectId, currentStep, "failed", err.message || String(err));
    throw err;
  }
}

export async function listProjects(userId: string): Promise<ProjectMetadata[]> {
  const projects = await loadProjectList(userId);
  const inbound = await loadInboundLinks(userId);
  // Cache source projects.json and user-profile reads so we don't re-read
  // the same source user multiple times when one user has linked several
  // projects from another.
  const sourceListCache = new Map<string, ProjectMetadata[] | null>();
  const sourceProfileCache = new Map<string, PublicUser | null>();
  const getSourceProfile = async (sourceUserId: string) => {
    let p = sourceProfileCache.get(sourceUserId);
    if (p === undefined) {
      p = await loadPublicUser(sourceUserId);
      sourceProfileCache.set(sourceUserId, p);
    }
    return p;
  };
  return Promise.all(projects.map(async (p) => {
    // Sharing is metadata-only: a shared entry carries sourceUserId. There is no
    // on-disk junction — a recipient's file access is redirected to the owner's
    // real dir in code (resolveOwnerUserId).
    const isLink = !!p.sourceUserId;

    // Deployment status resolves to the owner's dir for shared entries (the
    // path accessors are owner-aware), so linked entries show the owner's state.
    const deployment = await getDeployStatus(userId, p.id).catch(() => ({ deployed: false }));

    // Resource settings live in project.yaml — read through symlinks too so
    // linked entries reflect the source project's configuration.
    const settings = await readProjectSettings(await getWorkspacePath(userId, p.id))
      .catch(() => ({ ...DEFAULT_PROJECT_SETTINGS }));

    // Lifetime LLM spend (also symlink-transparent). Undefined when the
    // project never accrued cost, so fresh projects show no badge.
    const costState = await readProjectCostIfExists(await getWorkspacePath(userId, p.id));
    const cost = costState ? { totalUsd: costState.totalUsd, updatedAt: costState.updatedAt || undefined } : undefined;

    if (isLink && p.sourceUserId) {
      let sourceList = sourceListCache.get(p.sourceUserId);
      if (sourceList === undefined) {
        try {
          sourceList = await loadProjectList(p.sourceUserId);
        } catch {
          sourceList = null;
        }
        sourceListCache.set(p.sourceUserId, sourceList);
      }
      const sourceProfile = await getSourceProfile(p.sourceUserId);
      const sourceDisplayName = sourceProfile?.displayName || "";
      const sourceMeta = sourceList?.find(s => s.id === p.id);
      if (sourceMeta) {
        return { ...p, isLink, deployment, settings, cost, name: sourceMeta.name, sourceDisplayName };
      }
      return { ...p, isLink, deployment, settings, cost, staleSource: true, sourceDisplayName };
    }

    const inboundLinkCount = Array.isArray(inbound[p.id]) ? inbound[p.id].length : 0;
    return { ...p, isLink, deployment, settings, cost, inboundLinkCount };
  }));
}

// Persists project settings to project.yaml. Used by the admin PATCH route.
// Reads-modifies-writes so non-settings fields (applicationName, etc.) are
// preserved across the update.
export async function setProjectSettings(
  userId: string,
  projectId: string,
  settings: ProjectSettings,
): Promise<void> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  const existing = await readProjectYaml(workspacePath);
  await writeProjectYaml(workspacePath, {
    applicationName: existing.applicationName ?? "",
    applicationUuid: existing.applicationUuid ?? projectId,
    creatorEmail: existing.creatorEmail ?? "",
    // app_type is stamped at creation and immutable through settings.
    appType: existing.appType,
    deploymentOption: settings.deploymentOption,
    vcsProfileId: settings.vcsProfileId,
    repoUrl: settings.repoUrl,
  });
  // Per-project credential override → gitignored, encrypted .vca-vcs.json.
  await writeProjectVcsOverride(workspacePath, {
    username: settings.vcsOverrideUsername,
    pat: settings.vcsOverridePat,
  });
}

// Owned (non-link) projects of `targetUserId` with live deployment status,
// for cross-user gallery / link-discovery views.
export async function listPublicProjects(targetUserId: string): Promise<ProjectMetadata[]> {
  const projects = await loadProjectList(targetUserId);
  // sourceUserId is the persisted share marker (isLink is derived, never stored
  // in projects.json) — without this, every recipient re-lists the owner's
  // project as their own in link-discovery views.
  const owned = projects.filter(p => !p.sourceUserId);
  return Promise.all(owned.map(async (p) => {
    const deployment = await getDeployStatus(targetUserId, p.id).catch(() => ({ deployed: false }));
    const costState = await readProjectCostIfExists(await getWorkspacePath(targetUserId, p.id));
    const cost = costState ? { totalUsd: costState.totalUsd, updatedAt: costState.updatedAt || undefined } : undefined;
    return { ...p, deployment, cost };
  }));
}

// ─── User profile + cross-user admin helpers ────────────────

// Thin shim around user-store.createEntraUser used by the OAuth callback +
// refresh paths. Splits a Graph-provided `displayName` into first/last name
// the first time we see a user; on subsequent calls createEntraUser preserves
// any admin-edited values (Graph never blows them away).
export async function saveUserProfile(userId: string, displayName: string, email: string): Promise<void> {
  const trimmed = (displayName || "").trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  const firstName = parts.length > 0 ? parts[0] : "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";
  // Username must satisfy USERNAME_RE in user-store (letters/digits/._-).
  // Derive in preference order: email local-part → full email if it fits →
  // the userId as a last resort (always passes the regex — UUIDs are hex+`-`).
  const usernameRe = /^[a-zA-Z0-9._-]{2,64}$/;
  const trimmedEmail = (email || "").trim();
  const localPart = trimmedEmail.includes("@") ? trimmedEmail.split("@")[0] : trimmedEmail;
  const username = usernameRe.test(localPart) ? localPart
    : usernameRe.test(trimmedEmail) ? trimmedEmail
    : userId;
  await createEntraUser({ userId, username, firstName, lastName, email: email || "" });
}

async function readCreatorEmailFromAnyProjectYaml(userId: string, projectIds: string[]): Promise<string> {
  for (const id of projectIds) {
    try {
      const yaml = await fs.readFile(path.join(await getWorkspacePath(userId, id), "project.yaml"), "utf-8");
      const m = yaml.match(/^creator_email:\s*"((?:[^"\\]|\\.)*)"/m);
      if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } catch { /* try next */ }
  }
  return "";
}

export interface UserWithProjects {
  userId: string;
  displayName: string;
  email: string;
  projects: Array<{ id: string; name: string; createdAt: string; linked: boolean; isLink: boolean }>;
}

export async function enumerateUsersWithProjects(excludeUserId: string): Promise<UserWithProjects[]> {
  const userDirs = (await listUserDirs()).filter((u) => u !== excludeUserId);

  const adminProjectIds = new Set((await loadProjectList(excludeUserId)).map(p => p.id));

  const result: UserWithProjects[] = [];
  for (const userId of userDirs) {
    let projects: ProjectMetadata[] = [];
    try { projects = await loadProjectList(userId); } catch { continue; }
    if (projects.length === 0) continue;

    const profile = await loadPublicUser(userId);
    let displayName = profile?.displayName || "";
    let email = profile?.email || "";
    if (!email) email = await readCreatorEmailFromAnyProjectYaml(userId, projects.map(p => p.id));
    if (!displayName) displayName = email || userId;

    const projectEntries = projects.map(p => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      linked: adminProjectIds.has(p.id),
      isLink: !!p.sourceUserId, // metadata-only sharing — no junction to lstat
    }));
    projectEntries.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    result.push({
      userId,
      displayName,
      email,
      projects: projectEntries,
    });
  }

  result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return result;
}

export async function linkProject(linkerUserId: string, sourceUserId: string, projectId: string): Promise<void> {
  if (sourceUserId === linkerUserId) throw new Error("Cannot link your own project");

  // Validate the source purely from metadata — sharing is metadata-only (no
  // on-disk junction, which would fail when WORKSPACES_ROOT is on an SMB share).
  // The source user must actually OWN the project (not hold it as a share);
  // an entry with sourceUserId set would be a transitive link.
  const sourceProjects = await loadProjectList(sourceUserId);
  const sourceMeta = sourceProjects.find(p => p.id === projectId);
  if (!sourceMeta) throw new Error("Source project not found");
  if (sourceMeta.sourceUserId) throw new Error("Source is itself a link — refusing transitive link");

  // The owner's physical dir must also exist: metadata without a directory
  // (crashed create, manual cleanup) would hand out a share whose every open
  // fails or fabricates skeleton dirs inside the owner's tree.
  const sourceDirStat = await fs.lstat(projectPaths.workspace(sourceUserId, projectId)).catch(() => null);
  if (!sourceDirStat || sourceDirStat.isSymbolicLink() || !sourceDirStat.isDirectory()) {
    throw new Error("Source project not found");
  }

  await withProjectListLock(linkerUserId, async () => {
    const linkerProjects = await loadProjectList(linkerUserId);
    if (linkerProjects.some(p => p.id === projectId)) {
      const err: any = new Error("Project already linked");
      err.code = "ALREADY_LINKED";
      throw err;
    }

    await fs.mkdir(getUserDir(linkerUserId), { recursive: true });
    // Self-heal: drop a stale share junction left by an older (junction-based)
    // build so the metadata entry is the sole source of truth.
    const linkerPath = projectPaths.workspace(linkerUserId, projectId);
    const stale = await fs.lstat(linkerPath).catch(() => null);
    if (stale?.isSymbolicLink()) await fs.unlink(linkerPath).catch(() => {});

    linkerProjects.push({
      id: sourceMeta.id,
      name: sourceMeta.name,
      createdAt: sourceMeta.createdAt,
      sourceUserId,
    });
    await saveProjectList(linkerUserId, linkerProjects);
  });

  await withInboundLinksLock(sourceUserId, async () => {
    const links = await loadInboundLinks(sourceUserId);
    const list = Array.isArray(links[projectId]) ? links[projectId] : [];
    if (!list.some(e => e.userId === linkerUserId)) {
      list.push({ userId: linkerUserId, linkedAt: new Date().toISOString() });
    }
    links[projectId] = list;
    await saveInboundLinks(sourceUserId, links);
  });
}

export async function unlinkProject(linkerUserId: string, projectId: string): Promise<void> {
  // Metadata-only unshare. The project must be present as a SHARE (sourceUserId
  // set); refuse to "unlink" a project the caller actually owns.
  const linkerProjectsBefore = await loadProjectList(linkerUserId);
  const linkerEntry = linkerProjectsBefore.find(p => p.id === projectId);
  if (!linkerEntry) throw new Error("Project not found in your workspace");
  if (!linkerEntry.sourceUserId) {
    const err: any = new Error("Refusing to unlink: you own this project, it is not a share");
    err.code = "NOT_A_LINK";
    throw err;
  }
  const ownerUserId = linkerEntry.sourceUserId;

  await withProjectListLock(linkerUserId, async () => {
    // Self-heal any stale junction from an older build before dropping metadata.
    const linkerPath = projectPaths.workspace(linkerUserId, projectId);
    const stale = await fs.lstat(linkerPath).catch(() => null);
    if (stale?.isSymbolicLink()) await fs.unlink(linkerPath).catch(() => {});
    const linkerProjects = await loadProjectList(linkerUserId);
    await saveProjectList(linkerUserId, linkerProjects.filter(p => p.id !== projectId));
  });

  await withInboundLinksLock(ownerUserId, async () => {
    const links = await loadInboundLinks(ownerUserId);
    const list = Array.isArray(links[projectId]) ? links[projectId] : [];
    links[projectId] = list.filter(e => e.userId !== linkerUserId);
    await saveInboundLinks(ownerUserId, links);
  });
}

// Admin-only: hand a project over from one user to another. Moves the
// workspace directory, owner entry in projects.json, inbound-link records,
// and re-points every existing share's sourceUserId to the new owner (metadata
// only — sharing no longer uses filesystem junctions). Refuses if the project
// is currently locked by any user.
export interface TransferProjectResult {
  fromUserId: string;
  toUserId: string;
  projectId: string;
  rePointedRecipients: string[];
  failedRecipients: string[];
  removedPriorShareToNewOwner: boolean;
}

export async function transferProjectOwnership(
  fromUserId: string,
  toUserId: string,
  projectId: string,
): Promise<TransferProjectResult> {
  if (!fromUserId || !toUserId || !projectId) {
    const err: any = new Error("fromUserId, toUserId, and projectId are required");
    err.code = "INVALID_ARGS";
    err.status = 400;
    throw err;
  }
  if (fromUserId === toUserId) {
    const err: any = new Error("Source and destination users must differ");
    err.code = "SELF_TRANSFER";
    err.status = 400;
    throw err;
  }

  // Raw per-user physical paths — NOT the owner-aware resolver. fromPath is the
  // owner's real dir; toPath is the destination we move it to. Owner-resolving
  // toUser would wrongly yield fromPath when toUser currently holds a share.
  const fromPath = projectPaths.workspace(fromUserId, projectId);
  const toPath = projectPaths.workspace(toUserId, projectId);

  // Ownership is decided by metadata (sharing is metadata-only, no junction).
  const fromProjectsSnapshot = await loadProjectList(fromUserId);
  const fromEntry = fromProjectsSnapshot.find(p => p.id === projectId);
  if (!fromEntry || fromEntry.sourceUserId) {
    const err: any = new Error("Source user is not the owner of this project");
    err.code = "NOT_OWNER";
    err.status = 409;
    throw err;
  }

  // The owner's physical dir must exist as a real directory to be moved.
  const fromStat = await fs.lstat(fromPath).catch(() => null);
  if (!fromStat) {
    const err: any = new Error("Source project not found");
    err.code = "PROJECT_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if (fromStat.isSymbolicLink()) {
    // A legacy share junction the boot sweep hasn't cleared (it only visits
    // entries with sourceUserId) — a data-state conflict, not a server fault.
    const err: any = new Error("Source workspace is a symlink (stale share junction) — source user is not the owner");
    err.code = "NOT_OWNER_DIR";
    err.status = 409;
    throw err;
  }
  if (!fromStat.isDirectory()) {
    const err: any = new Error("Source workspace path is not a directory");
    err.code = "NOT_A_DIR";
    err.status = 500;
    throw err;
  }

  // A prior share of this project TO the new owner is a metadata entry carrying
  // sourceUserId; the dedupe below replaces it with the owner entry. A NON-share
  // entry means toUser already owns a project with this id — a real conflict.
  const toProjectsSnapshot = await loadProjectList(toUserId);
  const priorToEntry = toProjectsSnapshot.find(p => p.id === projectId);
  if (priorToEntry && !priorToEntry.sourceUserId) {
    const err: any = new Error("Destination user already owns a project with this id");
    err.code = "TARGET_HAS_REAL_DIR";
    err.status = 409;
    throw err;
  }
  // Disk check too: an orphaned REAL directory at the destination (present on
  // disk, absent from metadata after a crashed create/delete) would make the
  // fs.rename below fail late (EPERM on Windows) or silently replace data.
  // Refuse upfront with the actionable conflict code; a stale symlink is fine —
  // it is self-healed inside the locks.
  const toDiskStat = await fs.lstat(toPath).catch(() => null);
  if (toDiskStat && !toDiskStat.isSymbolicLink()) {
    const err: any = new Error("Destination user already has a real directory at this projectId");
    err.code = "TARGET_HAS_REAL_DIR";
    err.status = 409;
    throw err;
  }
  const removedPriorShareToNewOwner = !!priorToEntry?.sourceUserId;

  const canonical = await resolveCanonicalProjectKey(fromUserId, projectId);
  // Synchronous check-and-set: no awaits between get and set, so no other
  // caller can sneak in and acquire the lock first. Refuse if a real user
  // is holding it (no force option in v1).
  const existingLock = projectLocks.get(canonical.key);
  if (existingLock) {
    const err: any = new Error("Project is currently open — refuse transfer while locked");
    err.code = "PROJECT_LOCKED";
    err.status = 409;
    err.holder = publicLockHolder(existingLock);
    throw err;
  }
  const sentinelHolder: ProjectLockHolder = {
    userId: "__admin_transfer__",
    displayName: "Admin transfer",
    email: "",
    acquiredAt: Date.now(),
    sseClientIds: new Set(),
    releaseTimer: null,
  };
  projectLocks.set(canonical.key, sentinelHolder);

  await fs.mkdir(getUserDir(toUserId), { recursive: true });

  const rePointedRecipients: string[] = [];
  const failedRecipients: string[] = [];
  let recipientsToRePoint: InboundLinkEntry[] = [];

  try {
    // Acquire user-keyed locks in sorted order to avoid deadlocks against
    // concurrent share/unlink/link operations in either direction.
    const [firstUser, secondUser] = [fromUserId, toUserId].sort();
    await withProjectListLock(firstUser, async () => {
      await withProjectListLock(secondUser, async () => {
        await withInboundLinksLock(firstUser, async () => {
          await withInboundLinksLock(secondUser, async () => {
            const fromLinks = await loadInboundLinks(fromUserId);
            const rawRecipients = Array.isArray(fromLinks[projectId]) ? fromLinks[projectId] : [];
            recipientsToRePoint = rawRecipients.filter(e => e.userId !== toUserId);

            // Pristine snapshots of every metadata file the pivot mutates, taken
            // inside the locks — rollback restores ALL of them so a partial
            // failure can never leave a phantom owner entry in toUser's list
            // (which would 409 every retry) or a destroyed prior-share entry.
            const fromProjectsPristine = await loadProjectList(fromUserId);
            const toProjectsPristine = await loadProjectList(toUserId);
            const fromLinksPristine: InboundLinksFile = JSON.parse(JSON.stringify(fromLinks));
            const toLinksPristine = await loadInboundLinks(toUserId);

            // Self-heal: remove any stale share junction at the destination left
            // by an older build. The prior-share metadata entry (if any) is
            // dropped by the dedupe below.
            const staleTo = await fs.lstat(toPath).catch(() => null);
            if (staleTo?.isSymbolicLink()) { try { await fs.unlink(toPath); } catch { /* best-effort */ } }

            let pivoted = false;
            try {
              await fs.rename(fromPath, toPath);
              pivoted = true;

              const fromProjects = await loadProjectList(fromUserId);
              await saveProjectList(fromUserId, fromProjects.filter(p => p.id !== projectId));

              const toProjects = await loadProjectList(toUserId);
              const dedupedToProjects = toProjects.filter(p => p.id !== projectId);
              dedupedToProjects.push({
                id: fromEntry.id,
                name: fromEntry.name,
                createdAt: fromEntry.createdAt,
                appTemplate: fromEntry.appTemplate,
              });
              await saveProjectList(toUserId, dedupedToProjects);

              const fromLinksFresh = await loadInboundLinks(fromUserId);
              delete fromLinksFresh[projectId];
              await saveInboundLinks(fromUserId, fromLinksFresh);

              const toLinksFresh = await loadInboundLinks(toUserId);
              if (recipientsToRePoint.length > 0) {
                toLinksFresh[projectId] = recipientsToRePoint;
              } else {
                delete toLinksFresh[projectId];
              }
              await saveInboundLinks(toUserId, toLinksFresh);
            } catch (err: any) {
              if (pivoted) {
                try {
                  await fs.rename(toPath, fromPath);
                  // Restore EVERY metadata file the pivot may have touched from
                  // the pristine snapshots — including toUser's projects.json,
                  // so no phantom owner entry survives to block retries.
                  await saveProjectList(fromUserId, fromProjectsPristine);
                  await saveProjectList(toUserId, toProjectsPristine);
                  await saveInboundLinks(fromUserId, fromLinksPristine);
                  await saveInboundLinks(toUserId, toLinksPristine);
                  const rollErr: any = new Error(`Transfer rolled back: ${err?.message || err}`);
                  rollErr.code = "PARTIAL_TRANSFER_ROLLED_BACK";
                  rollErr.status = 500;
                  throw rollErr;
                } catch (rollbackErr: any) {
                  if (rollbackErr?.code === "PARTIAL_TRANSFER_ROLLED_BACK") throw rollbackErr;
                  const unrecoverable: any = new Error(`Transfer partially applied and rollback failed (orig: ${err?.message || err}; rollback: ${rollbackErr?.message || rollbackErr})`);
                  unrecoverable.code = "PARTIAL_TRANSFER_UNRECOVERABLE";
                  unrecoverable.status = 500;
                  throw unrecoverable;
                }
              }
              throw err;
            }
          });
        });
      });
    });

    // Re-point each existing recipient's share to the new owner — metadata only.
    // Per-recipient errors are non-fatal — the ownership move is durable; we
    // surface failures so the admin can fix them manually.
    for (const recipient of recipientsToRePoint) {
      try {
        await withProjectListLock(recipient.userId, async () => {
          const list = await loadProjectList(recipient.userId);
          const entry = list.find(p => p.id === projectId);
          if (!entry) {
            console.warn(`[transferProjectOwnership] recipient ${recipient.userId} has no projects.json entry for ${projectId} — skipping`);
            return;
          }
          entry.sourceUserId = toUserId;
          await saveProjectList(recipient.userId, list);

          // Self-heal any stale junction from an older build.
          const recipientPath = projectPaths.workspace(recipient.userId, projectId);
          const stale = await fs.lstat(recipientPath).catch(() => null);
          if (stale?.isSymbolicLink()) await fs.unlink(recipientPath).catch(() => {});
        });
        rePointedRecipients.push(recipient.userId);
      } catch (err: any) {
        console.error(`[transferProjectOwnership] failed to re-point recipient ${recipient.userId}: ${err?.message || err}`);
        failedRecipients.push(recipient.userId);
      }
    }

    try { broadcastSSEEvent(fromUserId, projectId, "ownership_transferred", { fromUserId, toUserId }); } catch { /* best-effort */ }
    try { broadcastSSEEvent(toUserId, projectId, "ownership_transferred", { fromUserId, toUserId }); } catch { /* best-effort */ }
  } finally {
    if (projectLocks.get(canonical.key) === sentinelHolder) {
      projectLocks.delete(canonical.key);
    }
  }

  return {
    fromUserId,
    toUserId,
    projectId,
    rePointedRecipients,
    failedRecipients,
    removedPriorShareToNewOwner,
  };
}

/**
 * Enumerate every known projectId across every user. Used by the
 * startup sweep to decide which entries under the node_modules store
 * are orphaned and safe to delete.
 */
export async function listAllKnownProjectIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const userDirs = await listUserDirs();
  for (const userId of userDirs) {
    try {
      const projects = await loadProjectList(userId);
      for (const p of projects) ids.add(p.id);
    } catch { /* ignore */ }
  }
  return ids;
}

// One-time, idempotent migration to the junction-free sharing model. Earlier
// builds represented a share as a Windows junction / symlink at
// WORKSPACES_ROOT/<recipient>/<projectId> pointing at the owner's real dir.
// Sharing is now metadata-only (the projects.json sourceUserId entry is the
// whole relationship, and a recipient's file access is redirected to the owner
// in code), so any such on-disk link is stale. Remove it — unlink drops only the
// link, never its target. A share that was attempted on an SMB root never
// created a link, so those entries have nothing to clean. Idempotent: after the
// first pass there are no links left, so every later run is a no-op.
export async function cleanupLegacyShareJunctions(): Promise<number> {
  let removed = 0;
  for (const userId of await listUserDirs()) {
    let projects: ProjectMetadata[];
    try {
      projects = await loadProjectList(userId);
    } catch { continue; }
    for (const p of projects) {
      if (!p.sourceUserId) continue; // only shares could carry a stale link
      const linkPath = projectPaths.workspace(userId, p.id);
      const st = await fs.lstat(linkPath).catch(() => null);
      if (!st) continue; // never created (e.g. SMB) — nothing to do
      if (st.isSymbolicLink()) {
        try {
          await fs.unlink(linkPath);
          removed++;
        } catch (err) {
          console.warn(`[share-migration] failed to remove stale junction ${linkPath}: ${(err as Error).message}`);
        }
      } else {
        // A REAL directory where metadata says "share" (e.g. a backup/copy tool
        // materialized the old junction into files, which then diverged). Disk
        // is truth: sever the share so the local directory becomes this user's
        // owned project — otherwise the owner-aware accessors would permanently
        // shadow it and the local data would be unreachable.
        const formerOwner = p.sourceUserId;
        try {
          await withProjectListLock(userId, async () => {
            const list = await loadProjectList(userId);
            const entry = list.find(e => e.id === p.id);
            if (entry?.sourceUserId) {
              delete entry.sourceUserId;
              await saveProjectList(userId, list);
            }
          });
          await withInboundLinksLock(formerOwner, async () => {
            const links = await loadInboundLinks(formerOwner);
            const lst = Array.isArray(links[p.id]) ? links[p.id] : [];
            links[p.id] = lst.filter(e => e.userId !== userId);
            if (links[p.id].length === 0) delete links[p.id];
            await saveInboundLinks(formerOwner, links);
          });
          console.warn(`[share-migration] ${linkPath} is a real directory that diverged from its share of ${formerOwner} — share severed; the local copy is now owned by ${userId}`);
        } catch (err) {
          console.warn(`[share-migration] failed to sever diverged share at ${linkPath}: ${(err as Error).message}`);
        }
      }
    }
  }
  return removed;
}

export async function renameProject(userId: string, projectId: string, newName: string): Promise<void> {
  await withProjectListLock(userId, async () => {
    const projects = await loadProjectList(userId);
    const project = projects.find(p => p.id === projectId);
    if (!project) throw new Error("Project not found");
    project.name = newName;
    await saveProjectList(userId, projects);
  });

  // Keep project.yaml in sync with the new name, preserving every other
  // field (creator_email, deployment_option) so the rename does not silently
  // drop settings.
  const workspacePath = await getWorkspacePath(userId, projectId);
  try {
    const existing = await readProjectYaml(workspacePath);
    await writeProjectYaml(workspacePath, {
      ...existing,
      applicationName: newName,
      applicationUuid: projectId,
      creatorEmail: existing.creatorEmail ?? "",
    });
  } catch (err) {
    console.warn(`[workspace] Failed to update project.yaml for ${projectId}:`, err);
  }
}

// File a project entry under a virtual folder (null → back to the top level).
// Metadata-only: the workspace on disk is untouched. Works for link entries
// too — the assignment lives on the viewer's own projects.json entry.
export async function setProjectFolder(userId: string, projectId: string, folderId: string | null): Promise<void> {
  await withProjectListLock(userId, async () => {
    const projects = await loadProjectList(userId);
    const project = projects.find(p => p.id === projectId);
    if (!project) throw new Error("Project not found");
    if (folderId) project.folderId = folderId;
    else delete project.folderId;
    await saveProjectList(userId, projects);
  });
}

// After a folder is deleted, re-file the projects that pointed at it under
// its parent (or the top level), mirroring what deleteProjectFolder does
// with child folders.
export async function reassignProjectFolder(userId: string, fromFolderId: string, toFolderId: string | null): Promise<void> {
  await withProjectListLock(userId, async () => {
    const projects = await loadProjectList(userId);
    let changed = false;
    for (const project of projects) {
      if (project.folderId === fromFolderId) {
        if (toFolderId) project.folderId = toFolderId;
        else delete project.folderId;
        changed = true;
      }
    }
    if (changed) await saveProjectList(userId, projects);
  });
}

export interface AppVersionInfo {
  version: string;
  main: number;
  minor: number;
  build: number;
}

// Reads the app's main.minor.build version from its workspace package.json.
// Returns null for apps without a parseable version (e.g. no package.json).
export async function getAppVersionInfo(userId: string, projectId: string): Promise<AppVersionInfo | null> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  const version = await readAppVersion(workspacePath);
  if (!version) return null;
  const parsed = parseVersion(version);
  if (!parsed) return null;
  return { version, main: parsed.main, minor: parsed.minor, build: parsed.build };
}

// Sets the manually-controlled main/minor version, resetting build to 0.
// Writes package.json and commits just that file so the change is durable and
// picked up by the next deploy. Owner-initiated (not admin-gated).
export async function setAppMainMinor(
  userId: string,
  projectId: string,
  main: number,
  minor: number,
): Promise<AppVersionInfo> {
  if (!Number.isInteger(main) || main < 0 || !Number.isInteger(minor) || minor < 0) {
    throw Object.assign(new Error("main and minor must be non-negative integers"), { code: "INVALID_VERSION" });
  }
  const workspacePath = await getWorkspacePath(userId, projectId);
  const newVersion = withMainMinor(main, minor);
  await withGitLock(workspacePath, async () => {
    // Throws (ENOENT) if the app has no package.json — surfaced to the caller.
    await writeAppVersion(workspacePath, newVersion);
    try {
      await git(["add", "package.json"], { cwd: workspacePath });
      const { stdout } = await git(["status", "--porcelain", "--", "package.json"], { cwd: workspacePath });
      // `-- package.json` isolates the commit to just this file even if the
      // working tree has other in-progress changes staged.
      if (stdout.trim()) {
        await git(["commit", "-m", `Set version to ${newVersion}`, "--", "package.json"], { cwd: workspacePath });
        // Push the version commit + tag it (vX.Y.Z), mirroring the agent commit
        // path so the branch and tag stay consistent on the remote.
        try {
          const { stdout: remoteUrl } = await git(["remote", "get-url", "origin"], { cwd: workspacePath });
          if (remoteUrl.trim()) {
            await git(["push", "-u", "origin", "HEAD"], { cwd: workspacePath });
          }
        } catch {
          // No remote configured, skip push
        }
        await tagAppVersion(workspacePath, newVersion);
      }
    } catch (err) {
      console.warn(`[version] Failed to commit version change for ${projectId}:`, err);
    }
  });
  const parsed = parseVersion(newVersion)!;
  return { version: newVersion, main: parsed.main, minor: parsed.minor, build: parsed.build };
}

export async function deleteProject(userId: string, projectId: string): Promise<void> {
  // Stop the caller's app process, release its port, and dispose their chat
  // sessions FIRST — these are keyed by the viewer's `${userId}:${projectId}`,
  // so this teardown is correct (and required) for both owners and share
  // recipients. A recipient's preview must not keep serving the owner's
  // workspace after the share is dropped.
  const projectKey = makeProjectKey(userId, projectId);
  await stopAppProcess(projectKey);
  releasePort(projectKey);
  const sessionPrefix = `${projectKey}:`;
  for (const [key, managed] of sessions) {
    if (!key.startsWith(sessionPrefix)) continue;
    try { managed.session.dispose(); } catch {}
    sessions.delete(key);
    pendingSSEClients.delete(key);
  }

  // Guard against destroying the owner's data: sharing is metadata-only, so
  // getWorkspacePath below resolves a recipient to the OWNER's real dir. If this
  // user merely holds a share, degrade to unlink (drop the metadata link) and
  // never touch the owner's files.
  const ownershipList = await loadProjectList(userId);
  const ownershipEntry = ownershipList.find(p => p.id === projectId);
  if (ownershipEntry?.sourceUserId) {
    await unlinkProject(userId, projectId);
    return;
  }

  // Remove workspace
  const workspacePath = await getWorkspacePath(userId, projectId);
  await rmRetry(workspacePath, { recursive: true, force: true });
  // Also drop the overlay-disk node_modules store for this project
  await removeNodeModulesStore(projectId);

  // Update metadata
  await withProjectListLock(userId, async () => {
    const projects = await loadProjectList(userId);
    const filtered = projects.filter(p => p.id !== projectId);
    await saveProjectList(userId, filtered);
  });

  // Drop every recipient's share entry so no ghost share survives the owner's
  // delete (a ghost entry would otherwise resolve into the deleted owner's tree
  // and silently fabricate a workspace there on next open). Best-effort per
  // recipient — a failure leaves a stale entry, which the session-open guard
  // also refuses.
  const inbound = await loadInboundLinks(userId);
  const recipients = Array.isArray(inbound[projectId]) ? inbound[projectId] : [];
  for (const recipient of recipients) {
    try {
      await withProjectListLock(recipient.userId, async () => {
        const list = await loadProjectList(recipient.userId);
        await saveProjectList(recipient.userId, list.filter(p => p.id !== projectId));
      });
    } catch (err) {
      console.warn(`[deleteProject] failed to drop share entry for recipient ${recipient.userId}: ${(err as Error).message}`);
    }
  }
  if (recipients.length > 0 || inbound[projectId]) {
    await withInboundLinksLock(userId, async () => {
      const links = await loadInboundLinks(userId);
      delete links[projectId];
      await saveInboundLinks(userId, links);
    }).catch((err) => console.warn(`[deleteProject] failed to clear inbound links: ${(err as Error).message}`));
  }
}

function createAskQuestionTool(getManagedSession: () => ManagedSession): ToolDefinition {
  return {
    name: "ask_question",
    label: "Ask Question",
    description: "Present a multiple choice question to the user to clarify requirements or preferences. The user can pick one of the predefined options or type a custom answer.",
    promptSnippet: "ask_question — present a multiple choice question to the user for clarification",
    promptGuidelines: [
      "Use ask_question when the user's request is ambiguous and could be interpreted in 2+ meaningfully different ways.",
      "ALWAYS use ask_question instead of listing options as plain text — any time you would present choices, alternatives, or suggestions for the user to pick from, use this tool so the user can click to select.",
      "Provide 2-6 clear, concise options. Each option should represent a distinct direction.",
      "Do NOT use ask_question for yes/no questions you can reasonably decide yourself.",
      "Prefer building something and iterating rather than asking too many clarification questions.",
      "When in doubt about what the user wants, ask — do not guess. One clarifying question saves more time than building the wrong thing.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the user" }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Short label for the option" }),
          description: Type.Optional(Type.String({ description: "Optional longer description" })),
        }),
        { description: "The choices to present (2-6 options)", minItems: 2, maxItems: 6 }
      ),
    }),
    async execute(toolCallId, params: any, signal) {
      const managed = getManagedSession();
      // The question UI is rendered by the frontend when it receives the tool_start SSE event
      // (which fires automatically via forwardAgentEvent before execute runs).
      // We just need to block here until the user answers.
      const answer = await new Promise<string>((resolve, reject) => {
        managed.pendingQuestions.set(toolCallId, { resolve, reject });

        // Clean up if aborted
        if (signal) {
          signal.addEventListener("abort", () => {
            managed.pendingQuestions.delete(toolCallId);
            reject(new Error("Question aborted"));
          }, { once: true });
        }
      });

      return {
        content: [{ type: "text" as const, text: `User answered: ${answer}` }],
        details: {},
      };
    },
  } as ToolDefinition;
}

function createRenameChatTool(getManagedSession: () => ManagedSession): ToolDefinition {
  return {
    name: "rename_chat",
    label: "Rename Chat",
    description: "Rename the current chat tab to a short, descriptive name based on the conversation topic.",
    promptSnippet: "rename_chat — give the current chat a meaningful name once the topic is clear",
    promptGuidelines: [
      "Use rename_chat after the user's intent for the current chat is clear, typically once the first 1–2 turns are done.",
      "Pick a concise, descriptive name (2–5 words). Avoid generic names like 'chat' or 'conversation'.",
      "Do not call rename_chat if the chat already has a user-customized (non-default) name. Default names follow the pattern 'chat-<n>'.",
      "Call rename_chat at most once per chat unless the topic genuinely changes.",
    ],
    parameters: Type.Object({
      new_name: Type.String({ description: "Short descriptive name (2–5 words) for the current chat." }),
    }),
    async execute(toolCallId, params: any, signal) {
      const managed = getManagedSession();
      try {
        const applied = await renameChatById(managed.userId, managed.projectId, managed.chatId, params.new_name, true);
        if (applied) {
          sendSSEEvent(managed, "chat_renamed", { chatId: managed.chatId, name: params.new_name.trim() });
          return {
            content: [{ type: "text" as const, text: `Renamed current chat to "${params.new_name.trim()}".` }],
            details: { chatId: managed.chatId, name: params.new_name.trim() },
          };
        }
        return {
          content: [{ type: "text" as const, text: "Chat already has a user-customized name; rename skipped." }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to rename chat: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;
}

function createWaitTool(): ToolDefinition {
  return {
    name: "wait",
    label: "Wait",
    description: "Pause execution for a number of seconds before continuing. Use when you need to wait for an external process (resource provisioning, deployment propagation, rate-limit cooldown, app startup) before the next step.",
    promptSnippet: "wait — pause for N seconds with a user-visible reason",
    promptGuidelines: [
      "Use wait when an external process needs time to settle before the next tool call would succeed (e.g. Azure resource still provisioning, app process just started, deploy propagating).",
      "Always provide a concrete reason — it is shown to the user so they understand why the agent paused.",
      "Keep waits as short as plausible. Prefer 5–30s for most cases; reserve longer waits for things known to take minutes.",
      "Do NOT use wait as a substitute for proper polling/retry of an idempotent check tool — if a status tool exists, call it instead.",
      "Do NOT chain multiple waits back-to-back; pick one duration that covers the whole gap.",
    ],
    parameters: Type.Object({
      seconds: Type.Number({ description: "How long to wait, in seconds. Must be between 1 and 300.", minimum: 1, maximum: 300 }),
      reason: Type.String({ description: "Short explanation shown to the user (e.g. 'Container App is still provisioning'). 5–80 chars recommended." }),
    }),
    async execute(_toolCallId, params: any, signal) {
      const requested = Number(params?.seconds);
      const seconds = Number.isFinite(requested) ? Math.max(1, Math.min(300, Math.floor(requested))) : 1;
      const reason = typeof params?.reason === "string" ? params.reason.trim() : "";

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), seconds * 1000);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            reject(new Error("Wait aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Wait aborted"));
          }, { once: true });
        }
      });

      return {
        content: [{ type: "text" as const, text: `Waited ${seconds}s — ${reason || "(no reason given)"}.` }],
        details: { seconds, reason },
      };
    },
  } as ToolDefinition;
}

function createRestartAppProcessTool(getManagedSession: () => ManagedSession): ToolDefinition {
  return {
    name: "restart_app_process",
    label: "Restart preview server",
    description: "Stop and restart the user's Node app process powering the vca preview. Reuses the same port; rebuilds node_modules if package.json changed since the process started. Blocks until the new process is listening or has failed.",
    promptSnippet: "restart_app_process — restart the preview's Node server on the same port",
    promptGuidelines: [
      "Call get_server_log first to confirm a restart is actually warranted — most failures explain themselves in the log.",
      "Routine source edits do NOT need a manual restart — `node --watch` already restarts the server on file change.",
      "Good fits: package.json changed (dependency added/removed), server entry file changed, env-var change, server is stuck or crashed, preview proxy returning 502.",
      "Do not chain a `wait` after this tool — restart_app_process only returns once the new process is ready or has given up.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params: any, _signal) {
      const managed = getManagedSession();
      const projectKey = makeProjectKey(managed.userId, managed.projectId);
      try {
        const port = await restartAppProcess(managed.workspacePath, projectKey);
        if (port <= 0) {
          return {
            content: [{ type: "text" as const, text: "Restart skipped or failed — workspace may not be a Node app (missing server.js / package.json), or the new process did not become ready. Check get_server_log for details." }],
            details: { restarted: false, port },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Preview server restarted (listening on port ${port}).` }],
          details: { restarted: true, port },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to restart preview server: ${(err as Error).message}` }],
          details: { restarted: false },
        };
      }
    },
  } as ToolDefinition;
}

function createServerLogTool(getManagedSession: () => ManagedSession): ToolDefinition {
  return {
    name: "get_server_log",
    label: "Read server log",
    description: "Read the recent stdout/stderr from the running app process for the current project. Lines are prefixed with [stdout] or [stderr]. Empty if the app isn't running yet.",
    promptSnippet: "get_server_log — read the running app's recent stdout/stderr",
    promptGuidelines: [
      "Use when debugging a runtime error, crash, unexpected behavior, or 500 response — the log is the fastest way to see what the app is actually doing.",
      "Lines are prefixed with [stdout] or [stderr]. Buffer is capped at the most recent 200 lines.",
      "Use the optional 'tail' parameter to read only the last N lines if you only need the very recent output.",
    ],
    parameters: Type.Object({
      tail: Type.Optional(Type.Number({ description: "Return only the last N lines. Omit for all 200 buffered lines." })),
    }),
    async execute(_toolCallId, params: any, _signal) {
      const managed = getManagedSession();
      const projectKey = makeProjectKey(managed.userId, managed.projectId);
      const all = getAppProcessLogs(projectKey);
      const tail = typeof params?.tail === "number" && params.tail > 0 ? Math.floor(params.tail) : null;
      const text = tail ? all.split("\n").slice(-tail).join("\n") : all;
      const lineCount = text ? text.split("\n").length : 0;
      return {
        content: [{ type: "text" as const, text: text || "(no log output yet — the app process may not be running)" }],
        details: { lineCount, truncated: tail != null },
      };
    },
  } as ToolDefinition;
}

export async function startNewChat(args: {
  userId: string;
  projectId: string;
  name?: string;
  prompt: string;
  displayText?: string;
  awaitCompletion?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  autoSwitch?: boolean;
}): Promise<{ chatId: string; name: string; result?: { ok: boolean; error?: string } }> {
  const { userId, projectId } = args;
  const chat = await createChat(userId, projectId, args.name);
  broadcastSSEEvent(userId, projectId, "chat_created", { chat, autoSwitch: args.autoSwitch ?? false });
  if (args.awaitCompletion) {
    const result = await submitPromptAndAwaitCompletion(userId, projectId, chat.id, args.prompt, {
      displayText: args.displayText,
      timeoutMs: args.timeoutMs,
      signal: args.signal,
    });
    return { chatId: chat.id, name: chat.name, result };
  }
  void sendPrompt(userId, projectId, chat.id, args.prompt, undefined, undefined, undefined, args.displayText);
  return { chatId: chat.id, name: chat.name };
}

function createStartNewChatTool(getManagedSession: () => ManagedSession): ToolDefinition {
  return {
    name: "start_new_chat",
    label: "Start New Chat",
    description: "Create a new chat in the current project and submit a prompt to it as if the user had typed it. The new chat's first prompt runs after the current turn ends (a project allows only one streaming agent at a time).",
    promptSnippet: "start_new_chat — open a new chat in the project and submit a prompt as if the user typed it",
    promptGuidelines: [
      "Use start_new_chat to spawn parallel work the user should be able to follow in its own tab.",
      "The new chat's first prompt only begins once the current turn ends — the project allows one streaming agent at a time.",
      "Pass a meaningful 2-5 word name so the new chat is recognisable in the tab bar.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt submitted as the new chat's first user message." }),
      name: Type.Optional(Type.String({ description: "Short chat label (2-5 words). Defaults to an auto chat-N." })),
      display_text: Type.Optional(Type.String({ description: "Optional shorter text shown in the chat bubble; if omitted the prompt itself is shown." })),
    }),
    async execute(_toolCallId, params: any) {
      const managed = getManagedSession();
      const { chatId, name } = await startNewChat({
        userId: managed.userId,
        projectId: managed.projectId,
        name: typeof params?.name === "string" ? params.name : undefined,
        prompt: String(params?.prompt ?? ""),
        displayText: typeof params?.display_text === "string" ? params.display_text : undefined,
        awaitCompletion: false,
      });
      return {
        content: [{ type: "text" as const, text: `Started chat "${name}" (id=${chatId}). Its first prompt will run after this turn ends.` }],
        details: { chatId, name },
      };
    },
  } as ToolDefinition;
}


async function getOrCreateSession(userId: string, projectId: string, chatId: string, apiKey?: string, llmConfig?: UserLLMConfig): Promise<ManagedSession> {
  const key = makeSessionKey(userId, projectId, chatId);
  const existing = sessions.get(key);
  if (existing) return existing;

  // Coalesce concurrent creates for the same key onto a single promise.
  const inflight = sessionCreationLocks.get(key);
  if (inflight) return inflight;

  const promise = createSessionLocked(userId, projectId, chatId, apiKey, llmConfig);
  sessionCreationLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    sessionCreationLocks.delete(key);
  }
}

function mergeLlmConfigWithSettings(req?: UserLLMConfig): UserLLMConfig | undefined {
  const stored = getCachedVcaSettings();
  const storedProvider = stored.llmProvider || "";
  const hasStored = !!storedProvider || !!stored.apiKey || !!stored.llmModelId;
  if (!req && !hasStored) return undefined;

  // If the request omits provider, the stored provider drives the whole config.
  // If the request specifies a provider, only fill in fields it didn't supply
  // (avoids accidentally mixing one provider's modelId with another's secret).
  const provider = req?.provider || (storedProvider as any);
  if (!provider) return req;
  const sameAsStored = !req?.provider || req.provider === storedProvider;

  return {
    provider,
    apiKey: req?.apiKey || (sameAsStored ? stored.apiKey : "") || "",
    modelId: req?.modelId || (sameAsStored ? stored.llmModelId : "") || undefined,
    endpoint: req?.endpoint || (sameAsStored ? stored.llmEndpoint : "") || undefined,
    apiVersion: req?.apiVersion || (sameAsStored ? stored.llmApiVersion : "") || undefined,
    thinkingLevel: req?.thinkingLevel || undefined,
  };
}

// Thrown when no model id is configured anywhere. The message is user-facing
// (it reaches the chat via the SSE error path), so it names exactly what to set.
function requireModelId(modelId: string | undefined, hint: string): string {
  if (modelId) return modelId;
  throw new Error(`No LLM model configured. ${hint}`);
}

// Look up a model in pi's builtin catalog. Returns undefined for ids the
// catalog doesn't know (e.g. custom Foundry deployment names) — callers fall
// back to hand-picked metadata in that case.
function builtinModel(provider: string, modelId: string): Model<Api> | undefined {
  try { return getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined; } catch { return undefined; }
}

// A positive integer token override, or undefined for "unset / auto-detect".
function tokenOverride(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

// Build the model object + the per-provider credential material WITHOUT creating
// a ModelRuntime. Split out from resolveLlmModel so callers that already own a
// runtime (e.g. the set_llm_config tool switching a live session's model) can
// reuse the exact same model-building + credential logic and register the keys
// on their existing runtime instead of spinning up a throwaway one.
//   - runtimeApiKeys: [provider, key] pairs to register via runtime.setRuntimeApiKey().
//   - credentials: an OAuth-backed CredentialStore (codex/kimi/openrouter-OAuth).
//     When set, the provider's auth lives in a shared store that can't be injected
//     into an already-created runtime — a live in-session switch isn't possible.
export async function resolveLlmModelParts(apiKey?: string, llmConfig?: UserLLMConfig): Promise<{ model: any; thinkingLevel: any; runtimeApiKeys: Array<[provider: string, key: string]>; credentials: CredentialStore | undefined }> {
  const config = getLLMConfig();
  // vca-settings.json is the deployment-wide source of truth. We always
  // merge it in: any field the request (llmConfig / apiKey) leaves blank
  // is filled from the stored settings, so non-admin requests — which now
  // receive only the public, secret-stripped view — still get a working
  // client.
  llmConfig = mergeLlmConfigWithSettings(llmConfig);
  if (!apiKey && llmConfig?.apiKey) apiKey = llmConfig.apiKey;
  const thinkingLevel = llmConfig?.thinkingLevel || getThinkingLevel();
  // Per-session runtime API keys by default; the openai-codex branch swaps in
  // the shared file-backed credential store so pi's per-prompt token refresh
  // persists rotated tokens.
  const runtimeApiKeys: Array<[provider: string, key: string]> = [];
  let credentials: CredentialStore | undefined;
  let model: any;

  // The hand-built model objects below take per-model metadata (compat flags
  // like adaptive thinking, context window, max tokens, cost) from pi's builtin
  // catalog when the id is known, so newer models (e.g. Claude Sonnet 5) get
  // the request shape they require. Only baseUrl/headers/name stay VCA-owned.
  if (config.mode === "server-configured" && config.provider === "azure-openai-responses") {
    const baseUrl = process.env.AZURE_OPENAI_BASE_URL!;
    const envKey = process.env.AZURE_OPENAI_API_KEY || "";
    const modelId = requireModelId(config.modelId, "Set AZURE_OPENAI_MODEL (or MODEL) to the deployment name on the Azure OpenAI endpoint.");
    const registryModel = builtinModel("azure-openai-responses", modelId);
    model = {
      id: modelId, name: config.displayName,
      api: "azure-openai-responses", provider: "azure-openai-responses",
      baseUrl, reasoning: registryModel?.reasoning ?? true,
      input: registryModel?.input ?? ["text", "image"],
      ...(registryModel?.compat ? { compat: registryModel.compat } : {}),
      cost: registryModel?.cost ?? { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
      contextWindow: registryModel?.contextWindow ?? 128000, maxTokens: registryModel?.maxTokens ?? 16384,
    };
    if (envKey) runtimeApiKeys.push(["azure-openai-responses", envKey]);
  } else if (config.mode === "server-configured") {
    const endpoint = process.env.AZURE_AI_FOUNDRY_ENDPOINT!;
    const envKey = process.env.AZURE_AI_FOUNDRY_API_KEY || "";
    const modelId = requireModelId(config.modelId, "Set AZURE_AI_FOUNDRY_MODEL (or MODEL) to the model deployed on the AI Foundry endpoint.");
    const registryModel = builtinModel("anthropic", modelId);
    model = {
      id: modelId, name: config.displayName,
      api: "anthropic-messages", provider: "anthropic",
      baseUrl: endpoint, reasoning: registryModel?.reasoning ?? true,
      input: registryModel?.input ?? ["text", "image"],
      ...(registryModel?.compat ? { compat: registryModel.compat } : {}),
      cost: registryModel?.cost ?? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: registryModel?.contextWindow ?? 200000, maxTokens: registryModel?.maxTokens ?? 64000,
      headers: { "Authorization": `Bearer ${envKey}` },
    };
    if (envKey) runtimeApiKeys.push(["anthropic", envKey]);
  } else if (llmConfig) {
    const p = llmConfig.provider;
    const mid = requireModelId(llmConfig.modelId, "Select a model for the LLM provider in Settings.");
    if (p === "azure-ai-foundry") {
      const registryModel = builtinModel("anthropic", mid);
      model = {
        id: mid, name: mid,
        api: "anthropic-messages", provider: "anthropic",
        baseUrl: llmConfig.endpoint, reasoning: registryModel?.reasoning ?? true,
        input: registryModel?.input ?? ["text", "image"],
        ...(registryModel?.compat ? { compat: registryModel.compat } : {}),
        cost: registryModel?.cost ?? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: registryModel?.contextWindow ?? 200000, maxTokens: registryModel?.maxTokens ?? 64000,
        headers: { "Authorization": `Bearer ${llmConfig.apiKey}` },
      };
      if (llmConfig.apiKey) runtimeApiKeys.push(["anthropic", llmConfig.apiKey]);
    } else if (p === "azure-openai") {
      if (llmConfig.apiVersion) {
        process.env.AZURE_OPENAI_API_VERSION = llmConfig.apiVersion;
      }
      const registryModel = builtinModel("azure-openai-responses", mid);
      model = {
        id: mid, name: mid,
        api: "azure-openai-responses", provider: "azure-openai-responses",
        baseUrl: llmConfig.endpoint, reasoning: registryModel?.reasoning ?? true,
        input: registryModel?.input ?? ["text", "image"],
        ...(registryModel?.compat ? { compat: registryModel.compat } : {}),
        cost: registryModel?.cost ?? { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
        contextWindow: registryModel?.contextWindow ?? 128000, maxTokens: registryModel?.maxTokens ?? 16384,
      };
      if (llmConfig.apiKey) runtimeApiKeys.push(["azure-openai-responses", llmConfig.apiKey]);
    } else if (p === "openai-compatible" || p === "openrouter") {
      // OpenAI-compatible Chat Completions endpoint: hosted gateways
      // (OpenRouter) or self-hosted/local servers (LM Studio, vLLM, Ollama,
      // text-generation-webui, …). The user supplies the base URL and model id;
      // OpenRouter defaults to its public gateway when no endpoint is given.
      const baseUrl = (llmConfig.endpoint && llmConfig.endpoint.trim())
        || (p === "openrouter" ? "https://openrouter.ai/api/v1" : "");
      if (!baseUrl) throw new Error("OpenAI-compatible provider requires an endpoint (base URL)");
      const sdkProvider = p === "openrouter" ? "openrouter" : "openai";
      const registryModel = builtinModel(sdkProvider, mid);
      model = {
        id: mid, name: mid,
        api: "openai-completions", provider: sdkProvider,
        baseUrl, reasoning: registryModel?.reasoning ?? true,
        input: registryModel?.input ?? ["text", "image"],
        ...(registryModel?.compat ? { compat: registryModel.compat } : {}),
        cost: registryModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: registryModel?.contextWindow ?? 128000, maxTokens: registryModel?.maxTokens ?? 16384,
      };
      // OpenRouter OAuth: when the admin signed in with OpenRouter and supplied
      // no static API key, source the minted key from the shared encrypted
      // store (pi's toAuth returns {apiKey: access}) instead of a runtime key —
      // same request shape, credential owned by the store. Any other case keeps
      // the static-key path (local servers often accept any non-empty key; the
      // OpenAI client rejects an empty one, so fall back to a placeholder).
      if (p === "openrouter" && !llmConfig.apiKey && hasOpenRouterCredential()) {
        credentials = getOpenRouterCredentialStore();
        console.log(`[openrouter] model ${mid}, using OAuth credential`);
      } else {
        runtimeApiKeys.push([sdkProvider, llmConfig.apiKey || "not-needed"]);
      }
    } else if (p === "kimi-coding") {
      // Kimi Code subscription. pi's catalog model carries the full request
      // shape (api "anthropic-messages", api.kimi.com/coding baseUrl); auth is
      // the OAuth credential in the shared encrypted store — pi's per-prompt
      // getAuth() refreshes it under the store's file lock and re-persists
      // rotated refresh tokens (toAuth returns the Authorization: Bearer
      // header). No runtime API key here (an override would bypass that refresh
      // path, and any stale merged apiKey belongs to a previous provider).
      model = builtinModel("kimi-coding", mid);
      if (!model) {
        // Non-catalog id — a leftover model id from a previous provider, or a
        // Kimi model newer than pi's catalog. Send it on a catalog-shaped
        // template instead of hard-failing: the backend's own "invalid model"
        // error is actionable and new Kimi models keep working before a pi bump.
        const template = builtinModel("kimi-coding", "k3");
        console.warn(`[kimi] Model "${mid}" is not in pi's Kimi catalog — passing it to the backend as-is.`);
        model = {
          id: mid, name: mid,
          api: "anthropic-messages", provider: "kimi-coding",
          baseUrl: template?.baseUrl ?? "https://api.kimi.com/coding",
          reasoning: template?.reasoning ?? true,
          input: template?.input ?? ["text", "image"],
          ...(template?.compat ? { compat: template.compat } : {}),
          ...(template?.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
          cost: template?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: template?.contextWindow ?? 262144, maxTokens: template?.maxTokens ?? 65536,
        };
      }
      if (!hasKimiCredential()) throw new Error("Not signed in with Kimi Code. Open Settings → AI Model Config and sign in with Kimi Code.");
      credentials = getKimiCredentialStore();
      console.log(`[kimi] model ${mid}, transport anthropic-messages`);
    } else if (p === "openai-codex") {
      // ChatGPT subscription (Codex backend). pi's catalog model carries the
      // full request shape (api "openai-codex-responses", chatgpt.com baseUrl);
      // auth is the OAuth credential in the shared encrypted store — pi's
      // per-prompt getAuth() refreshes it under the store's file lock and
      // re-persists rotated refresh tokens. No runtime API key here: an
      // override would bypass that refresh path (and any stale merged apiKey
      // from vca-settings.json belongs to a previous provider anyway).
      model = builtinModel("openai-codex", mid);
      if (!model) {
        // Non-catalog id — commonly a model id carried over from a previous
        // provider (e.g. an Azure deployment name like "gpt-5.5-2026-04-23"),
        // or a Codex model newer than pi's catalog. Send it through on a
        // catalog-shaped template instead of hard-failing: the backend's own
        // "invalid model" error is actionable, and new Codex models keep
        // working before a pi bump.
        const template = builtinModel("openai-codex", "gpt-5.5");
        console.warn(`[codex] Model "${mid}" is not in pi's Codex catalog — passing it to the backend as-is.`);
        model = {
          id: mid, name: mid,
          api: "openai-codex-responses", provider: "openai-codex",
          baseUrl: template?.baseUrl ?? "https://chatgpt.com/backend-api",
          reasoning: template?.reasoning ?? true,
          input: template?.input ?? ["text", "image"],
          ...(template?.compat ? { compat: template.compat } : {}),
          ...(template?.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: template?.contextWindow ?? 272000, maxTokens: template?.maxTokens ?? 128000,
        };
      }
      if (!hasCodexCredential()) throw new Error("Not signed in with ChatGPT. Open Settings → AI Model Config and sign in with ChatGPT.");
      credentials = getCodexCredentialStore();
      console.log(`[codex] model ${mid}, transport sse`);
    } else if (p === "google") {
      // Google AI Studio (Gemini). pi's catalog model carries the full request
      // shape (api "google-generative-ai", generativelanguage.googleapis.com
      // baseUrl). Auth is a static API key registered as a runtime key below.
      model = builtinModel("google", mid);
      if (!model) {
        // Non-catalog id — a Gemini model newer than pi's catalog, or an id
        // carried over from a previous provider. Send it on a catalog-shaped
        // template instead of hard-failing: the backend's own "invalid model"
        // error is actionable and new Gemini models keep working before a pi bump.
        const template = builtinModel("google", "gemini-2.5-pro");
        console.warn(`[google] Model "${mid}" is not in pi's Google catalog — passing it to the backend as-is.`);
        model = {
          id: mid, name: mid,
          api: "google-generative-ai", provider: "google",
          baseUrl: template?.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
          reasoning: template?.reasoning ?? true,
          input: template?.input ?? ["text", "image"],
          ...(template?.compat ? { compat: template.compat } : {}),
          ...(template?.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
          cost: template?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: template?.contextWindow ?? 1048576, maxTokens: template?.maxTokens ?? 65536,
        };
      }
      if (llmConfig.apiKey) runtimeApiKeys.push(["google", llmConfig.apiKey]);
      console.log(`[google] model ${mid}, transport google-generative-ai`);
    } else {
      model = builtinModel(p, mid);
      if (!model) throw new Error(`Unknown model "${mid}" for provider "${p}". Select a model the provider supports in Settings.`);
      if (llmConfig.apiKey) runtimeApiKeys.push([p, llmConfig.apiKey]);
    }
  } else {
    const { provider, modelId } = getProviderAndModel();
    const mid = requireModelId(modelId, "Set the MODEL environment variable (and optionally PROVIDER), or configure an LLM provider in Settings.");
    model = builtinModel(provider, mid);
    if (!model) throw new Error(`Unknown model "${mid}" for provider "${provider}". Check the MODEL/PROVIDER environment variables.`);
    const effectiveKey = apiKey || getApiKeyFromEnv(provider);
    if (effectiveKey) runtimeApiKeys.push([provider, effectiveKey]);
  }

  // Admin-set context/output overrides (Settings → AI Model Config). They win
  // over pi's catalog metadata and the per-branch fallbacks above, so a custom
  // deployment name whose id isn't in pi's catalog can still declare its true
  // context window (e.g. 1,000,000) — otherwise it's capped at the 200K/128K
  // fallback, triggering premature compaction and a wrong context-usage %.
  // Spread into a copy rather than mutating: for the catalog-lookup branches
  // `model` is a shared registry object, and mutating it would leak the
  // override into every later resolution.
  const storedSettings = getCachedVcaSettings();
  const ctxOverride = tokenOverride(storedSettings.llmContextWindow);
  const maxOverride = tokenOverride(storedSettings.llmMaxTokens);
  if (model && (ctxOverride || maxOverride)) {
    model = {
      ...model,
      ...(ctxOverride ? { contextWindow: ctxOverride } : {}),
      ...(maxOverride ? { maxTokens: maxOverride } : {}),
    };
  }

  return { model, thinkingLevel, runtimeApiKeys, credentials };
}

async function resolveLlmModel(apiKey?: string, llmConfig?: UserLLMConfig): Promise<{ model: any; runtime: ModelRuntime; thinkingLevel: any; runtimeApiKeys: Array<[provider: string, key: string]>; credentials: CredentialStore | undefined }> {
  const { model, thinkingLevel, runtimeApiKeys, credentials } = await resolveLlmModelParts(apiKey, llmConfig);

  // Hermetic per-resolution runtime: modelsPath null / network off means no
  // ~/.pi config files are read and no catalog endpoints are fetched — VCA
  // hand-builds its models above. Request auth resolves from the runtime API
  // key (or ambient env vars) and, for codex, the shared encrypted OAuth store.
  const runtime = await ModelRuntime.create({
    credentials: credentials ?? new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  for (const [provider, key] of runtimeApiKeys) {
    await runtime.setRuntimeApiKey(provider, key);
  }

  return { model, runtime, thinkingLevel, runtimeApiKeys, credentials };
}

// Case-insensitive on Windows; pi's context-file walk builds candidate paths
// with path.resolve/join off the cwd we pass it, so a lexical compare against
// path.resolve(workspacePath) matches exactly the paths it produces.
function isInsideWorkspace(filePath: string, workspacePath: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const root = norm(workspacePath);
  const target = norm(filePath);
  return target === root || target.startsWith(root + path.sep);
}

async function createSessionLocked(userId: string, projectId: string, chatId: string, apiKey?: string, llmConfig?: UserLLMConfig): Promise<ManagedSession> {
  const key = makeSessionKey(userId, projectId, chatId);
  // Re-check after acquiring the lock — another waiter may have populated it
  // while we were queued (unlikely with the inflight check above, but cheap).
  const existing = sessions.get(key);
  if (existing) return existing;

  const workspacePath = await getWorkspacePath(userId, projectId);

  // Ghost-share guard: for a share (owner != viewer), workspacePath is the
  // OWNER's dir. If it no longer exists (owner deleted the project but this
  // viewer's share entry survived), refuse instead of letting initWorkspace
  // silently fabricate a fresh template workspace inside the owner's tree.
  const ownerUserId = await resolveOwnerUserId(userId, projectId);
  if (ownerUserId !== userId) {
    const st = await fs.stat(workspacePath).catch(() => null);
    if (!st?.isDirectory()) {
      const err: any = new Error("This shared project no longer exists — its owner has deleted it. Remove it from your gallery.");
      err.code = "STALE_SHARE";
      err.status = 410;
      throw err;
    }
  }

  await initWorkspace(workspacePath, projectId);

  const { model, runtime, thinkingLevel } = await resolveLlmModel(apiKey, llmConfig);

  // Codex rides SSE: pi's default "auto" transport tries WebSocket first,
  // which corporate middleboxes routinely break; SSE uses the same fetch
  // channel the ChatGPT sign-in already proved works.
  const settingsManager = SettingsManager.inMemory(
    model?.provider === "openai-codex" ? { transport: "sse" } : undefined,
  );
  // Packaged desktop: ship Git Bash under resources/runtime/git and point pi's
  // bash tool at it, so the agent's shell commands work without a system Git
  // install (MinGit-style bundles have no bash, hence the "/bin/bash not found"
  // failures). No-op in dev/containers (returns null → pi uses the system bash,
  // e.g. /bin/bash from the node:24-slim image).
  const bundledBash = bundledBashExe();
  if (bundledBash) {
    settingsManager.setShellPath(bundledBash);
    console.log(`[shell] pi bash tool using bundled Git Bash: ${bundledBash}`);
  }

  const skillsDir = getSkillsDir(userId);
  await fs.mkdir(skillsDir, { recursive: true });
  await seedDefaultSkills(skillsDir);

  // Sync per-project active skills. Best-effort: skills are an enhancement, so
  // a sync failure (e.g. an SMB lock on a network WORKSPACES_ROOT) must not
  // abort session creation — the agent runs with whatever is on disk.
  try {
    await syncProjectSkills(userId, projectId);
  } catch (err) {
    console.warn(`[skills] sync failed for ${userId}:${projectId} — continuing with on-disk skills:`, err);
  }
  const projectSkillsDir = await getProjectSkillsDir(userId, projectId);

  // Log skills dir contents for debugging
  try {
    const entries = await fs.readdir(projectSkillsDir, { withFileTypes: true });
    console.log(`[skills] projectSkillsDir: ${projectSkillsDir}`);
    console.log(`[skills] contents:`, entries.map(e => `${e.name} (${e.isDirectory() ? 'dir' : 'file'})`));
    for (const e of entries) {
      if (e.isDirectory()) {
        const skillMd = path.join(projectSkillsDir, e.name, "SKILL.md");
        try {
          await fs.access(skillMd);
          console.log(`[skills]   ${e.name}/SKILL.md exists`);
        } catch {
          console.log(`[skills]   ${e.name}/SKILL.md MISSING`);
        }
      }
    }
  } catch (err) {
    console.log(`[skills] Error reading projectSkillsDir:`, err);
  }

  let systemPromptForSession = getSystemPrompt();
  // Template-author per-project instructions appended first; user-editable project memory wins by being last.
  const tplInstructions = await readVcaHook(workspacePath, "instructions");
  if (tplInstructions) {
    systemPromptForSession = `${systemPromptForSession}\n\n<project_instructions>\n${tplInstructions}\n</project_instructions>`;
  }
  try {
    const memory = (await fs.readFile(path.join(workspacePath, "project.md"), "utf-8")).trim();
    if (memory) {
      systemPromptForSession = `${systemPromptForSession}\n\n<project_memory>\n${memory}\n</project_memory>`;
    }
  } catch { /* no project.md yet — fine */ }

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir: getAgentDir(),
    settingsManager,
    systemPrompt: systemPromptForSession,
    // Cross-project isolation: pi's context-file discovery walks EVERY
    // ancestor of cwd — WORKSPACES_ROOT/<userId>/ (shared across the user's
    // projects) and WORKSPACES_ROOT/ (shared across ALL users) — plus the
    // global agent dir. The agent's bash is not filesystem-confined
    // (agent-sandbox.ts), so an AGENTS.md planted one level up in project A
    // would be injected into every project's system prompt. Keep only
    // context files inside this workspace (the template's CLAUDE.md keeps
    // working, with pi's own precedence and formatting).
    agentsFilesOverride: ({ agentsFiles }) => ({
      agentsFiles: agentsFiles.filter((f) => isInsideWorkspace(f.path, workspacePath)),
    }),
    // Same reasoning: never discover APPEND_SYSTEM.md (global agent dir or
    // workspace .pi/) — VCA composes its system prompt itself above.
    appendSystemPrompt: [],
    noExtensions: true,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: [projectSkillsDir],
  });
  await resourceLoader.reload();

  // Log what skills were loaded
  const loadedSkills = resourceLoader.getSkills();
  console.log(`[skills] Loaded skills:`, loadedSkills.skills.map(s => s.name));
  if (loadedSkills.diagnostics.length) console.log(`[skills] Diagnostics:`, loadedSkills.diagnostics);
  // Context files are system-prompt content; log what survived the workspace
  // filter so cross-project ingestion is observable in production logs.
  const ctxFiles = resourceLoader.getAgentsFiles().agentsFiles;
  console.log(`[context] injected context files:`, ctxFiles.map((f) => f.path));

  // Use a ref so tools can access the managed session after creation
  let managedRef: ManagedSession | null = null;
  const askQuestionTool = createAskQuestionTool(() => managedRef!);
  const renameChatTool = createRenameChatTool(() => managedRef!);

  const serverLogTool = createServerLogTool(() => managedRef!);
  const restartAppProcessTool = createRestartAppProcessTool(() => managedRef!);
  const startNewChatTool = createStartNewChatTool(() => managedRef!);
  // Phase 1 sandbox: hardened bash/read/write/edit/grep/find/ls that scrub the
  // shell env of secrets and confine the file tools to this workspace's real
  // root (shared projects already resolve to the owner's tree via the owner-aware
  // path accessors). These override pi's built-ins of the same name — they must
  // be in customTools.
  const sandboxRealRoot = await resolveWorkspaceRealRoot(workspacePath);
  const hardenedTools = buildHardenedToolDefinitions(workspacePath, sandboxRealRoot, {
    shellPath: bundledBash ?? undefined,
  });
  const customTools: ToolDefinition[] = [...hardenedTools, askQuestionTool, renameChatTool, serverLogTool, restartAppProcessTool, createWaitTool(), startNewChatTool];
  customTools.push(...createRequirementTools(() => managedRef!));
  customTools.push(...createSkillTools(() => managedRef!));
  // Let the agent switch its own LLM profile / reasoning effort mid-run (this
  // chat's session only) without stopping — see llm-config-tools.ts.
  customTools.push(...createLlmConfigTools(() => managedRef!));
  // Web tools follow the configured LLM provider (see web-tools-config.ts).
  // web_fetch's direct path extracts with this session's own model, so hand it
  // the resolved model plus a key getter. Resolved per fetch (not captured):
  // codex access tokens expire mid-session and getApiKey() refreshes them.
  const webFetchTool = createWebFetchTool({
    model,
    getApiKey: () => runtime.getAuth(model).then((r) => r?.auth.apiKey).catch(() => undefined),
  });
  if (webFetchTool) customTools.push(webFetchTool);
  const webSearchTool = createWebSearchTool();
  if (webSearchTool) customTools.push(webSearchTool);
  // Electron-only: captures the running app (visible preview pane or a hidden
  // window) and returns the image to the model.
  const screenshotTool = createScreenshotTool(() => managedRef!, model);
  if (screenshotTool) customTools.push(screenshotTool);

  try {
    const mcpServers = await readMcpServers();
    const mcpTools = await loadMcpToolsForAllEnabled(mcpServers);
    if (mcpTools.length) {
      console.log(`[mcp] Adding ${mcpTools.length} tool(s) from ${mcpServers.filter((s) => s.enabled).length} server(s)`);
      customTools.push(...mcpTools);
    }
  } catch (err) {
    console.warn("[mcp] Failed to load MCP tools:", err);
  }

  const sessionManager = await createChatSessionManager(userId, projectId, chatId, workspacePath, model);

  const { session } = await createAgentSession({
    cwd: workspacePath,
    model,
    thinkingLevel,
    modelRuntime: runtime,
    sessionManager,
    settingsManager,
    resourceLoader,
    customTools,
  });

  const managed: ManagedSession = {
    session,
    sessionManager,
    resourceLoader,
    sseClients: new Map(),
    projectId,
    chatId,
    userId,
    workspacePath,
    pendingQuestions: new Map(),
    pendingScreenshots: new Map(),
    userDisplayTexts: [],
    userAuthors: [],
    thinkingLevel,
  };
  managedRef = managed;
  await hydrateManagedSessionDisplayMetadata(managed);

  session.subscribe((event) => forwardAgentEvent(managed, event));
  sessions.set(key, managed);

  // Attach any pending SSE clients
  const pending = pendingSSEClients.get(key);
  if (pending) {
    for (const [id, client] of pending) {
      managed.sseClients.set(id, client);
    }
    pendingSSEClients.delete(key);
  }

  return managed;
}

function getApiKeyFromEnv(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "azure") return process.env.AZURE_AI_FOUNDRY_API_KEY;
  if (provider === "azure-openai-responses") return process.env.AZURE_OPENAI_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "google") return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return undefined;
}

export interface ImageAttachment {
  type: "image";
  mimeType: string;
  data: string; // base64
}

export async function sendPrompt(userId: string, projectId: string, chatId: string, text: string, apiKey?: string, images?: ImageAttachment[], llmConfig?: UserLLMConfig, displayText?: string, authorName?: string): Promise<void> {
  // Project-level prompt gate. The /prompt route pre-checks; this is the
  // authoritative atomic claim. Without this, two chats in the same project
  // race on workspace files, diagram .md writes, and shell commands.
  if (!tryClaimProjectPromptSlot(userId, projectId, chatId)) {
    const activeChatId = getProjectActiveChatId(userId, projectId);
    const existing = sessions.get(makeSessionKey(userId, projectId, chatId));
    if (existing) {
      sendSSEEvent(existing, "error", {
        message: "Another chat in this project is currently running an agent task. Wait for it to finish or abort it first.",
        status: "PROJECT_BUSY",
        activeChatId,
      });
    }
    return;
  }

  // The claim above only covers this process. When WORKSPACES_ROOT is on a
  // fileserver or a synced folder, a colleague's VCA resolves to the very same
  // workspace directory, and nothing downstream (git, chat JSONL, projects.json)
  // survives two agents writing at once. Take the cross-machine lease too, and
  // give the slot straight back if someone else holds it.
  if (await leasingEnabled()) {
    const workspacePath = await getWorkspacePath(userId, projectId);
    const lease = await acquireLease(workspacePath, describeSelf(userId));
    if (!lease.ok) {
      releaseProjectPromptSlot(userId, projectId, chatId);
      const who = lease.holder ? `${lease.holder.user} (${lease.holder.machine})` : "another VCA instance";
      const existing = sessions.get(makeSessionKey(userId, projectId, chatId));
      if (existing) {
        sendSSEEvent(existing, "error", {
          message: `This project is currently open by ${who}. Only one person can work on a project at a time.`,
          status: "PROJECT_LOCKED",
          holder: lease.holder,
        });
      }
      return;
    }
  }

  // Notify every chat in the project (including viewing-only chats whose
  // SSE clients are still pending) that the slot is now held — fire before
  // the slow getOrCreateSession await so other tabs disable submit during
  // session init too.
  broadcastSSEEvent(userId, projectId, "project_lock_acquired", { chatId });

  // Captures the async work spawned from the agent_end subscription so we
  // can hold the project slot until that work (auto-commit, diagram .md
  // sync, preview restart, message persistence) actually finishes.
  let agentEndComplete: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | null = null;
  let sessionReady = false;

  try {
    const managed = await getOrCreateSession(userId, projectId, chatId, apiKey, llmConfig);
    sessionReady = true;

    // If a previous turn is still blocked on an unanswered ask_question or an
    // unfinished preview screenshot (user reloaded the page or ignored the
    // prompt and typed a new message), reject the pending promises and abort
    // the stuck turn so this new prompt can run.
    if (managed.pendingQuestions.size > 0 || managed.pendingScreenshots.size > 0) {
      for (const [, q] of managed.pendingQuestions) {
        q.reject(new Error("User moved on without answering"));
      }
      managed.pendingQuestions.clear();
      for (const [, s] of managed.pendingScreenshots) {
        s.reject(new Error("User moved on before the screenshot completed"));
      }
      managed.pendingScreenshots.clear();
      if (managed.session.isStreaming) {
        try {
          await managed.session.abort();
        } catch { /* abort errors are non-fatal */ }
      }
    }

    // Subscribe to message_end (per-message disk save) and agent_end (commit,
    // diagrams, preview restart). The outer callback is sync; the long async
    // work for agent_end is captured into agentEndComplete so the finally
    // block can await it before releasing the project slot.
    unsubscribe = managed.session.subscribe((event) => {
      // Persist after every message commit so a reload between message_end
      // and agent_end — or a Container App restart — doesn't lose the latest
      // turn. The SDK pushes onto state.messages before dispatching
      // message_end, so parseSessionMessages sees the finalized message.
      // Fire-and-forget is safe because saveChatMessagesToDisk serializes
      // writes per chat via chatSaveLocks.
      if (event.type === "message_end") {
        void saveChatMessagesToDisk(userId, projectId, chatId, parseSessionMessages(managed));
        return;
      }
      if (event.type !== "agent_end") return;
      const unsub = unsubscribe;
      unsubscribe = null;
      if (unsub) { try { unsub(); } catch { /* ignore */ } }
      agentEndComplete = (async () => {
        // Sync all diagrams first so the .md files land in the same commit as the code change.
        try {
          const ucData = await getUseCaseData(userId, projectId);
          if (ucData) {
            const mermaid = generateUseCaseMermaid(ucData);
            if (mermaid) {
              await fs.writeFile(path.join(managed.workspacePath, "usecase.md"), `# Use-Case Diagram\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
            }
            sendSSEEvent(managed, "usecase_updated", { data: ucData, mermaid });
          }
        } catch { /* ignore if no diagram */ }
        try {
          const depData = await getDeploymentData(userId, projectId);
          if (depData) {
            const mermaid = generateDeploymentMermaid(depData);
            if (mermaid) {
              await fs.writeFile(path.join(managed.workspacePath, "deployment.md"), `# Deployment Diagram\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
            }
            sendSSEEvent(managed, "deployment_updated", { data: depData, mermaid });
          }
        } catch { /* ignore if no diagram */ }
        try {
          const compData = await getComponentData(userId, projectId);
          if (compData) {
            const mermaid = generateComponentMermaid(compData);
            if (mermaid) {
              await fs.writeFile(path.join(managed.workspacePath, "component.md"), `# Component Diagram\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
            }
            sendSSEEvent(managed, "component_updated", { data: compData, mermaid });
          }
        } catch { /* ignore if no diagram */ }
        try {
          const actList = await listActivityDiagrams(userId, projectId);
          for (const entry of actList) {
            const actData = await getActivityData(userId, projectId, entry.id);
            if (actData) {
              const mermaid = generateActivityMermaid(actData);
              if (mermaid) {
                await fs.writeFile(path.join(managed.workspacePath, `activity-${entry.id}.md`), `# Activity Diagram: ${actData.name}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
              }
              sendSSEEvent(managed, "activity_updated", { diagramId: entry.id, data: actData, mermaid });
            }
          }
        } catch { /* ignore if no diagram */ }
        try {
          const erList = await listERDiagrams(userId, projectId);
          for (const entry of erList) {
            const erData = await getERData(userId, projectId, entry.id);
            if (erData) {
              const mermaid = generateERMermaid(erData);
              if (mermaid) {
                await fs.writeFile(path.join(managed.workspacePath, `er-${entry.id}.md`), `# ER Diagram: ${erData.name}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`, "utf-8");
              }
              sendSSEEvent(managed, "er_updated", { diagramId: entry.id, data: erData, mermaid });
            }
          }
        } catch { /* ignore if no diagram */ }
        // Persist the finalized turn BEFORE the slow auto-commit + preview
        // restart so a reload during those steps can't lose the chat. The
        // per-message_end save above usually already covered this — repeating
        // it here is cheap (atomic write, serialized) and acts as the
        // canonical end-of-turn checkpoint.
        await saveChatMessagesToDisk(userId, projectId, chatId, parseSessionMessages(managed));
        // Single commit per turn, message generated from the staged diff.
        await autoCommitWithGeneratedMessage(managed.workspacePath, text);
        // Restart the preview deterministically so it matches the committed files.
        const projectKey = makeProjectKey(managed.userId, managed.projectId);
        await restartAppProcess(managed.workspacePath, projectKey).catch(err =>
          console.warn("[process] Failed to restart app process:", err)
        );
      })();
    });

    // Indexed set, not push: the slot is the position this prompt's user
    // message will take in the transcript, so a prior prompt that never made
    // it into the session (init failure, abort) can't shift the attribution.
    const nextUserIdx = countSessionUserMessages(managed);
    managed.userDisplayTexts[nextUserIdx] = displayText ?? text;
    managed.userAuthors[nextUserIdx] = authorName ?? "";

    const promptOptions: any = {};
    if (images && images.length > 0) {
      promptOptions.images = images;
    }
    if (managed.session.isStreaming) {
      promptOptions.streamingBehavior = "followUp";
    }

    // Clear any stale buffered error before this turn starts streaming.
    managed.pendingLlmError = undefined;
    // Drop any pending compaction-retry from a prior turn; this turn's own
    // pre-prompt / post-run compaction check will re-evaluate from scratch.
    clearCompactionRetry(managed);
    try {
      await managed.session.prompt(text, Object.keys(promptOptions).length > 0 ? promptOptions : undefined);
    } catch (err: any) {
      managed.pendingLlmError = undefined;
      const errMsg = err?.error?.message || err?.message || String(err);
      const status = err?.status || "unknown";
      const authShaped = isAuthErrorStatus(status) || looksLikeAuthMessage(errMsg);
      const classified = classifyLlmError(managed.session.model?.provider, errMsg, authShaped);
      if (classified.code === "CONTEXT_COMPACTED") {
        // Benign: the compaction already succeeded (compaction_end was emitted)
        // and only the SDK's phantom continuation failed. Surface a calm notice
        // and fall through to normal end-of-turn finalization — do NOT re-throw.
        console.warn(`[LLM] Post-compaction continuation skipped — ${errMsg}`);
        sendSSEEvent(managed, "error", { message: classified.message, status: "info", code: classified.code });
      } else {
        console.error(`[LLM] Request failed — ${formatErrorDetail(err)}`);
        sendSSEEvent(managed, "error", { message: classified.message, status, ...(classified.code ? { code: classified.code } : {}) });
        throw err;
      }
    }
    // The turn finished without throwing. If an LLM error was buffered during it
    // — a non-retryable failure that wasn't surfaced via auto_retry_end — it's
    // now final, so show it in the chat.
    if (managed.pendingLlmError) {
      sendSSEEvent(managed, "error", managed.pendingLlmError);
      managed.pendingLlmError = undefined;
    }

    // Wait for the agent_end async cleanup before releasing the slot — the
    // next chat shouldn't start editing while this turn's auto-commit and
    // diagram .md writes are still in progress.
    await agentEndComplete.catch((err) => {
      console.warn("[agent_end] post-turn work failed:", err);
    });
  } catch (err: any) {
    // Failures before the session exists (resolveLlmModel — wrong model, not
    // signed in —, workspace init, createAgentSession) previously died in the
    // /prompt route's console.error and the chat showed nothing at all.
    // Broadcast them so the user sees why. Failures after the session exists
    // were already surfaced by the inner handlers (SSE "error" events).
    if (!sessionReady) {
      const raw = err?.message || String(err);
      console.error(`[prompt] Session creation failed — ${formatErrorDetail(err)}`);
      const classified = classifyLlmError(getLLMConfig().provider, raw);
      broadcastSSEEvent(userId, projectId, "error", { message: classified.message, status: "error", ...(classified.code ? { code: classified.code } : {}) });
    }
    throw err;
  } finally {
    if (unsubscribe) {
      try { unsubscribe(); } catch { /* ignore */ }
    }
    releaseProjectPromptSlot(userId, projectId, chatId);
    // Only broadcast the release once the slot is actually free (refcount 0
    // for same-chat re-entry). The cross-machine lease follows the same rule —
    // a followUp prompt re-enters with the slot still held, and dropping the
    // lease there would let a peer in mid-turn.
    if (getProjectActiveChatId(userId, projectId) === null) {
      broadcastSSEEvent(userId, projectId, "project_lock_released", { chatId });
      try {
        await releaseLease(await getWorkspacePath(userId, projectId));
      } catch { /* never let lease cleanup mask the turn's own outcome */ }
    }
  }
}

export async function submitPromptAndAwaitCompletion(
  userId: string,
  projectId: string,
  chatId: string,
  prompt: string,
  opts?: { displayText?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ ok: boolean; error?: string }> {
  // sendPrompt swallows the project-busy case (emits an SSE error and returns).
  // Pre-check so blocking callers (predeploy/postdeploy) surface it as a failure.
  const active = getProjectActiveChatId(userId, projectId);
  if (active && active !== chatId) {
    return { ok: false, error: `PROJECT_BUSY: chat ${active} is currently running an agent` };
  }
  let timer: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | null = null;
  try {
    const races: Promise<never>[] = [];
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      races.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abortSession(userId, projectId, chatId).catch(() => { /* ignore */ });
          reject(new Error(`Agent timed out after ${opts!.timeoutMs}ms`));
        }, opts.timeoutMs);
      }));
    }
    if (opts?.signal) {
      races.push(new Promise<never>((_, reject) => {
        if (opts.signal!.aborted) { reject(new Error("Aborted")); return; }
        abortListener = () => {
          abortSession(userId, projectId, chatId).catch(() => { /* ignore */ });
          reject(new Error("Aborted"));
        };
        opts.signal!.addEventListener("abort", abortListener, { once: true });
      }));
    }
    await Promise.race([
      sendPrompt(userId, projectId, chatId, prompt, undefined, undefined, undefined, opts?.displayText),
      ...races,
    ]);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener && opts?.signal) {
      try { opts.signal.removeEventListener("abort", abortListener); } catch { /* ignore */ }
    }
  }
}

export function getSessionStatus(userId: string, projectId: string, chatId: string): {
  isStreaming: boolean;
  projectActiveChatId: string | null;
  // Effective LLM config of THIS chat's live session (may differ from the
  // deployment defaults after the agent ran set_llm_config). null when there is
  // no live session yet — the client then falls back to the global defaults.
  thinkingLevel: string | null;
  activeProfileId: string | null;
  provider: string | null;
  modelId: string | null;
} {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  const model = managed?.session.model as any;
  return {
    isStreaming: managed?.session.isStreaming ?? false,
    projectActiveChatId: getProjectActiveChatId(userId, projectId),
    thinkingLevel: managed?.thinkingLevel ?? managed?.session.thinkingLevel ?? null,
    activeProfileId: managed?.activeProfileId ?? null,
    provider: model?.provider ?? null,
    modelId: model?.id ?? null,
  };
}

// Snapshot of the assistant message currently mid-stream, so a client that
// connects during a turn (page reload) can rebuild the live placeholder. Returns
// null unless a turn is actively streaming an uncommitted assistant message with
// some text or thinking. During tool execution there is no streamingMessage
// (the prior message already committed), so this returns null and the committed
// history + tool_end handle restoration on their own.
export function getStreamingResume(userId: string, projectId: string, chatId: string): { startTime: number; text: string; thinking: string } | null {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (!managed || !managed.session.isStreaming || !managed.streamingMessage) return null;
  const content = (managed.streamingMessage as any).content;
  if (!Array.isArray(content)) return null;
  let text = "";
  let thinking = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "thinking" && !block.redacted) thinking += block.thinking;
  }
  if (!text && !thinking) return null;
  return { startTime: managed.currentMessageStartTime ?? Date.now(), text, thinking };
}

export async function abortSession(userId: string, projectId: string, chatId: string): Promise<void> {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (managed) {
    // Reject all pending questions/screenshots so the tool promises don't hang
    for (const [id, q] of managed.pendingQuestions) {
      q.reject(new Error("Session aborted"));
    }
    managed.pendingQuestions.clear();
    for (const [, s] of managed.pendingScreenshots) {
      s.reject(new Error("Session aborted"));
    }
    managed.pendingScreenshots.clear();
    await managed.session.abort();
  }
}

export function answerQuestion(userId: string, projectId: string, chatId: string, toolCallId: string, answer: string): void {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (!managed) throw new Error("No active session for this chat");
  const pending = managed.pendingQuestions.get(toolCallId);
  if (!pending) throw new Error("No pending question with this ID");
  managed.pendingQuestions.delete(toolCallId);
  pending.resolve(answer);
}

// Resolves a screenshot tool call blocked on the browser capturing the preview
// pane. Throws when nothing is pending for the ID — with several tabs open the
// first POST wins and the rest land here (the client swallows the 500).
export function resolveScreenshotResult(userId: string, projectId: string, chatId: string, toolCallId: string, result: ScreenshotClientResult): void {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (!managed) throw new Error("No active session for this chat");
  const pending = managed.pendingScreenshots.get(toolCallId);
  if (!pending) throw new Error("No pending screenshot with this ID");
  managed.pendingScreenshots.delete(toolCallId);
  pending.resolve(result);
}

export async function compactSession(userId: string, projectId: string, chatId: string): Promise<void> {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (!managed) throw new Error("No active session for this chat");
  // Explicit user action gets a fresh retry budget.
  clearCompactionRetry(managed);
  try {
    await managed.session.compact();
  } catch {
    // A failed summarization is already surfaced — and retried — via the
    // compaction_end event in forwardAgentEvent. The SSE channel is the single
    // source of truth for the outcome, so don't double-report through HTTP.
  }
  emitContextUsage(managed);
}

export async function resetUserSessions(userId: string): Promise<void> {
  // Abort every chat session belonging to this user, and stop each unique
  // project's app process exactly once.
  const stoppedProjects = new Set<string>();
  for (const [key, managed] of sessions) {
    if (managed.userId !== userId) continue;
    const projectKey = makeProjectKey(userId, managed.projectId);
    if (!stoppedProjects.has(projectKey)) {
      stoppedProjects.add(projectKey);
      await stopAppProcess(projectKey);
    }
    try { await managed.session.abort(); } catch {}
    sessions.delete(key);
  }
}

// Commit hashes arrive from API callers. Passing a real argv already removes the
// shell, but git itself still reads a leading "-" as an option — and on some
// subcommands `--upload-pack=<cmd>` executes it. Validate the shape first.
const COMMIT_HASH_RE = /^[0-9a-fA-F]{7,40}$/;

function checkedCommitHash(hash: string): string {
  if (!COMMIT_HASH_RE.test(hash)) throw new Error(`Invalid commit hash: ${hash}`);
  return hash;
}

export async function rollback(userId: string, projectId: string, chatId: string, commitHash?: string): Promise<number> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  return withGitLock(workspacePath, async () => {
    if (commitHash) {
      await git(["reset", "--hard", checkedCommitHash(commitHash)], { cwd: workspacePath });
    } else {
      await git(["reset", "--hard", "HEAD~1"], { cwd: workspacePath });
    }

    // Force-push to remote if configured
    try {
      const { stdout } = await git(["remote", "get-url", "origin"], { cwd: workspacePath });
      if (stdout.trim()) {
        await git(["push", "--force", "origin", "HEAD"], { cwd: workspacePath });
        console.log("[rollback] Force-pushed to remote");
      }
    } catch {
      // No remote configured, skip
    }

    // Count remaining commits (excluding "Initial commit") to determine conversation turns
    let turnCount = 0;
    try {
      const { stdout } = await git(["log", "--oneline"], { cwd: workspacePath });
      const lines = stdout.trim().split("\n").filter(l => l.trim());
      // Each non-initial commit corresponds to one conversation turn
      turnCount = lines.filter(l => !l.includes("Initial commit")).length;
    } catch {
      // Ignore
    }

    // Truncate the current chat's messages to match remaining turns. With
    // multi-chat the commit/turn mapping is no longer one-to-one across chats,
    // but we keep this best-effort behavior for the chat that triggered rollback.
    const messages = await loadChatMessagesFromDisk(userId, projectId, chatId);
    if (messages.length > 0) {
      let userMsgsSeen = 0;
      let cutIndex = messages.length;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "user") {
          userMsgsSeen++;
          if (userMsgsSeen > turnCount) {
            cutIndex = i;
            break;
          }
        }
      }
      const truncated = messages.slice(0, cutIndex);
      await saveChatMessagesToDisk(userId, projectId, chatId, truncated, { allowShrink: true });
    }
    await deleteChatSdkSession(userId, projectId, chatId);

    // Clear the current chat's in-memory session, then stop and restart the
    // (project-level) app process so the preview reflects the rolled-back state.
    const sessionKey = makeSessionKey(userId, projectId, chatId);
    const projectKey = makeProjectKey(userId, projectId);
    await stopAppProcess(projectKey);
    const managed = sessions.get(sessionKey);
    if (managed) {
      managed.session.dispose();
      if (managed.sseClients.size > 0) {
        pendingSSEClients.set(sessionKey, new Map(managed.sseClients));
      }
      sessions.delete(sessionKey);
    }
    await startAppProcess(workspacePath, projectKey);

    return turnCount;
  });
}

export async function getCommits(userId: string, projectId: string): Promise<{ commits: Array<{ hash: string; message: string; date: string; tags: string[] }>; headHash: string; latestHash: string }> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  try {
    // %D carries the ref decoration (branches + tags) for each commit; we parse
    // out the `tag: <name>` entries so the UI can show a commit's version tag.
    const { stdout } = await git(
      ["log", "--all", "--format=%H%x1f%B%x1f%aI%x1f%D%x1e", "--max-count=50"],
      { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 }
    );
    const commits = stdout.split("\x1e").map(s => s.trim()).filter(Boolean).map(record => {
      const [hash, message, date, refs] = record.split("\x1f");
      const tags = (refs || "")
        .split(",")
        .map(s => s.trim())
        .filter(s => s.startsWith("tag: "))
        .map(s => s.slice("tag: ".length).trim())
        .filter(Boolean);
      return { hash, message: (message || "").trim(), date, tags };
    });
    const { stdout: headOut } = await git(["rev-parse", "HEAD"], { cwd: workspacePath });
    const headHash = headOut.trim();
    const latestHash = commits.length > 0 ? commits[0].hash : headHash;
    return { commits, headHash, latestHash };
  } catch {
    return { commits: [], headHash: "", latestHash: "" };
  }
}

export async function checkoutCommit(userId: string, projectId: string, commitHash: string): Promise<void> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  const key = makeProjectKey(userId, projectId);
  await withGitLock(workspacePath, async () => {
    await git(["checkout", checkedCommitHash(commitHash)], { cwd: workspacePath });
  });
  // Restart app process so preview reflects the checked-out state
  await stopAppProcess(key);
  await startAppProcess(workspacePath, key);
}

export async function checkoutLatest(userId: string, projectId: string): Promise<void> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  const key = makeProjectKey(userId, projectId);
  await withGitLock(workspacePath, async () => {
    // Get the default branch name (usually main or master)
    try {
      const { stdout } = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: workspacePath });
      const branch = stdout.trim().replace("refs/remotes/origin/", "");
      await git(["checkout", branch], { cwd: workspacePath });
    } catch {
      // No remote HEAD, try main then master
      try {
        await git(["checkout", "main"], { cwd: workspacePath });
      } catch {
        await git(["checkout", "master"], { cwd: workspacePath });
      }
    }
  });
  // Restart app process so preview reflects the latest state
  await stopAppProcess(key);
  await startAppProcess(workspacePath, key);
}

export function addSSEClient(userId: string, projectId: string, chatId: string, client: SSEClient): void {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (managed) {
    managed.sseClients.set(client.id, client);
  } else {
    // Store as pending - will be attached when session is created
    if (!pendingSSEClients.has(key)) {
      pendingSSEClients.set(key, new Map());
    }
    pendingSSEClients.get(key)!.set(client.id, client);
  }
}

export function removeSSEClient(userId: string, projectId: string, chatId: string, clientId: string): void {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (managed) {
    managed.sseClients.delete(clientId);
  }
  const pending = pendingSSEClients.get(key);
  if (pending) {
    pending.delete(clientId);
  }
}

export async function getWorkspacePathForProject(userId: string, projectId: string): Promise<string> {
  return await getWorkspacePath(userId, projectId);
}

async function getLegacyMessagesFilePath(userId: string, projectId: string): Promise<string> {
  return projectPaths.legacyMessages(await resolveOwnerUserId(userId, projectId), projectId);
}

async function getChatsDir(userId: string, projectId: string): Promise<string> {
  return projectPaths.chatsDir(await resolveOwnerUserId(userId, projectId), projectId);
}

async function getChatSdkRootDir(userId: string, projectId: string): Promise<string> {
  return projectPaths.chatSdkRootDir(await resolveOwnerUserId(userId, projectId), projectId);
}

async function getChatSdkDir(userId: string, projectId: string, chatId: string): Promise<string> {
  return projectPaths.chatSdkDir(await resolveOwnerUserId(userId, projectId), projectId, chatId);
}

async function getChatsIndexPath(userId: string, projectId: string): Promise<string> {
  return projectPaths.chatsIndex(await resolveOwnerUserId(userId, projectId), projectId);
}

async function getChatMessagesFilePath(userId: string, projectId: string, chatId: string): Promise<string> {
  return projectPaths.chatMessages(await resolveOwnerUserId(userId, projectId), projectId, chatId);
}

function defaultChatNameRegex(): RegExp {
  return /^chat-(\d+)$/;
}

function nextDefaultChatName(chats: ChatMetadata[]): string {
  let max = 0;
  const re = defaultChatNameRegex();
  for (const c of chats) {
    const m = c.name.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `chat-${max + 1}`;
}

async function readChatsIndex(userId: string, projectId: string): Promise<ChatMetadata[] | null> {
  try {
    const data = await fs.readFile(await getChatsIndexPath(userId, projectId), "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed as ChatMetadata[];
    return null;
  } catch {
    return null;
  }
}

async function writeChatsIndex(userId: string, projectId: string, chats: ChatMetadata[]): Promise<void> {
  await fs.mkdir(await getChatsDir(userId, projectId), { recursive: true });
  await atomicWriteJson(await getChatsIndexPath(userId, projectId), chats, 2);
}

// Lazy migration: if .vca-chats/ doesn't exist but the legacy
// .vca-messages.json does, move the messages into a single chat-1 entry.
// Writes use atomicWriteJson so a crash mid-migration can't truncate the
// new chat file. Caller is expected to hold withChatsIndexLock so concurrent
// requests don't race on the legacy file.
async function migrateLegacyMessagesIfNeeded(userId: string, projectId: string): Promise<ChatMetadata[] | null> {
  const legacyPath = await getLegacyMessagesFilePath(userId, projectId);
  let legacyData: string | null = null;
  try {
    legacyData = await fs.readFile(legacyPath, "utf-8");
  } catch {
    return null;
  }

  // Parse so atomicWriteJson can stringify; if the legacy JSON is corrupt,
  // fall back to an empty array rather than carrying corrupt bytes forward.
  let parsed: unknown[];
  try {
    const raw = JSON.parse(legacyData);
    parsed = Array.isArray(raw) ? raw : [];
  } catch {
    parsed = [];
  }

  const chatId = crypto.randomUUID().slice(0, 8);
  const meta: ChatMetadata = { id: chatId, name: "chat-1", createdAt: new Date().toISOString() };
  await fs.mkdir(await getChatsDir(userId, projectId), { recursive: true });
  await atomicWriteJson(await getChatMessagesFilePath(userId, projectId, chatId), parsed);
  await writeChatsIndex(userId, projectId, [meta]);
  try { await fs.unlink(legacyPath); } catch { /* ignore */ }
  return [meta];
}

// Always returns at least one chat. If the project has no chats and no legacy
// file, creates a fresh chat-1. Caller is expected to hold withChatsIndexLock.
async function ensureChatsIndex(userId: string, projectId: string): Promise<ChatMetadata[]> {
  let chats = await readChatsIndex(userId, projectId);
  if (chats && chats.length > 0) return chats;
  if (!chats) {
    const migrated = await migrateLegacyMessagesIfNeeded(userId, projectId);
    if (migrated) return migrated;
  }
  // Brand-new project, or empty index — create chat-1.
  const meta: ChatMetadata = {
    id: crypto.randomUUID().slice(0, 8),
    name: "chat-1",
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(await getChatsDir(userId, projectId), { recursive: true });
  await atomicWriteJson(await getChatMessagesFilePath(userId, projectId, meta.id), []);
  await writeChatsIndex(userId, projectId, [meta]);
  return [meta];
}

export async function listChats(userId: string, projectId: string): Promise<ChatMetadata[]> {
  return withChatsIndexLock(userId, projectId, () => ensureChatsIndex(userId, projectId));
}

export async function createChat(userId: string, projectId: string, name?: string): Promise<ChatMetadata> {
  return withChatsIndexLock(userId, projectId, async () => {
    const chats = await ensureChatsIndex(userId, projectId);
    const meta: ChatMetadata = {
      id: crypto.randomUUID().slice(0, 8),
      name: name && name.trim() ? name.trim() : nextDefaultChatName(chats),
      createdAt: new Date().toISOString(),
    };
    await atomicWriteJson(await getChatMessagesFilePath(userId, projectId, meta.id), []);
    await writeChatsIndex(userId, projectId, [...chats, meta]);
    return meta;
  });
}

// Returns true if the rename was applied. The LLM rename_chat tool calls this
// with `onlyIfDefault = true` so it doesn't override a name the user has chosen.
export async function renameChatById(userId: string, projectId: string, chatId: string, newName: string, onlyIfDefault = false): Promise<boolean> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("New chat name cannot be empty");
  return withChatsIndexLock(userId, projectId, async () => {
    const chats = await ensureChatsIndex(userId, projectId);
    const idx = chats.findIndex(c => c.id === chatId);
    if (idx < 0) throw new Error("Chat not found");
    if (onlyIfDefault && !defaultChatNameRegex().test(chats[idx].name)) return false;
    chats[idx] = { ...chats[idx], name: trimmed };
    await writeChatsIndex(userId, projectId, chats);
    return true;
  });
}

// Deletes a chat: aborts its session, removes the messages file, drops it from
// the index. If the deleted chat was the last one, auto-creates a fresh chat-1.
export async function deleteChatById(userId: string, projectId: string, chatId: string): Promise<ChatMetadata[]> {
  return withChatsIndexLock(userId, projectId, async () => {
    const chats = await ensureChatsIndex(userId, projectId);
    const idx = chats.findIndex(c => c.id === chatId);
    if (idx < 0) throw new Error("Chat not found");

    const sessionKey = makeSessionKey(userId, projectId, chatId);
    const managed = sessions.get(sessionKey);
    if (managed) {
      try { await managed.session.abort(); } catch {}
      try { managed.session.dispose(); } catch {}
      sessions.delete(sessionKey);
    }
    pendingSSEClients.delete(sessionKey);

    try { await fs.unlink(await getChatMessagesFilePath(userId, projectId, chatId)); } catch { /* ignore */ }
    await deleteChatSdkSession(userId, projectId, chatId);
    chatSavedRowCounts.delete(sessionKey);
    reconciledChats.delete(sessionKey);

    const remaining = chats.filter(c => c.id !== chatId);
    if (remaining.length === 0) {
      const fresh: ChatMetadata = {
        id: crypto.randomUUID().slice(0, 8),
        name: "chat-1",
        createdAt: new Date().toISOString(),
      };
      await atomicWriteJson(await getChatMessagesFilePath(userId, projectId, fresh.id), []);
      remaining.push(fresh);
    }
    await writeChatsIndex(userId, projectId, remaining);
    return remaining;
  });
}

// A pi AgentMessage's own timestamp (ms epoch, set when the message was
// created — survives reloads and the legacy backfill) beats the entry's
// append time; both beat "now" (only reachable for not-yet-persisted tails).
function messageTimestampIso(message: any, entryTimestamp?: string): string {
  const ms = message?.timestamp;
  if (typeof ms === "number" && Number.isFinite(ms)) return new Date(ms).toISOString();
  return entryTimestamp ?? new Date().toISOString();
}

type SessionBranchEntry = ReturnType<SessionManager["getBranch"]>[number];

// Serializes session-tree entries (plus an optional tail of not-yet-persisted
// live messages) into display rows. Roles other than user/assistant/toolResult
// (compactionSummary, branchSummary, bashExecution, custom) are context-only
// reconstructions, not transcript rows — a compaction is instead rendered from
// its ENTRY as a `compaction` marker row. Every consumer of the persisted rows
// (frontend parsePersistedMessages, formatChatTranscript, the rollback walk,
// the legacy backfill) iterates known roles, so the marker degrades to a no-op
// where it isn't understood.
function sessionBranchToPersistedMessages(
  branch: SessionBranchEntry[],
  unpersistedTail: any[],
  meta: { userDisplayTexts: string[]; userAuthors: string[]; thinkingLevel?: string },
): PersistedChatMessage[] {
  const result: PersistedChatMessage[] = [];
  let userIdx = 0;

  const pushMessage = (msg: any, ts: string): void => {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : ((msg.content ?? []) as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("");
      const entry: any = { role: "user", content: text, ts };
      if (meta.userDisplayTexts[userIdx] !== undefined) {
        entry.displayText = meta.userDisplayTexts[userIdx];
      }
      if (meta.userAuthors[userIdx]) {
        entry.author = meta.userAuthors[userIdx];
      }
      userIdx++;
      result.push(entry);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

      for (const block of msg.content ?? []) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking" && !block.redacted) {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          toolCalls.push({ id: block.id, name: block.name, args: block.arguments });
        }
      }

      const costUsd = msg.usage?.cost?.total;
      result.push({
        role: "assistant",
        content: { text: textParts.join(""), thinking: thinkingParts.join(""), toolCalls },
        ts,
        ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}),
        ...(typeof msg.model === "string" && msg.model ? { model: msg.model } : {}),
        ...(typeof msg.provider === "string" && msg.provider ? { provider: msg.provider } : {}),
        ...(meta.thinkingLevel ? { reasoning: meta.thinkingLevel } : {}),
      });
    } else if (msg.role === "toolResult") {
      const trContent: any = {
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        isError: msg.isError,
      };
      // Persist the answer text for ask_question so the frontend can reconstruct it
      if (msg.toolName === "ask_question") {
        const textParts = (msg.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text);
        if (textParts.length > 0) trContent.resultText = textParts.join("");
      }
      result.push({ role: "toolResult", content: trContent, ts });
    }
  };

  for (const entry of branch) {
    if (entry.type === "message") {
      pushMessage(entry.message, messageTimestampIso(entry.message, entry.timestamp));
    } else if (entry.type === "compaction") {
      result.push({ role: "compaction", content: null, ts: entry.timestamp });
    }
  }
  for (const msg of unpersistedTail) {
    pushMessage(msg, messageTimestampIso(msg));
  }

  return result;
}

// Index the NEXT user message will occupy in the serialized transcript —
// branch user entries plus any live user messages not yet appended as entries.
function countSessionUserMessages(managed: ManagedSession): number {
  const branch = managed.sessionManager.getBranch();
  const inBranch = new Set<unknown>();
  let count = 0;
  for (const entry of branch) {
    if (entry.type === "message") {
      inBranch.add(entry.message);
      if ((entry.message as any)?.role === "user") count++;
    }
  }
  for (const m of managed.session.messages as any[]) {
    if (!inBranch.has(m) && m.role === "user") count++;
  }
  return count;
}

// Serializes the chat's FULL transcript: the session tree's current branch
// (root → leaf), which — unlike session.messages, the compaction-managed LLM
// context — still contains every message older compactions summarized away.
// Deriving the display history from session.messages instead is what used to
// truncate chats: the first save after a compaction overwrote the file with
// just the kept tail, visible once the project was reopened.
//
// pi appends a finished message to the SessionManager only AFTER dispatching
// its message_end, so at save time the newest message(s) live only in
// session.messages; merge that unpersisted tail by object identity —
// state.messages is rebuilt from these same entry objects on reload and
// compaction, so identity is stable across both.
function parseSessionMessages(managed: ManagedSession): PersistedChatMessage[] {
  const branch = managed.sessionManager.getBranch();
  const inBranch = new Set<unknown>();
  for (const entry of branch) {
    if (entry.type === "message") inBranch.add(entry.message);
  }
  const tail = (managed.session.messages as any[]).filter(
    (m) => !inBranch.has(m) && (m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
  );
  return sessionBranchToPersistedMessages(branch, tail, managed);
}

async function saveChatMessagesToDisk(userId: string, projectId: string, chatId: string, messages: PersistedChatMessage[], opts?: { allowShrink?: boolean }): Promise<void> {
  try {
    await withChatSaveLock(userId, projectId, chatId, async () => {
      const key = makeSessionKey(userId, projectId, chatId);
      let baseline = chatSavedRowCounts.get(key);
      if (baseline === undefined) {
        baseline = (await loadChatMessagesFromDisk(userId, projectId, chatId)).length;
      }
      if (!opts?.allowShrink && messages.length < baseline) {
        console.error(
          `[VCA] Refusing to shrink chat history — userId=${userId} projectId=${projectId} chatId=${chatId} existing=${baseline} new=${messages.length}`,
        );
        return;
      }
      await fs.mkdir(await getChatsDir(userId, projectId), { recursive: true });
      await atomicWriteJson(await getChatMessagesFilePath(userId, projectId, chatId), messages);
      chatSavedRowCounts.set(key, messages.length);
    });
  } catch (err) {
    // Loud log — silent failures here are why "chat history not preserved on
    // reload" went undiagnosed. Include enough context to find the chat in
    // Container App logs (userId/projectId/chatId, message count) without
    // leaking message bodies.
    console.error(
      `[VCA] Failed to save chat messages to disk — userId=${userId} projectId=${projectId} chatId=${chatId} messageCount=${messages.length}`,
      err,
    );
  }
}

async function loadChatMessagesFromDisk(userId: string, projectId: string, chatId: string): Promise<PersistedChatMessage[]> {
  try {
    const data = await fs.readFile(await getChatMessagesFilePath(userId, projectId, chatId), "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// First line of a session JSONL must be its header. Guards the resume path
// against picking a truncated/corrupt file whose entries can't anchor a tree.
async function hasValidSessionHeader(file: string): Promise<boolean> {
  let fh: import("fs/promises").FileHandle | null = null;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, bytesRead).toString("utf-8").split("\n", 1)[0];
    return JSON.parse(firstLine)?.type === "session";
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// Newest session file (by mtime) in a chat's SDK dir with a valid header, or
// null if none. Selection is deliberately NOT SessionManager.continueRecent:
// its header-cwd filter requires the stored cwd to string-equal the resolved
// current workspace path, so any change in path spelling between runs (drive
// letter vs UNC on an SMB WORKSPACES_ROOT, casing, a moved root) made it
// silently ignore the existing session and start an EMPTY one — the other way
// chat history got truncated. SessionManager.open() takes the file
// unconditionally and overrides the header cwd with the live workspace path.
async function findNewestSdkSessionFile(sdkDir: string): Promise<string | null> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(sdkDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const stats: Array<{ file: string; mtimeMs: number }> = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const file = path.join(sdkDir, e.name);
    try {
      stats.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs });
    } catch { /* vanished between readdir and stat */ }
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file } of stats) {
    if (await hasValidSessionHeader(file)) return file;
  }
  return null;
}

function persistedTimestampMs(ts: string | undefined): number {
  if (!ts) return Date.now();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function createLegacySessionManagerFromDisplayHistory(
  workspacePath: string,
  sdkDir: string,
  messages: PersistedChatMessage[],
  model: any,
): SessionManager {
  const sessionManager = SessionManager.create(workspacePath, sdkDir);
  const api = String(model?.api ?? "");
  const provider = String(model?.provider ?? "");
  const modelId = String(model?.id ?? model?.name ?? "");

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text.trim()) {
        sessionManager.appendMessage({
          role: "user",
          content: text,
          timestamp: persistedTimestampMs(msg.ts),
        } as any);
      }
      continue;
    }

    if (msg.role === "assistant") {
      const text = typeof msg.content?.text === "string" ? msg.content.text : "";
      const thinking = typeof msg.content?.thinking === "string" ? msg.content.thinking : "";
      const content: any[] = [];
      if (thinking) content.push({ type: "thinking", thinking });
      if (text.trim()) content.push({ type: "text", text });
      if (content.length === 0) continue;
      sessionManager.appendMessage({
        role: "assistant",
        content,
        api,
        provider,
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: persistedTimestampMs(msg.ts),
      } as any);
    }
  }

  return sessionManager;
}

async function createChatSessionManager(
  userId: string,
  projectId: string,
  chatId: string,
  workspacePath: string,
  model: any,
): Promise<SessionManager> {
  const sdkDir = await getChatSdkDir(userId, projectId, chatId);
  await fs.mkdir(sdkDir, { recursive: true });

  const sessionFile = await findNewestSdkSessionFile(sdkDir);
  if (sessionFile) {
    return SessionManager.open(sessionFile, sdkDir, workspacePath);
  }

  const displayMessages = await loadChatMessagesFromDisk(userId, projectId, chatId) as PersistedChatMessage[];
  if (displayMessages.length > 0) {
    console.log(`[chat] Backfilling SDK session from display history: userId=${userId} projectId=${projectId} chatId=${chatId} messages=${displayMessages.length}`);
    return createLegacySessionManagerFromDisplayHistory(workspacePath, sdkDir, displayMessages, model);
  }

  return SessionManager.create(workspacePath, sdkDir);
}

async function deleteChatSdkSession(userId: string, projectId: string, chatId: string): Promise<void> {
  await rmRetry(await getChatSdkDir(userId, projectId, chatId), { recursive: true, force: true });
}

// Plain text of a user-role AgentMessage — the same join the display rows
// persist as `content`, so file rows and branch messages compare directly.
function userMessageText(message: any): string {
  return typeof message?.content === "string"
    ? message.content
    : ((message?.content ?? []) as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
}

// Carries user displayText/author from persisted display rows onto the session
// branch's user messages. Content-matched (greedy, order-preserving), not
// index-mapped: a display file truncated by the pre-fix context-derived writes,
// or a legacy backfill that skipped empty messages, must not shift the
// surviving metadata onto the wrong users. Arrays are sized to the branch's
// user count so sendPrompt's push() for the NEXT message lands at the right
// index even when some branch users found no row.
function alignUserDisplayMeta(
  displayRows: PersistedChatMessage[],
  branch: SessionBranchEntry[],
): { userDisplayTexts: string[]; userAuthors: string[] } {
  const branchUserTexts: string[] = [];
  for (const entry of branch) {
    if (entry.type === "message" && (entry.message as any)?.role === "user") {
      branchUserTexts.push(userMessageText(entry.message));
    }
  }
  const fileUsers = displayRows.filter((r) => r.role === "user");
  const userDisplayTexts: string[] = new Array(branchUserTexts.length);
  const userAuthors: string[] = new Array(branchUserTexts.length);
  let fi = 0;
  for (let bi = 0; bi < branchUserTexts.length; bi++) {
    let j = fi;
    while (j < fileUsers.length) {
      const rowContent = typeof fileUsers[j].content === "string" ? fileUsers[j].content : "";
      if (rowContent === branchUserTexts[bi]) break;
      j++;
    }
    if (j < fileUsers.length) {
      if (typeof fileUsers[j].displayText === "string") userDisplayTexts[bi] = fileUsers[j].displayText as string;
      if (typeof fileUsers[j].author === "string" && fileUsers[j].author) userAuthors[bi] = fileUsers[j].author as string;
      fi = j + 1;
    }
  }
  return { userDisplayTexts, userAuthors };
}

async function hydrateManagedSessionDisplayMetadata(managed: ManagedSession): Promise<void> {
  const rows = await loadChatMessagesFromDisk(managed.userId, managed.projectId, managed.chatId) as PersistedChatMessage[];
  const meta = alignUserDisplayMeta(rows, managed.sessionManager.getBranch());
  managed.userDisplayTexts = meta.userDisplayTexts;
  managed.userAuthors = meta.userAuthors;
}

// Chats already reconciled against their SDK session this process (keyed by
// makeSessionKey). One pass per chat is enough: display writes go through the
// shrink guard and are branch-derived, so once healed the file only grows.
// clearChatMessages marks its chat done so a lagging SDK delete can't
// resurrect a deliberately cleared history.
const reconciledChats = new Set<string>();

// Self-heal for histories truncated by the pre-fix context-derived writes:
// rebuild the display file from the SDK session's full branch when the branch
// holds more content rows than the file. Returns the healed rows, or null if
// nothing needed healing. The session JSONL is append-only, so everything an
// old compaction wiped from the display file is still recoverable here.
async function reconcileDisplayHistoryFromSdk(userId: string, projectId: string, chatId: string): Promise<PersistedChatMessage[] | null> {
  const key = makeSessionKey(userId, projectId, chatId);
  if (reconciledChats.has(key)) return null;
  reconciledChats.add(key);

  const sessionFile = await findNewestSdkSessionFile(await getChatSdkDir(userId, projectId, chatId));
  if (!sessionFile) return null;

  // Distinguish "user cleared the chat" (valid empty array — leave it alone)
  // from "file missing/corrupt" (heal from the session).
  let fileRows: PersistedChatMessage[] | null = null;
  try {
    const parsed = JSON.parse(await fs.readFile(await getChatMessagesFilePath(userId, projectId, chatId), "utf-8"));
    fileRows = Array.isArray(parsed) ? parsed : null;
  } catch {
    fileRows = null;
  }
  if (fileRows !== null && fileRows.length === 0) return null;
  const existing = fileRows ?? [];

  let branch: SessionBranchEntry[];
  try {
    branch = SessionManager.open(sessionFile, path.dirname(sessionFile), await getWorkspacePath(userId, projectId)).getBranch();
  } catch {
    return null;
  }

  const rebuilt = sessionBranchToPersistedMessages(branch, [], alignUserDisplayMeta(existing, branch));
  const contentRows = (rows: PersistedChatMessage[]) => rows.filter((r) => r.role !== "compaction").length;
  if (contentRows(rebuilt) <= contentRows(existing)) return null;

  console.log(`[chat] Healed truncated chat history from SDK session: userId=${userId} projectId=${projectId} chatId=${chatId} fileRows=${existing.length} healedRows=${rebuilt.length}`);
  await saveChatMessagesToDisk(userId, projectId, chatId, rebuilt);
  return rebuilt;
}

export async function getMessages(userId: string, projectId: string, chatId: string): Promise<Array<{
  role: string;
  content: unknown;
  ts?: string;
  author?: string;
  displayText?: string;
  costUsd?: number;
  model?: string;
  provider?: string;
  reasoning?: string;
}>> {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (managed) {
    return parseSessionMessages(managed);
  }
  // No active session — serve the persisted file, first giving the one-shot
  // reconcile pass a chance to repair a history the old code truncated.
  try {
    const healed = await reconcileDisplayHistoryFromSdk(userId, projectId, chatId);
    if (healed) return healed;
  } catch (err) {
    console.warn(`[chat] Display-history reconcile failed for ${key}:`, err);
  }
  return loadChatMessagesFromDisk(userId, projectId, chatId);
}

// Renders persisted chat messages as a plain-text transcript for the
// summary prompt. Deliberately excludes all tool calls/outputs and thinking —
// it emits only the user's request text and the assistant's generated text
// (the same text shown with the robot icon in the UI). The one exception is
// the ask_question tool: the question, the offered options, and the user's
// selected answer are included so the summary can report the choices made.
function formatChatTranscript(messages: Array<{ role: string; content: any }>): string {
  // Pre-pass: map each ask_question tool call to the answer the user picked.
  const answersByToolCallId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "toolResult" && msg.content?.toolName === "ask_question" && typeof msg.content.resultText === "string") {
      answersByToolCallId.set(msg.content.toolCallId, msg.content.resultText.replace(/^User answered:\s*/, "").trim());
    }
  }

  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text.trim()) lines.push(`USER: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const content = msg.content && typeof msg.content === "object" ? msg.content : {};
      const text = typeof content.text === "string" ? content.text : "";
      if (text.trim()) lines.push(`ASSISTANT: ${text.trim()}`);
      // Surface ask_question interactions (question + offered choices + selection).
      for (const call of Array.isArray(content.toolCalls) ? content.toolCalls : []) {
        if (call?.name !== "ask_question") continue;
        const question = typeof call.args?.question === "string" ? call.args.question.trim() : "";
        if (!question) continue;
        const options = Array.isArray(call.args?.options)
          ? call.args.options.map((o: any) => (typeof o?.label === "string" ? o.label.trim() : "")).filter(Boolean)
          : [];
        const answer = answersByToolCallId.get(call.id) || "(unanswered)";
        const block = [`AGENT ASKED: ${question}`];
        if (options.length) block.push(`OPTIONS OFFERED: ${options.join(" | ")}`);
        block.push(`USER SELECTED: ${answer}`);
        lines.push(block.join("\n"));
      }
    }
  }
  return lines.join("\n\n");
}

const SUMMARY_INSTRUCTIONS =
  "Summarize the following chat between a user and an AI coding assistant. " +
  "Output short markdown bullet points covering: (1) what the user requested, " +
  "(2) what the assistant created or changed, and (3) any choices the assistant offered " +
  "the user and which option the user selected. The input below contains only the user's " +
  "and assistant's text plus recorded questions and answers — base your summary solely on " +
  "that. Be concise. Do not greet the reader or restate this instruction. Output bullets only.";

// One-shot, non-streaming LLM call that returns a markdown summary of the
// given chat. Generates a fresh AgentSession in a temp workspace so the
// summary call has no project skills, no system prompt, and no tools.
export async function generateChatSummary(userId: string, projectId: string, chatId: string, apiKey?: string, llmConfig?: UserLLMConfig): Promise<string> {
  const messages = await getMessages(userId, projectId, chatId);
  const transcript = formatChatTranscript(messages);
  if (!transcript.trim()) return "";

  const { model, runtime, thinkingLevel } = await resolveLlmModel(apiKey, llmConfig);
  // Same SSE-for-codex reasoning as createSessionLocked.
  const settingsManager = SettingsManager.inMemory(
    model?.provider === "openai-codex" ? { transport: "sse" } : undefined,
  );

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vca-summary-"));
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: tmpDir,
      agentDir: getAgentDir(),
      settingsManager,
      systemPrompt: SUMMARY_INSTRUCTIONS,
      // cwd is a scratch tmp dir: without these, pi's discovery walk would
      // pull AGENTS.md/CLAUDE.md from the OS temp dir's ancestors (the server
      // account's home, drive root) and the global APPEND_SYSTEM.md into the
      // summary prompt.
      noContextFiles: true,
      appendSystemPrompt: [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: tmpDir,
      model,
      thinkingLevel,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(tmpDir),
      settingsManager,
      resourceLoader,
      customTools: [],
      // The summary input is an attacker-influenceable chat transcript, so a
      // prompt-injection could otherwise drive the default bash/read/... tools
      // to exfiltrate process.env or peer files. The summarizer only emits
      // text — give it no tools at all.
      excludeTools: ["bash", "edit", "write", "read", "grep", "find", "ls"],
    });

    try {
      await session.prompt(`${SUMMARY_INSTRUCTIONS}\n\n--- CHAT ---\n${transcript}\n--- END ---`);
      // Attribute the summary call's spend to the project (the temp session's
      // message_ends never flow through forwardAgentEvent).
      const spend = { usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const spendCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const m of session.messages as any[]) {
        if (m.role !== "assistant" || !m.usage) continue;
        spend.usd += Number.isFinite(m.usage.cost?.total) ? m.usage.cost.total : 0;
        spend.input += m.usage.input || 0;
        spend.output += m.usage.output || 0;
        spend.cacheRead += m.usage.cacheRead || 0;
        spend.cacheWrite += m.usage.cacheWrite || 0;
        spendCost.input += m.usage.cost?.input || 0;
        spendCost.output += m.usage.cost?.output || 0;
        spendCost.cacheRead += m.usage.cost?.cacheRead || 0;
        spendCost.cacheWrite += m.usage.cost?.cacheWrite || 0;
      }
      void addProjectCost(await getWorkspacePath(userId, projectId), spend.usd, spend, spendCost, model?.id, model?.provider)
        .then((state) => {
          broadcastSSEEvent(userId, projectId, "project_cost", { totalUsd: state.totalUsd, tokens: state.tokens });
        })
        .catch((err) => console.error("[cost] chat-summary attribution failed:", err));
      // The final assistant message is the last assistant entry in session.messages.
      const sessMessages = session.messages;
      for (let i = sessMessages.length - 1; i >= 0; i--) {
        const m: any = sessMessages[i];
        if (m.role !== "assistant") continue;
        const blocks = Array.isArray(m.content) ? m.content : [];
        const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        if (text.trim()) return text.trim();
      }
      return "";
    } finally {
      try { session.dispose(); } catch {}
    }
  } finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Clears a single chat's messages and disposes its session if active. Unlike
// the previous project-level clearChat, this does NOT touch the running app
// process — the preview is a project concern shared by all chats.
export async function clearChatMessages(userId: string, projectId: string, chatId: string): Promise<void> {
  const key = makeSessionKey(userId, projectId, chatId);
  const managed = sessions.get(key);
  if (managed) {
    try { await managed.session.abort(); } catch {}
    if (managed.sseClients.size > 0) {
      pendingSSEClients.set(key, new Map(managed.sseClients));
    }
    try { managed.session.dispose(); } catch {}
    sessions.delete(key);
  }
  await saveChatMessagesToDisk(userId, projectId, chatId, [], { allowShrink: true });
  await deleteChatSdkSession(userId, projectId, chatId);
  // The SDK session is gone — a later reconcile pass must not resurrect the
  // cleared history from a re-read of this chat.
  reconciledChats.add(key);
}

// Git remote operations
export async function hasGitRemote(userId: string, projectId: string): Promise<boolean> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  try {
    const { stdout } = await git(["remote", "get-url", "origin"], { cwd: workspacePath });
    return !!stdout.trim();
  } catch {
    return false;
  }
}

export async function getGitRemote(userId: string, projectId: string): Promise<{ remoteUrl: string } | null> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  try {
    const { stdout } = await git(["remote", "get-url", "origin"], { cwd: workspacePath });
    const url = stdout.trim();
    if (!url) return null;
    // Strip any embedded credentials (https://user:pat@host → https://host).
    return { remoteUrl: url.replace(/^(https?:\/\/)[^@/]+@/, "$1") };
  } catch {
    return null;
  }
}

// Build an authenticated https clone URL. Supports "username & password/PAT"
// (user:secret@) or PAT-only (secret@). Both parts are percent-encoded so
// special characters can't break the URL — and, combined with execFileAsync
// below, can't be interpreted by a shell.
function buildAuthedUrl(remoteUrl: string, cred: { username?: string; secret: string }): string {
  let u: URL;
  try {
    u = new URL(remoteUrl.trim());
  } catch {
    const e = new Error("Invalid repository URL") as Error & { code: string };
    e.code = "UNPARSEABLE_URL";
    throw e;
  }
  if (u.protocol !== "https:") {
    const e = new Error("Repository URL must be https") as Error & { code: string };
    e.code = "UNPARSEABLE_URL";
    throw e;
  }
  const pass = encodeURIComponent(cred.secret);
  const user = cred.username && cred.username.trim() ? encodeURIComponent(cred.username.trim()) : "";
  const auth = user ? `${user}:${pass}` : pass;
  // Rebuild from parsed parts — this also strips any pre-existing `user@`.
  return `${u.protocol}//${auth}@${u.host}${u.pathname}${u.search}`;
}

export async function setGitRemote(
  userId: string,
  projectId: string,
  remoteUrl: string,
  cred: { username?: string; secret: string },
): Promise<void> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  const authedUrl = buildAuthedUrl(remoteUrl, cred);
  try {
    await execFileAsync("git", ["remote", "remove", "origin"], { cwd: workspacePath });
  } catch {
    // origin might not exist yet
  }
  await execFileAsync("git", ["remote", "add", "origin", authedUrl], { cwd: workspacePath });
}

// ─── Per-project VCS credential override (.vca-vcs.json, gitignored) ──

interface ProjectVcsOverride {
  username?: string;
  enc?: string; // ciphertext of the override PAT/password
}

const VCS_OVERRIDE_FILENAME = ".vca-vcs.json";

async function readProjectVcsOverride(workspacePath: string): Promise<ProjectVcsOverride | null> {
  try {
    const text = await fs.readFile(path.join(workspacePath, VCS_OVERRIDE_FILENAME), "utf-8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const out: ProjectVcsOverride = {};
    if (typeof parsed.username === "string") out.username = parsed.username;
    if (typeof parsed.enc === "string" && parsed.enc) out.enc = parsed.enc;
    return out;
  } catch {
    return null;
  }
}

async function writeProjectVcsOverride(
  workspacePath: string,
  incoming: { username: string; pat: string },
): Promise<void> {
  const prev = await readProjectVcsOverride(workspacePath);
  const username = typeof incoming.username === "string" ? incoming.username.trim() : "";
  let enc = prev?.enc;
  if (incoming.pat === UNCHANGED_SECRET_SENTINEL) {
    // keep prior ciphertext
  } else if (typeof incoming.pat === "string" && incoming.pat.length > 0) {
    enc = await encryptSecret(incoming.pat);
  } else {
    enc = undefined;
  }
  const filePath = path.join(workspacePath, VCS_OVERRIDE_FILENAME);
  if (!username && !enc) {
    try { await fs.unlink(filePath); } catch { /* nothing to clear */ }
    return;
  }
  await atomicWriteJson(filePath, { username, enc }, 2);
}

function redactProjectVcsOverride(o: ProjectVcsOverride | null): { username: string; pat: string } {
  return { username: o?.username || "", pat: o?.enc ? UNCHANGED_SECRET_SENTINEL : "" };
}

async function persistProjectRepoUrl(userId: string, projectId: string, repoUrl: string): Promise<void> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  const y = await readProjectYaml(workspacePath);
  await writeProjectYaml(workspacePath, {
    applicationName: y.applicationName ?? "",
    applicationUuid: y.applicationUuid ?? "",
    creatorEmail: y.creatorEmail ?? "",
    deploymentOption: y.deploymentOption,
    vcsProfileId: y.vcsProfileId,
    repoUrl,
  });
}

// Create a Git repository via the project's chosen VCS profile (+ optional
// per-project override) and wire it up as `origin`. The project is looked up
// from `projects.json` (never trust the client); credentials are resolved and
// decrypted server-side; the repo name is `vca-app-<first 8 chars of UUID>`.
export async function createAndSetRemote(
  userId: string,
  projectId: string,
): Promise<{ remoteUrl: string; repoName: string }> {
  const projects = await loadProjectList(userId);
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Project not found");

  const workspacePath = await getWorkspacePath(userId, projectId);
  const y = await readProjectYaml(workspacePath);
  const override = await readProjectVcsOverride(workspacePath);
  const creds = await resolveProfileCredentials(y.vcsProfileId ?? "", override);
  if (!creds) {
    const e = new Error("No version-control profile selected for this project") as Error & { code: string };
    e.code = "NO_PROFILE";
    throw e;
  }
  if (!creds.secret) {
    const e = new Error("The selected version-control profile has no credential") as Error & { code: string };
    e.code = "NO_CREDENTIAL";
    throw e;
  }

  const repoName = `vca-app-${project.id.slice(0, 8)}`;
  let remoteUrl: string;
  if (creds.provider === "azure-devops") {
    ({ remoteUrl } = await createDevOpsRepo(creds.host, creds.organization, creds.project, creds.secret, repoName));
  } else {
    ({ remoteUrl } = await createGitHubRepo({ host: creds.host, org: creds.organization, pat: creds.secret, repoName }));
  }
  await setGitRemote(userId, projectId, remoteUrl, { username: creds.username, secret: creds.secret });
  await persistProjectRepoUrl(userId, projectId, remoteUrl);
  return { remoteUrl, repoName };
}

// Wire an already-known repository URL (from project settings) as `origin`,
// resolving credentials from the project's profile (+ override).
export async function connectRemote(userId: string, projectId: string): Promise<{ remoteUrl: string }> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  const y = await readProjectYaml(workspacePath);
  const repoUrl = (y.repoUrl || "").trim();
  if (!repoUrl) {
    const e = new Error("No repository URL configured for this project") as Error & { code: string };
    e.code = "BAD_REQUEST";
    throw e;
  }
  const override = await readProjectVcsOverride(workspacePath);
  const creds = await resolveProfileCredentials(y.vcsProfileId ?? "", override);
  if (!creds) {
    const e = new Error("No version-control profile selected for this project") as Error & { code: string };
    e.code = "NO_PROFILE";
    throw e;
  }
  if (!creds.secret) {
    const e = new Error("The selected version-control profile has no credential") as Error & { code: string };
    e.code = "NO_CREDENTIAL";
    throw e;
  }
  await setGitRemote(userId, projectId, repoUrl, { username: creds.username, secret: creds.secret });
  return { remoteUrl: repoUrl };
}

export async function gitPush(userId: string, projectId: string, force?: boolean): Promise<string> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  return withGitLock(workspacePath, async () => {
    const args = force
      ? ["push", "--force", "-u", "origin", "HEAD"]
      : ["push", "-u", "origin", "HEAD"];
    const { stdout, stderr } = await git(args, { cwd: workspacePath });
    return stdout + stderr;
  });
}

export async function gitPull(userId: string, projectId: string, force?: boolean): Promise<string> {
  const workspacePath = await getWorkspacePath(userId, projectId);
  return withGitLock(workspacePath, async () => {
    // Always clean untracked files and reset tracked changes before pull
    // to avoid conflicts with files from the remote (e.g. .gitignore)
    await git(["clean", "-fd"], { cwd: workspacePath }).catch(() => {});
    await git(["checkout", "--", "."], { cwd: workspacePath }).catch(() => {});
    if (force) {
      await git(["reset", "--hard", "HEAD"], { cwd: workspacePath }).catch(() => {});
    }
    const { stdout, stderr } = await git(["pull", "origin", "HEAD", "--no-rebase", "--allow-unrelated-histories"], { cwd: workspacePath });
    return stdout + stderr;
  });
}

export async function getDeployStatus(userId: string, projectId: string): Promise<{ deployed: boolean; provider?: string; url?: string; version?: string; deployedAt?: string }> {
  const deployPath = path.join(await getWorkspacePath(userId, projectId), ".vca-deploy.json");
  try {
    const data = JSON.parse(await fs.readFile(deployPath, "utf-8"));
    return { deployed: true, ...data };
  } catch {
    return { deployed: false };
  }
}
