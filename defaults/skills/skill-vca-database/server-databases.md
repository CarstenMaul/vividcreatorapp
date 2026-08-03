# Server Databases — PostgreSQL and MySQL/MariaDB

Companion to `SKILL.md`. Read this when the app needs a network database server: durable structured data on Azure deployments, multi-user concurrent writes, transactions, or integration with an existing corporate database.

A server database is the **only durable structured-data option on Azure** — the container filesystem is ephemeral and the Azure Files share cannot host database files. PostgreSQL is the paved road: `pg`, `drizzle-orm`, and `drizzle-kit` already ship in every app template. Reach for MySQL/MariaDB only to integrate an existing corporate database.

---

## Connection configuration

Connection details come **exclusively from `process.env`** — admins inject them as platform environment variables (container deploy config, or baked into desktop builds). Never hardcode hosts, users, or passwords in code, and never commit them to the workspace.

Precedence:

1. `DATABASE_URL` — a single connection URL (`postgres://user:pass@host:5432/dbname` or `mysql://user:pass@host:3306/dbname`). Preferred.
2. Discrete variables — `pg` natively reads `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; for MySQL use `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.

For TLS to corporate or Azure servers, pass `ssl: { rejectUnauthorized: false }` — consistent with the `NODE_TLS_REJECT_UNAUTHORIZED=0` posture from the `node-backend` skill.

### Connection pooling (required pattern)

Always go through **one module-level connection pool per process** — both drivers provide one. Never open a connection (or create a pool) per request: connection setup is expensive, and leaked connections exhaust the server.

- Keep the pool small: `max: 5` (pg) / `connectionLimit: 5` (mysql2). The container has 0.25 CPU and the database server is shared with other apps — more connections do not add throughput, they starve neighbours.
- Simple queries go through the pool directly (`pool.query` / `pool.execute`) — checkout and return are automatic.
- **Transactions need a dedicated connection** checked out from the pool for the duration of the transaction; release it in `finally`, always (a `withTransaction` helper for each driver is shown below). Running `BEGIN`/`COMMIT` through `pool.query` is a bug — each statement may land on a different connection.
- Close the pool on shutdown so the server exits cleanly: `process.on("SIGTERM", () => pool?.end())`.

### Graceful degradation (required pattern)

The preview environment often has **no database configured**. A missing `DATABASE_URL` must never crash the server at import time — the app boots, warns once, and data routes return 503:

```javascript
// db/index.js
import pg from "pg";

export const dbAvailable = Boolean(process.env.DATABASE_URL || process.env.PGHOST);

export const pool = dbAvailable
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL, // undefined -> falls back to PG* vars
      max: 5,
      ssl: { rejectUnauthorized: false },
    })
  : null;

if (pool) {
  pool.on("error", (err) => console.error("Unexpected idle client error:", err));
} else {
  console.warn("Database not configured (set DATABASE_URL) — data routes will return 503.");
}
```

```javascript
// server.js — guard every data route
function requireDb(req, res, next) {
  if (!dbAvailable) return res.status(503).json({ error: "database not configured" });
  next();
}
app.use("/api", requireDb);
```

---

## PostgreSQL — the paved road

`pg` ^8, `drizzle-orm` ^0.45, and `drizzle-kit` ^0.31 are already in the template's `package.json` — add nothing.

Raw queries: always `pool.query(text, values)` with `$1` placeholders — never string interpolation:

```javascript
const { rows } = await pool.query(
  "SELECT * FROM myapp.items WHERE owner = $1 ORDER BY created_at DESC LIMIT $2",
  [userId, 50]
);
```

Transactions — check out one client from the pool, run every statement of the transaction on that client (not on `pool`), and release it in `finally`:

```javascript
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

await withTransaction(async (client) => {
  const { rows: [order] } = await client.query(
    "INSERT INTO myapp.orders (customer_id) VALUES ($1) RETURNING id", [customerId]);
  for (const line of lines) {
    await client.query(
      "INSERT INTO myapp.order_lines (order_id, sku, qty) VALUES ($1, $2, $3)",
      [order.id, line.sku, line.qty]);
  }
});
```

(Drizzle users: `db.transaction(async (tx) => { ... })` does the checkout/release for you.)

