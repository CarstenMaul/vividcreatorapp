import fs from "fs/promises";
import path from "path";

/**
 * Static export of client-side webapp projects (appType "web"): turns the
 * workspace's public/ dir into a single self-contained HTML file with every
 * local stylesheet, script, image and font inlined (CSS/JS as text, binaries
 * as base64 data URIs), so the file works offline from anywhere (file://,
 * mail attachment, static host).
 *
 * The inliner is regex-based on purpose: the client-webapp template constrains
 * the HTML shape (relative refs, classic scripts or one import-free module),
 * so a full HTML parser dependency isn't warranted. External (http(s)://,
 * data:, //host) refs are left untouched and reported as warnings — the
 * template forbids them anyway (airgap rule).
 */

export class StaticExportError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "StaticExportError";
    this.code = code;
  }
}

// Assembled-output ceiling — inlining multiplies binary assets by ~4/3, and a
// single HTML file beyond this size stops being a sensible artifact.
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CSS_IMPORT_DEPTH = 8;
const MAX_WARNINGS = 20;

const MIME: Record<string, string> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

/** Does the workspace have an exportable app? */
export async function hasPublicIndex(workspacePath: string): Promise<boolean> {
  try {
    await fs.access(path.join(workspacePath, "public", "index.html"));
    return true;
  } catch {
    return false;
  }
}

// Scheme-full (http:, https:, data:, mailto:, …), protocol-relative (//host)
// and fragment-only refs are not local files.
function isExternalRef(ref: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
}

