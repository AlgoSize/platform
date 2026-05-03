// Tests for the error-tracking / structured-logs module (Task #22).
//
// Run with:  node scripts/test-observability.mjs

import {
  parseDsn,
  buildEvent,
  captureException,
  captureMessage,
} from "../src/observability.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

// Mock fetch + waitUntil + console capture.
function makeFetchSpy(responseStatus = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: responseStatus < 400, status: responseStatus };
  };
  return { fetchImpl, calls };
}

function makeCtx() {
  const promises = [];
  return {
    waitUntil: (p) => promises.push(p),
    _promises: promises,
  };
}

function silenceConsole() {
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  const lines = [];
  console.log   = (...a) => lines.push({ ch: "log",   args: a });
  console.error = (...a) => lines.push({ ch: "error", args: a });
  console.warn  = (...a) => lines.push({ ch: "warn",  args: a });
  return {
    lines,
    restore() { console.log = origLog; console.error = origErr; console.warn = origWarn; },
  };
}

// ---------------------------------------------------------------------------
console.log("\nobservability — DSN parsing\n");
// ---------------------------------------------------------------------------
{
  const good = parseDsn("https://abc123@o12345.ingest.sentry.io/9876543");
  expect(good && good.publicKey === "abc123",   "extracts publicKey");
  expect(good && good.host === "o12345.ingest.sentry.io", "extracts host");
  expect(good && good.projectId === "9876543",  "extracts projectId");

  expect(parseDsn(null)               === null, "null DSN → null");
  expect(parseDsn("")                 === null, "empty string DSN → null");
  expect(parseDsn("not-a-url")        === null, "garbage DSN → null (does not throw)");
  expect(parseDsn("https://o.io/123") === null, "DSN missing publicKey → null");
  expect(parseDsn("https://k@o.io/")  === null, "DSN missing project id → null");
  expect(parseDsn("https://k@o.io/notanumber") === null, "DSN with non-numeric project id → null");
}

// ---------------------------------------------------------------------------
console.log("\nobservability — buildEvent shape\n");
// ---------------------------------------------------------------------------
{
  const err = new Error("kv put failed");
  err.name = "KVError";
  // Synthesize a stack so frame parsing has something to chew on.
  err.stack = `KVError: kv put failed
    at handleCheckoutCompleted (worker/src/handlers/webhook.js:142:11)
    at stripeWebhookHandler (worker/src/handlers/webhook.js:96:9)`;

  const req = new Request("https://algosize.com/api/stripe/webhook?sig=secret", {
    method: "POST",
    headers: {
      "user-agent":       "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
      "cf-connecting-ip": "192.0.2.1",
      "cookie":           "session=should-not-be-included",
    },
  });

  const ev = buildEvent({
    error:   err,
    request: req,
    userId:  "user_42",
    tags:    { endpoint: "stripe_webhook", stripe_event_id: "evt_123" },
    extra:   { rawBodyBytes: 4096 },
    env:     { RELEASE_TAG: "abc123def" },
  });

  expect(typeof ev.event_id === "string" && /^[0-9a-f]{32}$/.test(ev.event_id),
    `event_id is 32-char hex (got ${ev.event_id})`);
  expect(ev.platform === "javascript", "platform is 'javascript'");
  expect(ev.level === "error", "default level is 'error'");
  expect(ev.release === "abc123def", "release pulled from env.RELEASE_TAG");

  expect(ev.exception && ev.exception.values && ev.exception.values[0],
    "exception.values is populated for an Error");
  expect(ev.exception.values[0].type === "KVError", "exception type = error.name");
  expect(ev.exception.values[0].value === "kv put failed", "exception value = error.message");

  const frames = ev.exception.values[0].stacktrace.frames;
  expect(Array.isArray(frames) && frames.length === 2, "two stack frames parsed");
  // Most recent call last (Sentry convention) — the throw site is the LAST entry.
  const last = frames[frames.length - 1];
  expect(last.function === "handleCheckoutCompleted",
    `last frame's function is the throw site (got "${last.function}")`);
  expect(last.lineno === 142 && last.colno === 11,
    `last frame's line/col are correct (got ${last.lineno}:${last.colno})`);

  expect(ev.user && ev.user.id === "user_42", "userId surfaced as user.id");
  expect(ev.tags && ev.tags.stripe_event_id === "evt_123",
    "custom tags merged");
  expect(ev.tags.runtime === "cloudflare-workers",
    "default runtime tag is set even when caller passes other tags");

  expect(ev.request && ev.request.url === "https://algosize.com/api/stripe/webhook",
    "request.url stripped of querystring (PII safety)");
  expect(ev.request.method === "POST", "request.method preserved");
  expect(ev.request.headers["cf-connecting-ip"] === "192.0.2.1",
    "cf-connecting-ip header preserved for triage");
  expect(ev.request.headers.cookie === undefined,
    "cookie header NEVER sent to Sentry");
  expect(ev.request.headers.authorization === undefined,
    "authorization header NEVER sent to Sentry");

  expect(ev.extra.rawBodyBytes === 4096, "extra fields preserved");
  expect(typeof ev.extra.stack === "string" && ev.extra.stack.includes("KVError"),
    "raw stack string also included in extra (grep-friendly)");
}

