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
import { getActiveOrg, getOrgById } from "./handlers/_orgs.js";
import { captureException } from "./observability.js";

/**
 * Why a given entitlement was reached. Exported so callers and tests can
 * assert on the reason rather than re-deriving it, and so the values show up
 * verbatim in observability tags.
 */
export const ENTITLEMENT_REASON = Object.freeze({
  NO_USER_ID:        "no_user_id",
  NO_USER_ROW:       "no_user_row",
  NO_ORG:            "no_org",
  NO_ORG_ID:         "no_org_id",
  ORG_NOT_FOUND:     "org_not_found",
  FREE_PLAN:         "free_plan",
  // An organisation Algosize itself owns. Deliberately its own reason rather
  // than reusing ACTIVE_SUBSCRIPTION: the dashboard, the invoices page and
  // every support conversation should say "internal", not claim a Stripe
  // subscription that does not exist and would confuse the first person to
  // go looking for the invoice.
  INTERNAL_ORG:      "internal_org",
  ACTIVE_SUBSCRIPTION: "active_subscription",
  TRIALING:          "trialing",
  GRACE_PERIOD:      "grace_period",
  PERIOD_EXPIRED:    "period_expired",
  MISSING_PERIOD_END: "missing_period_end",
  NOT_ENTITLING_STATUS: "not_entitling_status",
});

// `sub_status` now holds Stripe's own subscription status (written by the
// lifecycle webhooks) rather than only the "active"/"inactive" pair the
// checkout and cancel handlers used. The three sets below are the whole
// mapping from that status to what we serve.

/** Serve paid features outright, regardless of the paid-through date. */
const ENTITLING_STATUSES = new Set(["active", "trialing"]);

/**
 * The customer had access and something ended or lapsed: they keep what they
 * already paid for until `current_period_end`, then drop to free.
 *
 * `past_due` belongs here on purpose — that is what dunning is. Stripe retries
 * a failed payment for roughly two weeks, and cutting access off on the first
 * failed charge would punish an expired card far harder than a cancellation.
 * `null` is included because rows written before `sub_status` existed carry it,
 * and they resolved through this same grace path before.
 */
const GRACE_ELIGIBLE_STATUSES = new Set(["past_due", "inactive", "canceled", "unpaid", null, undefined]);

/**
 * Everything else — `incomplete`, `incomplete_expired`, `paused`. These never
 * entitle, even though Stripe still stamps a `current_period_end` on them.
 * `incomplete` is the dangerous one: it means the subscription exists but the
 * first payment has not succeeded, so treating its period end as a grace
 * window would hand out a full month to anyone who starts a checkout and
 * abandons it at the card form.
 */

/**
 * Resolve what an account is entitled to.
 *
 * Entitlement belongs to the ORGANISATION, not the user (migrations/0004): a
 * seat on a paid org is what grants access, so every member of a paid org is
 * entitled and losing the seat ends it. The user's active org is resolved
 * first, and its billing columns are the only ones consulted.
 *
 * Returns `{ plan, active, reason, currentPeriodEnd, user, org, role }`:
 *   plan     "paid" | "free" — what the org row claims.
 *   active   boolean — whether paid features should actually be served.
 *            THIS is what callers gate on, never `plan` alone: a cancelled
 *            customer inside their grace window is plan "paid", and one past
 *            the end of it is plan "paid" with active false.
 *   reason   an ENTITLEMENT_REASON, for logs, tags and tests.
 *   user     the user row, passed back so callers don't fetch it twice.
 *   org      the organisation the decision was made against, or null.
 *   role     the caller's role in that org ("owner" | "admin" | "member"),
 *            so route handlers can authorise without a second query.
 *
 * `now` (unix seconds) is injectable so tests can sit either side of a period
 * boundary without touching the clock. `ctx`/`request` are threaded through to
 * observability only.
 */
export async function resolveEntitlement(env, userId, { now, ctx, request } = {}) {
  const deny = (reason, extra = {}) => ({
    plan: "free", active: false, reason, currentPeriodEnd: null, user: null, org: null, role: null, ...extra,
  });

  if (!userId) {
    // requireAuth should have caught this long before here.
    return deny(ENTITLEMENT_REASON.NO_USER_ID);
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
    return deny(ENTITLEMENT_REASON.NO_USER_ROW);
  }

  // The org is the billing subject (migrations/0004). A user with no org is
  // the same class of bug as a user with no row — the backfill gave everyone
  // one and every signup path creates one — so it is surfaced and fails
  // closed rather than quietly falling back to the dead users.plan column.
  const active = await getActiveOrg(env, userId);
  if (!active) {
    await captureException(
      env, ctx,
      new Error(`entitlement: no organisation for userId ${userId}`),
      { request, userId, tags: { source: "entitlement", reason: ENTITLEMENT_REASON.NO_ORG } },
    );
    return deny(ENTITLEMENT_REASON.NO_ORG, { user });
  }

  return applyOrgRules(active.org, { now, user, role: active.role, env });
}

