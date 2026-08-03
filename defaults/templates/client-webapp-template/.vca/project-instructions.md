This project is a PURE CLIENT-SIDE web app. The following rules replace the
global full-stack rules for this project:

- There is NO Express backend and none may be created. Ignore the global
  requirements to create `server.js` API routes, backend LLM proxy routes, or
  any server-side code. There is no API — never call `fetch("api/...")`.
- `server.js` in this workspace is a locked platform dev-harness that serves
  `public/` for the preview. Never open, modify, replace, or extend it. Never
  touch `package.json` or install npm packages.
- Build exclusively inside `public/` with vanilla HTML/CSS/JavaScript: no
  React, no Tailwind, no CDN tags, no build tools. `public/index.html` is the
  entry page.
- Use relative URLs for every asset and link (never a leading `/`). Persist
  data with `localStorage` or `IndexedDB`.
- The app is deployed as a static-file zip or a single self-contained HTML
  file, so it must work offline from `file://`. Load JS via classic
  `<script src defer>` tags (or one import-free module script); cross-file
  ES-module imports are forbidden.

The global rules about maintaining the `.vca-*.json` diagrams still apply —
model the app as frontend-only (no server/database tiers unless the user asks
for external systems).
