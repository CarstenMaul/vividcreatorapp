# App Workspace

## Port configuration

The vca platform assigns this app an exclusive TCP port and passes it via the `PORT`
environment variable. The server **must** bind on exactly that port.

Rules — enforce these in all generated and modified code without exception:

- Always read the port from `process.env.PORT`: `const PORT = parseInt(process.env.PORT || "3000", 10);`
- Never hardcode a port number anywhere in server code
- Never implement port-scanning or fallback logic (do not try multiple ports)
- The `|| "3000"` fallback is only a local-dev safety net; in production `PORT` is always set

Violating these rules causes the preview proxy to be unable to reach the app.

## Desktop (Electron) contract

Packaged desktop builds wrap the server in an Electron shell that sets two
more environment variables. `server.js` already honors both — keep that code
intact in all generated and modified code:

- `BIND_HOST` — when set, bind the server to exactly this host:
  `app.listen(PORT, BIND_HOST, …)`. When unset, keep Node's default bind.
  The desktop wrapper sets `127.0.0.1` so the app is never exposed to the
  network.
- `APP_ACCESS_TOKEN` — when set, the access-guard middleware in `server.js`
  must reject every request that lacks the matching `vca_app_token` cookie
  (the Electron shell injects that cookie into its own window). Never remove
  or weaken this middleware — without it, any local process could call the
  API of an installed desktop app.

## Browser-side React setup

The frontend lives in `web/`:

- `web/index.html` — HTML shell (no CDN scripts, no Babel).
- `web/src/main.jsx` — mount point. Imports React, fonts, styles.
- `web/src/App.jsx` — the top-level component. Add new components alongside it.
- `web/src/styles.css` — Tailwind v4 entry. Brand tokens live in `@theme`.

Vite bundles `web/` to `public/` at build time. `server.js` serves `public/` as
static files; **never edit `public/` directly** — it is overwritten on every build.

### Rebuild after editing the frontend

After you change any file under `web/`, run:

    npm run build

This regenerates `public/` so the preview iframe (or the deployed app) picks up
your changes on next load. The preview server does **not** auto-rebuild; the
build step is your job.

If you want auto-rebuild while iterating locally, run `npm run dev` in a
terminal — it parallel-runs `node --watch server.js` and `vite build --watch`.

### Don't reintroduce CDN imports

The whole point of this template is that the app must run on an airgapped
machine. Never add `<script src="https://...">` tags, `<link>` to external
fonts, browser-side Babel, or esm.sh import maps — they will work in dev and
break the moment the app is installed on a corporate desktop without internet.
Every JS/CSS/font asset must come from npm and be bundled by Vite.
