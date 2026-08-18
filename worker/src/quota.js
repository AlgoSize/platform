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

import { resolveEntitlement, resolveEntitlementForOrg } from "./entitlement.js";
import { getOrgBillingEmail } from "./handlers/_orgs.js";
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
 * LEGACY / FALLBACK PATH — not atomic. Two requests can both read N and both
 * write N+1, and under real concurrency the shortfall is unbounded rather than
 * off-by-one: 20 concurrent callers all read 0 and all write 1. Metering no
 * longer runs through here when the USAGE Durable Object is bound, which is
 * the case in every deployed environment; see reserveRun below. It remains for
 * the no-DO case (bare `wrangler dev`, unit tests) and as the seed the DO
 * migrates from.
 */
export async function incrementMonthlyUsage(env, userId, now = new Date()) {
  const key  = quotaKey(userId, now);
  const next = (await getMonthlyUsage(env, userId, now)) + 1;
  await env.USERS.put(key, String(next), { expirationTtl: QUOTA_TTL_SECONDS });
  return next;
}

// ---------------------------------------------------------------------------
// Atomic reserve / release, via the USAGE Durable Object.
// ---------------------------------------------------------------------------

/**
 * Call one op on the meter's Durable Object.
 *
 * `idFromName(meterId)` is what makes this correct: every request for one
 * account routes to the same object, so the object's single-threaded execution
 * is a global lock on that account's counter. A different meter id gets a
 * different object and never contends.
 *
 * Returns null when there is no USAGE binding, so callers fall back to KV.
 */
async function usageOp(env, meterId, op, now, extra = {}) {
  if (!env || !env.USAGE || !meterId) return null;
  try {
    const stub = env.USAGE.get(env.USAGE.idFromName(meterId));
    const res  = await stub.fetch("https://usage.internal/", {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ op, meterId, month: currentMonthKey(now), ...extra }),
    });
    if (!res.ok) throw new Error(`usage counter returned ${res.status}`);
    return await res.json();
  } catch (err) {
    // Fall back to KV rather than failing the request. A DO outage should
    // degrade the guarantee, not take the analyzers down — and the KV path,
    // weak as it is, still stops the sequential case.
    console.warn("quota: USAGE durable object unavailable, falling back to KV", err && err.message);
    return null;
  }
}

/**
 * Atomically claim one run against the month's limit.
 *
 * Returns `{ allowed, used }` where `used` is the post-reservation count when
 * allowed, and the current count when refused. The caller must release on any
 * non-200 from the handler it went on to run — see releaseRun.
 */
export async function reserveRun(env, meterId, now = new Date(), limit = FREE_MONTHLY_LIMIT) {
  const viaDo = await usageOp(env, meterId, "reserve", now, { limit });
  if (viaDo) return { allowed: !!viaDo.allowed, used: viaDo.used, atomic: true };

  // KV fallback: check-then-act, and knowingly racy. Kept so the analyzers
  // still meter at all in an environment with no DO binding.
  const used = await getMonthlyUsage(env, meterId, now);
  if (used >= limit) return { allowed: false, used, atomic: false };
  const next = await incrementMonthlyUsage(env, meterId, now);
  return { allowed: true, used: next, atomic: false };
}

/**
 * Hand back a reservation whose run did not succeed.
 *
 * Floors at zero on both paths, so a duplicated release can never mint quota.
 */
export async function releaseRun(env, meterId, now = new Date()) {
  const viaDo = await usageOp(env, meterId, "release", now);
  if (viaDo) return viaDo.used;

  const used = await getMonthlyUsage(env, meterId, now);
  const next = Math.max(0, used - 1);
  await env.USERS.put(quotaKey(meterId, now), String(next), { expirationTtl: QUOTA_TTL_SECONDS });
  return next;
}

/**
 * Current month's count for display (/api/me), from whichever store is
 * authoritative in this environment.
 */
