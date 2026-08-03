import { createRoot } from "react-dom/client";

// Installs window.marked / window.hljs / window.DOMPurify. app.jsx references
// these CDN-era globals at module-evaluation time (e.g. a top-level
// marked.setOptions(...)), so this side-effect import MUST come before
// ./app.jsx below — otherwise the bundle throws "marked is not defined" during
// evaluation and React never mounts (blank window).
import "./global-shims.js";

import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/600.css";
import "@fontsource/open-sans/700.css";

import hljsLightUrl from "highlight.js/styles/github.css?url";
import hljsDarkUrl from "highlight.js/styles/github-dark.css?url";

import { initAppConfig } from "./i18n.js";
import "./styles.css";
import { App } from "./app.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";

function applyHljsTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const href = dark ? hljsDarkUrl : hljsLightUrl;
  let link = document.getElementById("hljs-theme");
  if (!link) {
    link = document.createElement("link");
    link.rel = "stylesheet";
    link.id = "hljs-theme";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

applyHljsTheme();
new MutationObserver(applyHljsTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

(async () => {
  const rootEl = document.getElementById("root");
  try {
    await initAppConfig();
    // Server already substituted __APP_SHORTCUT__ in index.html (see
    // serveWithAppNameSubstitution in src/server.ts) — nothing to do here for
    // the <title>; this note exists so no one wonders why no JS sets it.
    createRoot(rootEl).render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>,
    );
  } catch (err) {
    // Bootstrap threw before React could mount. Without this, the window stays
    // pure white with nothing to go on. Render the error directly into the DOM
    // and log it (electron/main.ts forwards console output to boot.log).
    console.error("[bootstrap] failed before mount:", err);
    const detail = (err && (err.stack || err.message)) || String(err);
    if (rootEl) {
      document.body.style.background = "#1f2430";
      const pre = document.createElement("pre");
      pre.textContent = "VCA failed to start:\n\n" + detail;
      pre.style.cssText =
        "white-space:pre-wrap;word-break:break-word;font-family:system-ui,sans-serif;padding:32px;color:#e6e6e6";
      rootEl.replaceChildren(pre);
    }
  }
})();
