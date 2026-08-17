// Tests for API keys — Task #P-4, "add API keys so CI can call the scanner".
//
// A key authenticates AS THE ORGANISATION (migrations/0004), through the
// SAME requireAuth middleware and the SAME /api/analyze/* routes a browser
// session uses — so this file drives most of its cases through the real
// router (`worker.fetch`) rather than calling handlers directly, to prove
// the whole chain (rate limit → requireAuth → org-scoped quota → analyzer)
// actually wires together for a key, not just that each piece works in
// isolation.
//
// Covers, per the task spec:
//   - the stored row holds sha256(key), never the plaintext
//   - a live key works on /api/analyze/vuln, end to end through the router
//   - a revoked key gets 401
//   - a key is scoped to its own org's data (quota isolation between orgs'
//     keys, and management isolation — an org cannot list/revoke another
//     org's keys even by guessing an id)
//   - last_used_at updates, via ctx.waitUntil, without blocking the response
//
// Run with:  node scripts/test-api-keys.mjs

import worker from "../src/index.js";
import { issueJWT } from "../src/auth.js";
import {
  createApiKeyHandler,
  listApiKeysHandler,
  revokeApiKeyHandler,
} from "../src/handlers/keys.js";
import { generateApiKey, createApiKey, listApiKeys } from "../src/handlers/_api_keys.js";
import { makeApiKeyRateLimit } from "../src/middleware/rate-limit.js";
import { makeD1 } from "./_d1-stub.mjs";

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
    JWT_SECRET:  "api-keys-test-jwt-secret-32-or-more-chars!",
    SITE_ORIGIN: "http://localhost:5000",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    ...overrides,
  };
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** A user + the org they own, matching what the real signup/checkout paths produce. */
async function seedOwner(env, { userId, email, plan = "paid", subStatus = "active", seats = 1 }) {
  const now = NOW;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?, ?)`,
  ).bind(userId, email, `org_${userId}`, now, now).run();

  const orgId = `org_${userId}`;
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(orgId, email, plan === "paid" ? `cus_${userId}` : null, plan, subStatus, seats, now, now).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
  ).bind(orgId, userId, now).run();

  return orgId;
}

async function addMember(env, orgId, userId, email, role) {
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?, ?)`,
  ).bind(userId, email, orgId, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
  ).bind(orgId, userId, role, NOW).run();
}

function ownerRequest(userId, { method = "GET", url = "https://algosize.com/api/keys", body, params } = {}) {
  const req = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  req.user = { userId, email: `${userId}@example.com` };
  if (params) req.params = params;
  return req;
}

function analyzeRequest(key) {
  return new Request("https://algosize.com/api/analyze/vuln", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Origin": "http://localhost:5000",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({ code: 'eval(x);' }),
  });
}

// ---------------------------------------------------------------------------
console.log("\nstorage — sha256, never the plaintext\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const orgId = await seedOwner(env, { userId: "usr_hash", email: "hash@example.com" });
  const { key, record } = await createApiKey(env, { orgId, name: "test key", createdBy: "usr_hash" });

  const row = await env.DB.prepare("SELECT * FROM api_keys WHERE key_id = ?").bind(record.keyId).first();
  expect(!!row, "the row was written");
  expect(row.key_hash !== key, "key_hash column does not equal the plaintext key");
  expect(!Object.values(row).some((v) => v === key),
    "no column on the row holds the plaintext key at all");

  const expectedHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");
  expect(row.key_hash === expectedHash, "key_hash is exactly sha256(key), hex-encoded");

  expect(key.startsWith("ask_live_"), `key carries the ask_live_ prefix (got "${key.slice(0, 12)}…")`);
  expect(row.prefix === key.slice(0, 16), "the stored display prefix matches the first 16 chars of the key");
}

{
  // generateApiKey on its own — enough entropy that two calls never collide
  // in any test run, and always the documented shape.
  const a = generateApiKey();
  const b = generateApiKey();
  expect(a !== b, "two generated keys are never equal");
  expect(/^ask_live_[A-Za-z0-9_-]{40,}$/.test(a), `key matches the ask_live_<base64url> shape (got "${a}")`);
}

// ---------------------------------------------------------------------------
console.log("\na live key works on /api/analyze/vuln, end to end\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const orgId = await seedOwner(env, { userId: "usr_ci", email: "ci@example.com", plan: "paid", subStatus: "active" });
  const created = await createApiKeyHandler(
    ownerRequest("usr_ci", { method: "POST", url: "https://algosize.com/api/keys", body: { name: "CI" } }),
    env,
  );
  const createdBody = await created.json();
  expect(created.status === 201, `key creation → 201 (got ${created.status})`);
  expect(typeof createdBody.key === "string" && createdBody.key.startsWith("ask_live_"),
    "creation response includes the plaintext key");
  expect(/only time/i.test(createdBody.message), "and says this is the only time it's shown");

  const res = await worker.fetch(analyzeRequest(createdBody.key), env, {});
  const body = await res.json();
  expect(res.status === 200, `the key authenticates and runs the analyzer (got ${res.status})`);
  expect(Array.isArray(body.findings) && body.findings.length >= 1,
    "and gets real findings back, not a stub response");
}

