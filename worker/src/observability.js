// Error tracking + structured logs (Task #22).
//
// Two channels for every error event:
//
//   1. Structured JSON to console (always on). `wrangler tail` and any
//      log aggregator that ingests stdout will pick it up. This is the
//      free, can't-fail tier — even a misconfigured Worker still logs.
//
//   2. Optional POST to a Sentry project envelope endpoint when
//      env.SENTRY_DSN is set. Sentry's free Developer plan currently
//      includes 5,000 errors/month — adequate for sub-1k DAU. If we
//      ever push past that, follow-up #41 adds per-fingerprint
//      sampling for upstream-outage spikes (e.g. OSV being down for
//      30 minutes), and Axiom is a viable swap target since the
//      captureException signature hides the transport.
//
// We intentionally don't pull in the @sentry/cloudflare SDK:
//   - it adds ~30 KB to the Worker bundle (we're competing for
//     Cloudflare's 1 MB compressed Worker size limit alongside acorn
//     for the algo sandbox);
//   - the public envelope HTTP API is stable and only ~50 lines of
//     code to call directly;
//   - testing a hand-rolled module against `globalThis.fetch` is
//     mechanically simpler than mocking an SDK's internals.
//
// Caller contract: pass `ctx` so the network round-trip rides on
// `ctx.waitUntil` and never blocks the user-facing response. If `ctx`
// is missing we fall through to a fire-and-forget promise — observable
// but not awaited.

// ---------------------------------------------------------------------------
// DSN parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Sentry DSN of the form:
 *
 *   https://<publicKey>@<host>/<projectId>
 *   https://<publicKey>@<host>:<port>/<path>/<projectId>
 *
 * Returns null on anything that doesn't look like a DSN — all callers
 * treat null as "Sentry disabled" rather than throwing, so a bad DSN
 * doesn't take down the Worker.
 */
export function parseDsn(dsn) {
  if (!dsn || typeof dsn !== "string") return null;
  let u;
  try { u = new URL(dsn); } catch { return null; }
  if (!u.username) return null;
  // The project id is the last non-empty path segment.
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const projectId = segments[segments.length - 1];
  if (!/^\d+$/.test(projectId)) return null;
  // Everything before the project id is part of the path (Sentry on a
  // sub-path proxy). Almost always empty.
  const basePath = segments.slice(0, -1).join("/");
  return {
    publicKey: u.username,
    host:      u.host,                  // includes :port if present
    projectId,
    protocol:  u.protocol.replace(":", ""),
    basePath,
  };
}

function envelopeUrl(parsed) {
  const path = parsed.basePath
    ? `/${parsed.basePath}/api/${parsed.projectId}/envelope/`
    : `/api/${parsed.projectId}/envelope/`;
  return `${parsed.protocol}://${parsed.host}${path}`;
}

function sentryAuthHeader(parsed) {
  // Sentry-Auth header format per
  // https://develop.sentry.dev/sdk/overview/#authentication
  return [
    "Sentry sentry_version=7",
    "sentry_client=algosize-worker/1.0",
    `sentry_key=${parsed.publicKey}`,
  ].join(", ");
}

// ---------------------------------------------------------------------------
// Stack trace parsing
// ---------------------------------------------------------------------------

// Workers V8 stacks look like:
//   "    at functionName (file.js:10:5)"
//   "    at file.js:10:5"
//   "    at async functionName (file.js:10:5)"
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?([^()]+?):(\d+):(\d+)\)?$/;

function parseStackFrames(stack) {
  if (typeof stack !== "string") return [];
  const lines  = stack.split("\n");
  const frames = [];
  for (const line of lines) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    let fn = m[1] ? m[1].replace(/^async\s+/, "") : "<anonymous>";
    frames.push({
      function: fn,
      filename: m[2],
      lineno:   parseInt(m[3], 10),
      colno:    parseInt(m[4], 10),
      in_app:   !m[2].includes("node_modules"),
    });
  }
  // Sentry expects the call site closest to the throw LAST (chronological).
  return frames.reverse();
}

// ---------------------------------------------------------------------------
// Event builder
// ---------------------------------------------------------------------------

function eventId() {
  // Sentry requires a 32-char lowercase hex event id (UUID without dashes).
  return crypto.randomUUID().replace(/-/g, "");
}

function safeRelease(env) {
  return (env && (env.RELEASE_TAG || env.RELEASE)) || "unreleased";
}

