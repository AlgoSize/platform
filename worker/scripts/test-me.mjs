// Tests for GET /api/me (handler + auth integration).
//
// Verifies:
//   1. requireAuth → meHandler chain returns 401 with NO cookie / no header.
//   2. requireAuth → meHandler chain returns 401 after a logout (revoked
//      session in KV) — proves end-to-end revocation, not just a stale JWT.
//   3. With an active session + a USERS row, meHandler returns 200 JSON
//      shaped { email, subStatus } and the values come from USERS KV (not
//      the session payload) — i.e. a webhook flip is reflected immediately.
//   4. If the USERS row is missing under a valid session, the response
//      falls back to the session payload (no 200-with-empty-fields surprise).
//
// Run with:  node scripts/test-me.mjs

import { issueJWT, requireAuth, revokeJWT } from "../src/auth.js";
import { meHandler } from "../src/handlers/me.js";
import { upsertUserFromCheckout } from "../src/handlers/_users.js";

const JWT_SECRET = "me-test-jwt-secret-32-or-more-chars-please";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };

// In-memory KV stub mirroring the parts of Cloudflare KV we use.
function makeKV() {
  const store = new Map();
  return {
    async get(key)            { return store.has(key) ? store.get(key) : null; },
    async put(key, val, opts) { store.set(key, val); },
    async delete(key)         { store.delete(key); },
    _store: store,
  };
}

function makeEnv() {
  return {
    JWT_SECRET,
    SITE_ORIGIN: "http://localhost:5000",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
  };
}

// Run requireAuth followed by meHandler the way the router would.
async function callMe(req, env) {
  const guard = await requireAuth(req, env);
  if (guard) return guard;            // 401 short-circuit
  return meHandler(req, env);
}

console.log("\nGET /api/me — auth gating\n");

// 1. No cookie / no Authorization header → 401 missing_token
{
  const env = makeEnv();
  const req = new Request("http://localhost/api/me", { method: "GET" });
  const res = await callMe(req, env);
  if (res.status === 401) {
    const body = await res.json();
    if (body.reason === "missing_token") ok("no cookie → 401 missing_token");
    else fail(`401 but wrong reason: ${JSON.stringify(body)}`);
  } else {
    fail(`expected 401, got ${res.status}`);
  }
}

