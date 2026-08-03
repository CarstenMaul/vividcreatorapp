---
name: client-webapp-conventions
description: Project-specific conventions for pure client-side apps built from this template — everything lives in public/, no backend, relative URLs, no CDN, and the single-file-export constraints on scripts.
---

# Client-side webapp conventions

<context>
These are the conventions for any app created from this project template. They
complement the workspace rules in `CLAUDE.md`. Follow them whenever you add or
change application code in this project.
</context>

<structure>
- The entire app is static files in `public/`: `index.html` (entry page), plain CSS, vanilla JS, and assets (e.g. `public/assets/`).
- `server.js` is a read-only VCA dev harness serving `public/` for the preview — it is not part of the app and is excluded from exports.
- There is no build step and no `node_modules`; edit `public/` directly.
</structure>

<rules>
1. No backend and no API calls — persist data with `localStorage`/`IndexedDB` only.
2. Relative URLs for every asset/link/script (`./styles.css`, `assets/logo.png` — never a leading `/`), so the app works behind the preview proxy and from `file://`.
3. Airgapped only: no CDN `<script>`/`<link>`, no external fonts, no `http(s)://` asset references — they break the offline exports.
4. Scripts must stay inlinable for the single-file HTML export: classic `<script src="…" defer>` tags in dependency order, or one `<script type="module">` without relative `import`s. Never split JS across ES modules.
5. Never modify `server.js`, `package.json`, or `package-lock.json`.
</rules>

<notes>
This skill is delivered by the project template (a "project skill"). It is
active by default and read-only. You can deactivate it per project from the
Skills dialog, but it cannot be edited or deleted from within icode — change it
by updating the template.
</notes>
