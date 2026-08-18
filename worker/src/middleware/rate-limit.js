// Per-IP rate limiting middleware (Task #21).
//
// Why: the public-facing endpoints — /api/checkout, /api/signup, the three
// /api/analyze/* analyzers — have no other gate against a bot hammering us.
// /api/checkout would create thousands of empty Stripe customer objects;
// the analyzers would burn Worker CPU billing. Quotas (Task #19) protect
// the *authenticated* path, but the unauthenticated path needs an IP-level
// brake.
//
// How: per-IP, per-endpoint, per-minute counter in the existing SESSIONS KV
// namespace under keys `rl:<ip>:<endpoint>:<minute>` with a 2-minute TTL
// (one full window of slack so a counter being read on the boundary never
// 404s). Over-limit requests get HTTP 429 with a `Retry-After` header and
// a JSON body of `{error:"rate_limited", retryAfterSec}`.
//
// Caveat: KV is non-atomic — a true read-then-write race under burst can
// let extra requests through (under-counts). For pure abuse mitigation that
// is an acceptable trade: the goal is "stop the flood", not "exact 10/min".
//
// But do not read that as "the overshoot is small". Concurrent requests all
// read the same count and all write count+1, so a burst of N advances the
// counter by 1, and the limit binds only against traffic that arrives
// sequentially. Note also what this does NOT back up: src/quota.js has the
// same non-atomicity in its free-tier counter, and its header comment names
// this limiter as the remaining brake. It is a weak one for that purpose —
// per-IP rather than per-account, and racy itself. Neither layer should be
// cited as making the other safe. See the KNOWN GAP notes in src/quota.js.
//
// Itty-router middleware contract: returning a Response short-circuits the
// chain; returning undefined lets the next handler run.

/** Look up the caller's IP. Cloudflare populates CF-Connecting-IP for every
 *  request that reaches a Worker; in local/dev we fall back to X-Forwarded-For
 *  and finally a sentinel so the limiter still functions (and so a bot
 *  spoofing-blanking the header doesn't get a free pass — they all share
 *  the "unknown" bucket). */
export function clientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf;
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

/**
 * Build a rate-limit middleware bound to a specific endpoint key + limit.
 *
 *   const checkoutLimit = makeRateLimit({
 *     keyName: "checkout", limit: 10, windowSec: 60,
 *   });
 *   router.post("/api/checkout", checkoutLimit, checkoutHandler);
 *
 * `keyName` namespaces the counter so /api/checkout traffic and
 * /api/analyze/* traffic don't share a bucket.
 *
 * Optional `now` lets tests inject a fixed clock without mocking Date.now.
 *
 * `identity(request)` overrides what the counter is keyed on — default is
 * `clientIp(request)`. Task #P-4 needs API-key traffic limited per org
 * rather than per IP (a key used from many CI runners, or many IPs behind
 * one NAT, is one customer either way — and per-IP limiting would either
 * miss a single leaked key spread across sources, or wrongly throttle
 * unrelated customers sharing an egress IP). Returning a falsy identity
 * skips limiting entirely for that request — see makeApiKeyRateLimit below,
 * which uses this to become a no-op for non-API-key traffic rather than
 * limiting it on an identity that doesn't apply.
 */
export function makeRateLimit({ keyName, limit, windowSec = 60, now, identity }) {
  if (!keyName) throw new Error("makeRateLimit: keyName is required");
  if (!limit || limit < 1) throw new Error("makeRateLimit: limit must be >= 1");
  const identityOf = identity || clientIp;

  return async function rateLimitMiddleware(request, env) {
    // SESSIONS is the existing KV binding — re-using it instead of
    // provisioning a dedicated RATELIMIT namespace keeps DEPLOY.md simple.
    if (!env || !env.SESSIONS) {
      // Fail open in the bizarre case where the binding is missing rather
      // than 500ing every public request — limiting is best-effort.
      console.warn("rate-limit: SESSIONS binding missing; failing open");
      return undefined;
    }

    const id = identityOf(request);
    if (!id) return undefined;   // nothing to key this request on — not limited here

    const nowSec      = Math.floor((typeof now === "function" ? now() : Date.now()) / 1000);
    const windowIndex = Math.floor(nowSec / windowSec);
    const key         = `rl:${id}:${keyName}:${windowIndex}`;

    const raw     = await env.SESSIONS.get(key);
    const current = raw ? parseInt(raw, 10) || 0 : 0;

    if (current >= limit) {
      // How long until this window rolls over.
      const retryAfterSec = (windowIndex + 1) * windowSec - nowSec;
      return new Response(
        JSON.stringify({ error: "rate_limited", retryAfterSec }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "Retry-After":  String(retryAfterSec),
          },
        },
      );
    }

    // Increment. 2-window TTL so counters being read at the boundary don't
    // 404 mid-flight. KV non-atomic — see file header.
    await env.SESSIONS.put(key, String(current + 1), {
      expirationTtl: windowSec * 2,
    });
    return undefined;   // proceed to next handler
  };
}

/**
 * A rate limiter scoped to API-key traffic only, keyed by org id rather than
 * IP (Task #P-4). Must run AFTER requireAuth in the middleware chain — it
 * reads `request.org`, which requireAuth is what attaches. For a cookie
 * session (no `request.org`) this is a no-op: that traffic is already
 * covered by the endpoint's own per-IP limiter earlier in the chain, plus
 * the free-tier monthly quota.
 */
export function makeApiKeyRateLimit({ keyName, limit, windowSec = 60, now }) {
  return makeRateLimit({
    keyName, limit, windowSec, now,
    identity: (request) => request.org && request.org.orgId ? `org:${request.org.orgId}` : null,
  });
}
