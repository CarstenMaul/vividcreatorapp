import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import { sendSSEEvent, makeProjectKey, type ManagedSession } from "./agent-manager.js";
import { startAppProcess, getPreviewState } from "./app-process-manager.js";

/**
 * screenshot agent tool. Electron-only (getDisplayMedia works without a user
 * gesture there thanks to the setDisplayMediaRequestHandler in electron main).
 * Captures the app exactly as the user sees it via an SSE round-trip to the
 * renderer: the frontend hides the "AI is editing your app" overlay and the
 * sidebars, refreshes the preview iframe so the current app is rendered,
 * captures it (getDisplayMedia + crop), compresses it like the manual
 * screenshot button does, and POSTs the image back to
 * /projects/:id/screenshot-result. Before the round-trip the server makes sure
 * the preview process is running (and actually serving) so the first screenshot
 * of a turn shows the app rather than the preview's "not started" placeholder.
 *
 * The tool registers even for text-only models: capturing would be pointless
 * (pi strips image blocks the model can't accept), so execute() then skips the
 * capture and returns an explanation the agent can relay — instead of the
 * agent hallucinating a reason for a tool it never had.
 */

/** What the browser POSTs back for a pending capture. */
export type ScreenshotClientResult =
  | { ok: true; dataUrl: string; width: number; height: number }
  | { ok: false; error: string };

const PREVIEW_CAPTURE_TIMEOUT_MS = 45_000;

function errorResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Best-effort: make sure the preview process is running (and actually serving)
 * before the browser captures it. The agent calls screenshot mid-turn, but the
 * preview is otherwise only (re)started at project-open and at the END of a turn
 * (restartAppProcess) — so on the first screenshot of a turn the process is often
 * still "stopped"/"starting" and the browser would grab the preview server's
 * static "No preview yet" placeholder instead of the app.
 *
 * startAppProcess is idempotent and serialized per project (withProjectQueue): if
 * already running it returns at once; if a start/restart is in-flight it queues
 * behind it and resolves once ready; a crashed preview is restarted. "running"
 * only becomes true after an HTTP readiness probe, so it is a real "is serving"
 * signal. Failures are swallowed: we fall through and capture whatever the pane
 * shows (may still be the placeholder), matching the previous behavior.
 */
async function ensurePreviewStarted(managed: ManagedSession): Promise<void> {
  const projectKey = makeProjectKey(managed.userId, managed.projectId);
  if (getPreviewState(projectKey).status === "running") return;
  try {
    await startAppProcess(managed.workspacePath, projectKey);
  } catch (err) {
    console.warn("[screenshot] Failed to ensure preview is running:", err);
  }
}

async function capturePreviewPane(managed: ManagedSession, toolCallId: string, signal: AbortSignal | undefined) {
  if (managed.sseClients.size === 0) {
    return errorResult(
      "Screenshot failed: no browser window is currently viewing this chat, so the preview cannot be captured.",
      { error: "NoClient" },
    );
  }

  // Start the preview (and wait until it serves) before asking the browser to
  // reload+capture — otherwise the first screenshot of a turn captures the
  // "No preview yet" placeholder. Runs before the 45s SSE round-trip below, so
  // startup time doesn't eat that timeout.
  await ensurePreviewStarted(managed);
  if (signal?.aborted) throw new Error("Screenshot aborted");

  // The frontend performs the capture when it receives the screenshot_request
  // SSE event and POSTs the result to /projects/:id/screenshot-result, which
  // resolves this promise via resolveScreenshotResult().
  const result = await new Promise<ScreenshotClientResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      managed.pendingScreenshots.delete(toolCallId);
      resolve({
        ok: false,
        error: `the browser did not return a capture within ${PREVIEW_CAPTURE_TIMEOUT_MS / 1000}s (tab busy, capture blocked, or page reloaded).`,
      });
    }, PREVIEW_CAPTURE_TIMEOUT_MS);
    managed.pendingScreenshots.set(toolCallId, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        managed.pendingScreenshots.delete(toolCallId);
        reject(new Error("Screenshot aborted"));
      }, { once: true });
    }
    sendSSEEvent(managed, "screenshot_request", { toolCallId });
  });

  if (!result.ok) {
    return errorResult(`Screenshot failed: ${result.error}`, { error: "CaptureFailed" });
  }

  const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(result.dataUrl);
  if (!match) {
    return errorResult("Screenshot failed: the browser returned an unrecognized image format.", {
      error: "BadDataUrl",
    });
  }
  const [, mimeType, data] = match;
  const kb = Math.round((data.length * 3) / 4 / 1024);
  return {
    content: [
      { type: "image" as const, data, mimeType },
      { type: "text" as const, text: `Screenshot of the app preview (${result.width}x${result.height} CSS px, ${kb} KB ${mimeType}).` },
    ],
    // No base64 in details — it would bloat SSE payloads and logs.
    details: { width: result.width, height: result.height, bytes: kb * 1024 },
  };
}

export function createScreenshotTool(getManagedSession: () => ManagedSession, model: Model<Api>): ToolDefinition | null {
  if (!process.versions.electron) {
    console.log("[screenshot] Not running inside Electron. Screenshot tool not registered.");
    return null;
  }
  const supportsImages = !Array.isArray(model.input) || model.input.includes("image");
  console.log(`[screenshot] Registered (Electron ${process.versions.electron}${supportsImages ? "" : `; model ${model.id} is text-only — degraded`})`);

  return {
    name: "screenshot",
    label: "Screenshot",
    description:
      "Capture a screenshot of the user's generated app as rendered in the preview pane and return it as an image. The editing overlay and the sidebars are hidden during the capture; the preview app is started if it isn't already running and refreshed first, so the current app is shown.",
    promptSnippet: "screenshot — capture the app preview as an image",
    promptGuidelines: supportsImages ? [
      "Use screenshot to visually verify UI work or investigate layout/styling issues — then describe what you actually see instead of guessing.",
      "The capture shows the app exactly as the user sees it (their navigation state included); the editing overlay and sidebars are hidden automatically and restored afterwards.",
      "Requires a VCA browser window viewing this chat — the tool fails when none is open.",
      "Server files are hot-reloaded (node --watch), but Vite-built frontends are NOT rebuilt automatically: after editing frontend source in a project with a build script, call restart_app_process first.",
      "Screenshots permanently consume context — capture sparingly (once per verification step, not after every small edit).",
    ] : [
      `NOTE: the current model (${model.id}) cannot process images, so screenshot returns no picture in this session — only an explanation to relay. If the user asks for a visual check, tell them to switch to a vision-capable model profile in Settings.`,
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, _params: any, signal) {
      if (!supportsImages) {
        return errorResult(
          `Screenshot not taken: the current model (${model.id}) accepts text only and cannot view images. ` +
          `Ask the user to switch to a vision-capable model profile in Settings, then try again.`,
          { error: "ModelTextOnly" },
        );
      }
      const managed = getManagedSession();
      try {
        return await capturePreviewPane(managed, toolCallId, signal);
      } catch (err) {
        const e = err as Error;
        if (signal?.aborted) throw err;
        return errorResult(`Screenshot failed: ${e.message}`, { error: e.name || "Error" });
      }
    },
  } as ToolDefinition;
}
