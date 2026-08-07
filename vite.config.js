import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Paths here are deliberately relative, never derived from __dirname /
// import.meta.url — see defaults/templates/default-app-template/vite.config.js
// for the full reasoning. Short version: rolldown realpaths this file while
// bundling it, which on a mapped network drive yields a UNC path that vite's
// normalizePath() then mangles. It matters for this config too, because
// platform-release-runner prefixes `npm run build &&` onto the packaging
// scripts and runs them inside a project workspace.
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  build: {
    // Relative to `root`, i.e. <repo>/dist-web.
    outDir: "../dist-web",
    // Load-bearing: vite refuses to empty an outDir outside root without it.
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rolldownOptions: {
      output: {
        manualChunks: (id) => (id.includes("node_modules/mermaid") ? "mermaid" : undefined),
      },
    },
  },
});