{
  // Nonsense bearer with the right tag but no matching row — diagnosed as an
  // invalid key, not silently run through JWT verification.
  const env = makeEnv();
  const res = await worker.fetch(analyzeRequest("ask_live_not_a_real_key_at_all"), env, {});
  const body = await res.json();
  expect(res.status === 401 && body.reason === "invalid_api_key",
    `an unknown ask_live_ token is refused as invalid_api_key (got ${res.status}/${body.reason})`);
}

// ---------------------------------------------------------------------------
console.log("\nrevocation\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  await seedOwner(env, { userId: "usr_rev", email: "rev@example.com" });
  const created = await createApiKeyHandler(
    ownerRequest("usr_rev", { method: "POST", url: "https://algosize.com/api/keys", body: { name: "to revoke" } }),
    env,
  );
  const { key, keyId } = await created.json();

  const before = await worker.fetch(analyzeRequest(key), env, {});
  expect(before.status === 200, "the key works before revocation");

  const revoke = await revokeApiKeyHandler(
    ownerRequest("usr_rev", { method: "DELETE", url: `https://algosize.com/api/keys/${keyId}`, params: { id: keyId } }),
    env,
  );
  expect(revoke.status === 200, `revocation succeeds (got ${revoke.status})`);

  const after = await worker.fetch(analyzeRequest(key), env, {});
  const afterBody = await after.json();
  expect(after.status === 401 && afterBody.reason === "invalid_api_key",
    `the SAME key is refused immediately after revocation (got ${after.status})`);

  // Revoking again is a no-op, not an error — a double-click or a retried
  // request must not surface as a failure.
  const second = await revokeApiKeyHandler(
    ownerRequest("usr_rev", { method: "DELETE", url: `https://algosize.com/api/keys/${keyId}`, params: { id: keyId } }),
    env,
  );
  const secondBody = await second.json();
  expect(second.status === 200 && secondBody.alreadyRevoked === true,
    "revoking an already-revoked key is idempotent");
}

// ---------------------------------------------------------------------------
console.log("\nscoped to its own org — quota, entitlement and management\n");
// ---------------------------------------------------------------------------

{
  // Org A is paid; org B is free and already sitting at the monthly limit.
  // A's key must still work; B's key must be blocked — proving usage is
  // metered per org and one org's key cannot spend from another's counter
  // (or dodge its own).
  const env = makeEnv();
  await seedOwner(env, { userId: "usr_a", email: "a@example.com", plan: "paid", subStatus: "active" });
  const orgB = await seedOwner(env, { userId: "usr_b", email: "b@example.com", plan: "free" });

  const keyA = await createApiKeyHandler(
    ownerRequest("usr_a", { method: "POST", url: "https://algosize.com/api/keys", body: { name: "A" } }), env,
  ).then((r) => r.json());
  const keyB = await createApiKeyHandler(
    ownerRequest("usr_b", { method: "POST", url: "https://algosize.com/api/keys", body: { name: "B" } }), env,
  ).then((r) => r.json());

  // Put org B at its free limit directly (the quota counter is keyed by org
  // id for API-key traffic — see quota.js's enforceQuota).
  await env.USERS.put(`quota:${orgB}:${new Date(NOW * 1000).getUTCFullYear()}-${String(new Date(NOW * 1000).getUTCMonth() + 1).padStart(2, "0")}`, "5");

  const resA = await worker.fetch(analyzeRequest(keyA.key), env, {});
  expect(resA.status === 200, `org A's paid key still runs (got ${resA.status})`);

  const resB = await worker.fetch(analyzeRequest(keyB.key), env, {});
  const bodyB = await resB.json();
  expect(resB.status === 402 && bodyB.error === "quota_exceeded",
    `org B's free key is blocked at ITS OWN limit, unaffected by org A (got ${resB.status})`);
}

{
  // Management isolation: org A cannot see or revoke org B's keys, even
  // when it knows (or guesses) the exact key id.
  const env = makeEnv();
  await seedOwner(env, { userId: "usr_ma", email: "ma@example.com" });
  await seedOwner(env, { userId: "usr_mb", email: "mb@example.com" });

  const keyB = await createApiKeyHandler(
    ownerRequest("usr_mb", { method: "POST", url: "https://algosize.com/api/keys", body: { name: "B's key" } }), env,
  ).then((r) => r.json());

  const listA = await listApiKeysHandler(ownerRequest("usr_ma"), env).then((r) => r.json());
  expect(listA.keys.every((k) => k.keyId !== keyB.keyId),
    "org A's key list does not include org B's key");

  const revokeAttempt = await revokeApiKeyHandler(
    ownerRequest("usr_ma", { method: "DELETE", url: `https://algosize.com/api/keys/${keyB.keyId}`, params: { id: keyB.keyId } }),
    env,
  );
  expect(revokeAttempt.status === 404,
    `org A cannot revoke org B's key by id (got ${revokeAttempt.status})`);

  // And B's key is confirmed still live.
  const stillWorks = await worker.fetch(analyzeRequest(keyB.key), env, {});
  expect(stillWorks.status === 200, "org B's key is unaffected by org A's failed attempt");
}

