// Tests for GET /api/admin/schema-check.
//
// The endpoint's whole job is to answer "does production have the schema the
// code expects?" from outside the Cloudflare account. It is only worth having
// if it is right about BOTH answers — so the tests below build databases at
// several real points along the migration sequence and assert it reports each
// one correctly, including the partial-application case that a naive
// table-exists check would round up to "done".
//
// Run with:  node scripts/test-schema-check.mjs

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import worker from "../src/index.js";
import { adminSchemaCheckHandler } from "../src/handlers/admin.js";
import { makeD1, makeEmptyD1 } from "./_d1-stub.mjs";
import { issueJWT } from "../src/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

const ADMIN_EMAIL = "admin@algosize.com";
const JWT_SECRET  = "schema-check-test-secret-32-or-more-chars";

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

/**
 * A database with migrations applied UP TO (and including) `upTo`.
 *
 * Applies the real .sql files in order, so the fixtures track the migrations
 * rather than a hand-written copy of them — if a future migration lands
 * without a manifest entry, the "all applied" test below notices.
 */
function makeD1UpTo(upTo) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (f.slice(0, 4) > upTo) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  return wrap(db);
}

/** Minimal D1 shim — prepare().all() is all the handler uses. */
function wrap(db) {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          const rows = db.prepare(sql).all();
          return { results: rows, success: true };
        },
        async first() { return db.prepare(sql).get() ?? null; },
        async run() { return { success: true, meta: { changes: 0 } }; },
      };
    },
    async exec(sql) { db.exec(sql); return { count: 0 }; },
    _raw: db,
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET,
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    ADMIN_EMAILS: ADMIN_EMAIL,
    SESSIONS: makeKV(),
    USERS: makeKV(),
    DB: makeD1(),
    ...overrides,
  };
}

/** The handler reads request.user; requireAdmin is exercised separately below. */
function adminRequest() {
  const req = new Request("https://algosize.com/api/admin/schema-check");
  req.user = { userId: "usr_admin", email: ADMIN_EMAIL };
  req.authMethod = "session";
  return req;
}

const byId = (body, id) => body.migrations.find((m) => m.migration === id);

// ===========================================================================
console.log("\na fully migrated database\n");
// ===========================================================================
{
  // makeD1() applies every file in migrations/, which is exactly what a
  // correctly provisioned production database should look like.
  const env = makeEnv();
  const res = await adminSchemaCheckHandler(adminRequest(), env);
  const body = await res.json();

  expect(res.status === 200, `responds 200 (got ${res.status})`);
  expect(body.ok === true, "ok:true when every migration is applied");
  expect(body.pending.length === 0, `nothing pending (got ${JSON.stringify(body.pending)})`);
  expect(body.appliedCount === body.total, `appliedCount equals total (${body.appliedCount}/${body.total})`);
  expect(body.migrations.every((m) => m.applied), "every migration reports applied");
  expect(body.summary.includes("All"), "summary says all applied");

  // The manifest must cover every migration file on disk — a new migration
  // that nobody adds a signature for would otherwise report a clean bill of
  // health for a database missing it.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  expect(body.total === files.length,
    `manifest covers every migration file (${body.total} entries vs ${files.length} files — ` +
    `add the new one to MIGRATIONS in handlers/admin.js)`);
  const fileIds = files.map((f) => f.slice(0, 4));
  const manifestIds = body.migrations.map((m) => m.migration);
  expect(JSON.stringify(fileIds) === JSON.stringify(manifestIds),
    `manifest ids match the files in order (${manifestIds.join(",")} vs ${fileIds.join(",")})`);

  // Every real table should be listed, so an operator can eyeball it.
  ["users", "runs", "organisations", "memberships", "api_keys", "monitors"]
    .forEach((t) => expect(body.tables.includes(t), `tables[] includes ${t}`));
}

// ===========================================================================
console.log("\nan empty database — the pre-migration production case\n");
// ===========================================================================
{
  // What Miniflare hands a fresh `wrangler dev`, and what production looks
  // like if `wrangler d1 execute` was never run at all.
  const env = makeEnv({ DB: makeEmptyD1() });
  const res = await adminSchemaCheckHandler(adminRequest(), env);
  const body = await res.json();

  expect(res.status === 200, "still 200 — a pending schema is a successful report");
  expect(body.ok === false, "ok:false when nothing is applied");
  expect(body.appliedCount === 0, `nothing applied (got ${body.appliedCount})`);
  expect(body.pending.length === body.total, "every migration is pending");
  expect(body.tables.length === 0, "no tables reported");
  expect(body.summary.includes("wrangler d1 execute"),
    "summary names the command that fixes it");
}

// ===========================================================================
console.log("\npartial migration — the case this endpoint exists for\n");
// ===========================================================================
{
  // The exact state production is suspected to be in: everything through
  // 0006, but not the runs rebuild or the branding columns.
  const env = makeEnv({ DB: makeD1UpTo("0006") });
  const res = await adminSchemaCheckHandler(adminRequest(), env);
  const body = await res.json();

  expect(body.ok === false, "ok:false with 0007/0008 missing");
  expect(JSON.stringify(body.pending) === JSON.stringify(["0007", "0008"]),
    `pending names exactly the missing migrations (got ${JSON.stringify(body.pending)})`);
  expect(body.appliedCount === 6, `six applied (got ${body.appliedCount})`);

  // 0007's signature is a COLUMN on an existing table — a table-exists check
  // would have called this applied, which is the bug worth guarding.
  const m7 = byId(body, "0007");
  expect(m7.applied === false, "0007 reports not-applied even though `runs` exists");
  expect(m7.checks.every((c) => c.present === false),
    "0007's per-check detail names org_id and source as absent");
  expect(m7.checks.some((c) => c.target === "runs.org_id"), "0007 check targets runs.org_id");

  const m8 = byId(body, "0008");
  expect(m8.applied === false, "0008 reports not-applied");
  expect(m8.checks.some((c) => c.target === "organisations.brand_company_name" && !c.present),
    "0008's detail names the missing branding column");

  // And the ones that ARE applied still say so.
  expect(byId(body, "0004").applied === true, "0004 still reports applied");
  expect(byId(body, "0006").applied === true, "0006 still reports applied");
}

