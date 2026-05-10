// Tests for the magic-link auth flow.
//
// Covers:
//   - POST /api/auth/request-link validates email, mints a token, stores it
//     in SESSIONS KV under `magic:<token>` with a 15-min TTL, queues the
//     send via ctx.waitUntil, and ALWAYS returns 200 (no enumeration).
//   - GET /api/auth/verify with a valid token finds-or-creates the user,
//     issues a session JWT cookie, and 302s to /dashboard/.
//   - The token is deleted on successful verify (single-use).
//   - Verify with missing / unknown / replayed token redirects to
//     /?auth=… without setting any cookie.

import {
  requestMagicLinkHandler,
  verifyMagicLinkHandler,
} from "../src/handlers/auth_magic.js";
import { makeD1 } from "./_d1-stub.mjs";

const JWT_SECRET = "magic-test-jwt-secret-32-or-more-chars-please";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const eq   = (a, b, msg) => (a === b ? ok(msg) : fail(`${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

function makeKV() {
  const store = new Map();
  const meta  = new Map();
  return {
    async get(k)            { return store.has(k) ? store.get(k) : null; },
    async put(k, v, opts)   { store.set(k, v); if (opts) meta.set(k, opts); },
    async delete(k)         { store.delete(k); meta.delete(k); },
    _store: store,
    _meta:  meta,
  };
}

function makeCtx() {
  const promises = [];
  return {
    waitUntil(p) { promises.push(p); },
    _drain: () => Promise.all(promises),
    _count: () => promises.length,
  };
}

function makeEnv() {
  return {
    JWT_SECRET,
    SITE_ORIGIN: "http://localhost:5000",
    COOKIE_NAME: "algosize_session",
    EMAIL_FROM:  "Algosize <noreply@algosize.com>",
    SESSIONS:    makeKV(),
    USERS:       makeKV(),
    DB:          makeD1(),
    // GOOGLE_SERVICE_ACCOUNT_JSON intentionally unset — sendTransactional
    // no-ops with a "not_configured" warning, which is exactly what we want
    // for tests (no real Gmail call).
  };
}

async function postJson(url, body) {
  return new Request(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

console.log("\nPOST /api/auth/request-link\n");

// 1. Invalid email → 400
{
  const env = makeEnv(); const ctx = makeCtx();
  const res = await requestMagicLinkHandler(
    await postJson("http://localhost/api/auth/request-link", { email: "not-an-email" }),
    env, ctx,
  );
  eq(res.status, 400, "rejects invalid email with 400");
  const body = await res.json();
  eq(body.error, "invalid_email", "error code is invalid_email");
  eq(env.SESSIONS._store.size, 0, "no token stored on invalid email");
}

// 2. Missing JSON body → 400
{
  const env = makeEnv(); const ctx = makeCtx();
  const req = new Request("http://localhost/api/auth/request-link", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "not json",
  });
  const res = await requestMagicLinkHandler(req, env, ctx);
  eq(res.status, 400, "rejects malformed JSON with 400");
}

// 3. Valid email → 200 + token stored under magic: with TTL
{
  const env = makeEnv(); const ctx = makeCtx();
  const res = await requestMagicLinkHandler(
    await postJson("http://localhost/api/auth/request-link", { email: "alice@example.com" }),
    env, ctx,
  );
  eq(res.status, 200, "valid email returns 200");
  const body = await res.json();
  eq(body.ok, true, "body.ok = true");
  eq(typeof body.message, "string", "body has a human-readable message");
  eq(body.ttlMinutes, 15, "advertised TTL is 15 minutes");

  const keys = [...env.SESSIONS._store.keys()];
  eq(keys.length, 1, "exactly one token stored");
  if (keys[0].startsWith("magic:")) ok("token key prefixed with 'magic:'");
  else fail(`token key prefix wrong: ${keys[0]}`);

  const stored = JSON.parse(env.SESSIONS._store.get(keys[0]));
  eq(stored.email, "alice@example.com", "stored payload carries lowercased email");

  const opts = env.SESSIONS._meta.get(keys[0]);
  eq(opts && opts.expirationTtl, 900, "token TTL is 15 min (900 s)");

  // Send was queued onto ctx.waitUntil.
  if (ctx._count() >= 1) ok("send queued via ctx.waitUntil");
  else fail("expected ctx.waitUntil to be called for the email send");
  await ctx._drain();
}

// 4. Email is normalized (lowercased + trimmed)
{
  const env = makeEnv(); const ctx = makeCtx();
  await requestMagicLinkHandler(
    await postJson("http://localhost/api/auth/request-link", { email: "  ALICE@EXAMPLE.COM  " }),
    env, ctx,
  );
  const stored = JSON.parse([...env.SESSIONS._store.values()][0]);
  eq(stored.email, "alice@example.com", "email lowercased + trimmed before storage");
  await ctx._drain();
}

// 5. Same shape regardless of whether the email exists (no enumeration)
{
  const env = makeEnv(); const ctx = makeCtx();
  // Pre-create one user; the response for a known address must look identical
  // to the response for an unknown one.
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, plan, created_at, updated_at) VALUES (?, ?, 'free', ?, ?)`,
  ).bind("usr_existing", "known@example.com", now, now).run();

  const r1 = await requestMagicLinkHandler(
    await postJson("http://localhost/api/auth/request-link", { email: "known@example.com" }),
    env, ctx,
  );
  const r2 = await requestMagicLinkHandler(
    await postJson("http://localhost/api/auth/request-link", { email: "unknown@example.com" }),
    env, ctx,
  );
  eq(r1.status, r2.status, "known + unknown both return same status");
  const b1 = await r1.json(), b2 = await r2.json();
  eq(b1.message, b2.message, "known + unknown emit identical message body");
  await ctx._drain();
}