/** Resolve a local ref against public/ with containment; null = outside/invalid. */
function resolveLocal(publicDir: string, fromDir: string, ref: string): string | null {
  let clean = ref.split(/[?#]/)[0].trim();
  if (!clean) return null;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const abs = clean.startsWith("/")
    ? path.resolve(publicDir, clean.slice(1))
    : path.resolve(fromDir, clean);
  const rootAbs = path.resolve(publicDir);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

// (?<![\w-]) instead of \b so e.g. data-src never matches as src.
function getAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`(?<![\\w-])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? "";
}

function stripAttr(tag: string, name: string): string {
  return tag
    .replace(new RegExp(`\\s*(?<![\\w-])${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i"), "")
    .replace(new RegExp(`\\s+(?<![\\w-])${name}(?=[\\s>])`, "i"), ""); // bare boolean form
}

interface InlineContext {
  publicDir: string;
  warnings: string[];
  total: number;
}

function warn(ctx: InlineContext, message: string): void {
  if (ctx.warnings.length < MAX_WARNINGS && !ctx.warnings.includes(message)) {
    ctx.warnings.push(message);
  }
}

function addBytes(ctx: InlineContext, n: number): void {
  ctx.total += n;
  if (ctx.total > MAX_TOTAL_BYTES) {
    throw new StaticExportError(
      "Inlined export exceeds 64 MB — reduce embedded assets (images, fonts, media)",
      "EXPORT_TOO_LARGE",
    );
  }
}

async function readLocalFile(ctx: InlineContext, fromDir: string, ref: string): Promise<Buffer | null> {
  const abs = resolveLocal(ctx.publicDir, fromDir, ref);
  if (!abs) {
    warn(ctx, `unresolvable reference left as-is: ${ref}`);
    return null;
  }
  try {
    const buf = await fs.readFile(abs);
    addBytes(ctx, buf.length);
    return buf;
  } catch {
    warn(ctx, `missing file left as-is: ${ref}`);
    return null;
  }
}

async function toDataUri(ctx: InlineContext, fromDir: string, ref: string): Promise<string | null> {
  const buf = await readLocalFile(ctx, fromDir, ref);
  if (buf === null) return null;
  const abs = resolveLocal(ctx.publicDir, fromDir, ref)!;
  const mime = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  // base64 output is ~4/3 of the raw bytes — count the difference too.
  addBytes(ctx, Math.ceil(buf.length / 3));
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Replace async — sequential, since handlers hit the filesystem. */
async function replaceAsync(
  input: string,
  re: RegExp,
  fn: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  let out = "";
  let last = 0;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    out += input.slice(last, m.index) + (await fn(m));
    last = m.index + m[0].length;
  }
  return out + input.slice(last);
}

/** Inline url(...) refs and @import statements inside CSS text. */
async function inlineCss(ctx: InlineContext, css: string, fromDir: string, depth: number): Promise<string> {
  if (depth > MAX_CSS_IMPORT_DEPTH) {
    warn(ctx, "css @import nesting too deep — deeper imports left as-is");
    return css;
  }
  // @import "x"; / @import url("x") screen; → recursively inlined stylesheet.
  css = await replaceAsync(
    css,
    /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)([^;]*);/gi,
    async (m) => {
      const ref = (m[2] ?? m[4] ?? "").trim();
      if (!ref || isExternalRef(ref)) {
        if (ref) warn(ctx, `external css import left as-is: ${ref}`);
        return m[0];
      }
      const buf = await readLocalFile(ctx, fromDir, ref);
      if (buf === null) return m[0];
      const abs = resolveLocal(ctx.publicDir, fromDir, ref)!;
      const nested = await inlineCss(ctx, buf.toString("utf-8"), path.dirname(abs), depth + 1);
      const media = (m[5] || "").trim();
      return media ? `@media ${media} {\n${nested}\n}` : nested;
    },
  );
  // url(...) → data URI (fonts, images). data:/external untouched.
  css = await replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, async (m) => {
    const ref = m[2].trim();
    if (!ref || isExternalRef(ref)) {
      if (ref && !ref.startsWith("data:") && !ref.startsWith("#")) {
        warn(ctx, `external css url left as-is: ${ref}`);
      }
      return m[0];
    }
    const dataUri = await toDataUri(ctx, fromDir, ref);
    return dataUri ? `url("${dataUri}")` : m[0];
  });
  return css;
}

// A relative static or dynamic ES-module import — cannot survive inlining
// (the sibling files won't exist next to the exported single HTML file).
function hasRelativeModuleImports(code: string): boolean {
  return (
    /(?:^|[\s;{}()])import\s+(?:[\w${},*\s]+from\s+)?['"](?:\.{0,2}\/)[^'"]*['"]/m.test(code) ||
    /(?:^|[\s;{}()])import\s*\(\s*['"](?:\.{0,2}\/)[^'"]*['"]/m.test(code) ||
    /(?:^|[\s;{}()])export\s+(?:[\w${},*\s]+\s+)?from\s+['"](?:\.{0,2}\/)[^'"]*['"]/m.test(code)
  );
}

function escapeInlineScript(code: string): string {
  // "</script" would terminate the inline block early; "<!--" can open an
  // HTML comment inside scripts per the spec. Both rewrites are inert in JS
  // string/template contexts and invalid nowhere else in practice.
  return code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

/**
 * Build one self-contained HTML document from public/index.html.
 * Throws StaticExportError with code NO_INDEX_HTML, MODULE_IMPORTS or
 * EXPORT_TOO_LARGE.
 */
export async function buildSingleHtml(publicDir: string): Promise<{ html: string; warnings: string[] }> {
  let html: string;
  try {
    html = await fs.readFile(path.join(publicDir, "index.html"), "utf-8");
  } catch {
    throw new StaticExportError("public/index.html not found — nothing to export", "NO_INDEX_HTML");
  }
  const ctx: InlineContext = { publicDir, warnings: [], total: 0 };
  addBytes(ctx, Buffer.byteLength(html, "utf-8"));

  // 1. <link> tags: stylesheets → <style>, icons → data URI, preloads dropped.
  html = await replaceAsync(html, /<link\b[^>]*>/gi, async (m) => {
    const tag = m[0];
    const rel = (getAttr(tag, "rel") || "").toLowerCase();
    const href = getAttr(tag, "href") || "";
    if (!href || isExternalRef(href)) {
      if (href && /stylesheet|icon/.test(rel)) warn(ctx, `external link left as-is: ${href}`);
      return tag;
    }
    if (/\bstylesheet\b/.test(rel)) {
      const buf = await readLocalFile(ctx, publicDir, href);
      if (buf === null) return tag;
      const abs = resolveLocal(publicDir, publicDir, href)!;
      const css = await inlineCss(ctx, buf.toString("utf-8"), path.dirname(abs), 0);
      const media = getAttr(tag, "media");
      return `<style${media ? ` media="${media}"` : ""}>\n${css}\n</style>`;
    }
    if (/\b(?:icon|apple-touch-icon)\b/.test(rel)) {
      const dataUri = await toDataUri(ctx, publicDir, href);
      return dataUri ? tag.replace(href, dataUri) : tag;
    }
    if (/\b(?:preload|modulepreload|prefetch)\b/.test(rel)) {
      return ""; // pointless once everything is inlined
    }
    return tag;
  });

  // 2. <script src> → inline the file's content.
  html = await replaceAsync(html, /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, async (m) => {
    const attrs = m[1];
    const body = m[2];
    const openTag = `<script${attrs}>`;
    const src = getAttr(openTag, "src");
    const isModule = (getAttr(openTag, "type") || "").toLowerCase() === "module";
    if (!src) {
      if (isModule && hasRelativeModuleImports(body)) {
        throw new StaticExportError(
          "Inline module script imports local files — bundle the app's JS into one file or use classic scripts",
          "MODULE_IMPORTS",
        );
      }
      return m[0];
    }
    if (isExternalRef(src)) {
      warn(ctx, `external script left as-is: ${src}`);
      return m[0];
    }
    const buf = await readLocalFile(ctx, publicDir, src);
    if (buf === null) return m[0];
    const code = buf.toString("utf-8");
    if (isModule && hasRelativeModuleImports(code)) {
      throw new StaticExportError(
        `Module script "${src}" imports local files — bundle the app's JS into one file or use classic scripts`,
        "MODULE_IMPORTS",
      );
    }
    // src (and now-meaningless defer/async) go away; the code runs in place.
    const newOpen = stripAttr(stripAttr(stripAttr(openTag, "src"), "defer"), "async");
    return `${newOpen}\n${escapeInlineScript(code)}\n</script>`;
  });

  // 3. Media/image tags: src, poster and srcset attributes → data URIs.
  html = await replaceAsync(html, /<(?:img|source|audio|video|input|embed)\b[^>]*>/gi, async (m) => {
    let tag = m[0];
    for (const attr of ["src", "poster"]) {
      const ref = getAttr(tag, attr);
      if (!ref || isExternalRef(ref)) {
        if (ref && !ref.startsWith("data:")) warn(ctx, `external ${attr} left as-is: ${ref}`);
        continue;
      }
      const dataUri = await toDataUri(ctx, publicDir, ref);
      if (dataUri) tag = tag.replace(ref, dataUri);
    }
    const srcset = getAttr(tag, "srcset");
    if (srcset) {
      const parts = await Promise.all(
        srcset.split(",").map(async (candidate) => {
          const [ref, ...desc] = candidate.trim().split(/\s+/);
          if (!ref || isExternalRef(ref)) return candidate.trim();
          const dataUri = await toDataUri(ctx, publicDir, ref);
          return dataUri ? [dataUri, ...desc].join(" ") : candidate.trim();
        }),
      );
      tag = tag.replace(srcset, parts.join(", "));
    }
    return tag;
  });

  // 4. Inline <style> blocks may carry url() refs of their own. (Blocks
  // produced by step 1 re-run harmlessly — data: URIs are skipped.)
  html = await replaceAsync(html, /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, async (m) => {
    if (!m[1].trim()) return m[0];
    const inlined = await inlineCss(ctx, m[1], publicDir, 0);
    return m[0].replace(m[1], () => inlined);
  });

  if (ctx.warnings.length > 0) {
    html += `\n<!-- vca static export: ${ctx.warnings.length} warning(s)\n${ctx.warnings
      .map((w) => `  - ${w.replace(/--/g, "- -")}`)
      .join("\n")}\n-->\n`;
  }
  return { html, warnings: ctx.warnings };
}