// ---------------------------------------------------------------------------
console.log("\nlast_used_at\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  await seedOwner(env, { userId: "usr_touch", email: "touch@example.com" });
  const created = await createApiKeyHandler(
    ownerRequest("usr_touch", { method: "POST", url: "https://algosize.com/api/keys", body: { name: "touch" } }), env,
  ).then((r) => r.json());

  const before = await listApiKeys(env, "org_usr_touch");
  expect(before[0].lastUsedAt === null, "last_used_at is null before the key is ever used");

  // Capture ctx.waitUntil promises and await them explicitly — mirrors how
  // the real Workers runtime keeps a request alive until they settle, and
  // proves the bump genuinely never blocked the response (the response
  // above resolved before this await runs).
  const queued = [];
  const ctx = { waitUntil: (p) => queued.push(p) };
  const res = await worker.fetch(analyzeRequest(created.key), env, ctx);
  expect(res.status === 200, "the request itself succeeds");
  expect(queued.length >= 1, "the last_used_at bump was queued via ctx.waitUntil, not awaited inline");
  await Promise.all(queued);

  const after = await listApiKeys(env, "org_usr_touch");
  expect(typeof after[0].lastUsedAt === "number" && after[0].lastUsedAt >= before[0].createdAt,
    `last_used_at is now set (got ${after[0].lastUsedAt})`);
}

// ---------------------------------------------------------------------------
console.log("\nmanagement is owner/admin only, and keys cannot manage keys\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const orgId = await seedOwner(env, { userId: "usr_owner2", email: "owner2@example.com" });
  await addMember(env, orgId, "usr_plain", "plain@example.com", "member");

  const create = await createApiKeyHandler(
    ownerRequest("usr_plain", { method: "POST", url: "https://algosize.com/api/keys", body: { name: "nope" } }), env,
  );
  expect(create.status === 403, `a plain member cannot create a key (got ${create.status})`);

  const list = await listApiKeysHandler(ownerRequest("usr_plain"), env);
  expect(list.status === 403, `a plain member cannot list keys (got ${list.status})`);
}

{
  // An API-key-authenticated request must not be able to mint or revoke
  // keys itself — that would let a leaked key re-arm past a revocation.
  const env = makeEnv();
  await seedOwner(env, { userId: "usr_self", email: "self@example.com" });
  const created = await createApiKeyHandler(
    ownerRequest("usr_self", { method: "POST", url: "https://algosize.com/api/keys", body: { name: "self" } }), env,
  ).then((r) => r.json());

  const req = new Request("https://algosize.com/api/keys", {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": `Bearer ${created.key}` },
    body: JSON.stringify({ name: "escalation attempt" }),
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  expect(res.status === 403, `an API key cannot manage API keys (got ${res.status})`);
  expect(/cannot manage/i.test(body.message), "and says why");
}

// ---------------------------------------------------------------------------
console.log("\nrate limiting API-key traffic per org, not per IP\n");
// ---------------------------------------------------------------------------

{
  // A tight limit so the test is fast, exercising the same makeApiKeyRateLimit
  // factory index.js wires in front of /api/analyze/*.
  const env = makeEnv();
  const limiter = makeApiKeyRateLimit({ keyName: "test-org-limit", limit: 2, windowSec: 60 });

  const reqFor = (orgId, ip) => {
    const req = new Request("https://algosize.com/api/analyze/vuln", {
      headers: ip ? { "CF-Connecting-IP": ip } : undefined,
    });
    if (orgId) { req.org = { orgId }; req.authMethod = "api_key"; }
    return req;
  };

  // Two different IPs presenting the SAME org's key share one bucket — this
  // is the point of the feature (a key used from many source IPs is still
  // one customer).
  expect(await limiter(reqFor("org_shared", "1.1.1.1"), env) === undefined, "org_shared request 1 (ip A) passes");
  expect(await limiter(reqFor("org_shared", "2.2.2.2"), env) === undefined, "org_shared request 2 (ip B) also passes — same org bucket");
  const third = await limiter(reqFor("org_shared", "3.3.3.3"), env);
  expect(third && third.status === 429, "org_shared request 3 (ip C) is limited — the bucket is per org, not per IP");

  // A different org is an independent bucket.
  expect(await limiter(reqFor("org_other", "1.1.1.1"), env) === undefined,
    "a different org is unaffected by org_shared's limit");

  // A session request (no request.org) is a no-op for this limiter — it's
  // covered by the endpoint's IP limiter and the free-tier quota instead.
  const sessionReq = reqFor(null, "9.9.9.9");
  expect(await limiter(sessionReq, env) === undefined, "a non-API-key request is not limited by the org limiter");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all api-key tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} api-key test(s) failed\x1b[0m\n`);
  process.exit(1);
}
