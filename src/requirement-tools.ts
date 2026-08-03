import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { getRequirements, createRequirement, updateRequirement } from "./agent-manager.js";

export function createRequirementTools(getManagedSession: () => { userId: string; projectId: string }): ToolDefinition[] {
  const listTool: ToolDefinition = {
    name: "list_requirements",
    label: "List Requirements",
    description: "List all requirements for the current project. Returns an array of requirement objects with id (FRXXXXX for functional, RXXXXX for non-functional), title, description, type, priority, status, and timestamps.",
    promptSnippet: "list_requirements — list all project requirements (Architect View → Requirements tab)",
    promptGuidelines: [
      "Whenever the user mentions 'requirements', they mean items managed in the Architect View → Requirements tab — call this tool first.",
      "Always call list_requirements before create_requirement, update_requirement, or set_requirement_status so you have the correct id (FRXXXXX / RXXXXX).",
      "Requirements are not project files — never write or modify them via file edits, only via these tools.",
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        const requirements = await getRequirements(userId, projectId);
        return {
          content: [{ type: "text" as const, text: requirements.length === 0 ? "No requirements found." : JSON.stringify(requirements, null, 2) }],
          details: { count: requirements.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to list requirements: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  const createTool: ToolDefinition = {
    name: "create_requirement",
    label: "Create Requirement",
    description: "Create a new requirement for the current project. The id is server-assigned: FRXXXXX (5-digit) for functional, RXXXXX (5-digit) for non-functional.",
    promptSnippet: "create_requirement — add a new requirement (id auto-assigned as FRXXXXX or RXXXXX)",
    promptGuidelines: [
      "Use this tool when the user asks to add a new requirement (Architect View → Requirements tab).",
      "The title is required. Other fields have defaults: type=functional, priority=should, status=draft.",
      "Do not invent or pass an id — the server assigns it. The id prefix follows the type: FR for functional, R for non-functional.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short title of the requirement" }),
      description: Type.Optional(Type.String({ description: "Detailed description of the requirement" })),
      type: Type.Optional(Type.Union([Type.Literal("functional"), Type.Literal("non-functional")], { description: "Requirement type (default: functional)" })),
      priority: Type.Optional(Type.Union([Type.Literal("must"), Type.Literal("should"), Type.Literal("could"), Type.Literal("wont")], { description: "MoSCoW priority (default: should)" })),
      status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("approved"), Type.Literal("implemented"), Type.Literal("rejected"), Type.Literal("deferred")], { description: "Requirement status (default: draft)" })),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        const req = await createRequirement(userId, projectId, {
          title: params.title,
          description: params.description,
          type: params.type,
          priority: params.priority,
          status: params.status,
        });
        return {
          content: [{ type: "text" as const, text: `Created requirement "${req.title}" (id: ${req.id})` }],
          details: { requirement: req },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to create requirement: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  const updateTool: ToolDefinition = {
    name: "update_requirement",
    label: "Update Requirement",
    description: "Update an existing requirement by id. Only the provided fields will be changed.",
    promptSnippet: "update_requirement — modify an existing requirement (by FRXXXXX / RXXXXX id)",
    promptGuidelines: [
      "Use this tool to modify an existing requirement. You must provide the requirement id (FRXXXXX or RXXXXX).",
      "Always call list_requirements first to look up the exact id — never guess or fabricate it.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The requirement id to update (FRXXXXX for functional, RXXXXX for non-functional)" }),
      title: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      type: Type.Optional(Type.Union([Type.Literal("functional"), Type.Literal("non-functional")], { description: "Requirement type" })),
      priority: Type.Optional(Type.Union([Type.Literal("must"), Type.Literal("should"), Type.Literal("could"), Type.Literal("wont")], { description: "MoSCoW priority" })),
      status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("approved"), Type.Literal("implemented"), Type.Literal("rejected"), Type.Literal("deferred")], { description: "Requirement status" })),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        const { id, ...data } = params;
        const req = await updateRequirement(userId, projectId, id, data);
        return {
          content: [{ type: "text" as const, text: `Updated requirement "${req.title}" (id: ${req.id})` }],
          details: { requirement: req },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to update requirement: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  const setStatusTool: ToolDefinition = {
    name: "set_requirement_status",
    label: "Set Requirement Status",
    description: "Change the status of a requirement (by FRXXXXX / RXXXXX id). Use 'rejected' for requirements that are explicitly declined, or 'deferred' for requirements that are valid but postponed.",
    promptSnippet: "set_requirement_status — change a requirement's status (draft, approved, implemented, rejected, deferred)",
    promptGuidelines: [
      "Use this tool to change a requirement's status. The id (FRXXXXX or RXXXXX) is required.",
      "Always call list_requirements first to look up the exact id — never guess or fabricate it.",
      "You cannot delete requirements — only humans can do that. Use 'rejected' or 'deferred' instead.",
      "Use 'rejected' when a requirement is explicitly declined after review.",
      "Use 'deferred' when a requirement is valid but should be postponed to a later phase.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The requirement id (FRXXXXX for functional, RXXXXX for non-functional)" }),
      status: Type.Union([Type.Literal("draft"), Type.Literal("approved"), Type.Literal("implemented"), Type.Literal("rejected"), Type.Literal("deferred")], { description: "The new status" }),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        const req = await updateRequirement(userId, projectId, params.id, { status: params.status });
        return {
          content: [{ type: "text" as const, text: `Set requirement "${req.title}" (id: ${req.id}) status to "${params.status}"` }],
          details: { requirement: req },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to set requirement status: ${(err as Error).message}` }],
          details: {},
        };
      }
    },
  } as ToolDefinition;

  return [listTool, createTool, updateTool, setStatusTool];
}
