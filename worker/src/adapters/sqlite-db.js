// SQLite adapter that mimics the Cloudflare D1 API surface.
// Used in the Replit environment instead of wrangler's D1 binding.

import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "..", "data", "algosize.db");
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

// One connection per path. Keyed by path rather than a single `_db` global
// because callers can ask for `:memory:` — and with a single global, the
// first caller's choice silently became everyone's.
const _dbs = new Map();

function getDb(path) {
  const cached = _dbs.get(path);
  if (cached) return cached;
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path);
  applyMigrations(db);
  _dbs.set(path, db);
  return db;
}

/**
 * Apply every file in migrations/ in filename order, recording each one so it
 * runs at most once against a given database.
 *
 * The tracking table is what makes this safe to call on every boot: this
 * adapter opens a PERSISTENT file, and not every migration is self-guarding.
 * 0001 is all `CREATE TABLE IF NOT EXISTS` and re-runs harmlessly, but SQLite
 * has no `ADD COLUMN IF NOT EXISTS`, so 0002's `ALTER TABLE` throws
 * "duplicate column name" the second time. Without a record of what has run,
 * adding any ALTER-based migration breaks local dev on the next restart.
 *
 * An existing database that predates the tracking table is handled by the
 * same path: 0001 re-runs as a no-op and gets recorded, then 0002 applies for
 * the first time.
 */
function applyMigrations(db) {
  if (!existsSync(MIGRATIONS_DIR)) return;

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
             file       TEXT PRIMARY KEY,
             applied_at INTEGER NOT NULL
           )`);

  const applied = new Set(
    db.prepare("SELECT file FROM _migrations").all().map((r) => r.file),
  );
  const record = db.prepare("INSERT OR IGNORE INTO _migrations (file, applied_at) VALUES (?, ?)");

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
    record.run(file, Date.now());
  }
}

// D1 statement wrapper
function makeStatement(db, sql) {
  const stmt = db.prepare(sql);
  let _boundArgs = [];

  return {
    bind(...args) {
      _boundArgs = args;
      return this;
    },
    first() {
      try {
        const row = stmt.get(..._boundArgs);
        return Promise.resolve(row || null);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    all() {
      try {
        const rows = stmt.all(..._boundArgs);
        return Promise.resolve({ results: rows });
      } catch (err) {
        return Promise.reject(err);
      }
    },
    run() {
      try {
        const info = stmt.run(..._boundArgs);
        return Promise.resolve({ meta: { changes: info.changes } });
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}

/**
 * D1-shaped binding backed by better-sqlite3.
 *
 * `path` defaults to the on-disk dev database. Pass `":memory:"` for an
 * isolated, throwaway database — which is what test scripts want, and what
 * `createSqliteDb(":memory:")` previously did NOT do: the argument was
 * ignored outright, so `scripts/test-google-oauth.mjs` quietly read and
 * wrote the tracked `worker/data/algosize.db`, leaving test users in a
 * committed file and carrying state between runs.
 */
export function createSqliteDb(path = DB_PATH) {
  return {
    prepare(sql) {
      const db = getDb(path);
      return makeStatement(db, sql);
    },
    exec(sql) {
      try {
        const db = getDb(path);
        db.exec(sql);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}
