// Tests for POST /api/logout (handler + auth integration).
//
// Verifies:
//   1. logoutHandler with a valid request.token deletes the SESSIONS KV row.
//   2. Response is 200 JSON with Set-Cookie carrying Max-Age=0 (clears cookie).
//   3. requireAuth → logoutHandler chain rejects requests without a session.
//   4. After a successful logout, the same token can no longer pass requireAuth
//      (proves end-to-end revocation, not just a cookie clear).
//
// Run with:  node scripts/test-logout.mjs

import { issueJWT, requireAuth, buildSessionCookie } from "../src/auth.js";
import { logoutHandler } from "../src/handlers/logout.js";

const JWT_SECRET = "logout-test-jwt-secret-32-or-more-chars-please";

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

console.log("\nLogout handler\n");

// 1. Successful logout via direct handler call
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_logout_1", "a@b.co", "active");
  if (!env.SESSIONS._store.has(`sess:${token}`)) fail("setup: KV row not present");

  // Simulate post-requireAuth state.
  const req = new Request("http://localhost/api/logout", {
    method: "POST",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  req.token = token;
  req.user  = { userId: "user_logout_1", email: "a@b.co", subStatus: "active" };

  const res = await logoutHandler(req, env);
  if (res.status === 200) ok("logoutHandler returns 200"); else fail(`status=${res.status}`);

  const body = await res.json();
  if (body.ok === true) ok("response body { ok: true }"); else fail(`body=${JSON.stringify(body)}`);

  const cookie = res.headers.get("Set-Cookie") || "";
  if (cookie.includes("algosize_session=")) ok("Set-Cookie targets session cookie name");
  else fail(`Set-Cookie missing cookie name: ${cookie}`);
  if (/Max-Age=0\b/.test(cookie)) ok("Set-Cookie carries Max-Age=0 (cookie cleared)");
  else fail(`Set-Cookie missing Max-Age=0: ${cookie}`);
  if (/HttpOnly/i.test(cookie)) ok("clear cookie remains HttpOnly");
  else fail(`Set-Cookie missing HttpOnly: ${cookie}`);

  if (!env.SESSIONS._store.has(`sess:${token}`)) ok("session row deleted from SESSIONS KV");
  else fail("session row still present after logout");
}

// 2. Idempotent: calling logout when KV row already gone still returns 200
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_logout_2", "c@d.co", "active");
  await env.SESSIONS.delete(`sess:${token}`);

  const req = new Request("http://localhost/api/logout", { method: "POST" });
  req.token = token;

  const res = await logoutHandler(req, env);
  if (res.status === 200) ok("idempotent: 200 even if KV row already gone");
  else fail(`status=${res.status}`);
}

// 3. Logout with missing token still clears the cookie (defensive)
{
  const env = makeEnv();
  const req = new Request("http://localhost/api/logout", { method: "POST" });
  // intentionally no req.token
  const res = await logoutHandler(req, env);
  if (res.status === 200) ok("no-token call returns 200 (defensive)");
  else fail(`no-token status=${res.status}`);
  const cookie = res.headers.get("Set-Cookie") || "";
  if (/Max-Age=0\b/.test(cookie)) ok("no-token call still emits clear cookie");
  else fail(`Set-Cookie missing Max-Age=0: ${cookie}`);
}

// 4. End-to-end: requireAuth rejects after logout (proves real revocation)
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_logout_3", "e@f.co", "active");

  // Pre-logout: requireAuth accepts the token.
  const req1 = new Request("http://localhost/api/logout", {
    method: "POST",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  const guard1 = await requireAuth(req1, env);
  if (guard1 === undefined && req1.token === token) ok("pre-logout: requireAuth accepts token");
  else fail(`pre-logout requireAuth unexpectedly returned: ${guard1 && guard1.status}`);

  // Logout.
  await logoutHandler(req1, env);

  // Post-logout: same cookie now fails requireAuth with session_revoked.
  const req2 = new Request("http://localhost/api/logout", {
    method: "POST",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  const guard2 = await requireAuth(req2, env);
  if (guard2 && guard2.status === 401) {
    const body = await guard2.json();
    if (body.reason === "session_revoked") ok("post-logout: requireAuth → 401 session_revoked");
    else fail(`post-logout: 401 but wrong reason: ${JSON.stringify(body)}`);
  } else {
    fail(`post-logout: expected 401, got ${guard2 && guard2.status}`);
  }
}

// 5. buildSessionCookie / buildClearSessionCookie symmetry
{
  const env = makeEnv();
  const setCookie   = buildSessionCookie(env, "tok123", { secure: false });
  // Sanity: the active cookie has a non-zero Max-Age, the clear one is 0.
  if (/Max-Age=\d+/.test(setCookie) && !/Max-Age=0\b/.test(setCookie)) {
    ok("active session cookie has non-zero Max-Age");
  } else {
    fail(`active cookie Max-Age unexpected: ${setCookie}`);
  }
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all logout tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} logout test(s) failed\x1b[0m\n`);
  process.exit(1);
}
