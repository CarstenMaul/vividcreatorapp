---
name: persistent-storage
description: How to store and manage persistent user data files under `process.env.STORAGE_PATH` — use this whenever the app needs to save, load, or manage files that survive redeployments.
---

# Persistent Storage

<when_to_use>
Use the app's persistent storage for files that are read-only or written occasionally and survive container restarts:
1. User uploads (images, documents, media)
2. Generated files (reports, exports, PDFs)
3. Read-mostly configuration or seed data loaded at startup
4. Log files that need long-term retention
5. Cache files that should survive restarts (low write frequency)

Do **not** use persistent storage for:
- Structured / relational data, transactions, multi-user concurrent access — use the `databases` skill (PostgreSQL).
- Anything written on every request, hot paths, or data with multiple concurrent writers — use PostgreSQL.
- SQLite or any other file-backed SQL database **stored on this share** — see the rules below, and the `databases` skill for where file-backed databases *are* allowed.
</when_to_use>

<storage_location>
The platform injects a `STORAGE_PATH` environment variable that points to **your app's private data directory** on an Azure Files share. The path looks like `/mnt/storage/<container-app-name>` in production. Files written under `${STORAGE_PATH}` persist across container restarts and redeployments.

```
${STORAGE_PATH}     <- your app's private data root (per-app subdirectory)
```

Always derive every file path from `process.env.STORAGE_PATH`. Never write directly to `/mnt/storage` — that is the mount root of a share that other apps also mount, and writing there leaks data outside your app's namespace.

Files written outside `${STORAGE_PATH}` (e.g. `/tmp`, project directory) are ephemeral and will be lost on restart.
</storage_location>

<performance_and_concurrency>
The persistent storage is an NFS-mounted Azure Files share — **not** local disk. Per-operation latency is high (single-digit to tens of milliseconds per syscall) and throughput is far below local disk. The share also does not provide the locking semantics that databases like SQLite expect.

Use it for:
- Large blobs read or written infrequently — uploads, exports, generated reports, logs.
- Read-mostly data loaded at process startup (config, seed JSON).

Do **not** use it for:
- Hot paths or per-request reads/writes.
- Anything with multiple concurrent writers.
- Any database file (SQLite, DuckDB, H2 embedded, etc.) — never on this share; see the `databases` skill for allowed locations.

For structured data, transactions, multi-user concurrent access, or anything written on every request, use the `databases` skill (PostgreSQL on the shared Azure Database for PostgreSQL Flexible Server).
</performance_and_concurrency>

<directory_structure>
Organize files under `${STORAGE_PATH}` by purpose:

```
${STORAGE_PATH}/
  config/        <- read-mostly app config or seed data (NOT for live read/write — use PostgreSQL)
  uploads/       <- user-uploaded files
  exports/       <- generated files for download
  logs/          <- persistent application logs
```

`${STORAGE_PATH}` itself does not pre-exist on the first deploy — create it (and any subdirectories) at application startup with `recursive: true`.
</directory_structure>

<implementation_patterns>
Ensure your data root and its subdirectories exist at startup:

```javascript
import fs from "fs/promises";

const STORAGE = process.env.STORAGE_PATH;
if (!STORAGE) throw new Error("STORAGE_PATH is not set");

const DIRS = ["config", "uploads", "exports", "logs"];

async function initStorage() {
  await fs.mkdir(STORAGE, { recursive: true });
  for (const dir of DIRS) {
    await fs.mkdir(`${STORAGE}/${dir}`, { recursive: true });
  }
}
```

Call `initStorage()` when the server starts, before handling any requests.

Saving user uploads:

```javascript
import path from "path";
import crypto from "crypto";

function getUploadPath(originalName) {
  const ext = path.extname(originalName);
  const id = crypto.randomUUID();
  return `${STORAGE}/uploads/${id}${ext}`;
}
```

Always generate unique filenames to avoid collisions. Never trust user-provided filenames directly.

Serving files:

```javascript
import express from "express";

app.use("/files", express.static(`${STORAGE}/uploads`));
```

Or for controlled access:

```javascript
app.get("/files/:id", async (req, res) => {
  const filePath = path.join(STORAGE, "uploads", req.params.id);
  // Prevent path traversal
  if (!filePath.startsWith(`${STORAGE}/uploads/`)) {
    return res.status(403).send("Forbidden");
  }
  res.sendFile(filePath);
});
```

JSON file store for **read-mostly** data (e.g. config loaded at startup, a small allowlist that changes rarely). Do **not** use this for data with concurrent writers or per-request mutation — use PostgreSQL via the `databases` skill instead.

```javascript
const DATA_FILE = `${STORAGE}/config/store.json`;

async function loadData() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}
```
</implementation_patterns>

<rules>
1. Always derive every persistent file path from `process.env.STORAGE_PATH`. Never hardcode `/mnt/storage` — apps that bypass `STORAGE_PATH` would write into the shared mount root and leak data outside their own namespace.
2. Never store SQLite, DuckDB, or any other file-backed database file under `${STORAGE_PATH}` — the Azure Files share does not provide the locking semantics these engines need, and per-op latency makes it unusable for hot paths. File-backed databases are allowed on other targets (desktop/Electron apps, local dev, container-local ephemeral cache) — see the `databases` skill. For durable structured data on Azure, use PostgreSQL via the `databases` skill.
3. Persistent storage is for files that are read-only or written **occasionally**. For concurrent read/write, per-request mutation, or any structured / multi-user data, use PostgreSQL via the `databases` skill.
4. Create directories with `recursive: true` — `${STORAGE_PATH}` itself does not pre-exist on the first deploy and subdirectories will not exist until you make them.
5. Generate unique filenames for uploads — use UUIDs or timestamps, never raw user input.
6. Prevent path traversal — validate that resolved file paths stay within the intended directory before reading or writing.
7. Handle missing files gracefully — the storage starts empty. Always use try/catch when reading files that may not exist yet.
8. Mind the quota — apps that manage large files should implement cleanup or rotation; do not assume unlimited space.
9. For local development outside the platform, set `STORAGE_PATH` to a workspace-local directory:
   ```javascript
   const STORAGE = process.env.STORAGE_PATH || "./data";
   ```
   Never fall back to `/mnt/storage` — in production that path is real and would leak data outside the app's subdirectory.
</rules>
