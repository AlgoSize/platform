// SQLite adapter that mimics the Cloudflare D1 API surface.
// Used in the Replit environment instead of wrangler's D1 binding.

import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "..", "data", "algosize.db");
const SCHEMA_PATH = join(__dirname, "..", "..", "migrations", "0001_init.sql");

let _db = null;

function getDb() {
  if (_db) return _db;
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  // Apply schema
  if (existsSync(SCHEMA_PATH)) {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    _db.exec(schema);
  }
  return _db;
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

// D1 database wrapper
export function createSqliteDb() {
  return {
    prepare(sql) {
      const db = getDb();
      return makeStatement(db, sql);
    },
    exec(sql) {
      try {
        const db = getDb();
        db.exec(sql);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
}
