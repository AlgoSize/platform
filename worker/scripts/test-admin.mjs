// Tests for the admin endpoints + requireAdmin middleware.
//
// Covers:
//   - requireAdmin returns 401 for unauthenticated requests.
//   - requireAdmin returns 403 for authenticated non-admin users.
//   - requireAdmin lets admin emails through (case-insensitive,
//     comma-list parsing).
//   - GET /api/admin/users returns JSON {count, items[]} with the user
//     fields the admin UI consumes, sorted newest first.
//   - GET /api/admin/users.csv returns text/csv with the right header,
//     content-disposition attachment, and one row per user with ISO
//     timestamps + properly-escaped values.

import { issueJWT } from "../src/auth.js";
import {
  requireAdmin,
  adminListUsersHandler,
  adminUsersCsvHandler,
} from "../src/handlers/admin.js";
import { makeD1 } from "./_d1-stub.mjs";

const JWT_SECRET = "admin-test-jwt-secret-32-or-more-chars-please";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const eq   = (a, b, msg) => (a === b ? ok(msg) : fail(`${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

function makeKV() {
  const store = new Map();
  return {
    async get(k)         { return store.has(k) ? store.get(k) : null; },
    async put(k, v)      { store.set(k, v); },
    async delete(k)      { store.delete(k); },
  };
}

function makeEnv(extra = {}) {
  return {
    JWT_SECRET,
    SITE_ORIGIN:   "http://localhost:5000",
    COOKIE_NAME:   "algosize_session",
    ADMIN_EMAILS:  "guillaumelauzier@gmail.com",
    SESSIONS:      makeKV(),
    USERS:         makeKV(),
    DB:            makeD1(),
    ...extra,
  };
}

async function seedUsers(env, rows) {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      r.user_id, r.email, r.stripe_customer_id || null,
      r.plan || "free", r.sub_status || null,
      r.created_at, r.updated_at || r.created_at,
    ).run();
  }
}

async function authedReq(env, url, email, userId = "usr_test") {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (user_id, email, plan, created_at, updated_at)
     VALUES (?, ?, 'free', ?, ?)`,
  ).bind(userId, email, 1, 1).run();
  const tok = await issueJWT(env, userId, email, null);
  return new Request(url, {
    method:  "GET",
    headers: { Cookie: `algosize_session=${tok}` },
  });
}

console.log("\nrequireAdmin gating\n");

// 1. No cookie → 401 from requireAuth
{
  const env = makeEnv();
  const req = new Request("http://localhost/api/admin/users", { method: "GET" });
  const res = await requireAdmin(req, env);
  eq(res && res.status, 401, "no auth → 401");
}

// 2. Auth'd non-admin → 403
{
  const env = makeEnv();
  const req = await authedReq(env, "http://localhost/api/admin/users", "rando@example.com");
  const res = await requireAdmin(req, env);
  eq(res && res.status, 403, "non-admin → 403");
  const body = await res.json();
  eq(body.error, "forbidden", "body.error = forbidden");
}

// 3. Auth'd admin → undefined (continue)
{
  const env = makeEnv();
  const req = await authedReq(env, "http://localhost/api/admin/users", "guillaumelauzier@gmail.com", "usr_admin");
  const res = await requireAdmin(req, env);
  eq(res, undefined, "admin → fallthrough (undefined)");
}

// 4. Admin allowlist is case-insensitive + tolerates whitespace + multiple
{
  const env = makeEnv({ ADMIN_EMAILS: "  Foo@Bar.com  ,  guillaumelauzier@gmail.com" });
  const req = await authedReq(env, "http://localhost/api/admin/users", "FOO@bar.com", "usr_a2");
  const res = await requireAdmin(req, env);
  eq(res, undefined, "case + whitespace tolerant in ADMIN_EMAILS");
}

console.log("\nGET /api/admin/users (JSON)\n");

