// VCA dev harness — DO NOT EDIT.
//
// The application lives entirely in public/. This file only serves public/
// for the VCA preview pane (and packaged desktop builds); it is NOT part of
// the exported app — the zip / single-file exports contain public/ only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = parseInt(process.env.PORT || "3000", 10);
// Optional explicit bind host. Unset (preview, containers) keeps Node's
// default bind on all interfaces; the packaged desktop wrapper sets
// 127.0.0.1 so the server is reachable from this machine only.
const BIND_HOST = process.env.BIND_HOST || "";
// Access guard (armed by the packaged desktop wrapper — do not remove).
// When APP_ACCESS_TOKEN is set, every request must carry the matching
// vca_app_token cookie.
const ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  if (ACCESS_TOKEN) {
    const want = Buffer.from(ACCESS_TOKEN);
    const match = /(?:^|;\s*)vca_app_token=([^;]*)/.exec(req.headers.cookie || "");
    const got = Buffer.from(match ? match[1] : "");
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
  } catch {
    urlPath = "/";
  }
  let filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // fall through to the SPA fallback below
  }
  if (!stat || stat.isDirectory()) filePath = path.join(PUBLIC_DIR, "index.html");

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

const onListening = () => {
  console.log(`Server running on port ${PORT}${BIND_HOST ? ` (bound to ${BIND_HOST})` : ""}`);
};
if (BIND_HOST) server.listen(PORT, BIND_HOST, onListening);
else server.listen(PORT, onListening);