export async function peekUsage(env, meterId, now = new Date()) {
  const viaDo = await usageOp(env, meterId, "peek", now);
  if (viaDo) return viaDo.used;
  return getMonthlyUsage(env, meterId, now);
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
 * `user` only needs `.userId` (for the sentinel key) and `.email` — for a
 * cookie session that's the member's own row; for an API-key request (Task
 * #P-4, no member behind the call) `enforceQuota` builds an org-billing
 * stand-in shaped the same way, so this function doesn't need to know which
 * kind of credential triggered the warning.
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
 *   1. Resolve entitlement via src/entitlement.js (the only place that
 *      decides paid vs free, and the only place that reads sub_status).
 *   2. If entitled → call the handler unchanged (paid users skip quota and
 *      never increment the counter). A cancelled subscriber stays entitled
 *      until the end of the period they paid for, then stops.
 *   3. Otherwise (free, cancelled-and-expired, or no user row at all):
 *      a. RESERVE one run atomically. If the month is already at the limit
 *         → return 402 `{ error: "quota_exceeded", monthlyRunsUsed,
 *           monthlyRunsLimit, upgradeUrl }` WITHOUT calling the handler.
 *      b. Otherwise call the handler. On any non-200 (or a throw), RELEASE
 *         the reservation so the failed run costs the user nothing.
 *
 * RESERVE-BEFORE-RUN IS THE WHOLE POINT. This used to read the counter, run
 * the handler, and increment afterwards on a 200 — which is check-then-act
 * with the handler's entire execution time as the race window. Because these
 * handlers run analyzer code in a sandbox, that window is hundreds of ms to
 * seconds, and it did not hold: 20 concurrent requests from a fresh free user
 * produced 20 successful runs and left the counter at 1, making the burst
 * repeatable forever. Reserving collapses the decision and the write into one
 * atomic step against the USAGE Durable Object (src/usage-counter.js), so a
 * concurrent caller at the boundary observes the post-reservation count.
 *
 * The cost of that is this function no longer knows the run succeeded when it
 * charges for it, hence the release on the failure path. Net behaviour for a
 * user is unchanged from the increment-on-success design — a validation error
 * (400) or sandbox crash (500) still doesn't burn a free run — but it is now
 * two writes on the failure path instead of zero, which is the right place to
 * spend it.
 *
 * Without a USAGE binding (bare `wrangler dev`, unit tests) reserveRun falls
 * back to the old non-atomic KV path. Same observable behaviour sequentially,
 * same race under concurrency; deployed environments all bind the DO.
 *
 * `now` is injectable for tests that need to assert month-boundary
 * behavior without time-travelling the system clock.
 *
 * Callers reach this wrapper through either credential requireAuth accepts:
 * a cookie/JWT session (`request.user.userId`) or an API key (Task #P-4,
 * `request.org.orgId`, no member behind the call). Entitlement is resolved
 * through whichever one is present — `resolveEntitlement` for a session,
 * `resolveEntitlementForOrg` for a key — and both call the same rule set, so
 * a member and a key on the same org can never see different answers. The
 * free-tier counter is metered the same way: per user for a session, per org
 * for a key, because a key has no member to count against and a free org's 5
 * runs are 5 runs total, not 5 per credential it happens to call in with.
 */
export function enforceQuota(handler, { now, sendTransactional: sendTxOverride } = {}) {
  return async function quotaWrappedHandler(request, env, ctx) {
    const sessionUser = request.user || null;
    const org         = request.org  || null;
    const meterId      = sessionUser?.userId || org?.orgId;
    if (!meterId) {
      // requireAuth would have caught this — defensive only.
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const ts = now ? (typeof now === "function" ? now() : now) : new Date();
    const nowSec = Math.floor(ts.getTime() / 1000);

    // One source of truth for paid vs free (src/entitlement.js). This used to
    // read `(user && user.plan) || "paid"`, so a missing users row granted
    // unlimited access — and `sub_status` was never consulted at all, so a
    // cancelled customer never lost it. Both now fail closed.
    const entitlement = sessionUser
      ? await resolveEntitlement(env, sessionUser.userId, { now: nowSec, ctx, request })
      : await resolveEntitlementForOrg(env, org.orgId, { now: nowSec, ctx, request });
    const user = entitlement.user;

    if (entitlement.active) {
      return handler(request, env, ctx);
    }

    // Free tier — claim a run atomically BEFORE the handler runs. Reserving
    // at the gate is what closes the race: the decision and the write are one
    // step, so a concurrent caller at the boundary sees the post-reservation
    // count rather than the value this request read.
    const { allowed, used } = await reserveRun(env, meterId, ts, FREE_MONTHLY_LIMIT);
    if (!allowed) {
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

    let response;
    try {
      response = await handler(request, env, ctx);
    } catch (err) {
      // A throwing handler is a crashed run, not a consumed one. Give the
      // reservation back before re-throwing so the error still surfaces.
      await releaseRun(env, meterId, ts);
      throw err;
    }

    if (!response || response.status !== 200) {
      // Validation error, sandbox crash, upstream 502 — the user did not get
      // an analysis, so they do not spend a run. This preserves the behaviour
      // the increment-on-success design had; reserving at the gate is what
      // makes the release necessary rather than free.
      const giveBack = releaseRun(env, meterId, ts);
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(giveBack);
      else await giveBack;
      return response;
    }

    // The run counted. `used` is already the post-reservation count, so the
    // warning email needs no second read — and it is the count this request
    // actually claimed, not a re-read that a concurrent run could have moved.
    // Skipped early off the boundary, so the typical path costs nothing extra.
    if (used === QUOTA_WARN_AT_RUNS) {
      const work = (async () => {
        // A session has the member's own row; an API key has no member —
        // fall back to the org's billing owner. If even that has no email
        // on file (shouldn't happen; every org has an owner), the free
        // run itself is still granted — a missing warning is not a reason
        // to fail the request that earned it.
        const recipient = user || await orgBillingRecipient(env, org?.orgId);
        if (recipient) await maybeSendQuotaWarning(env, ctx, recipient, used, ts, sendTxOverride);
      })();
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);
      else await work;
    }
    return response;
  };
}

/** Recipient shape maybeSendQuotaWarning expects, built from an org's billing owner. */
async function orgBillingRecipient(env, orgId) {
  if (!orgId) return null;
  const email = await getOrgBillingEmail(env, orgId);
  return email ? { userId: orgId, email } : null;
}
