// Tests for the per-IP rate-limit middleware (Task #21).
//
// Covers:
//   1. The first N requests in a window pass (status undefined → next).
//   2. The (N+1)-th request returns 429 with Retry-After header and the
//      JSON body shape `{error:"rate_limited", retryAfterSec}`.
//   3. The counter resets when the window rolls over (different minute
//      key) — the next request is allowed again.
//   4. Different IPs are independent — IP-A hitting its limit does not
//      block IP-B.
//   5. Different endpoint keys are independent — checkout limit does not
//      eat into the analyze quota.
//   6. Missing CF-Connecting-IP falls back to X-Forwarded-For, then to
//      "unknown" (so spoofers can't get a per-request fresh bucket).
//   7. The KV row is written with a 2-window TTL.
//   8. SESSIONS binding missing → fails open (no 500 storm).
//   9. Retry-After header value matches the JSON body's retryAfterSec.
//
// Run with:  node scripts/test-rate-limit.mjs

import { makeRateLimit, clientIp } from "../src/middleware/rate-limit.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

// In-memory KV stub that records put options + write counts (mirrors the
// helper used in test-webhook-idempotency.mjs).
function makeKV() {
  const store  = new Map();
  const opts   = new Map();
  const writes = new Map();
  return {
    async get(key)              { return store.has(key) ? store.get(key) : null; },
    async put(key, val, o = {}) {
      store.set(key, val);
      opts.set(key, o);
      writes.set(key, (writes.get(key) || 0) + 1);
    },
    async delete(key)           { store.delete(key); opts.delete(key); writes.delete(key); },
    _store: store,
    _opts:  opts,
    _writes: writes,
  };
}

const makeEnv = (overrides = {}) => ({ SESSIONS: makeKV(), ...overrides });

// Build a request with a chosen CF-Connecting-IP (and optional XFF).
function reqWithIp(ip, { xff, path = "/api/checkout" } = {}) {
  const headers = {};
  if (ip)  headers["CF-Connecting-IP"] = ip;
  if (xff) headers["X-Forwarded-For"]  = xff;
  return new Request(`http://x${path}`, { method: "POST", headers });
}

// Fixed clock so tests don't depend on wall time. Returns ms since epoch.
const t0 = 1_700_000_000_000;
const clock = (offsetSec = 0) => () => t0 + offsetSec * 1000;

// ---------------------------------------------------------------------------
console.log("\nrate-limit — clientIp resolution\n");
// ---------------------------------------------------------------------------
{
  expect(clientIp(reqWithIp("9.9.9.9")) === "9.9.9.9",
    "CF-Connecting-IP wins when present");
  expect(clientIp(reqWithIp(null, { xff: "8.8.8.8, 1.1.1.1" })) === "8.8.8.8",
    "X-Forwarded-For first hop is used when CF-Connecting-IP is absent");
  expect(clientIp(reqWithIp(null)) === "unknown",
    'falls back to "unknown" when both headers are absent (so spoofers share one bucket)');
}

// ---------------------------------------------------------------------------
console.log("\nrate-limit — first N pass, (N+1) gets 429\n");
// ---------------------------------------------------------------------------
{
  const env = makeEnv();
  const limiter = makeRateLimit({ keyName: "checkout", limit: 10, windowSec: 60, now: clock(0) });

  // First 10 calls: middleware returns undefined (proceed).
  let allowed = 0;
  for (let i = 0; i < 10; i++) {
    const res = await limiter(reqWithIp("1.2.3.4"), env);
    if (res === undefined) allowed++;
  }
  expect(allowed === 10, "first 10 requests within the window are allowed");

  // 11th call must 429.
  const blocked = await limiter(reqWithIp("1.2.3.4"), env);
  expect(blocked instanceof Response && blocked.status === 429,
    "11th request in the same minute returns 429");

  const body = await blocked.json();
  expect(body.error === "rate_limited",
    'body has error: "rate_limited"');
  expect(typeof body.retryAfterSec === "number" && body.retryAfterSec > 0 && body.retryAfterSec <= 60,
    `body has retryAfterSec in (0, 60]; got ${body.retryAfterSec}`);

  const ra = blocked.headers.get("Retry-After");
  expect(ra === String(body.retryAfterSec),
    `Retry-After header (${ra}) matches body.retryAfterSec (${body.retryAfterSec})`);
}

// ---------------------------------------------------------------------------
console.log("\nrate-limit — window rollover resets the counter\n");
// ---------------------------------------------------------------------------
{
  const env = makeEnv();
  // Build two limiters that share the same env+key but advance the clock.
  const inWindowA = makeRateLimit({ keyName: "checkout", limit: 2, windowSec: 60, now: clock(0)  });
  const inWindowB = makeRateLimit({ keyName: "checkout", limit: 2, windowSec: 60, now: clock(60) });  // +1min

  // Window A: exhaust the limit.
  await inWindowA(reqWithIp("5.5.5.5"), env);
  await inWindowA(reqWithIp("5.5.5.5"), env);
  const blockedA = await inWindowA(reqWithIp("5.5.5.5"), env);
  expect(blockedA?.status === 429, "limit reached in window A → 429");

  // Window B (next minute): the same IP gets a fresh bucket.
  const allowedB = await inWindowB(reqWithIp("5.5.5.5"), env);
  expect(allowedB === undefined,
    "after the minute rolls over, the same IP is allowed again");
}

