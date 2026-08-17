// Tests for the e2e seed endpoint (src/handlers/_seed.js) against an EMPTY D1.
//
// This exists because of a CI failure the rest of the suite could not have
// caught. Every other test builds its database with makeD1(), which applies
// every file in migrations/ — so the schema is always complete. Miniflare,
// which is what `wrangler dev` gives the Playwright suite, starts D1 as an
// empty SQLite file and applies nothing. The seed endpoint carries its own
// inlined subset of the schema, and that subset is the ONLY schema the e2e
// environment ever gets.
//
// So the seed handler silently owns a second copy of the schema, and when a
// migration adds a table the handler doesn't know about, every test in the
// suite stays green and Playwright 500s. That is exactly what happened when
// organisations landed: /api/me threw on a missing `organisations` table.
//
// These tests run the real handler against makeEmptyD1() and then exercise the
// same endpoint Playwright asserts on, so the two schemas cannot drift again
// without something here going red.
//
// Run with:  node scripts/test-e2e-seed.mjs

import { seedHandler } from "../src/handlers/_seed.js";
import { meHandler } from "../src/handlers/me.js";
import { resolveEntitlement } from "../src/entitlement.js";
import { makeEmptyD1 } from "./_d1-stub.mjs";

const E2E_SECRET = "e2e-seed-test-secret";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

function makeKV() {
  const store = new Map();
  return {
    async get(key)              { return store.has(key) ? store.get(key) : null; },
    async put(key, val, o = {}) { store.set(key, val); },
    async delete(key)           { store.delete(key); },
    _store: store,
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET: "e2e-seed-test-jwt-secret-32-or-more-chars",
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    E2E_TEST_SECRET: E2E_SECRET,
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    // Empty, exactly like Miniflare. NOT makeD1() — that would apply every
    // migration and defeat the point of this file.
    DB:       makeEmptyD1(),
    ...overrides,
  };
}

const USER_ID = "usr_e2e_seed";
const EMAIL   = "e2e@example.com";

function seedBody({ subStatus = "active" } = {}) {
  return {
    token: "fake.jwt.token",
    session: { userId: USER_ID, email: EMAIL, subStatus, iat: Math.floor(Date.now() / 1000) },
    user: {
      userId: USER_ID,
      email: EMAIL,
      stripeCustomerId: "cus_E2E",
      subStatus,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    },
  };
}

function seedRequest(body, secret = E2E_SECRET) {
  return new Request("http://x/api/_test/seed", {
    method: "POST",
    headers: { "content-type": "application/json", "X-E2E-Auth": secret },
    body: JSON.stringify(body),
  });
}

function meRequest() {
  const req = new Request("https://algosize.com/api/me");
  req.user = { userId: USER_ID, email: EMAIL, subStatus: "active" };
  return req;
}

// ---------------------------------------------------------------------------
console.log("\nthe seed endpoint builds a complete schema from empty\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const res = await seedHandler(seedRequest(seedBody()), env);
  expect(res.status === 200, `seeding an empty database succeeds (got ${res.status})`);

  // Every table the authenticated read paths touch must now exist. A missing
  // one is a 500 in Playwright and nowhere else.
  const tables = env.DB._raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  for (const t of ["users", "runs", "organisations", "memberships"]) {
    expect(tables.includes(t), `table \`${t}\` was created`);
  }

  const cols = env.DB._raw.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  expect(cols.includes("active_org_id"),
    "users.active_org_id exists (entitlement's org lookup joins on it)");
}

{
  // THE regression: this is the exact request Playwright makes, and the exact
  // one that returned 500 when organisations landed without the seed knowing.
  const env = makeEnv();
  await seedHandler(seedRequest(seedBody()), env);

  const res = await meHandler(meRequest(), env, {});
  expect(res.status === 200, `GET /api/me on a seeded session returns 200 (got ${res.status})`);

  const body = await res.json();
  expect(body.email === EMAIL, "reports the seeded email");
  expect(body.subStatus === "active", "reports the seeded subscription status");
  expect(body.plan === "paid",
    `a seeded active subscriber reads as paid (got ${body.plan}) — not free, which is what a ` +
    `missing membership would produce`);
  expect(body.monthlyRunsLimit === null,
    "and gets null counters, so the dashboard renders Unlimited");
}

{
  // The seeded session must be genuinely entitled, not merely non-500: the
  // dashboard test drives all three analyzers through the quota gate.
  const env = makeEnv();
  await seedHandler(seedRequest(seedBody()), env);

  const ent = await resolveEntitlement(env, USER_ID);
  expect(ent.active === true, "the seeded session resolves as entitled");
  expect(ent.org !== null, "against a real organisation");
  expect(ent.role === "owner", "which it owns");
}

{
  // A seeded FREE session stays free — the seed must not hand out access the
  // fixture didn't ask for.
  const env = makeEnv();
  await seedHandler(seedRequest(seedBody({ subStatus: null })), env);

  const ent = await resolveEntitlement(env, USER_ID);
  expect(ent.active === false, "a seeded session with no subscription is not entitled");
}

{
  // Re-seeding the same user is what a re-run of the suite does against a
  // leftover database file. It must not trip a UNIQUE or PRIMARY KEY.
  const env = makeEnv();
  await seedHandler(seedRequest(seedBody()), env);
  const second = await seedHandler(seedRequest(seedBody()), env);
  expect(second.status === 200, `re-seeding the same user succeeds (got ${second.status})`);

  const orgs = env.DB._raw.prepare("SELECT COUNT(*) AS n FROM organisations").get().n;
  const mems = env.DB._raw.prepare("SELECT COUNT(*) AS n FROM memberships").get().n;
  expect(orgs === 1, `re-seeding did not duplicate the organisation (got ${orgs})`);
  expect(mems === 1, `nor the membership (got ${mems})`);
}

// ---------------------------------------------------------------------------
console.log("\nthe endpoint stays invisible outside the test environment\n");
// ---------------------------------------------------------------------------

{
  // No secret configured — production. The endpoint must not exist at all.
  const env = makeEnv({ E2E_TEST_SECRET: undefined });
  const res = await seedHandler(seedRequest(seedBody()), env);
  expect(res.status === 404,
    `without E2E_TEST_SECRET the endpoint 404s (got ${res.status}) — it is a no-op in production`);
}

{
  const env = makeEnv();
  const res = await seedHandler(seedRequest(seedBody(), "wrong-secret"), env);
  expect(res.status === 403, `a wrong X-E2E-Auth is refused (got ${res.status})`);

  const tables = env.DB._raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  expect(tables.length === 0, "and writes nothing at all");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all e2e-seed tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} e2e-seed test(s) failed\x1b[0m\n`);
  process.exit(1);
}
