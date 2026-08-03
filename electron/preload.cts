// Preload runs in an isolated world before the renderer loads. The SPA talks to
// the in-process Express server over fetch (exactly as in the web build), so the
// only renderer-side surface is the desktop-only Storage bridge below: it lets
// Settings → Storage relocate the physical workspace root via native folder
// picking + a staged change the main process applies on next boot.
//
// Presence of window.vcaDesktop is itself the "running in the desktop app" signal
// the UI gates on — it is absent in the plain browser/server build.
import { contextBridge, ipcRenderer } from "electron";

type RootChangeMode = "move" | "new" | "existing";

contextBridge.exposeInMainWorld("vcaDesktop", {
  /** { root, defaultRoot, pending } — pending is null when nothing is staged. */
  getStorageInfo: () => ipcRenderer.invoke("vca:getStorageInfo"),
  /** Native folder picker; resolves to the chosen absolute path or null. */
  pickFolder: () => ipcRenderer.invoke("vca:pickFolder"),
  /** Validate + stage a change; resolves to { ok, error? }. */
  stageRootChange: (arg: { newRoot: string; mode: RootChangeMode }) =>
    ipcRenderer.invoke("vca:stageRootChange", arg),
  /** Clear any staged change. */
  cancelPendingChange: () => ipcRenderer.invoke("vca:cancelPendingChange"),
  /** Open a project's userdata/ folder in the OS file explorer. */
  openUserdataFolder: (arg: { userId: string; projectId: string }) =>
    ipcRenderer.invoke("vca:openUserdataFolder", arg),
});

export {};