{
  const env = makeEnv();
  await seedUsers(env, [
    { user_id: "usr_a", email: "alice@example.com", plan: "free", created_at: 1000 },
    { user_id: "usr_b", email: "bob@example.com",   plan: "paid", sub_status: "active", stripe_customer_id: "cus_42", created_at: 2000 },
    { user_id: "usr_c", email: "carol@example.com", plan: "free", created_at: 3000 },
  ]);

  const req = await authedReq(env, "http://localhost/api/admin/users", "guillaumelauzier@gmail.com", "usr_admin");
  const guard = await requireAdmin(req, env);
  eq(guard, undefined, "admin guard passes");
  const res = await adminListUsersHandler(req, env);
  eq(res.status, 200, "200 OK");
  eq(res.headers.get("content-type"), "application/json", "JSON content-type");
  const body = await res.json();
  // 3 seeded + 1 admin row created by authedReq
  eq(body.count, 4, "count includes all rows");
  // Admin row was inserted with created_at=1 (oldest); the three seeded
  // users have 1000/2000/3000, so carol (3000) is newest. Order is by
  // created_at DESC.
  if (body.items[0].email === "carol@example.com") ok("ordered newest-first by created_at DESC");
  else fail("expected newest first; got " + body.items[0].email);
  if (body.items[body.items.length - 1].email === "guillaumelauzier@gmail.com") ok("oldest row is last");
  else fail("expected admin (created_at=1) to be last; got " + body.items[body.items.length - 1].email);
  // Field shape
  const bob = body.items.find((u) => u.email === "bob@example.com");
  if (bob && bob.plan === "paid" && bob.subStatus === "active" && bob.stripeCustomerId === "cus_42") {
    ok("paid user fields camelCased + present");
  } else {
    fail("paid user shape wrong: " + JSON.stringify(bob));
  }
  const alice = body.items.find((u) => u.email === "alice@example.com");
  if (alice && alice.plan === "free" && alice.stripeCustomerId === null) {
    ok("free user fields shaped correctly (stripeCustomerId null)");
  } else {
    fail("free user shape wrong: " + JSON.stringify(alice));
  }
}

console.log("\nGET /api/admin/users.csv\n");

{
  const env = makeEnv();
  await seedUsers(env, [
    // Email with a comma-trick + quote to exercise CSV escaping.
    { user_id: "usr_x", email: 'weird,"name"@example.com', plan: "free", created_at: 1700000000 },
    { user_id: "usr_y", email: "normal@example.com",       plan: "paid", sub_status: "active", stripe_customer_id: "cus_9", created_at: 1700000100 },
  ]);
  const req = await authedReq(env, "http://localhost/api/admin/users.csv", "guillaumelauzier@gmail.com", "usr_admin");
  const guard = await requireAdmin(req, env);
  eq(guard, undefined, "admin guard passes for CSV route");
  const res = await adminUsersCsvHandler(req, env);
  eq(res.status, 200, "CSV 200");
  if ((res.headers.get("content-type") || "").includes("text/csv")) ok("text/csv content-type");
  else fail("wrong content-type: " + res.headers.get("content-type"));
  const cd = res.headers.get("content-disposition") || "";
  if (cd.startsWith("attachment;") && /algosize-users-\d{4}-\d{2}-\d{2}\.csv/.test(cd)) {
    ok("content-disposition is attachment with dated filename");
  } else {
    fail("bad content-disposition: " + cd);
  }
  const text = await res.text();
  const lines = text.trim().split("\n");
  eq(lines[0], "email,plan,sub_status,stripe_customer_id,user_id,created_at_iso,updated_at_iso", "CSV header row matches schema");
  // 2 seeded + 1 admin = 3 data rows
  eq(lines.length, 1 + 3, "one row per user (header + 3 data rows)");
  // Quoting: weird email must be wrapped in quotes with internal "" doubling
  const weirdLine = lines.find((l) => l.startsWith('"weird,'));
  if (weirdLine && weirdLine.startsWith('"weird,""name""@example.com"')) {
    ok("CSV escaping handles commas + quotes correctly");
  } else {
    fail("CSV escape wrong for weird email; got: " + weirdLine);
  }
  // ISO timestamps for the seeded paid user
  if (text.includes("2023-11-14T")) ok("created_at rendered as ISO 8601");
  else fail("expected ISO timestamp in CSV; got body:\n" + text);
}

console.log("");
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.\n`);
  process.exit(1);
} else {
  console.log("All admin assertions passed.\n");
}
