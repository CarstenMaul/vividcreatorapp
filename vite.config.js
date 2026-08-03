import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "web"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist-web"),
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