/**
 * Resolve entitlement directly from an org id, with no user in the picture.
 *
 * Used by API-key auth (Task #P-4): a key authenticates AS the organisation,
 * not as any one member, so there is no userId to resolve through — see
 * requireAuth in src/auth.js. This calls the exact same rule set as
 * resolveEntitlement via applyOrgRules, so a key and a cookie session can
 * never disagree about whether the same org is paid.
 *
 * Returns the same shape as resolveEntitlement, with `user` and `role`
 * always null (there is no member in this call, so no role to report).
 */
export async function resolveEntitlementForOrg(env, orgId, { now, ctx, request } = {}) {
  const deny = (reason, extra = {}) => ({
    plan: "free", active: false, reason, currentPeriodEnd: null, user: null, org: null, role: null, ...extra,
  });

  if (!orgId) return deny(ENTITLEMENT_REASON.NO_ORG_ID);

  const org = await getOrgById(env, orgId);
  if (!org) {
    // An API key pointing at an org that no longer exists — shouldn't happen
    // (nothing deletes orgs), but a key row outliving its org is exactly the
    // kind of drift the users-table version of this bug used to hide.
    await captureException(
      env, ctx,
      new Error(`entitlement: no organisation row for orgId ${orgId}`),
      { request, tags: { source: "entitlement", reason: ENTITLEMENT_REASON.ORG_NOT_FOUND } },
    );
    return deny(ENTITLEMENT_REASON.ORG_NOT_FOUND);
  }

  return applyOrgRules(org, { now, env });
}

/**
 * The one rule set both entry points above call — see the ENTITLING /
 * GRACE_ELIGIBLE / (implicit) never-entitling sets above for what each
 * status means and why.
 */
/**
 * Organisations Algosize runs on its own behalf, from INTERNAL_ORG_IDS.
 *
 * Deliberately an environment variable and not a database column: this is the
 * one switch that turns metering off, so it should be set at deploy time by
 * someone with Cloudflare access and be visible in a config diff, never
 * flippable by anything with write access to a row.
 *
 * Keyed on the ORGANISATION, not on an admin email, because that is the only
 * identity a CI pipeline has. The dependency-audit gate authenticates with an
 * org-scoped API key and carries no user at all, so an email allowlist would
 * have looked correct in the dashboard and changed nothing where it was
 * actually needed.
 *
 * Unset or empty means nobody is internal — the safe direction.
 */
function isInternalOrg(env, orgId) {
  const raw = env && env.INTERNAL_ORG_IDS;
  if (typeof raw !== "string" || !raw.trim() || !orgId) return false;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(orgId);
}

function applyOrgRules(org, { now, user = null, role = null, env = null } = {}) {
  const nowSec = typeof now === "number" ? now : Math.floor(Date.now() / 1000);
  const currentPeriodEnd = org.currentPeriodEnd;
  const base = { currentPeriodEnd, user, org, role };

  // Checked before anything else, so an internal org is entitled regardless
  // of what Stripe later writes to its row. A webhook flipping sub_status
  // must not be able to switch our own metering back on mid-sweep.
  if (isInternalOrg(env, org.orgId)) {
    return { plan: "internal", active: true, reason: ENTITLEMENT_REASON.INTERNAL_ORG, ...base };
  }

  if (org.plan !== "paid") {
    return { plan: "free", active: false, reason: ENTITLEMENT_REASON.FREE_PLAN, ...base };
  }

  if (ENTITLING_STATUSES.has(org.subStatus)) {
    return {
      plan: "paid",
      active: true,
      reason: org.subStatus === "trialing"
        ? ENTITLEMENT_REASON.TRIALING
        : ENTITLEMENT_REASON.ACTIVE_SUBSCRIPTION,
      ...base,
    };
  }

  if (!GRACE_ELIGIBLE_STATUSES.has(org.subStatus)) {
    // A status that never earned access in the first place. Fail closed
    // without consulting the period end — see the comment on the set above.
    return { plan: "paid", active: false, reason: ENTITLEMENT_REASON.NOT_ENTITLING_STATUS, ...base };
  }

  // Paid, but the subscription is no longer active: serve the rest of the
  // period they already paid for, then stop. Grace, not amnesty.
  if (currentPeriodEnd === null) {
    // Nothing to measure the grace window against. Fail closed — but this is
    // worth seeing, because it also describes any pre-existing paid row that
    // was written before `current_period_end` existed as a column.
    return { plan: "paid", active: false, reason: ENTITLEMENT_REASON.MISSING_PERIOD_END, ...base };
  }
  if (nowSec < currentPeriodEnd) {
    return { plan: "paid", active: true, reason: ENTITLEMENT_REASON.GRACE_PERIOD, ...base };
  }
  return { plan: "paid", active: false, reason: ENTITLEMENT_REASON.PERIOD_EXPIRED, ...base };
}
