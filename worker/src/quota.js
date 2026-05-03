// Per-user monthly analyzer quota (Task #19).
//
// Free-tier users get 5 analyzer runs per calendar month, shared across
// the three analyzers (cost / vuln / algo). Paid users bypass entirely.
//
// Storage: USERS KV under `quota:<userId>:<YYYY-MM>` with a 35-day TTL.
//   - 35 days, not 31, so the row outlives the longest possible month
//     (31 days) plus a few days of slack — a counter that's still being
//     read on the 1st of the next month must not 404.
//   - One key per user per month → reading the current count is a single
//     KV.get; reset on the calendar boundary is automatic (the next month
//     just doesn't have a key yet).
//   - Counters live in USERS KV (not a new binding) per the task spec.
//
// We deliberately count successful analyzer responses only — validation
// errors, sandbox crashes, and quota-exceeded responses do NOT decrement
// the user's free runs. The wrapper (`enforceQuota`) below increments via
// `ctx.waitUntil` AFTER seeing a 200 from the inner handler.

const FREE_MONTHLY_LIMIT = 5;
const QUOTA_TTL_SECONDS  = 60 * 60 * 24 * 35;  // 35 days — see comment above

import { getUserById } from "./handlers/_users.js";

// ---------------------------------------------------------------------------
// Pure helpers — no KV access. Exported for tests.
// ---------------------------------------------------------------------------

/** UTC YYYY-MM key for the given Date (defaults to now). */
export function currentMonthKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function quotaKey(userId, now = new Date()) {
  return `quota:${userId}:${currentMonthKey(now)}`;
}

export { FREE_MONTHLY_LIMIT, QUOTA_TTL_SECONDS };

// ---------------------------------------------------------------------------
// KV read/write
// ---------------------------------------------------------------------------

/** Read the current month's run count for this user. Missing key → 0. */
export async function getMonthlyUsage(env, userId, now = new Date()) {
  const raw = await env.USERS.get(quotaKey(userId, now));
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Increment the user's month counter by 1 and return the new value.
 *
 * KV is eventually consistent and has no atomic increment, so two requests
 * landing in the same millisecond can both read N and both write N+1 — i.e.
 * we may under-count by one in a true race. That's acceptable for a free
 * quota: it errs in the user's favor (they get one extra free run) and
 * never errs against them. A strict atomic counter would require D1 (see
 * follow-up Task #25).
 */
export async function incrementMonthlyUsage(env, userId, now = new Date()) {
  const key  = quotaKey(userId, now);
  const next = (await getMonthlyUsage(env, userId, now)) + 1;
  await env.USERS.put(key, String(next), { expirationTtl: QUOTA_TTL_SECONDS });
  return next;
}

// ---------------------------------------------------------------------------
// Handler wrapper — bolts the quota check + increment around any handler.
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Wrap an authenticated analyzer handler with quota enforcement.
 *
 * Behavior, given `request.user.userId` from `requireAuth`:
 *   1. Load the user row from USERS KV.
 *   2. If `plan === "paid"` → call the handler unchanged (paid users skip
 *      quota and never increment the counter).
 *   3. If `plan === "free"`:
 *      a. Read the current month's count. If >= 5 → return 402
 *         `{ error: "quota_exceeded", monthlyRunsUsed, monthlyRunsLimit,
 *            upgradeUrl }` WITHOUT calling the handler.
 *      b. Otherwise call the handler. If it returns 200, queue an
 *         increment via ctx.waitUntil (non-blocking — the response goes
 *         out immediately, the KV write happens in the background).
 *
 * Increment-on-success means a validation error (400) or sandbox crash
 * (500) doesn't burn the user's free quota — they only "spend" a run when
 * they actually got a successful analysis back.
 *
 * `now` is injectable for tests that need to assert month-boundary
 * behavior without time-travelling the system clock.
 */
export function enforceQuota(handler, { now } = {}) {
  return async function quotaWrappedHandler(request, env, ctx) {
    const sessionUser = request.user || {};
    if (!sessionUser.userId) {
      // requireAuth would have caught this — defensive only.
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const user = await getUserById(env, sessionUser.userId);
    // Missing user row under a valid session is unusual but defensible —
    // treat as paid so we don't lock the user out (their session JWT is
    // valid). The webhook is the source of truth for plan downgrades.
    const plan = (user && user.plan) || "paid";

    if (plan === "paid") {
      return handler(request, env, ctx);
    }

    // Free tier — gate on the month counter.
    const ts   = now ? (typeof now === "function" ? now() : now) : new Date();
    const used = await getMonthlyUsage(env, sessionUser.userId, ts);
    if (used >= FREE_MONTHLY_LIMIT) {
      return jsonResponse(
        {
          error:             "quota_exceeded",
          message:           `You've used all ${FREE_MONTHLY_LIMIT} free analyses this month. Upgrade to Pro for unlimited runs.`,
          monthlyRunsUsed:   used,
          monthlyRunsLimit:  FREE_MONTHLY_LIMIT,
          upgradeUrl:        `${env.SITE_ORIGIN || ""}/#pricing`,
        },
        402,
      );
    }

    const response = await handler(request, env, ctx);
    if (response && response.status === 200) {
      // Fire-and-forget increment. ctx.waitUntil keeps the worker alive
      // until the KV write completes even though we've already returned
      // the response. In single-Worker dev mode (no ctx) we still await
      // so the test suite sees the new count.
      const work = incrementMonthlyUsage(env, sessionUser.userId, ts);
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(work);
      } else {
        await work;
      }
    }
    return response;
  };
}
