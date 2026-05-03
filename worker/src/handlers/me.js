// GET /api/me — return the signed-in user's email + subscription status.
//
// Auth is enforced by `requireAuth` middleware in the router, which attaches
// `request.user = { userId, email, subStatus }` after verifying the JWT
// against SESSIONS KV. We re-read from USERS KV so the response reflects
// the latest subStatus (the webhook may have flipped it since the JWT was
// issued — e.g. a customer.subscription.deleted event).
//
// Task #19 also surfaces the free-tier quota counters so the dashboard
// can render an "X / 5 used this month" pill (free) or "Unlimited"
// (paid). Counter is read from the same monthly KV row used by the
// quota wrapper in src/quota.js, so the dashboard and the analyzer
// gate always agree.
//
// If the user record has gone missing under us (KV row deleted but session
// still valid), fall back to the session payload rather than returning a
// confusing 200 with empty fields.

import { getUserById } from "./_users.js";
import { getMonthlyUsage, FREE_MONTHLY_LIMIT } from "../quota.js";

export async function meHandler(request, env) {
  const sessionUser = request.user || {};
  const stored = sessionUser.userId
    ? await getUserById(env, sessionUser.userId)
    : null;

  const email     = (stored && stored.email)     || sessionUser.email     || null;
  const subStatus = (stored && stored.subStatus) || sessionUser.subStatus || null;
  // Default to "paid" when no row exists — same posture as the quota
  // wrapper, so the orphan-session edge case doesn't accidentally lock
  // an existing user behind a free quota.
  const plan      = (stored && stored.plan) || (stored?.stripeCustomerId ? "paid" : (sessionUser.userId ? "paid" : null));

  let monthlyRunsUsed  = null;
  let monthlyRunsLimit = null;
  if (plan === "free" && sessionUser.userId) {
    monthlyRunsUsed  = await getMonthlyUsage(env, sessionUser.userId);
    monthlyRunsLimit = FREE_MONTHLY_LIMIT;
  }

  return new Response(
    JSON.stringify({ email, subStatus, plan, monthlyRunsUsed, monthlyRunsLimit }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
