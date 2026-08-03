process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import crypto from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
// Optional explicit bind host. Unset (preview, containers) keeps Node's
// default bind on all interfaces; the packaged desktop wrapper sets
// 127.0.0.1 so the server is reachable from this machine only.
const BIND_HOST = process.env.BIND_HOST || "";
const EXECENV = process.env.EXECENV || "DEV";

// --- Access guard (armed by the packaged desktop wrapper — do not remove) ---
// When APP_ACCESS_TOKEN is set, every request must carry the matching
// vca_app_token cookie. The Electron shell plants that cookie in its own
// window, so the app works normally there while any other local process
// gets 401.
const ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN || "";
if (ACCESS_TOKEN) {
  const want = Buffer.from(ACCESS_TOKEN);
  app.use((req, res, next) => {
    const match = /(?:^|;\s*)vca_app_token=([^;]*)/.exec(req.headers.cookie || "");
    const got = Buffer.from(match ? match[1] : "");
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return next();
    res.status(401).send("Unauthorized");
  });
}

app.use(express.json());

// --- API routes ---
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello, I am your new app!" });
});

// --- Static frontend ---
app.use(express.static(path.join(__dirname, "public")));

// SPA fallback: serve index.html for unmatched routes
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const onListening = () => {
  console.log(`Server running on port ${PORT}${BIND_HOST ? ` (bound to ${BIND_HOST})` : ""}`);
};
if (BIND_HOST) app.listen(PORT, BIND_HOST, onListening);
else app.listen(PORT, onListening);
