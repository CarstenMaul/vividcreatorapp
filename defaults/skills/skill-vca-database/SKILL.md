---
name: databases
description: How to choose and use a database in generated apps — PostgreSQL/MySQL for server deployments, node:sqlite for desktop and local data, DuckDB-WASM for in-browser analytics, LocalStorage for tiny UI state. Use whenever the app needs structured, queryable, or transactional data.
---

# Databases

<when_to_use>
Use this skill whenever the app needs structured data: relational rows, transactions, queries/filters/aggregations, multi-user writes, SQL analytics over CSV/JSON/Parquet, or per-user client-side state. Also use it whenever you are deciding *whether* to use SQLite, PostgreSQL, DuckDB, or browser storage.

Hand-off: raw file blobs (user uploads, generated exports, logs) are not database data — store them as files via the `persistent-storage` skill.

This skill is the decision guide. Before writing any database code, read the matching reference file in this skill directory:

- `browser-databases.md` — LocalStorage, IndexedDB, DuckDB-WASM (client-side)
- `local-databases.md` — node:sqlite, native DuckDB (file-backed, local disk)
- `server-databases.md` — PostgreSQL (pg + Drizzle), MySQL/MariaDB (mysql2)
</when_to_use>

<decision_matrix>
Answer these five questions in order:

1. **Deployment target** — Azure container, desktop/Electron, or both? Azure: the container filesystem is ephemeral and the NFS share bans database files, so durable data means PostgreSQL. Desktop: possibly airgapped with no reachable network database, so durable data means node:sqlite on local disk.
2. **Concurrency** — more than one user or process writing? Multiple writers → server database. Single-process writer → sqlite is fine.
3. **Durability** — must the data survive restarts/redeploys? Durable on Azure → PostgreSQL. A cache that can be rebuilt → container-local sqlite is fine.
4. **Data shape** — file blobs → `persistent-storage` skill; tiny key-value → LocalStorage; relational rows → sqlite/PostgreSQL/MySQL; columnar scans over datasets → DuckDB.
5. **Workload** — OLTP (many small reads/writes) → sqlite/PostgreSQL/MySQL; analytics (few big scans/aggregations) → DuckDB, in the browser first.

Then pick the scenario that matches:

| Scenario | Choice | Read |
|---|---|---|
| Durable multi-user data, Azure deployment | PostgreSQL (in the template) | `server-databases.md` |
| Integrate an existing corporate MySQL/MariaDB | mysql2 | `server-databases.md` |
| Desktop/Electron app, durable structured data | node:sqlite | `local-databases.md` |
| Hot-path cache / rebuildable derived data (any target) | node:sqlite on local/container disk | `local-databases.md` |
| SQL analytics over user CSV/JSON/Parquet | DuckDB-WASM in the browser | `browser-databases.md` |
| Server-side columnar analytics | Usually node:sqlite or DuckDB-WASM instead; native DuckDB only for container-only apps | `local-databases.md` |
| Tiny per-user UI state (theme, filters, drafts) | LocalStorage; larger client-side data → IndexedDB | `browser-databases.md` |
| Small read-mostly config/seed JSON | No database — `persistent-storage` skill | — |
</decision_matrix>

<deployment_targets>
**Azure Container Apps** — the container filesystem is ephemeral and `process.env.STORAGE_PATH` is an NFS-mounted Azure Files share. **No database file may ever live under `STORAGE_PATH`** — NFS lacks the locking these engines require and per-operation latency is high. Durable structured data = PostgreSQL. SQLite is allowed only as an ephemeral cache on container-local paths (`/tmp`, the app directory) that the app can rebuild at startup. The container has 0.25 CPU / 0.5 Gi — keep connection pools small (max 5) and avoid memory-hungry engines.

**Desktop / Electron** — the packaged app embeds Node 24, so `node:sqlite` works with zero dependencies. The packaging pipeline does **not** bundle native Node modules — never use `better-sqlite3` or `@duckdb/node-api` in an app that may ship to desktop. `STORAGE_PATH` is not set on desktop; put the database file in a per-user OS directory (see `local-databases.md`). Desktop machines may be airgapped — never assume a network database is reachable.

**Local development / preview** — anything goes technically, but default to whatever the app's deployment target needs, so dev and prod behave the same.
</deployment_targets>

<env_and_secrets>
Server-database connections are configured exclusively through environment variables, injected by platform admins:

- `DATABASE_URL` — single connection URL, preferred.
- Or discrete variables: `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` (read natively by `pg`), `MYSQL_HOST`/`MYSQL_PORT`/`MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DATABASE`.

Never hardcode hosts or credentials in code and never commit them to the workspace.

Degrade gracefully: the preview environment often has no database configured. A missing variable must not crash the server — boot anyway, log one clear warning, and return 503 from data routes (full pattern in `server-databases.md`). Never throw at module import time.
</env_and_secrets>

<integration_with_other_skills>
persistent-storage — file blobs (uploads, exports, logs) under `process.env.STORAGE_PATH`. Its rule against database files on the share is the same constraint as rule 1 below; this skill defines where file-backed databases *are* allowed.

node-backend — server-database access is backend-only: the frontend talks to `/api/*` routes (relative URLs), never to a database directly. Keep dependencies minimal for the 0.5 Gi container.
</integration_with_other_skills>

<rules>
1. Never place a database file (SQLite, DuckDB, or any file-backed engine) under `process.env.STORAGE_PATH` — the NFS share lacks the locking these engines require.
2. Never load duckdb-wasm or any database client from a CDN — `getJsDelivrBundles()` is banned; bundle from npm via Vite `?url` imports (airgap rule, see `browser-databases.md`).
3. Never use native Node modules (`better-sqlite3`, `@duckdb/node-api`) in an app that may deploy as a desktop/Electron app — use the built-in `node:sqlite`.
4. Parameterized queries only — `?` / `$1` / named parameters. Never interpolate user input into SQL strings, in any engine, including DuckDB-WASM in the browser.
5. Connection credentials come from `process.env` only — never hardcoded, never committed, never logged.
6. Degrade gracefully when database env vars are missing — boot, warn once, return 503 from data routes; never crash at import time.
7. Server-database access is backend-only. LocalStorage, IndexedDB, and DuckDB-WASM are the only frontend-side data engines.
8. Use one module-level connection pool per server database, kept small (max 5 — the container is 0.25 CPU and the server is shared). Never open a connection per request; run transactions on a dedicated pooled connection released in `finally`; call `pool.end()` on shutdown. Patterns in `server-databases.md`.
9. Read the matching reference file before writing database code: `browser-databases.md`, `local-databases.md`, or `server-databases.md`.
10. When in doubt on Azure, choose PostgreSQL — it is the paved road and already in the template's `package.json`.
</rules>