// 2. Cookie present but session revoked in KV → 401 session_revoked
{
  const env = makeEnv();
  const token = await issueJWT(env, "usr_revoked", "ghost@example.com", "active");
  await revokeJWT(env, token);  // delete SESSIONS row but keep cookie

  const req = new Request("http://localhost/api/me", {
    method: "GET",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  const res = await callMe(req, env);
  if (res.status === 401) {
    const body = await res.json();
    if (body.reason === "session_revoked") ok("revoked session → 401 session_revoked");
    else fail(`401 but wrong reason: ${JSON.stringify(body)}`);
  } else {
    fail(`expected 401, got ${res.status}`);
  }
}

// 3. Tampered JWT → 401 invalid_token (defense in depth — JWT verify catches it
//    even if the SESSIONS lookup would otherwise miss)
{
  const env = makeEnv();
  const token = await issueJWT(env, "usr_t", "tamper@example.com", "active");
  // Flip a single char in the signature segment.
  const flipped = token.slice(-1) === "A" ? token.slice(0, -1) + "B" : token.slice(0, -1) + "A";
  const req = new Request("http://localhost/api/me", {
    method: "GET",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(flipped)}` },
  });
  const res = await callMe(req, env);
  if (res.status === 401) {
    const body = await res.json();
    if (body.reason === "invalid_token") ok("tampered JWT → 401 invalid_token");
    else fail(`401 but wrong reason: ${JSON.stringify(body)}`);
  } else {
    fail(`expected 401, got ${res.status}`);
  }
}

console.log("\nGET /api/me — happy path\n");

// 4. Active session + USERS row → 200 { email, subStatus } from KV
{
  const env = makeEnv();
  const user = await upsertUserFromCheckout(env, {
    email: "buyer@example.com",
    stripeCustomerId: "cus_FROM_KV",
    subStatus: "active",
  });
  const token = await issueJWT(env, user.userId, user.email, user.subStatus);

  const req = new Request("http://localhost/api/me", {
    method: "GET",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  const res = await callMe(req, env);
  if (res.status !== 200) { fail(`expected 200, got ${res.status}`); }
  else {
    const body = await res.json();
    const shapeOk = typeof body.email === "string" && typeof body.subStatus === "string";
    if (shapeOk && body.email === "buyer@example.com" && body.subStatus === "active") {
      ok("active session returns { email, subStatus } from USERS KV");
    } else {
      fail(`unexpected body: ${JSON.stringify(body)}`);
    }
    if (res.headers.get("content-type")?.includes("application/json")) {
      ok("response is application/json");
    } else {
      fail(`wrong content-type: ${res.headers.get("content-type")}`);
    }
  }
}

// 5. Webhook flipped subStatus to "inactive" AFTER JWT was issued → /api/me
//    reflects the FRESH KV value (not the stale JWT payload). This is why we
//    re-read the user from KV instead of trusting request.user.subStatus.
{
  const env = makeEnv();
  const user = await upsertUserFromCheckout(env, {
    email: "canceller@example.com",
    stripeCustomerId: "cus_CANCELLED",
    subStatus: "active",
  });
  // Issue token while still active.
  const token = await issueJWT(env, user.userId, user.email, "active");
  // Webhook fires, flips status.
  await upsertUserFromCheckout(env, {
    email: "canceller@example.com",
    stripeCustomerId: "cus_CANCELLED",
    subStatus: "inactive",
  });

  const req = new Request("http://localhost/api/me", {
    method: "GET",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  const res = await callMe(req, env);
  const body = await res.json();
  if (res.status === 200 && body.subStatus === "inactive") {
    ok("/api/me reflects fresh USERS KV (cancelled subscription, not stale JWT)");
  } else {
    fail(`stale read: status=${res.status} body=${JSON.stringify(body)}`);
  }
}

// 6. Authorization: Bearer header is also accepted (parity with cookie path).
{
  const env = makeEnv();
  const user = await upsertUserFromCheckout(env, {
    email: "bearer@example.com",
    stripeCustomerId: "cus_BEARER",
    subStatus: "active",
  });
  const token = await issueJWT(env, user.userId, user.email, "active");

  const req = new Request("http://localhost/api/me", {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` },
  });
  const res = await callMe(req, env);
  if (res.status === 200) {
    const body = await res.json();
    if (body.email === "bearer@example.com" && body.subStatus === "active") {
      ok("Authorization: Bearer header is accepted");
    } else {
      fail(`bearer body unexpected: ${JSON.stringify(body)}`);
    }
  } else {
    fail(`bearer expected 200, got ${res.status}`);
  }
}

// 7. Edge case: USERS row missing under a valid session → fallback to session
//    payload so the dashboard still gets a usable email. (Defensive — should
//    not happen in normal operation, but better than 200-with-null-fields.)
{
  const env = makeEnv();
  // Issue a token WITHOUT writing to USERS KV.
  const token = await issueJWT(env, "usr_orphan", "orphan@example.com", "active");

  const req = new Request("http://localhost/api/me", {
    method: "GET",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  const res = await callMe(req, env);
  const body = await res.json();
  if (res.status === 200 && body.email === "orphan@example.com" && body.subStatus === "active") {
    ok("missing USERS row → falls back to session payload (no null fields)");
  } else {
    fail(`fallback failed: status=${res.status} body=${JSON.stringify(body)}`);
  }
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all /api/me tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} /api/me test(s) failed\x1b[0m\n`);
  process.exit(1);
}