function safeRequestContext(request) {
  if (!request) return undefined;
  try {
    const u = new URL(request.url);
    return {
      url:    `${u.origin}${u.pathname}`,    // no querystring (PII safety)
      method: request.method,
      headers: {
        // Just the small set of headers that help triage (NEVER cookies / auth).
        "user-agent":         request.headers.get("user-agent") || undefined,
        "cf-connecting-ip":   request.headers.get("cf-connecting-ip") || undefined,
        "cf-ray":             request.headers.get("cf-ray") || undefined,
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Build a Sentry-compatible event payload. Exposed for tests.
 *
 * @param {object} params
 * @param {Error?}   params.error    — the thrown Error (preferred over message)
 * @param {string?}  params.message  — message-only event (no exception)
 * @param {"error"|"warning"|"info"|"fatal"} params.level
 * @param {Request?} params.request  — incoming Request, for context
 * @param {string?}  params.userId   — authenticated user id, if any
 * @param {string?}  params.eventIdOverride — for deterministic test output
 * @param {object?}  params.tags     — flat string tags (e.g. {endpoint:"webhook"})
 * @param {object?}  params.extra    — anything else worth grepping for
 * @param {object}   params.env      — Worker env, for RELEASE_TAG etc.
 */
export function buildEvent({
  error, message, level = "error", request, userId,
  eventIdOverride, tags, extra, env = {},
}) {
  const ev = {
    event_id:  eventIdOverride || eventId(),
    timestamp: Date.now() / 1000,
    platform:  "javascript",
    level,
    release:   safeRelease(env),
    server_name: "algosize-worker",
    environment: env && env.ENVIRONMENT_NAME || "production",
    tags: { runtime: "cloudflare-workers", ...(tags || {}) },
    extra: { ...(extra || {}) },
  };

  if (error && (error.message || error.stack)) {
    const frames = parseStackFrames(error.stack || "");
    ev.exception = {
      values: [{
        type:  error.name || "Error",
        value: String(error.message || ""),
        stacktrace: frames.length ? { frames } : undefined,
      }],
    };
    // Always keep the raw stack too — helps when frame parsing misses
    // something (e.g. an exotic stack format) and is grep-friendly.
    if (error.stack) ev.extra.stack = String(error.stack);
  } else if (message) {
    ev.message = { formatted: String(message) };
  } else {
    ev.message = { formatted: "(no message)" };
  }

  const reqCtx = safeRequestContext(request);
  if (reqCtx) ev.request = reqCtx;

  if (userId) ev.user = { id: String(userId) };

  return ev;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function envelopeBody(event, parsed) {
  const envelopeHeader = JSON.stringify({
    event_id: event.event_id,
    sent_at:  new Date().toISOString(),
    dsn:      `${parsed.protocol}://${parsed.publicKey}@${parsed.host}/${parsed.projectId}`,
  });
  const itemHeader = JSON.stringify({ type: "event" });
  const itemBody   = JSON.stringify(event);
  return `${envelopeHeader}\n${itemHeader}\n${itemBody}\n`;
}

async function postToSentry(event, parsed, fetchImpl) {
  // Fire-and-forget: never throw upward. We log a one-liner on failure
  // (don't recurse into captureException — that would loop on Sentry
  // outage).
  try {
    const res = await fetchImpl(envelopeUrl(parsed), {
      method: "POST",
      headers: {
        "content-type":   "application/x-sentry-envelope",
        "X-Sentry-Auth":  sentryAuthHeader(parsed),
      },
      body: envelopeBody(event, parsed),
    });
    if (!res.ok) {
      console.warn("observability: sentry rejected event", {
        status: res.status, eventId: event.event_id,
      });
    }
  } catch (err) {
    console.warn("observability: sentry POST failed", {
      message: err && err.message, eventId: event.event_id,
    });
  }
}

// Always emit a structured JSON log line. Goes to stdout via console.log
// (level "warning"/"info") or stderr via console.error (level "error"/
// "fatal"). `wrangler tail --format pretty` shows them nicely; any
// log shipper can JSON-parse them.
function emitStructuredLog(event) {
  const flat = {
    msg:       event.exception
                 ? `${event.exception.values[0].type}: ${event.exception.values[0].value}`
                 : (event.message && event.message.formatted) || "(no message)",
    level:     event.level,
    eventId:   event.event_id,
    release:   event.release,
    userId:    event.user && event.user.id,
    url:       event.request && event.request.url,
    method:    event.request && event.request.method,
    tags:      event.tags,
    extra:     event.extra,
  };
  const line = JSON.stringify(flat);
  if (event.level === "error" || event.level === "fatal") console.error(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture an exception. ALWAYS structured-logs to console; ALSO posts
 * to Sentry if env.SENTRY_DSN is set. Network IO is queued onto
 * `ctx.waitUntil` so it never delays the response the user sees.
 *
 * Safe to await OR fire-and-forget — never throws. (If it threw it
 * would be the most ironic possible bug.)
 */
export async function captureException(env, ctx, error, context = {}) {
  try {
    const event = buildEvent({
      error,
      level:   context.level || "error",
      request: context.request,
      userId:  context.userId,
      tags:    context.tags,
      extra:   context.extra,
      env,
    });
    emitStructuredLog(event);

    const dsn = env && env.SENTRY_DSN;
    if (!dsn) return;
    const parsed = parseDsn(dsn);
    if (!parsed) {
      console.warn("observability: SENTRY_DSN is set but unparseable; skipping");
      return;
    }
    const fetchImpl = (env && env.FETCH) || globalThis.fetch;
    const promise = postToSentry(event, parsed, fetchImpl);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(promise);
    } else {
      // No ctx — let it run unawaited. This path mostly hits in tests.
      void promise;
    }
  } catch (err) {
    // Last-resort: never let observability take down a real handler.
    console.error("observability: captureException itself threw", err);
  }
}

/**
 * Capture a message-only event (no Error). Use for "expected but
 * notable" things like webhook signature failures, where there's no
 * stack trace but we still want a triage entry.
 */
export async function captureMessage(env, ctx, message, context = {}) {
  try {
    const event = buildEvent({
      message,
      level:   context.level || "warning",
      request: context.request,
      userId:  context.userId,
      tags:    context.tags,
      extra:   context.extra,
      env,
    });
    emitStructuredLog(event);

    const dsn = env && env.SENTRY_DSN;
    if (!dsn) return;
    const parsed = parseDsn(dsn);
    if (!parsed) {
      // Same operator-visibility behavior as captureException: an
      // unparseable DSN is a deploy-time mistake worth surfacing in
      // logs, even on the message path.
      console.warn("observability: SENTRY_DSN is set but unparseable; skipping");
      return;
    }
    const fetchImpl = (env && env.FETCH) || globalThis.fetch;
    const promise = postToSentry(event, parsed, fetchImpl);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(promise);
    else void promise;
  } catch (err) {
    console.error("observability: captureMessage itself threw", err);
  }
}
