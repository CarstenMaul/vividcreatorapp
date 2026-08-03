let activeSystemPrompt: string | null = null;
let systemPromptVersion: string = "unknown";

export function setActiveSystemPrompt(prompt: string, version: string): void {
  activeSystemPrompt = prompt;
  systemPromptVersion = version;
}

export function getSystemPrompt(): string {
  if (!activeSystemPrompt) {
    throw new Error(
      "System prompt not loaded. Configure one of: admin/systemprompt/SYSTEM_PROMPT.md (local override) " +
      "or admin/system-prompt-repo.json with a git repo URL (the repo path also needs AZURE_DEVOPS_PAT).",
    );
  }
  return activeSystemPrompt;
}

export function getSystemPromptVersion(): string {
  return systemPromptVersion;
}
