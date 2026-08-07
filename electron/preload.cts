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
  /**
   * Classify a folder without staging: resolves to
   * { kind, uncTarget, driveLetterPath, syncProvider } or null. Lets the picker
   * warn about network/cloud targets before a mode is chosen.
   */
  inspectFolder: (path: string) => ipcRenderer.invoke("vca:inspectFolder", path),
  /**
   * Map a `\\server\share` to a free drive letter via `net use`; resolves to
   * { ok, path? }. The remedy offered when a UNC root is rejected.
   */
  mapNetworkDrive: (share: string) => ipcRenderer.invoke("vca:mapNetworkDrive", share),
  /**
   * Validate + stage a change; resolves to { ok, error?, warnings?, volume? }.
   * `acceptedWarnings` must contain every warning code the UI displayed, or the
   * main process refuses with error "unacknowledged".
   */
  stageRootChange: (arg: { newRoot: string; mode: RootChangeMode; acceptedWarnings?: string[] }) =>
    ipcRenderer.invoke("vca:stageRootChange", arg),
  /** Clear any staged change. */
  cancelPendingChange: () => ipcRenderer.invoke("vca:cancelPendingChange"),
  /** Open a project's userdata/ folder in the OS file explorer. */
  openUserdataFolder: (arg: { userId: string; projectId: string }) =>
    ipcRenderer.invoke("vca:openUserdataFolder", arg),
  /**
   * One-way push: tells the main process whether an agent turn is in flight, so
   * win.on("close") and before-quit can refuse to tear down the in-process
   * server mid-turn. Carries the localized notice text — main has no i18n.
   */
  setAgentBusy: (arg: { busy: boolean; title?: string; message?: string }) =>
    ipcRenderer.send("vca:setAgentBusy", arg),
});

export {};
