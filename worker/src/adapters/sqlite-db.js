// SQLite adapter that mimics the Cloudflare D1 API surface.
// Used in the Replit environment instead of wrangler's D1 binding.

import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "..", "data", "algosize.db");
const SCHEMA_PATH = join(__dirname, "..", "..", "migrations", "0001_init.sql");

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
  // Apply schema
  if (existsSync(SCHEMA_PATH)) {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    db.exec(schema);
  }
  _dbs.set(path, db);
  return db;
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
