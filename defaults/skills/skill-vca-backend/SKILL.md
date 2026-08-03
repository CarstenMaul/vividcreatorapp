---
name: node-backend
description: Node.js/Express backend architecture — every app uses Express to serve API routes and the React CDN frontend from the public/ directory.
---

# Node.js Backend (Express)

<context>
Every app uses this architecture. Express serves both the API and the static React frontend.
This skill defines the backend architecture. For the frontend (React 19 + Tailwind CSS), read and apply the `modern-react` skill. For visual styling, read and apply the `frontend-design` skill.
</context>

<project_structure>
```
project/
  server.js           <- Express entry point
  package.json        <- Dependencies and scripts
  Dockerfile          <- Node.js container for deployment
  public/             <- React frontend (served by Express)
    index.html        <- Frontend entry point
    *.jsx             <- Additional React components
    styles.css        <- Custom styles (if needed)
  routes/
    api.js            <- API route definitions (for larger apps)
```
</project_structure>

<server_template>
Every `server.js` should follow this pattern:

```javascript
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 80;

app.use(express.json());

// --- API routes ---
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from the API" });
});

// --- Static frontend ---
app.use(express.static(path.join(__dirname, "public")));

// SPA fallback: serve index.html for unmatched routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```
</server_template>

<package_json_template>
```json
{
  "name": "app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test": "echo \"no tests yet\" && exit 0"
  },
  "dependencies": {
    "express": "^5"
  }
}
```

Add dependencies as needed but keep them minimal — the container has only 0.5 Gi memory.
</package_json_template>

<dockerfile_template>
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm config set strict-ssl false && npm ci --omit=dev
COPY . .
EXPOSE 80
CMD ["node", "server.js"]
```
</dockerfile_template>

<system_packages>
For Debian system packages the app needs at runtime (e.g. `ffmpeg`, `imagemagick`, `poppler-utils`, `git`), do **not** add `apt-get install` lines to the Dockerfile — the deploy pipeline generates its own Dockerfile and your edits are overwritten. Instead, list them in `project.yaml` under a top-level `packages:` YAML sequence and the pipeline `apt-get install`s them while building the production image:

```yaml
# project.yaml
packages:
  - "ffmpeg"
  - "imagemagick"
```

Node.js dependencies still belong in `package.json` — `packages:` is only for system binaries.
</system_packages>

<api_route_patterns>
Simple inline routes (small apps) — define routes directly in `server.js`:

```javascript
app.get("/api/items", (req, res) => {
  res.json(items);
});

app.post("/api/items", (req, res) => {
  const item = req.body;
  items.push(item);
  res.status(201).json(item);
});
```

Separate route files (larger apps) — create `routes/api.js`:

```javascript
import { Router } from "express";
const router = Router();

router.get("/items", (req, res) => {
  res.json(items);
});

export default router;
```

Mount in `server.js`:

```javascript
import apiRoutes from "./routes/api.js";
app.use("/api", apiRoutes);
```
</api_route_patterns>

<frontend_backend_integration>
All URLs in frontend code must be relative (no leading slash). This applies to fetch calls, script/link/img tags, CSS url() — everything. A leading slash breaks the preview system because the browser resolves absolute paths against the main server, bypassing the preview proxy.

```javascript
// CORRECT — relative URL, no leading slash
const res = await fetch("api/items");
const data = await res.json();

// WRONG — leading slash breaks the preview system
const res = await fetch("/api/items"); // DO NOT USE
```

```html
<!-- CORRECT — relative paths for all resources -->
<script src="./app.js"></script>
<link rel="stylesheet" href="./styles.css">
<img src="./images/logo.png" alt="Logo">

<!-- WRONG — absolute paths break preview -->
<script src="/app.js"></script>
<link rel="stylesheet" href="/styles.css">
<img src="/images/logo.png" alt="Logo">
```

Error handling pattern:

```javascript
async function fetchAPI(endpoint) {
  try {
    const res = await fetch(`api/${endpoint}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("API call failed:", err);
    return null;
  }
}
```
</frontend_backend_integration>

<integration_with_other_skills>
persistent-storage — for data that must survive container restarts, derive every path from `process.env.STORAGE_PATH` (the platform injects a per-app subdirectory). Never hardcode `/mnt/storage`. See the `persistent-storage` skill for details.

```javascript
import fs from "fs/promises";
const STORAGE = process.env.STORAGE_PATH;
if (!STORAGE) throw new Error("STORAGE_PATH is not set");

app.get("/api/data", async (req, res) => {
  const data = JSON.parse(await fs.readFile(`${STORAGE}/data/store.json`, "utf-8"));
  res.json(data);
});
```

databases — for structured, queryable, or transactional data (relational rows, multi-user writes, SQL analytics), read the `databases` skill. It covers choosing between PostgreSQL (already in the template), MySQL/MariaDB, node:sqlite, and browser-side storage, per deployment target. Database access is backend-only: the frontend talks to `/api/*` routes, never to a database directly.

llm-services — for server-side LLM calls, add `openai` to `package.json` dependencies and use the Node.js SDK:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "c5aa61853b144473ab3ce024371f7e44",
  baseURL: "https://xmwe-ailz-apim-ailandingzone-01.azure-api.net/apim-openai/openai",
  defaultQuery: { "api-version": "2025-04-01-preview" },
  defaultHeaders: { "api-key": "c5aa61853b144473ab3ce024371f7e44" },
});

app.post("/api/chat", async (req, res) => {
  const response = await client.chat.completions.create({
    model: "gpt-5-mini",
    messages: req.body.messages,
  });
  res.json(response.choices[0].message);
});
```

corporate-network — the `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` line at the top of `server.js` handles SSL bypass for all outgoing requests. The Dockerfile includes `npm config set strict-ssl false` for package installation.
</integration_with_other_skills>

<rules>
1. JavaScript/TypeScript only — the deployment environment only supports Node.js. Never use Python, Go, Java, or any other language/runtime for backend code.
2. Always listen on `process.env.PORT || 80` — Azure Container Apps expects port 80.
3. Always create a Dockerfile — without it, a default is used. Include it for full control.
4. Always create a `package.json` with `start` and `test` scripts — the pipeline runs `npm test`.
5. Mount API routes under `/api/` — keeps clean separation from static file serving.
6. Serve the frontend with `express.static("public")` — frontend files live in `public/`.
7. Use relative URLs without leading slash everywhere in frontend code — `fetch("api/data")` not `fetch("/api/data")`, `src="./app.js"` not `src="/app.js"`.
8. Keep dependencies minimal — the container has 0.25 CPU and 0.5 Gi memory. Avoid heavy frameworks.
9. Set `NODE_TLS_REJECT_UNAUTHORIZED=0` at the top of `server.js` — required for corporate proxy.
10. Use ES modules — set `"type": "module"` in `package.json` and use `import`/`export`.
11. Add SPA fallback — `app.get("*", ...)` sends `public/index.html` for client-side routing.
</rules>
