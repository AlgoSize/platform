// Tests for the noscript-pageview pixel forwarder (Task #26).
//
// Covers:
//   1. Returns a 1x1 image/gif on success.
//   2. Forwards a POST to PLAUSIBLE_ENDPOINT with name=pageview + body.
//   3. Carries CF-Connecting-IP through as X-Forwarded-For so Plausible's
//      daily-unique hash uses the real visitor.
//   4. Carries User-Agent through.
//   5. Domain mismatch → still returns the pixel but does NOT call upstream
//      (stops abuse as a relay).
//   6. Missing query params → still returns pixel, no upstream call.
//   7. Upstream throwing does not break the response.
//   8. Cache-Control: no-store on the response.
//
// Run with:  node scripts/test-pageview.mjs

import { pageviewPixelHandler } from "../src/handlers/pageview.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

function captureFetch({ throwErr = false } = {}) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (throwErr) throw new Error("upstream-down");
    return new Response("", { status: 202 });
  };
  return {
    calls,
    restore() { globalThis.fetch = orig; },
  };
}

function makeCtx() {
  const waited = [];
  return {
    waitUntil(p) { waited.push(p); },
    _waited: waited,
  };
}

function reqFor({ d = "algosize.com", u = "https://algosize.com/", ip = "203.0.113.4", ua = "Mozilla/5.0 (no-js)" } = {}) {
  const url = new URL("https://worker/api/pageview");
  if (d) url.searchParams.set("d", d);
  if (u) url.searchParams.set("u", u);
  const headers = {};
  if (ip) headers["CF-Connecting-IP"] = ip;
  if (ua) headers["User-Agent"] = ua;
  return new Request(url, { method: "GET", headers });
}

const env = { ANALYTICS_DOMAIN: "algosize.com", PLAUSIBLE_ENDPOINT: "https://plausible.io" };

// ----------------------------------------------------------------------------
console.log("\nhandler — happy path forwards to Plausible");
{
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  const res = await pageviewPixelHandler(reqFor(), env, ctx);
  expect(res.status === 200, "returns 200");
  expect(res.headers.get("content-type") === "image/gif", "content-type is image/gif");
  expect(/no-store/.test(res.headers.get("cache-control") || ""), "cache-control: no-store");
  // ctx.waitUntil queued the upstream
  expect(ctx._waited.length === 1, "upstream POST queued via waitUntil");
  // Settle the queued promise so calls[] populates
  await Promise.allSettled(ctx._waited);
  expect(fetchMock.calls.length === 1, "exactly one upstream POST");
  const call = fetchMock.calls[0];
  expect(call.url === "https://plausible.io/api/event", "POSTs to /api/event");
  expect(call.init.method === "POST", "method is POST");
  const body = JSON.parse(call.init.body);
  expect(body.name === "pageview", "body.name=pageview");
  expect(body.domain === "algosize.com", "body.domain matches");
  expect(body.url === "https://algosize.com/", "body.url is the page URL");
  expect(call.init.headers["x-forwarded-for"] === "203.0.113.4", "forwards CF-Connecting-IP as XFF");
  expect(call.init.headers["user-agent"] === "Mozilla/5.0 (no-js)", "forwards User-Agent");
  fetchMock.restore();
}

// ----------------------------------------------------------------------------
console.log("\nhandler — domain mismatch is silently dropped (no relay abuse)");
{
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  const res = await pageviewPixelHandler(reqFor({ d: "evil.example.com" }), env, ctx);
  expect(res.status === 200, "still returns 200 (pixel always renders)");
  expect(res.headers.get("content-type") === "image/gif", "still image/gif");
  expect(ctx._waited.length === 0, "NO upstream POST queued");
  expect(fetchMock.calls.length === 0, "fetch was not called");
  fetchMock.restore();
}

// ----------------------------------------------------------------------------
console.log("\nhandler — missing query params");
{
  const fetchMock = captureFetch();
  const ctx = makeCtx();
  const url = new URL("https://worker/api/pageview");  // no ?d= or ?u=
  const res = await pageviewPixelHandler(new Request(url), env, ctx);
  expect(res.status === 200, "returns 200");
  expect(fetchMock.calls.length === 0, "no upstream call without params");
  fetchMock.restore();
}

// ----------------------------------------------------------------------------
console.log("\nhandler — upstream throw never breaks the pixel");
{
  const fetchMock = captureFetch({ throwErr: true });
  const ctx = makeCtx();
  const res = await pageviewPixelHandler(reqFor(), env, ctx);
  expect(res.status === 200, "still returns 200 on upstream failure");
  expect(res.headers.get("content-type") === "image/gif", "still image/gif");
  // settle queued
  await Promise.allSettled(ctx._waited);
  fetchMock.restore();
}

// ----------------------------------------------------------------------------
console.log("\nhandler — body bytes are a real GIF89a header");
{
  const fetchMock = captureFetch();
  const res = await pageviewPixelHandler(reqFor(), env, makeCtx());
  const buf = new Uint8Array(await res.arrayBuffer());
  // GIF89a magic: 47 49 46 38 39 61
  expect(
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 &&
    buf[3] === 0x38 && buf[4] === 0x39 && buf[5] === 0x61,
    "response body is a GIF89a image",
  );
  fetchMock.restore();
}

if (failures) {
  console.log(`\n  \x1b[31m${failures} pageview test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\n  all pageview-pixel tests passed");
