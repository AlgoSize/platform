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

// Send the "1 free run left" warning email exactly once per user per month
// when their counter crosses to (limit - 1) — i.e. they have 1 run remaining.
// Threshold is expressed as a count, not a percentage, so the email copy in
// templates.js ("you have 1 run left") stays accurate as the limit changes.
const QUOTA_WARN_AT_RUNS = FREE_MONTHLY_LIMIT - 1;

import { getUserById } from "./handlers/_users.js";
import { sendTransactional as defaultSendTransactional } from "./email/transactional.js";
import { quotaWarning } from "./email/templates.js";

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

export { FREE_MONTHLY_LIMIT, QUOTA_TTL_SECONDS, QUOTA_WARN_AT_RUNS };

/** KV key marking that a user has been warned for the current month. */
export function quotaWarnedKey(userId, now = new Date()) {
  return `${quotaKey(userId, now)}:warned`;
}

/**
 * Format the first-of-next-month in human-readable UTC ("June 1, 2026") for
 * the `resetsOn` line in the warning email. Pure: no Intl side-effects.
 */
function nextMonthFirstHuman(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const next = new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1));
  return next.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

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
// "1 run left" warning email (Task #57).
// ---------------------------------------------------------------------------

/**
 * Send the quotaWarning email exactly once per user per month, idempotently.
 *
 * Trigger: caller invokes this AFTER the post-increment count is known. We
 * fire iff `runsUsed === QUOTA_WARN_AT_RUNS` (4 of 5 used, 1 left), the user
 * has an email, and the per-month sentinel KV key is not yet present.
 *
 * Idempotency strategy: claim the sentinel BEFORE attempting the send. KV
 * has no atomic SETNX, but the worst race here is two requests landing in
 * the same millisecond and both passing the `if (already)` check — the
 * second one's `put` is a no-op rewrite. We accept that one losing-race
 * caller might still try to send (ctx.waitUntil is parallel), so we
 * intentionally accept "at most one duplicate email per month per user
 * under contention" rather than "the email might never be retried" if the
 * provider transiently fails. The increment-to-4 boundary is hit exactly
 * once in normal use, so the sentinel-then-send order is the safer trade.
 *
 * `sendFn` is overridable for tests (default: real Workspace sender).
 *
 * Never throws — all failures are funnelled through `sendTransactional`'s
 * own captureException pipeline. Returns the same shape sendTransactional
 * returns, plus our own gating reasons (`not_threshold`, `already_warned`,
 * `no_user`) so callers/tests can assert without inspecting log output.
 */
export async function maybeSendQuotaWarning(env, ctx, user, runsUsed, now = new Date(), sendFn) {
  if (!user || !user.email)              return { sent: false, reason: "no_user" };
  if (runsUsed !== QUOTA_WARN_AT_RUNS)   return { sent: false, reason: "not_threshold" };

  const sentinel = quotaWarnedKey(user.userId, now);
  const already  = await env.USERS.get(sentinel);
  if (already) return { sent: false, reason: "already_warned" };

  // Claim the sentinel first so a second concurrent crossing in the same
  // millisecond reads `already=1` and bails. 35d TTL auto-expires the
  // claim before the next month so the trigger re-arms naturally — no
  // cron sweep, no manual reset.
  await env.USERS.put(sentinel, "1", { expirationTtl: QUOTA_TTL_SECONDS });

  const send = sendFn || defaultSendTransactional;
  return send(env, ctx, {
    to: user.email,
    ...quotaWarning({
      email:     user.email,
      runsUsed,
      runsLimit: FREE_MONTHLY_LIMIT,
      resetsOn:  nextMonthFirstHuman(now),
    }),
  });
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
export function enforceQuota(handler, { now, sendTransactional: sendTxOverride } = {}) {
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
      // Fire-and-forget increment + (at the boundary) the warning email.
      // Both must run AFTER the response flushes, but the email send must
      // see the *post-increment* count, so they're chained inside one
      // ctx.waitUntil promise. In single-Worker dev mode (no ctx) we
      // still await so the test suite sees the new count and the spy.
      const work = (async () => {
        const next = await incrementMonthlyUsage(env, sessionUser.userId, ts);
        // Skipped early when `next !== QUOTA_WARN_AT_RUNS`, so the typical
        // run path costs zero extra KV ops.
        if (next === QUOTA_WARN_AT_RUNS) {
          await maybeSendQuotaWarning(env, ctx, user, next, ts, sendTxOverride);
        }
      })();
      if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(work);
      } else {
        await work;
      }
    }
    return response;
  };
}
