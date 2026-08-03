// marked / highlight.js / DOMPurify were historically loaded via CDN <script>
// tags, which exposed them as the globals `marked` / `hljs` / `DOMPurify`.
// app.jsx (and other modules) still reference those globals at module-evaluation
// time — e.g. a top-level `marked.setOptions({...})` in app.jsx. Once everything
// is bundled by Vite, nothing creates those globals unless we do it here, and it
// MUST happen before app.jsx evaluates. This module is imported first in
// main.jsx (as a side-effect import) precisely so these assignments win the
// race; otherwise the bundle throws "marked is not defined" during evaluation
// and React never mounts (blank window).
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "./highlight-langs.js";

if (typeof window !== "undefined") {
  window.hljs = hljs;
  window.marked = marked;
  window.DOMPurify = DOMPurify;
}

export { hljs, marked, DOMPurify };