### Schema-per-app on a shared server

Apps typically share one PostgreSQL server (e.g. a shared Azure Database for PostgreSQL Flexible Server). Keep each app inside its **own named schema** so apps never collide — never create tables in `public`:

```javascript
// db/schema.js
import { pgSchema, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const app = pgSchema("myapp"); // the app's name, lowercase

export const items = app.table("items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

```javascript
// db/index.js (continued)
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export const db = pool ? drizzle(pool, { schema }) : null;

export async function initDb() {
  if (!pool) return;
  await pool.query('CREATE SCHEMA IF NOT EXISTS "myapp"');
}
```

Typed queries with Drizzle:

```javascript
import { eq, desc } from "drizzle-orm";
import { db } from "./db/index.js";
import { items } from "./db/schema.js";

const open = await db.select().from(items).where(eq(items.done, false)).orderBy(desc(items.createdAt));
const [created] = await db.insert(items).values({ name: "buy milk" }).returning();
```

### Migrations

Pick one of two modes:

- **Simple apps (few tables, schema settles early):** skip drizzle-kit at runtime. Run idempotent DDL (`CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`) in `initDb()` at startup.
- **Evolving schemas:** generate migration files during development and apply them programmatically at startup — nobody runs CLI commands against the production database:

  ```javascript
  // drizzle.config.js
  export default {
    dialect: "postgresql",
    schema: "./db/schema.js",
    out: "./drizzle",
    dbCredentials: { url: process.env.DATABASE_URL },
    schemaFilter: ["myapp"], // never touch other apps' schemas
  };
  ```

  During development: `npx drizzle-kit generate` — commit the generated `./drizzle/` folder. At server startup:

  ```javascript
  import { migrate } from "drizzle-orm/node-postgres/migrator";
  if (db) await migrate(db, { migrationsFolder: "./drizzle" });
  ```

`schemaFilter` is mandatory on a shared server — without it drizzle-kit diffs (and may drop) every other app's tables. `npx drizzle-kit push` is for local-dev iteration only; never wire it into startup or deployment.

---

## MySQL / MariaDB — for existing corporate databases

Use the `mysql2` driver — pure JavaScript, so it packages cleanly into desktop builds (unlike native alternatives). It is **not** in the template: add it to the app's `package.json` dependencies only when the app actually targets a MySQL/MariaDB server (`"mysql2": "^3"`). MariaDB is wire-compatible — same driver, same code.

```javascript
import mysql from "mysql2/promise";

export const dbAvailable = Boolean(process.env.DATABASE_URL || process.env.MYSQL_HOST);

export const pool = dbAvailable
  ? mysql.createPool({
      ...(process.env.DATABASE_URL
        ? { uri: process.env.DATABASE_URL }
        : {
            host: process.env.MYSQL_HOST,
            port: Number(process.env.MYSQL_PORT || 3306),
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            database: process.env.MYSQL_DATABASE,
          }),
      connectionLimit: 5,        // applies in both branches — keep it small on shared servers
      namedPlaceholders: true,
    })
  : null;
```

Always `pool.execute` (server-side prepared statements) with `?` placeholders:

```javascript
const [rows] = await pool.execute(
  "SELECT * FROM items WHERE owner = ? ORDER BY created_at DESC LIMIT 50",
  [userId]
);
```

Transactions — same pool discipline as PostgreSQL: one dedicated connection for the whole transaction, released in `finally`:

```javascript
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
```

Drizzle works here too if the app benefits from typed queries: `drizzle(pool)` from `drizzle-orm/mysql2`, with `dialect: "mysql"` in `drizzle.config.js` — same generate/`migrate()`-at-startup workflow as PostgreSQL.

**Respect ownership.** A corporate MySQL database usually has a schema the app does not own. Introspect it (`npx drizzle-kit pull`) or hand-write table definitions to match — and never run migrations or DDL against a database the app does not own.

---

## Choosing between them

- Greenfield app needing durable data → **PostgreSQL** (already in the template, schema-per-app on the shared server).
- Existing corporate MySQL/MariaDB to read or extend → **mysql2**.
- Never introduce a second database engine into one app without a concrete reason.
