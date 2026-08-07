import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Paths here are deliberately relative, never derived from __dirname /
// import.meta.url. Vite bundles this config with rolldown, which canonicalises
// the config's own path through realpath; on a mapped network drive (a VCA
// workspace root on a Windows fileserver) that returns the UNC spelling, and
// vite's normalizePath() then collapses the leading "\\" and loses the server
// name — the build dies with UNRESOLVED_ENTRY on a path that never existed.
// Relative paths resolve against the process cwd, which npm sets to the project
// directory, so they keep whatever spelling the build was launched with.
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    // Stops vite and rolldown canonicalising module paths through realpath,
    // which is the other way a mapped-drive path can turn into its UNC target
    // mid-build. Safe here because a generated app has a flat npm tree with no
    // linked workspace packages to dedupe.
    preserveSymlinks: true,
  },
  build: {
    // Relative to `root`, i.e. <project>/public — the directory server.js serves.
    outDir: "../public",
    // Load-bearing: vite refuses to empty an outDir that sits outside root
    // unless this is explicitly set.
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
