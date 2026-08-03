/**
 * Runtime-mode detection for the server process.
 *
 * VCA runs either as a container/server app (Docker, `node dist/server.js`)
 * or embedded in the packaged Electron desktop app. The desktop shell sets
 * VCA_PACKAGED=1 (electron/main.ts) before importing the server, so the mode
 * is fixed for the whole process lifetime.
 */
export function isElectronRuntime(): boolean {
  return process.env.VCA_PACKAGED === "1";
}
