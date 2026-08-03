# Browser Databases — LocalStorage, IndexedDB, DuckDB-WASM

Companion to `SKILL.md`. Read this when data lives **in the user's browser**: small UI state, larger client-side records, or in-browser SQL analytics.

Everything in this file is client-side only. Browser storage is per-browser, per-device, not backed up, and cleared when the user clears site data. It is never multi-user and never authoritative — anything shared, durable, or security-relevant goes through the backend. Never store secrets or tokens in any browser storage.

---

## LocalStorage — tiny per-user UI state

Scope: ~5 MB per origin, string values only, synchronous API (blocks the main thread — never read/write large payloads in render paths).

Right for: theme choice, active filters, collapsed-sidebar state, small unsaved drafts, "don't show again" flags.

Wrong for: anything over a few hundred KB, structured records you query, anything the server needs to know, secrets.

Platform specifics:

- In the VCA preview, apps are served through a proxy on the **platform origin**, so all apps share one LocalStorage namespace. **Prefix every key with the app name and a version**: `myapp:v1:settings`. Without the prefix, two apps using the key `settings` overwrite each other.
- In deployed desktop apps, the Electron shell gives each app its own session partition — storage survives launches and cannot collide — but keep the prefix anyway so the code works in preview too.

Use a small wrapper: JSON round-trip, try/catch on **both** read and write (parse failures, quota errors, and private-browsing modes all throw), silent fallback to defaults:

```javascript
const KEY = "myapp:v1:settings";
const DEFAULTS = { theme: "light", pageSize: 25 };

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // quota exceeded or storage disabled — the app must keep working
  }
}
```

When the shape of the stored value changes, bump the version segment (`v1` → `v2`) and let the old key fall back to defaults instead of writing migration code.

---

## IndexedDB — the bigger client-side option

When LocalStorage is too small or too flat — more than a few MB, structured records, binary blobs, indexed lookups — use IndexedDB. Add the `idb` npm package (a tiny promise wrapper, bundled by Vite — never CDN-loaded) to the frontend dependencies:

```javascript
import { openDB } from "idb";

const dbPromise = openDB("myapp", 1, {
  upgrade(db) {
    const store = db.createObjectStore("notes", { keyPath: "id", autoIncrement: true });
    store.createIndex("by-updated", "updatedAt");
  },
});

export async function putNote(note) {
  return (await dbPromise).put("notes", { ...note, updatedAt: Date.now() });
}

export async function listNotes() {
  return (await dbPromise).getAllFromIndex("notes", "by-updated");
}
```

Same key caveat as LocalStorage: database names share the preview origin, so name the database after the app. And it is still per-device — an offline cache or local-first buffer, not a substitute for a server database.

---

## DuckDB-WASM — in-browser SQL analytics

When the app needs real SQL — aggregations, joins, window functions — over CSV/JSON/Parquet data the user uploads or the API serves, run DuckDB **in the browser**. The user's machine does the heavy lifting, which sidesteps the backend container's 0.5 Gi memory limit entirely.

Install as a frontend dependency only when analytics is genuinely needed — the wasm assets add tens of MB to `public/`:

```
npm install @duckdb/duckdb-wasm
```

### Offline bundling with Vite (required)

The duckdb-wasm docs and most tutorials load bundles from jsDelivr. **That is banned here** — `duckdb.getJsDelivrBundles()` or any `cdn.jsdelivr.net` URL works in dev and breaks the moment the app runs airgapped. Import the assets through Vite with `?url` so they are copied into the build and served same-origin:

```javascript
import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvp_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdb_wasm_eh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import eh_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

const MANUAL_BUNDLES = {
  mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
  eh:  { mainModule: duckdb_wasm_eh, mainWorker: eh_worker },
};

let db, conn;

export async function initDuckDB() {
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES); // picks eh where supported
  const worker = new Worker(bundle.mainWorker);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  return conn;
}
```

The `?url` imports guarantee same-origin worker/wasm assets, which is exactly what `new Worker(...)` requires. The mvp/eh bundles need no COOP/COEP headers.

### Loading data and querying

Register uploaded or fetched data as a virtual file, then query it with SQL:

```javascript
// From a user-selected file (e.g. <input type="file">)
const text = await file.text();
await db.registerFileText("data.csv", text);
await conn.insertCSVFromPath("data.csv", { schema: "main", name: "data" });

// Or from the app's own API (relative URL — no leading slash)
const buf = new Uint8Array(await (await fetch("api/export.parquet")).arrayBuffer());
await db.registerFileBuffer("export.parquet", buf);

const result = await conn.query(`
  SELECT category, count(*) AS n, avg(amount) AS avg_amount
  FROM data GROUP BY category ORDER BY n DESC
`);
const rows = result.toArray().map((r) => r.toJSON()); // Arrow table -> plain objects
```

Parameterize user-driven values — the SQL-injection rule applies in the browser too:

```javascript
const stmt = await conn.prepare("SELECT * FROM data WHERE category = ? LIMIT 100");
const filtered = await stmt.query(selectedCategory);
await stmt.close();
```

### Lifecycle

DuckDB-WASM here is an **ephemeral compute engine, not a store**: it runs in memory, and everything vanishes on reload. Persist nothing in it — results the user must keep go to the backend. Clean up when the analytics view unmounts:

```javascript
await conn.close();
await db.terminate();
```

---

## Checklist before choosing browser storage

- Does another user or device ever need this data? → backend (`server-databases.md`).
- Must it survive the user clearing their browser / reinstalling? → backend.
- Is it a secret or token? → never in browser storage.
- Is it a few KB of UI state? → LocalStorage. Bigger structured client data? → IndexedDB. SQL over datasets? → DuckDB-WASM.