console.log("\nGET /api/auth/verify\n");

// 6. Missing token → 302 to /?auth=missing_token, no cookie
{
  const env = makeEnv();
  const res = await verifyMagicLinkHandler(
    new Request("http://localhost/api/auth/verify"), env,
  );
  eq(res.status, 302, "missing token returns 302");
  if (res.headers.get("Location").endsWith("/?auth=missing_token")) ok("redirects with missing_token marker");
  else fail("wrong redirect target: " + res.headers.get("Location"));
  eq(res.headers.get("Set-Cookie"), null, "no cookie set on missing-token redirect");
}

// 7. Unknown token → 302 to /?auth=expired_or_invalid, no cookie
{
  const env = makeEnv();
  const res = await verifyMagicLinkHandler(
    new Request("http://localhost/api/auth/verify?token=notarealtoken"), env,
  );
  eq(res.status, 302, "unknown token returns 302");
  if (res.headers.get("Location").endsWith("/?auth=expired_or_invalid")) ok("redirects with expired_or_invalid marker");
  else fail("wrong redirect target: " + res.headers.get("Location"));
  eq(res.headers.get("Set-Cookie"), null, "no cookie set on unknown-token redirect");
}

// 8. Valid token → creates user, issues session cookie, 302 to /dashboard/
//    AND the token is single-use (replay returns the invalid-token redirect).
{
  const env = makeEnv(); const ctx = makeCtx();
  const reqRes = await requestMagicLinkHandler(
    await postJson("http://localhost/api/auth/request-link", { email: "bob@example.com" }),
    env, ctx,
  );
  const tokenKey = [...env.SESSIONS._store.keys()][0];
  const token = tokenKey.replace(/^magic:/, "");

  const res = await verifyMagicLinkHandler(
    new Request(`http://localhost/api/auth/verify?token=${encodeURIComponent(token)}`), env,
  );
  eq(res.status, 302, "valid token returns 302");
  if (res.headers.get("Location").endsWith("/dashboard/")) ok("redirects to /dashboard/ on success");
  else fail("wrong redirect: " + res.headers.get("Location"));

  const cookie = res.headers.get("Set-Cookie") || "";
  if (cookie.startsWith("algosize_session=")) ok("session cookie set on verify");
  else fail("expected session cookie to be set, got: " + cookie);

  // User row was created.
  const row = await env.DB
    .prepare("SELECT email, plan FROM users WHERE email = ?")
    .bind("bob@example.com").first();
  if (row && row.email === "bob@example.com" && row.plan === "free") ok("free user created on first verify");
  else fail("user row not created: " + JSON.stringify(row));

  // Token is gone (single-use).
  const after = await env.SESSIONS.get(tokenKey);
  eq(after, null, "token deleted after successful verify");

  // Replay → invalid
  const replay = await verifyMagicLinkHandler(
    new Request(`http://localhost/api/auth/verify?token=${encodeURIComponent(token)}`), env,
  );
  if (replay.headers.get("Location").endsWith("/?auth=expired_or_invalid")) ok("replayed token rejected");
  else fail("replay should redirect to expired_or_invalid");
  await ctx._drain();
  void reqRes;
}

// 9. Valid token for an EXISTING user → reuses the row, issues session
{
  const env = makeEnv(); const ctx = makeCtx();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, plan, created_at, updated_at) VALUES (?, ?, 'paid', ?, ?)`,
  ).bind("usr_paid", "vip@example.com", now, now).run();

  await requestMagicLinkHandler(
    await postJson("http://localhost/api/auth/request-link", { email: "vip@example.com" }),
    env, ctx,
  );
  const tokenKey = [...env.SESSIONS._store.keys()][0];
  const token = tokenKey.replace(/^magic:/, "");

  const res = await verifyMagicLinkHandler(
    new Request(`http://localhost/api/auth/verify?token=${token}`), env,
  );
  eq(res.status, 302, "verify for existing user returns 302");
  const cookie = res.headers.get("Set-Cookie") || "";
  if (cookie.startsWith("algosize_session=")) ok("existing-user verify also sets session cookie");
  else fail("missing cookie on existing-user verify");

  // No duplicate user row.
  const rows = await env.DB
    .prepare("SELECT user_id FROM users WHERE email = ?")
    .bind("vip@example.com").all();
  eq(rows.results.length, 1, "no duplicate row created for existing user");
  await ctx._drain();
}

console.log("");
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.\n`);
  process.exit(1);
} else {
  console.log("All magic-link assertions passed.\n");
}
