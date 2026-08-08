// ─── VCA Translations ──────────────────────────────────────
// One module per language under ./locales/. English is the source of truth:
// it defines the full key set, and any key a translation has not covered yet
// falls back to the English string in createT below.
import en from "./locales/en.js";
import de from "./locales/de.js";
import fr from "./locales/fr.js";
import es from "./locales/es.js";
import it from "./locales/it.js";
import pt from "./locales/pt.js";
import pl from "./locales/pl.js";
import ru from "./locales/ru.js";
import ar from "./locales/ar.js";
import hi from "./locales/hi.js";
import zh from "./locales/zh.js";
import ja from "./locales/ja.js";
import ko from "./locales/ko.js";

// Key order here mirrors LANGS in app.jsx, which drives the switcher.
const translations = {
  en,
  de,
  fr,
  es,
  it,
  pt,
  pl,
  ru,
  ar,
  hi,
  zh,
  ja,
  ko,
};

// Placeholders __APP_NAME__ / __APP_SHORTCUT__ used to be rewritten server-side
// when i18n.js was fetched as a static file. With Vite the dictionaries are
// part of the JS bundle, so the placeholders are resolved at lookup time
// against config fetched once from the public /app-config endpoint.
let appConfig = { name: "VCA", shortcut: "VCA" };

export async function initAppConfig() {
  try {
    const res = await fetch("/app-config", { credentials: "include" });
    if (res.ok) {
      const parsed = await res.json();
      appConfig = {
        name: typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name : appConfig.name,
        shortcut: typeof parsed?.shortcut === "string" && parsed.shortcut.trim() ? parsed.shortcut : appConfig.shortcut,
      };
    }
  } catch {
    // keep defaults
  }
}

function applyAppName(value) {
  // Some translation values are arrays (e.g. "msg.spinnerVerbs"), so guard the
  // string ops: recurse into arrays, pass non-strings through untouched. Without
  // this, t("msg.spinnerVerbs") throws "x.replace is not a function" the moment
  // an assistant message renders its spinner.
  if (Array.isArray(value)) return value.map(applyAppName);
  if (typeof value !== "string") return value;
  return value
    .replace(/__APP_NAME__/g, appConfig.name)
    .replace(/__APP_SHORTCUT__/g, appConfig.shortcut);
}

export function createT(lang) {
  const dict = translations[lang] || translations.en;
  const fallback = translations.en;
  return function t(key, params) {
    let str = applyAppName(dict[key] || fallback[key] || key);
    if (params && typeof str === "string") {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, v);
      }
    }
    return str;
  };
}

// Back-compat shim so app.jsx:12705 (`window.__vca_i18n.createT(lang)`) keeps
// working unchanged. Future cleanup: convert the call site to a module import.
if (typeof window !== "undefined") {
  window.__vca_i18n = { translations, createT };
}