{
  // Message-only event (no Error)
  const ev = buildEvent({
    message: "stripe signature mismatch",
    level:   "warning",
    env:     {},
  });
  expect(ev.message && ev.message.formatted === "stripe signature mismatch",
    "message-only event populates message.formatted");
  expect(ev.exception === undefined,
    "message-only event has no exception field");
  expect(ev.level === "warning", "explicit level is preserved");
  expect(ev.release === "unreleased",
    "release defaults to 'unreleased' when env.RELEASE_TAG missing");
}

// ---------------------------------------------------------------------------
console.log("\nobservability — captureException transport\n");
// ---------------------------------------------------------------------------
{
  const { fetchImpl, calls } = makeFetchSpy();
  const env = {
    SENTRY_DSN:   "https://pub@o1.ingest.sentry.io/4242",
    RELEASE_TAG:  "v1.0.3",
    FETCH:        fetchImpl,
  };
  const ctx = makeCtx();
  const cap = silenceConsole();
  try {
    await captureException(env, ctx, new Error("boom"), {
      tags: { endpoint: "analyze_cost" },
    });
  } finally {
    cap.restore();
  }

  // Wait for the queued waitUntil promise to settle so calls populate.
  await Promise.all(ctx._promises);

  expect(calls.length === 1, "exactly one POST sent to Sentry");
  expect(calls[0].url.includes("/api/4242/envelope/"),
    `POST URL targets the right project envelope endpoint (got ${calls[0].url})`);
  expect(calls[0].init.method === "POST", "POSTs to Sentry");
  expect(calls[0].init.headers["X-Sentry-Auth"].includes("sentry_key=pub"),
    "X-Sentry-Auth header includes the public key");
  expect(calls[0].init.headers["content-type"] === "application/x-sentry-envelope",
    "content-type is sentry envelope");

  // Envelope body is 3 newline-delimited JSON lines: header, item header, item.
  const lines = calls[0].init.body.trim().split("\n");
  expect(lines.length === 3, "envelope body has 3 lines (header + item header + item)");
  const item = JSON.parse(lines[2]);
  expect(item.exception.values[0].value === "boom", "envelope contains the error message");
  expect(item.tags.endpoint === "analyze_cost", "envelope contains custom tags");
  expect(item.release === "v1.0.3", "envelope contains release tag");

  // The structured log line was also emitted.
  const errLines = cap.lines.filter(l => l.ch === "error");
  expect(errLines.length === 1, "exactly one console.error line emitted");
  const parsed = JSON.parse(errLines[0].args[0]);
  expect(parsed.msg === "Error: boom", "console line has summary msg");
  expect(parsed.eventId === item.event_id,
    "console line eventId matches Sentry envelope eventId (operators can correlate)");
}

// ---------------------------------------------------------------------------
console.log("\nobservability — Sentry disabled when DSN missing\n");
// ---------------------------------------------------------------------------
{
  const { fetchImpl, calls } = makeFetchSpy();
  const env = { FETCH: fetchImpl };  // no SENTRY_DSN
  const ctx = makeCtx();
  const cap = silenceConsole();
  try {
    await captureException(env, ctx, new Error("no dsn"));
  } finally { cap.restore(); }
  await Promise.all(ctx._promises);

  expect(calls.length === 0,
    "no POST is sent when SENTRY_DSN is unset (free-tier-friendly)");
  expect(cap.lines.filter(l => l.ch === "error").length === 1,
    "structured console log is STILL emitted (the always-on tier)");
}

