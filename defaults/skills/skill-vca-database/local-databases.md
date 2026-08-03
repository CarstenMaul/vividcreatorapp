# Local Databases — node:sqlite and DuckDB

Companion to `SKILL.md`. Read this when the app needs a file-backed database on **local disk**: durable structured data in a desktop/Electron app, a rebuildable cache in a container, or structured data during local development.

Two hard constraints apply to everything in this file:

1. **Never place a database file under `process.env.STORAGE_PATH`.** That path is an NFS-mounted Azure Files share without the locking semantics SQLite/DuckDB require. A database file there corrupts silently.
2. **Never use native Node modules** (`better-sqlite3`, `@duckdb/node-api`) **in an app that may deploy as a desktop/Electron app** — the desktop packaging pipeline does not bundle native binaries and the app will crash at require time. `node:sqlite` is built into Node 24 and needs no install.

---

## Where the database file may live

| Deployment target | Durable? | Path |
|---|---|---|
| Desktop / Electron | Yes | `path.join(os.homedir(), ".<appname>", "app.db")` — never the install directory (may be read-only) |
| Azure container | No — filesystem is ephemeral | `/tmp/<appname>-cache.db` — cache/derived data only, rebuilt at startup |
| Local development | Yes (workspace) | `./data/app.db` (add `data/` to `.gitignore`) |
| `${STORAGE_PATH}` (Azure Files share) | — | **NEVER** |

Resolve the path once, at startup, from an env override with a target-appropriate default. You know the deployment target when generating the app — pick the default accordingly; do not runtime-sniff.

```javascript
import os from "os";
import path from "path";
import fs from "fs";

// Desktop/local default. For a container-side cache use "/tmp/myapp-cache.db".
const DB_PATH = process.env.DB_PATH || path.join(os.homedir(), ".myapp", "app.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
```

---

## node:sqlite — the default choice

Built into Node 24 (`node:sqlite`), zero dependencies, works identically under the platform's Node runtime and the Electron desktop shell. Early Node 24.x minors print a one-time `ExperimentalWarning` on import — harmless; do not add flags or warning-suppression hacks.

Open the database once at module level and configure pragmas immediately:

```javascript
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");     // concurrent reads while writing
db.exec("PRAGMA busy_timeout = 5000");    // wait instead of throwing SQLITE_BUSY
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
```

Prepared statements — prepare once at module level, reuse per request, always bind parameters (`?` positional or `:name` named). Never interpolate user input into SQL strings:

```javascript
const insertItem = db.prepare("INSERT INTO items (name) VALUES (?)");
const getItem    = db.prepare("SELECT * FROM items WHERE id = ?");
const listItems  = db.prepare("SELECT * FROM items ORDER BY created_at DESC");
const setDone    = db.prepare("UPDATE items SET done = :done WHERE id = :id");

const { lastInsertRowid } = insertItem.run("buy milk");
const item  = getItem.get(lastInsertRowid);   // one row or undefined
const items = listItems.all();                // array of rows
setDone.run({ done: 1, id: item.id });
```

Transactions — `node:sqlite` has no transaction helper (unlike better-sqlite3), so wrap multi-statement writes manually:

```javascript
function withTransaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

withTransaction(() => {
  const { lastInsertRowid } = insertOrder.run(customerId);
  for (const line of lines) insertLine.run(lastInsertRowid, line.sku, line.qty);
});
```

Operational notes:

- The API is synchronous. That is fine for desktop single-user apps and small indexed queries; keep individual statements fast (indexes on filtered columns) because each call blocks the event loop.
- One module-level `DatabaseSync` instance per process — no pooling, no per-request opens.
- Call `db.close()` on shutdown (`process.on("SIGTERM", ...)`).
- Schema migrations: use `PRAGMA user_version` with numbered upgrade steps, or keep the schema idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` guarded by a try/catch). Do **not** use Drizzle/drizzle-kit for sqlite — the template's Drizzle version has no stable `node:sqlite` driver; raw SQL is the paved road here.

---

## DuckDB native (`@duckdb/node-api`) — rarely the right call

DuckDB shines at columnar analytics: aggregations and joins over Parquet/CSV files at high speed. But the Node bindings are a **native module**, so:

- **Excluded** for any app that may ship as a desktop/Electron app (same failure class as better-sqlite3 — the packaging pipeline does not bundle native binaries).
- Memory-hungry by default — in the 0.5 Gi container, set `SET memory_limit = '256MB'` immediately after opening.
- Adds a large binary dependency to `package.json` for a capability that usually fits elsewhere.

Decision rule, in order:

1. Analytics over user-supplied data → run **DuckDB-WASM in the browser** (`browser-databases.md`) — the user's machine does the work.
2. Modest server-side aggregation → **node:sqlite** with proper indexes and SQL aggregates.
3. Only a container-only, analytics-heavy app (large Parquet/CSV crunching on the server, never deployed to desktop) justifies `@duckdb/node-api` — and its `.db` file follows the same placement table above: never under `STORAGE_PATH`.

---

## Express integration

Wire prepared statements into API routes following the `node-backend` skill conventions — validate input, return 400 on bad requests:

```javascript
app.get("/api/items", (req, res) => {
  res.json(listItems.all());
});

app.post("/api/items", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  const { lastInsertRowid } = insertItem.run(name);
  res.status(201).json(getItem.get(lastInsertRowid));
});
```
