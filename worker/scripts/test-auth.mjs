// Standalone tests for the JWT primitives in src/auth.js.
//
// Verifies:
//   1. signJWT → verifyJWT round-trip succeeds and returns the payload.
//   2. A token mutated by one byte fails verification (returns null).
//   3. A token signed with a different secret fails verification.
//   4. An expired token fails verification.
//   5. Garbage input is rejected safely.
//   6. issueJWT writes to SESSIONS KV with 30-day TTL and the token verifies.
//   7. requireAuth accepts a freshly issued token (Bearer + cookie),
//      rejects a missing token, rejects a tampered token, and rejects a
//      revoked token (deleted from KV).
//   8. issueJWT/requireAuth refuse to operate without a strong JWT_SECRET.
//
// Run with:  node scripts/test-auth.mjs

import {
  signJWT,
  verifyJWT,
  issueJWT,
  revokeJWT,
  requireAuth,
} from "../src/auth.js";

// 32+ chars required by requireSecret().
const SECRET       = "test-secret-please-do-not-use-in-prod-xxxxxxxx";
const OTHER_SECRET = "another-secret-also-32-or-more-characters-yyyy";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };

// In-memory KV stub mirroring the parts of Cloudflare KV we use.
function makeKV() {
  const store = new Map();
  const ttls  = new Map();
  return {
    async get(key)            { return store.has(key) ? store.get(key) : null; },
    async put(key, val, opts) { store.set(key, val); if (opts?.expirationTtl) ttls.set(key, opts.expirationTtl); },
    async delete(key)         { store.delete(key); ttls.delete(key); },
    _store: store,
    _ttls:  ttls,
  };
}

console.log("\nJWT auth primitives\n");

// 1. Round trip
{
  const token = await signJWT({ sub: "user_123", email: "a@b.co", subStatus: "active" }, SECRET);
  const payload = await verifyJWT(token, SECRET);
  if (payload && payload.sub === "user_123" && payload.email === "a@b.co" && payload.subStatus === "active") {
    ok("round-trip: signJWT then verifyJWT returns the original payload");
  } else {
    fail(`round-trip failed: got ${JSON.stringify(payload)}`);
  }
  if (token.split(".").length === 3) ok("token has three base64url segments"); else fail("token segment count");
}

// 2. Tamper signature
{
  const token = await signJWT({ sub: "user_456" }, SECRET);
  const [h, p, sig] = token.split(".");
  const flipped = sig.slice(-1) === "A" ? "B" : "A";
  const tampered = `${h}.${p}.${sig.slice(0, -1)}${flipped}`;
  const result = await verifyJWT(tampered, SECRET);
  if (result === null) ok("tampered signature is rejected"); else fail(`tampered signature accepted: ${JSON.stringify(result)}`);
}

// 2b. Tamper payload (forge subStatus)
{
  const token = await signJWT({ sub: "user_789", subStatus: "inactive" }, SECRET);
  const [h, , sig] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "user_789", subStatus: "active", exp: 9999999999 })).toString("base64url");
  const result = await verifyJWT(`${h}.${forgedPayload}.${sig}`, SECRET);
  if (result === null) ok("tampered payload is rejected"); else fail(`tampered payload accepted: ${JSON.stringify(result)}`);
}

// 3. Wrong secret
{
  const token = await signJWT({ sub: "user_xyz" }, SECRET);
  const result = await verifyJWT(token, OTHER_SECRET);
  if (result === null) ok("token signed with another secret is rejected"); else fail("wrong-secret token accepted");
}

// 4. Expired
{
  const token = await signJWT({ sub: "user_old" }, SECRET, -10);
  const result = await verifyJWT(token, SECRET);
  if (result === null) ok("expired token is rejected"); else fail(`expired token accepted: ${JSON.stringify(result)}`);
}

// 5. Garbage
{
  let allRejected = true;
  for (const garbage of ["", "not.a.jwt", "a.b", "a.b.c.d", null, undefined, 123]) {
    const result = await verifyJWT(garbage, SECRET);
    if (result !== null) { fail(`garbage accepted: ${JSON.stringify(garbage)}`); allRejected = false; break; }
  }
  if (allRejected) ok("malformed/garbage tokens are rejected");
}