// ---------------------------------------------------------------------------
console.log("\nrate-limit — independence between IPs and endpoints\n");
// ---------------------------------------------------------------------------
{
  const env = makeEnv();
  const limiter = makeRateLimit({ keyName: "checkout", limit: 3, windowSec: 60, now: clock(0) });

  // IP-A burns its quota.
  for (let i = 0; i < 3; i++) await limiter(reqWithIp("10.0.0.1"), env);
  const blockedA = await limiter(reqWithIp("10.0.0.1"), env);
  expect(blockedA?.status === 429, "IP-A is rate-limited at its own threshold");

  // IP-B is unaffected.
  const allowedB = await limiter(reqWithIp("10.0.0.2"), env);
  expect(allowedB === undefined, "IP-B in the same window is NOT blocked by IP-A's traffic");
}

{
  const env = makeEnv();
  const checkoutLimit = makeRateLimit({ keyName: "checkout", limit: 2, windowSec: 60, now: clock(0) });
  const analyzeLimit  = makeRateLimit({ keyName: "analyze",  limit: 5, windowSec: 60, now: clock(0) });

  // Burn the checkout bucket for one IP.
  await checkoutLimit(reqWithIp("7.7.7.7"), env);
  await checkoutLimit(reqWithIp("7.7.7.7"), env);
  const checkoutBlocked = await checkoutLimit(reqWithIp("7.7.7.7"), env);
  expect(checkoutBlocked?.status === 429, "checkout bucket is exhausted at its own limit");

  // Analyzer bucket for the SAME IP is untouched.
  const analyzeAllowed = await analyzeLimit(reqWithIp("7.7.7.7"), env);
  expect(analyzeAllowed === undefined,
    "analyze bucket for the same IP is independent of the checkout bucket");
}

// ---------------------------------------------------------------------------
console.log("\nrate-limit — KV write hygiene\n");
// ---------------------------------------------------------------------------
{
  const env = makeEnv();
  const limiter = makeRateLimit({ keyName: "checkout", limit: 10, windowSec: 60, now: clock(0) });

  await limiter(reqWithIp("4.4.4.4"), env);
  // Find the rl:* key we just wrote.
  const keys = [...env.SESSIONS._store.keys()].filter(k => k.startsWith("rl:4.4.4.4:checkout:"));
  expect(keys.length === 1, "exactly one counter row written for that IP/endpoint/window");

  const opts = env.SESSIONS._opts.get(keys[0]);
  expect(opts?.expirationTtl === 120,
    "counter TTL is 2 windows (120s for a 60s window)");
  expect(env.SESSIONS._store.get(keys[0]) === "1",
    'counter starts at "1" after the first request');

  // Second request must update the SAME key (same IP/endpoint/window) to "2".
  await limiter(reqWithIp("4.4.4.4"), env);
  expect(env.SESSIONS._store.get(keys[0]) === "2",
    "counter increments to 2 on the second request in the same window");
  expect(env.SESSIONS._writes.get(keys[0]) === 2,
    "exactly two writes against the same counter key (no key sprawl per request)");
}

// ---------------------------------------------------------------------------
console.log("\nrate-limit — fail-open on missing binding\n");
// ---------------------------------------------------------------------------
{
  // Silence the expected console.warn for this case.
  const realWarn = console.warn;
  let warned = false;
  console.warn = (...args) => { warned = true; };
  try {
    const limiter = makeRateLimit({ keyName: "checkout", limit: 10, windowSec: 60, now: clock(0) });
    const res = await limiter(reqWithIp("3.3.3.3"), {});  // no SESSIONS binding
    expect(res === undefined,
      "missing SESSIONS binding fails open (returns undefined → request proceeds)");
    expect(warned, "missing SESSIONS binding logs a warning");
  } finally {
    console.warn = realWarn;
  }
}

// ---------------------------------------------------------------------------
console.log("\nrate-limit — input validation\n");
// ---------------------------------------------------------------------------
{
  let threw = false;
  try { makeRateLimit({ keyName: "", limit: 10 }); } catch (e) { threw = true; }
  expect(threw, "empty keyName throws (developer error caught at boot)");

  threw = false;
  try { makeRateLimit({ keyName: "x", limit: 0 }); } catch (e) { threw = true; }
  expect(threw, "limit < 1 throws");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all rate-limit tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} rate-limit test(s) failed\x1b[0m\n`);
  process.exit(1);
}
