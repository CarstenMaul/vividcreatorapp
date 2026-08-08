import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  readProjectMemory,
  writeProjectMemory,
  appendProjectMemoryFacts,
  formatProjectMemoryUsage,
  ProjectMemoryTooLargeError,
  PROJECT_MEMORY_SECTIONS,
} from "./agent-manager.js";

/**
 * Tools for the project's durable memory file (project.md).
 *
 * The sandboxed read/write/edit tools could already touch this file, so these
 * earn their place four ways: the promptSnippet/promptGuidelines below are the
 * only mechanism that tells the model WHEN a fact is worth keeping; the size
 * budget is enforced in one place; append is the default so an accumulated
 * memory file can't be silently two-thirds rewritten away; and only a
 * tool-mediated write is paired with the prompt refresh in agent-manager's
 * syncProjectMemoryForSession.
 */
export function createMemoryTools(getManagedSession: () => { userId: string; projectId: string }): ToolDefinition[] {
  const sharedGuidelines = [
    "Project memory lives in project.md in the project root. Read and change it ONLY through the memory tools — never with read, write, edit or bash. The memory tools enforce the size budget and are what make a change reach your context.",
    "A fact you record reaches your system prompt from your NEXT turn onward, not immediately — never re-read memory to 'confirm' it landed.",
  ];

  const readTool: ToolDefinition = {
    name: "read_project_memory",
    label: "Read Project Memory",
    description: "Read the current contents of this project's durable memory file (project.md), plus how much of the size budget it uses.",
    promptSnippet: "read_project_memory — read this project's durable memory file (Architect View → Memory tab)",
    promptGuidelines: [
      "The <project_memory> block in your system prompt is a snapshot taken when this turn started — it does not include anything written during this turn. Call read_project_memory for the authoritative current contents.",
      "ALWAYS call read_project_memory immediately before rewrite_project_memory. Rewriting from the stale snapshot permanently destroys anything recorded since the turn began.",
      ...sharedGuidelines,
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        const content = await readProjectMemory(userId, projectId);
        return {
          content: [{ type: "text" as const, text: `${content || "Project memory is empty."}\n\n${formatProjectMemoryUsage(content)}` }],
          details: { content, usage: formatProjectMemoryUsage(content) },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to read project memory: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  const rememberTool: ToolDefinition = {
    name: "remember_project_fact",
    label: "Remember Project Fact",
    description: "Append one or more durable facts to this project's memory (project.md). Each fact becomes a bullet under the given section. Use for knowledge that must survive this chat.",
    promptSnippet: "remember_project_fact — append durable project facts to project memory (Architect View → Memory tab)",
    promptGuidelines: [
      "Record a fact when it will still matter in a future chat: an architectural decision AND why it was made, a user preference stated as a standing rule ('always use X', 'never Y'), a non-obvious constraint or gotcha found while debugging, an external system or endpoint the project depends on, or an agreed naming/structure convention.",
      "Do NOT record: anything already visible in the code or in CLAUDE.md/README, task status or TODOs (those are requirements — use create_requirement), transient debugging state, secrets, tokens, passwords or personal data, or a restatement of the user's current request. If a fresh agent could learn it by reading one file, it does not belong in memory.",
      "Write each fact as one self-contained sentence that still makes sense with no surrounding conversation. Prefer 'The app deploys as an Electron build, so no server-side session store was added.' over 'as discussed, no sessions'.",
      "Check the <project_memory> block already in your context first — never append a fact that is already recorded. If an existing fact has become wrong, correct it with rewrite_project_memory instead of appending a contradiction.",
      "Record at most a handful of facts per turn, at the END of the turn, after the work is done and confirmed. Memory is a budget, not a log.",
      "Every memory tool reports how full memory is. At 75% or more, prune with rewrite_project_memory before appending anything else.",
      ...sharedGuidelines,
    ],
    parameters: Type.Object({
      facts: Type.Array(Type.String({ description: "One self-contained sentence" }), {
        minItems: 1,
        description: "Facts to append, one bullet each",
      }),
      section: Type.Optional(
        Type.Union(
          PROJECT_MEMORY_SECTIONS.map((s) => Type.Literal(s)),
          { description: "Heading to append under (default: Notes)" },
        ),
      ),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        const facts: string[] = (params.facts || []).filter((f: unknown) => typeof f === "string" && f.trim());
        if (!facts.length) {
          return { content: [{ type: "text" as const, text: "No facts given — nothing recorded." }], details: {} };
        }
        const section = params.section || "Notes";
        const content = await appendProjectMemoryFacts(userId, projectId, facts, section);
        return {
          content: [{ type: "text" as const, text: `Recorded ${facts.length} fact(s) under "${section}". ${formatProjectMemoryUsage(content)}` }],
          details: { count: facts.length, section, usage: formatProjectMemoryUsage(content) },
        };
      } catch (err) {
        if (err instanceof ProjectMemoryTooLargeError) {
          return {
            content: [{ type: "text" as const, text: `Project memory is full (${err.used.toLocaleString("en-US")} / ${err.max.toLocaleString("en-US")} characters). Call read_project_memory, then rewrite_project_memory with a pruned version that keeps only the still-relevant facts, then record this again.` }],
            details: { code: err.code, used: err.used, max: err.max },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Failed to record project fact: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  const rewriteTool: ToolDefinition = {
    name: "rewrite_project_memory",
    label: "Rewrite Project Memory",
    description: "Replace the entire contents of this project's memory file. Use to prune, reorganise, correct, or forget. Anything omitted is deleted.",
    promptSnippet: "rewrite_project_memory — replace project memory wholesale to prune, correct or forget (Architect View → Memory tab)",
    promptGuidelines: [
      "This is the ONLY way to remove or correct a remembered fact. To forget something: call read_project_memory, delete the obsolete lines from what it returned, then pass the remainder here — never a version you reconstructed from memory.",
      "Never call rewrite_project_memory without a read_project_memory earlier in the same turn.",
      "Use it when memory is 75% full or more, when two facts contradict each other, or when the user asks you to forget something.",
      "When pruning, keep decisions and standing rules; drop facts about code that no longer exists and anything now obvious from the current codebase.",
      "You must pass the COMPLETE new file content. Everything you leave out is permanently deleted — only git history can recover it.",
      "To clear memory entirely, pass an empty string, and only when the user explicitly asks for that.",
      "Keep the format: Markdown with '##' section headings and '-' bullets. Never add timestamps — git history already records when each fact was added.",
      ...sharedGuidelines,
    ],
    parameters: Type.Object({
      content: Type.String({ description: "The complete new contents of project memory (Markdown). Empty string clears it." }),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        const content = await writeProjectMemory(userId, projectId, params.content ?? "");
        return {
          content: [{ type: "text" as const, text: content ? `Project memory rewritten. ${formatProjectMemoryUsage(content)}` : "Project memory cleared." }],
          details: { usage: formatProjectMemoryUsage(content) },
        };
      } catch (err) {
        if (err instanceof ProjectMemoryTooLargeError) {
          return {
            content: [{ type: "text" as const, text: `That content is ${err.used.toLocaleString("en-US")} characters, over the ${err.max.toLocaleString("en-US")} character limit — nothing was written. Drop the least useful facts and try again.` }],
            details: { code: err.code, used: err.used, max: err.max },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Failed to rewrite project memory: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  return [readTool, rememberTool, rewriteTool];
}