// 6. issueJWT writes to KV with 30-day TTL
{
  const env = { JWT_SECRET: SECRET, COOKIE_NAME: "algosize_session", SESSIONS: makeKV() };
  const token = await issueJWT(env, "user_kv", "k@v.co", "active");
  const stored = await env.SESSIONS.get(`sess:${token}`);
  if (stored) {
    const session = JSON.parse(stored);
    const ttl = env.SESSIONS._ttls.get(`sess:${token}`);
    if (session.userId === "user_kv" && session.email === "k@v.co" && session.subStatus === "active" && ttl === 60 * 60 * 24 * 30) {
      ok("issueJWT writes session to KV with 30-day TTL");
    } else {
      fail(`KV row wrong: session=${stored} ttl=${ttl}`);
    }
  } else {
    fail("issueJWT did not write the session to KV");
  }

  // 7a. requireAuth accepts a freshly issued bearer
  const reqBearer = new Request("http://x/api/me", { headers: { Authorization: `Bearer ${token}` } });
  const r1 = await requireAuth(reqBearer, env);
  if (r1 === undefined && reqBearer.user?.userId === "user_kv") {
    ok("requireAuth accepts valid bearer token and attaches request.user");
  } else {
    fail(`requireAuth bearer failed: response=${r1 ? r1.status : "ok"} user=${JSON.stringify(reqBearer.user)}`);
  }

  // 7b. requireAuth accepts the same token via cookie
  const reqCookie = new Request("http://x/api/me", { headers: { Cookie: `algosize_session=${encodeURIComponent(token)}` } });
  const r2 = await requireAuth(reqCookie, env);
  if (r2 === undefined && reqCookie.user?.userId === "user_kv") {
    ok("requireAuth accepts valid cookie token and attaches request.user");
  } else {
    fail(`requireAuth cookie failed: response=${r2 ? r2.status : "ok"} user=${JSON.stringify(reqCookie.user)}`);
  }

  // 7c. requireAuth rejects missing token
  const reqMissing = new Request("http://x/api/me");
  const r3 = await requireAuth(reqMissing, env);
  if (r3 && r3.status === 401) ok("requireAuth rejects missing token with 401"); else fail("requireAuth allowed missing token");

  // 7d. requireAuth rejects tampered token
  const tampered = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
  const reqBad = new Request("http://x/api/me", { headers: { Authorization: `Bearer ${tampered}` } });
  const r4 = await requireAuth(reqBad, env);
  if (r4 && r4.status === 401) ok("requireAuth rejects tampered token with 401"); else fail("requireAuth allowed tampered token");

  // 7e. requireAuth rejects revoked token
  await revokeJWT(env, token);
  const reqRevoked = new Request("http://x/api/me", { headers: { Authorization: `Bearer ${token}` } });
  const r5 = await requireAuth(reqRevoked, env);
  if (r5 && r5.status === 401) {
    const body = JSON.parse(await r5.text());
    if (body.reason === "session_revoked") ok("requireAuth rejects revoked token with session_revoked");
    else fail(`requireAuth rejected revoked token but reason=${body.reason}`);
  } else {
    fail("requireAuth allowed revoked token");
  }
}

// 8. Fail-fast on missing/short JWT_SECRET (must require >= 32 chars)
{
  // 31-char secret is one char below the 32-char minimum.
  for (const badSecret of ["", "tiny", "x".repeat(31)]) {
    const env = { JWT_SECRET: badSecret, SESSIONS: makeKV(), COOKIE_NAME: "algosize_session" };
    let threw = false;
    try { await issueJWT(env, "u", "e@x", "active"); } catch { threw = true; }
    if (!threw) { fail(`issueJWT accepted weak secret of length ${badSecret.length}`); break; }

    threw = false;
    try { await requireAuth(new Request("http://x"), env); } catch { threw = true; }
    if (!threw) { fail(`requireAuth accepted weak secret of length ${badSecret.length}`); break; }
  }
  ok("issueJWT and requireAuth refuse JWT_SECRET shorter than 32 chars");
}

console.log();
if (failures === 0) {
  console.log("\x1b[32mAll JWT tests passed.\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m${failures} test(s) failed.\x1b[0m\n`);
  process.exit(1);
}
