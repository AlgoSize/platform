// Entitlement — the single place that decides whether an account is paid.
//
// This exists because the decision used to live in two places that had
// drifted apart, and BOTH defaulted an unknown user to "paid":
//
//   quota.js:196   const plan = (user && user.plan) || "paid";
//   me.js:33       ... : (sessionUser.userId ? "paid" : null);
//
// So a missing `users` row — a failed insert, a partial migration, a deleted
// account whose 30-day JWT is still valid — silently granted unlimited
// access, and /api/me confirmed it to the user by rendering "Unlimited".
// Billing that fails open has no floor: it cannot be forecast, and any
// support incident touching the users table hands out free accounts.
//
// The second half of the same problem: `sub_status` was written by the
// Stripe webhook but never read for entitlement, so a cancelled customer
// kept full access forever. Cancelling cost them nothing, which also removed
// any reason to resubscribe.
//
// Both are fixed here by one rule set, and every caller goes through it.
// The default is now `free` — an account is paid only when we can positively
// show it.

import { getUserById } from "./handlers/_users.js";
import { captureException } from "./observability.js";

/**
 * Why a given entitlement was reached. Exported so callers and tests can
 * assert on the reason rather than re-deriving it, and so the values show up
 * verbatim in observability tags.
 */
export const ENTITLEMENT_REASON = Object.freeze({
  NO_USER_ID:        "no_user_id",
  NO_USER_ROW:       "no_user_row",
  FREE_PLAN:         "free_plan",
  ACTIVE_SUBSCRIPTION: "active_subscription",
  GRACE_PERIOD:      "grace_period",
  PERIOD_EXPIRED:    "period_expired",
  MISSING_PERIOD_END: "missing_period_end",
});

/**
 * Resolve what an account is entitled to.
 *
 * Returns `{ plan, active, reason, currentPeriodEnd, user }`:
 *   plan     "paid" | "free" — what the row claims.
 *   active   boolean — whether paid features should actually be served.
 *            THIS is what callers gate on, never `plan` alone: a cancelled
 *            customer inside their grace window is plan "paid", and one past
 *            the end of it is plan "paid" with active false.
 *   reason   an ENTITLEMENT_REASON, for logs, tags and tests.
 *   user     the row we read, passed back so callers don't fetch it twice.
 *
 * `now` (unix seconds) is injectable so tests can sit either side of a period
 * boundary without touching the clock. `ctx`/`request` are threaded through to
 * observability only.
 */
export async function resolveEntitlement(env, userId, { now, ctx, request } = {}) {
  const nowSec = typeof now === "number" ? now : Math.floor(Date.now() / 1000);

  if (!userId) {
    // requireAuth should have caught this long before here.
    return { plan: "free", active: false, reason: ENTITLEMENT_REASON.NO_USER_ID, currentPeriodEnd: null, user: null };
  }

  const user = await getUserById(env, userId);

  if (!user) {
    // A valid session pointing at a row that isn't there is a real bug, and
    // the old code hid it behind a free upgrade. Surface it, then fail closed.
    await captureException(
      env, ctx,
      new Error(`entitlement: no users row for session userId ${userId}`),
      { request, userId, tags: { source: "entitlement", reason: ENTITLEMENT_REASON.NO_USER_ROW } },
    );
    return { plan: "free", active: false, reason: ENTITLEMENT_REASON.NO_USER_ROW, currentPeriodEnd: null, user: null };
  }

  const plan = user.plan === "paid" ? "paid" : "free";
  const currentPeriodEnd = typeof user.currentPeriodEnd === "number" ? user.currentPeriodEnd : null;

  if (plan !== "paid") {
    return { plan: "free", active: false, reason: ENTITLEMENT_REASON.FREE_PLAN, currentPeriodEnd, user };
  }

  if (user.subStatus === "active") {
    return { plan: "paid", active: true, reason: ENTITLEMENT_REASON.ACTIVE_SUBSCRIPTION, currentPeriodEnd, user };
  }

  // Paid, but the subscription is no longer active: serve the rest of the
  // period they already paid for, then stop. Grace, not amnesty.
  if (currentPeriodEnd === null) {
    // Nothing to measure the grace window against. Fail closed — but this is
    // worth seeing, because it also describes any pre-existing paid row that
    // was written before `current_period_end` existed as a column.
    return { plan: "paid", active: false, reason: ENTITLEMENT_REASON.MISSING_PERIOD_END, currentPeriodEnd, user };
  }
  if (nowSec < currentPeriodEnd) {
    return { plan: "paid", active: true, reason: ENTITLEMENT_REASON.GRACE_PERIOD, currentPeriodEnd, user };
  }
  return { plan: "paid", active: false, reason: ENTITLEMENT_REASON.PERIOD_EXPIRED, currentPeriodEnd, user };
}