{
  // Bad DSN → don't post, don't throw, log a warning.
  const { fetchImpl, calls } = makeFetchSpy();
  const env = { SENTRY_DSN: "not-a-real-dsn", FETCH: fetchImpl };
  const ctx = makeCtx();
  const cap = silenceConsole();
  try {
    await captureException(env, ctx, new Error("bad dsn case"));
  } finally { cap.restore(); }
  await Promise.all(ctx._promises);

  expect(calls.length === 0, "unparseable DSN → no POST attempt");
  expect(cap.lines.some(l => l.ch === "warn" && l.args[0].includes("unparseable")),
    "unparseable DSN logs a warning so an operator notices");
}

// ---------------------------------------------------------------------------
console.log("\nobservability — Sentry outage does not break the handler\n");
// ---------------------------------------------------------------------------
{
  const env = {
    SENTRY_DSN: "https://pub@o1.ingest.sentry.io/4242",
    FETCH: async () => { throw new Error("network down"); },
  };
  const ctx = makeCtx();
  const cap = silenceConsole();
  let threw = false;
  try {
    await captureException(env, ctx, new Error("real error"));
  } catch { threw = true; }
  finally { cap.restore(); }
  await Promise.all(ctx._promises.map(p => p.catch(() => {})));

  expect(!threw, "captureException returns cleanly even when Sentry is unreachable");
  expect(cap.lines.some(l => l.ch === "warn" && l.args[0].includes("sentry POST failed")),
    "Sentry network failure is logged (warn) but not re-captured (no recursion loop)");
}

{
  // Sentry returning 5xx (rate-limited project, etc) — also doesn't throw.
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const env = { SENTRY_DSN: "https://pub@o1.ingest.sentry.io/4242", FETCH: fetchImpl };
  const ctx = makeCtx();
  const cap = silenceConsole();
  await captureException(env, ctx, new Error("rate-limited at sentry"));
  await Promise.all(ctx._promises);
  cap.restore();
  expect(cap.lines.some(l => l.ch === "warn" && l.args[0].includes("sentry rejected")),
    "Sentry 5xx response is surfaced as a warning, no throw");
}

// ---------------------------------------------------------------------------
console.log("\nobservability — captureMessage path\n");
// ---------------------------------------------------------------------------
{
  const { fetchImpl, calls } = makeFetchSpy();
  const env = { SENTRY_DSN: "https://pub@o1.ingest.sentry.io/4242", FETCH: fetchImpl };
  const ctx = makeCtx();
  const cap = silenceConsole();
  try {
    await captureMessage(env, ctx, "stripe signature mismatch", {
      level: "warning",
      tags:  { endpoint: "stripe_webhook", reason: "bad_sig" },
    });
  } finally { cap.restore(); }
  await Promise.all(ctx._promises);

  expect(calls.length === 1, "captureMessage POSTs to Sentry");
  const item = JSON.parse(calls[0].init.body.trim().split("\n")[2]);
  expect(item.message.formatted === "stripe signature mismatch",
    "envelope contains the message string");
  expect(item.level === "warning", "envelope reflects 'warning' level");
  expect(item.exception === undefined,
    "captureMessage events have no exception block");

  // Warnings hit console.log (stdout), not console.error (stderr).
  expect(cap.lines.some(l => l.ch === "log"),
    "warning-level events write to stdout (console.log), not stderr");
}

// ---------------------------------------------------------------------------
console.log("\nobservability — ctx.waitUntil is preferred over awaiting\n");
// ---------------------------------------------------------------------------
{
  // Make fetch hang; assert captureException returns immediately.
  let resolveFetch;
  const slowFetch = () => new Promise((r) => { resolveFetch = r; });
  const env = { SENTRY_DSN: "https://pub@o1.ingest.sentry.io/4242", FETCH: slowFetch };
  const ctx = makeCtx();
  const cap = silenceConsole();
  try {
    const t0 = Date.now();
    await captureException(env, ctx, new Error("don't block"));
    const elapsed = Date.now() - t0;
    expect(elapsed < 50,
      `captureException returns without awaiting the network (took ${elapsed}ms)`);
    expect(ctx._promises.length === 1,
      "the network promise is queued onto ctx.waitUntil");
  } finally {
    cap.restore();
    resolveFetch && resolveFetch({ ok: true, status: 200 });
  }
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all observability tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} observability test(s) failed\x1b[0m\n`);
  process.exit(1);
}
