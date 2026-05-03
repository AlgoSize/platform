// In-memory D1 stub for the worker test scripts.
//
// Real Cloudflare D1 is SQLite-on-the-wire with a thin async wrapper. The
// closest local equivalent is better-sqlite3 with `:memory:`, which is what
// we use here — it gives the tests a real SQL engine instead of a
// hand-rolled query matcher and stays in lockstep with the production
// schema by re-applying `migrations/0001_init.sql` on each construction.
//
// Exposes:
//   makeD1()           — returns a fresh D1-shaped binding with the schema
//                        already applied. One per test environment.
//   makeFailingD1(n=1) — same shape, but the n-th .run() call rejects to
//                        simulate a transient D1 write failure (used by
//                        the webhook idempotency + observability tests).
//
// The shape we expose mirrors the public surface of Cloudflare's D1
// `D1Database` / `D1PreparedStatement` types — only the methods our worker
// code actually calls (prepare/.bind/.first/.all/.run, batch, exec).

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "migrations", "0001_init.sql");
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, "utf8");

/** Create an in-memory D1 binding with the schema applied. */
export function makeD1() {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  return wrapAsD1(db);
}

/**
 * Create an in-memory D1 binding that throws on the first `failOn` writes
 * (.run() calls). Used by tests that need to simulate a transient D1 blip
 * — the same role the previous USERS.put() throw served for KV.
 */
export function makeFailingD1({ failOn = 1 } = {}) {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  const binding = wrapAsD1(db);
  let writes = 0;
  const realPrepare = binding.prepare;
  binding.prepare = (sql) => {
    const stmt = realPrepare(sql);
    const realRun = stmt.run.bind(stmt);
    stmt.run = async (...args) => {
      writes++;
      if (writes <= failOn) throw new Error("simulated D1 write failure");
      return realRun(...args);
    };
    // Patch .bind() to also wrap the returned statement's .run().
    const realBind = stmt.bind.bind(stmt);
    stmt.bind = (...bargs) => {
      const bound = realBind(...bargs);
      const boundRun = bound.run.bind(bound);
      bound.run = async (...args) => {
        writes++;
        if (writes <= failOn) throw new Error("simulated D1 write failure");
        return boundRun(...args);
      };
      return bound;
    };
    return stmt;
  };
  return binding;
}

function wrapAsD1(db) {
  return {
    prepare(sql) { return makeStmt(db, sql, []); },
    async batch(statements) {
      // D1 batch is transactional. Mirror that with better-sqlite3's
      // transaction helper so a mid-batch throw rolls everything back.
      const txn = db.transaction((stmts) => stmts.map((s) => s._runSync()));
      return txn(statements);
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    // Escape hatch for tests that want to assert raw row counts.
    _raw: db,
  };
}

function makeStmt(db, sql, bindings) {
  // Compile lazily so a query that's never executed never hits the parser
  // — keeps test setup fast.
  let compiled;
  const get = () => (compiled ||= db.prepare(sql));

  return {
    bind(...args) { return makeStmt(db, sql, args); },

    async first(col) {
      const row = get().get(...bindings);
      if (!row) return null;
      if (col !== undefined) return row[col] ?? null;
      return row;
    },

    async all() {
      const rows = get().all(...bindings);
      // D1's .all() returns { results, success, meta }. We only populate
      // the fields the worker code reads.
      return { results: rows, success: true, meta: { rows_read: rows.length, rows_written: 0 } };
    },

    async run() {
      const info = get().run(...bindings);
      return {
        success: true,
        meta: {
          changes:        info.changes,
          last_row_id:    Number(info.lastInsertRowid),
          rows_read:      0,
          rows_written:   info.changes,
          changed_db:     info.changes > 0,
        },
      };
    },

    async raw() { return get().raw().all(...bindings); },

    // Internal hook used by .batch() above so we don't double-await inside
    // the better-sqlite3 transaction (which is sync).
    _runSync() {
      const info = get().run(...bindings);
      return { success: true, meta: { changes: info.changes } };
    },
  };
}