// ===========================================================================
console.log("\npartial application WITHIN one migration\n");
// ===========================================================================
{
  // 0004 creates two tables and adds a column. Simulate the ALTER landing
  // but the memberships CREATE not — a real possibility when someone pastes
  // a migration into a console and it errors halfway. All-checks-must-pass
  // is what makes this report honestly.
  // Applied in full, then `memberships` removed — the same end state as a
  // migration that errored partway, reached without having to fight 0004's
  // own backfill (which inserts into memberships and cannot run without it).
  const db = makeD1UpTo("0004")._raw;
  db.exec("DROP TABLE memberships");
  const env = makeEnv({ DB: wrap(db) });
  const res = await adminSchemaCheckHandler(adminRequest(), env);
  const body = await res.json();

  const m4 = byId(body, "0004");
  expect(m4.applied === false,
    "a half-applied 0004 reports not-applied rather than rounding up to done");
  const membershipsCheck = m4.checks.find((c) => c.target === "memberships");
  const orgsCheck = m4.checks.find((c) => c.target === "organisations");
  expect(membershipsCheck && membershipsCheck.present === false,
    "the detail names memberships as the missing half");
  expect(orgsCheck && orgsCheck.present === true,
    "and confirms organisations DID land — so the operator knows what to re-run");
}

// ===========================================================================
console.log("\nfailure modes\n");
// ===========================================================================
{
  const env = makeEnv({ DB: undefined });
  const res = await adminSchemaCheckHandler(adminRequest(), env);
  const body = await res.json();
  expect(res.status === 500 && body.error === "not_configured",
    "no DB binding → 500 not_configured, distinct from a pending schema");
}
{
  // A database that throws rather than answering must not look like an
  // empty one — "unreachable" and "nothing applied" need different answers.
  const env = makeEnv({
    DB: { prepare() { return { async all() { throw new Error("D1_ERROR: connection lost"); } }; } },
  });
  const res = await adminSchemaCheckHandler(adminRequest(), env);
  const body = await res.json();
  expect(res.status === 500 && body.error === "database_unreachable",
    "an unreadable database is 500 database_unreachable, not ok:false");
  expect(body.message.includes("connection lost"),
    "and surfaces the underlying error rather than swallowing it");
}

// ===========================================================================
console.log("\nadmin gating — routed through the real middleware\n");
// ===========================================================================
{
  const env = makeEnv();
  const res = await worker.fetch(
    new Request("https://algosize.com/api/admin/schema-check"), env, { waitUntil() {} });
  expect(res.status === 401, `no session → 401 (got ${res.status})`);
}
{
  // A signed-in NON-admin must be refused. 403 rather than 404, matching the
  // rest of /api/admin/* — the surface isn't a secret, the access is.
  const env = makeEnv();
  const token = await issueJWT(env, "usr_plain", "someone@example.com", "active");
  const res = await worker.fetch(
    new Request("https://algosize.com/api/admin/schema-check", {
      headers: { Cookie: `algosize_session=${token}` },
    }), env, { waitUntil() {} });
  const body = await res.json();
  expect(res.status === 403 && body.error === "forbidden",
    `a non-admin session → 403 forbidden (got ${res.status} ${body.error})`);
}
{
  const env = makeEnv();
  const token = await issueJWT(env, "usr_admin", ADMIN_EMAIL, "active");
  const res = await worker.fetch(
    new Request("https://algosize.com/api/admin/schema-check", {
      headers: { Cookie: `algosize_session=${token}` },
    }), env, { waitUntil() {} });
  const body = await res.json();
  expect(res.status === 200 && body.ok === true,
    `an admin session reaches the report (got ${res.status})`);
  expect(Array.isArray(body.migrations) && body.migrations.length > 0,
    "and the report is populated");
}

// ===========================================================================
console.log("\nno SQL injection path through the manifest\n");
// ===========================================================================
{
  // The PRAGMA interpolates a table name. Nothing in the request reaches it —
  // this asserts the guard holds even if a future edit puts something odd in
  // the manifest, by checking the endpoint ignores query parameters entirely.
  const env = makeEnv();
  const req = new Request(
    "https://algosize.com/api/admin/schema-check?table=users);DROP+TABLE+users;--");
  req.user = { userId: "usr_admin", email: ADMIN_EMAIL };
  const res = await adminSchemaCheckHandler(req, env);
  const body = await res.json();
  expect(res.status === 200 && body.ok === true, "query parameters are ignored");
  const stillThere = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'").first();
  expect(!!stillThere, "the users table survives a hostile query string");
}

console.log();
if (failures === 0) {
  console.log("\x1b[32m  all schema-check tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} schema-check test(s) failed\x1b[0m\n`);
  process.exit(1);
}
