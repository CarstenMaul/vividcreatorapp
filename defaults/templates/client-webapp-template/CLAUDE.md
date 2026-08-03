# Client-side App Workspace

This project is a **pure client-side web app**. There is no backend: the whole
application is static HTML/CSS/JavaScript living in `public/`. It is exported
("deployed") as a zip of `public/` or as a single self-contained HTML file, and
must work when opened from `file://` or any static file host.

## Where the app lives

- Build **exclusively inside `public/`** — `public/index.html` is the entry
  point, with plain CSS and vanilla JavaScript files next to it. Organize
  freely (e.g. `public/assets/` for images), but everything must stay under
  `public/`.
- There is **no build step** — no Vite, no bundler, no npm packages. Edit the
  files in `public/` directly; the preview serves them as-is.

## Files you must never touch

- `server.js` is a read-only VCA dev harness that serves `public/` for the
  preview pane and packaged desktop builds. It is **not part of the app** and
  is excluded from every export. Never open, modify, replace, or extend it —
  never add API routes to it.
- `package.json` / `package-lock.json` — the platform owns them.

## Hard rules

1. **No backend, no APIs.** Never `fetch()` an application backend — there is
   none. Persist data with `localStorage` or `IndexedDB` only.
2. **Relative URLs only** for every asset, link, and script (`./styles.css`,
   `assets/logo.png` — never a leading `/`). Required by the VCA preview proxy
   AND by the exports, which must work from `file://`.
3. **Airgapped only:** no CDN `<script>`/`<link>` tags, no external fonts, no
   `http(s)://` asset references. External resources break offline exports and
   are not inlined into the single-file export.
4. **Keep JavaScript inlinable for the single-file export:** load JS via
   classic `<script src="./app.js" defer></script>` tags (execution order =
   tag order), or a single `<script type="module">` **without** `import`
   statements referencing other local files. Cross-file ES-module imports
   cannot be inlined and will make the single-file export fail.
5. Keep `public/index.html` as the single entry page (the exports and the SPA
   fallback assume it). Multi-view apps switch views client-side.
