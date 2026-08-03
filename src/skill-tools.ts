import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  validateSkillInput,
  SkillValidationError,
  type SkillMeta,
} from "./agent-manager.js";

// Tools that let the agent manage the user's reusable skill library through the
// same service functions the HTTP API uses (createSkill/updateSkill/deleteSkill),
// so a model-created skill lands in WORKSPACES_ROOT/<userId>/skills/<name>/SKILL.md
// and therefore shows up in listSkills() and the UI skill list. Without these,
// the model hand-writes SKILL.md files into its workspace cwd, which the skill
// list never scans.
//
// Only USER skills are model-authored. System skills (vca/admin/git) and project
// skills (delivered by the project template) are read-only here — guarded below.
export function createSkillTools(getManagedSession: () => { userId: string; projectId: string }): ToolDefinition[] {
  // Look up a name (frontmatter name OR on-disk dir name) in the user's current
  // skill library, including the current project's template-delivered project
  // skills. Returns the matching SkillMeta or null. Drives the create collision
  // guard and the update/delete read-only refusal.
  async function resolveTarget(userId: string, projectId: string, name: string): Promise<SkillMeta | null> {
    const skills = await listSkills(userId, projectId);
    return skills.find((s) => s.dirName === name || s.name === name) ?? null;
  }

  // Tier label for refusal messages (the non-"user" tiers are read-only here).
  function tierLabel(kind: SkillMeta["kind"]): string {
    return kind === "project" ? "project" : "system";
  }

  const createTool: ToolDefinition = {
    name: "create_skill",
    label: "Create Skill",
    description:
      "Create a new reusable user skill (a named instruction set the agent can load later). Writes it to the user's skill library so it appears in the skill list and can be activated in projects.",
    promptSnippet: "create_skill — save a new reusable user skill to the library (never hand-write SKILL.md files)",
    promptGuidelines: [
      "When the user asks to create, add, or save a 'skill', ALWAYS use create_skill. Never create SKILL.md files yourself with the write or bash tools — skills written into the workspace are not registered and will not appear in the user's skill list.",
      "name must be lowercase letters, digits, and hyphens only — no spaces, no leading/trailing or doubled hyphens, max 64 characters.",
      "description is a required one-line summary of when to use the skill (used for skill discovery).",
      "content is the full skill body in Markdown — the actual instructions the skill provides.",
      "Skill names must be unique and must not collide with built-in system skills or the project's template (project) skills. If create_skill reports a conflict, pick a different name, or use update_skill to modify an existing user skill.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Skill name: lowercase letters, digits, and hyphens only (no spaces), 64 chars max. Becomes the skill's folder name.",
      }),
      description: Type.String({ description: "One-line summary of when to use this skill (used for discovery)." }),
      content: Type.String({ description: "The full skill body in Markdown — the instructions the skill provides." }),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        validateSkillInput(params.name, params.description);
        const target = await resolveTarget(userId, projectId, params.name);
        if (target && target.kind !== "user") {
          return {
            content: [{ type: "text" as const, text: `A ${tierLabel(target.kind)} skill named "${params.name}" already exists; choose a different name.` }],
            details: {},
          };
        }
        if (target) {
          return {
            content: [{ type: "text" as const, text: `A skill named "${params.name}" already exists; use update_skill to modify it.` }],
            details: {},
          };
        }
        await createSkill(userId, params.name, params.description, params.content);
        return {
          content: [{ type: "text" as const, text: `Created user skill "${params.name}".` }],
          details: { name: params.name },
        };
      } catch (err) {
        if (err instanceof SkillValidationError) {
          return { content: [{ type: "text" as const, text: `Invalid ${err.field}: ${err.message}` }], details: {} };
        }
        return { content: [{ type: "text" as const, text: `Failed to create skill: ${(err as Error).message}` }], details: {} };
      }
    },
  } as ToolDefinition;

  const updateTool: ToolDefinition = {
    name: "update_skill",
    label: "Update Skill",
    description: "Update the description and/or content of an existing user-authored skill. System and project skills cannot be edited.",
    promptSnippet: "update_skill — edit an existing user skill's description/content",
    promptGuidelines: [
      "Use update_skill to change an existing user skill instead of deleting and recreating it.",
      "Only user-authored skills can be edited. System skills and project (template-delivered) skills are read-only and this tool will refuse them.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the existing user skill to update." }),
      description: Type.String({ description: "New one-line summary of when to use this skill." }),
      content: Type.String({ description: "New full skill body in Markdown." }),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        validateSkillInput(params.name, params.description);
        const target = await resolveTarget(userId, projectId, params.name);
        if (!target) {
          return { content: [{ type: "text" as const, text: `No skill named "${params.name}" exists.` }], details: {} };
        }
        if (target.kind !== "user") {
          return { content: [{ type: "text" as const, text: `"${params.name}" is a ${tierLabel(target.kind)} skill and cannot be modified.` }], details: {} };
        }
        await updateSkill(userId, target.dirName, params.description, params.content);
        return {
          content: [{ type: "text" as const, text: `Updated user skill "${params.name}".` }],
          details: { name: target.dirName },
        };
      } catch (err) {
        if (err instanceof SkillValidationError) {
          return { content: [{ type: "text" as const, text: `Invalid ${err.field}: ${err.message}` }], details: {} };
        }
        return { content: [{ type: "text" as const, text: `Failed to update skill: ${(err as Error).message}` }], details: {} };
      }
    },
  } as ToolDefinition;

  const deleteTool: ToolDefinition = {
    name: "delete_skill",
    label: "Delete Skill",
    description: "Delete a user-authored skill from the user's skill library. System and project skills cannot be deleted.",
    promptSnippet: "delete_skill — remove a user-authored skill",
    promptGuidelines: [
      "Only user-authored skills can be deleted; system skills and project (template-delivered) skills are protected and this tool will refuse them.",
      "Deletion is permanent.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the user skill to delete." }),
    }),
    async execute(toolCallId, params: any, signal) {
      try {
        const { userId, projectId } = getManagedSession();
        const target = await resolveTarget(userId, projectId, params.name);
        if (!target) {
          return { content: [{ type: "text" as const, text: `No skill named "${params.name}" exists.` }], details: {} };
        }
        if (target.kind !== "user") {
          return { content: [{ type: "text" as const, text: `"${params.name}" is a ${tierLabel(target.kind)} skill and cannot be deleted.` }], details: {} };
        }
        await deleteSkill(userId, target.dirName);
        return {
          content: [{ type: "text" as const, text: `Deleted user skill "${params.name}".` }],
          details: { name: target.dirName },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to delete skill: ${(err as Error).message}` }], details: {} };
      }
    },
  } as ToolDefinition;

  return [createTool, updateTool, deleteTool];
}
