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
// If the user record has gone missing under us (row deleted but session
// still valid), fall back to the session payload for the display fields
// rather than returning a confusing 200 with empty fields. Entitlement is a
// separate question and is NOT guessed — see below.

import { resolveEntitlement, resolveEntitlementForOrg } from "../entitlement.js";
import { peekUsage, FREE_MONTHLY_LIMIT } from "../quota.js";
import { isAdmin } from "./admin.js";
import { initialsFor } from "./account.js";

export async function meHandler(request, env, ctx) {
  const sessionUser = request.user || {};
  const org         = request.org  || null;

  // Entitlement comes from the one resolver the analyzer gate also uses, so
  // the pill in the dashboard and the 402 from the API can never disagree.
  // This previously defaulted to "paid" whenever a session existed, which
  // told users with no row that they had "Unlimited" runs — and the quota
  // wrapper agreed with it, so they did.
  //
  // Org-first when there is no session user — mirrors enforceQuota in
  // quota.js. resolveEntitlement's NO_USER_ID branch is a safety net for
  // requireAuth failing to run upstream, not a real account state: it always
  // returns plan "free", active false, no matter what the organisation
  // actually pays for. Before this, an API-key or OAuth caller — which by
  // definition has no session user — hit that safety net on every call,
  // so algosize_whoami told every org connected that way it was on a free,
  // inactive plan, including a genuinely paying one. Caught by testing
  // against an org that happened to actually be free, where the wrong
  // mechanism produced a right-looking answer.
  const entitlement = sessionUser.userId
    ? await resolveEntitlement(env, sessionUser.userId, { ctx, request })
    : org
      ? await resolveEntitlementForOrg(env, org.orgId, { ctx, request })
      : await resolveEntitlement(env, sessionUser.userId, { ctx, request });
  const stored = entitlement.user;

  const email     = (stored && stored.email)     || sessionUser.email     || null;
  const subStatus = (stored && stored.subStatus) || sessionUser.subStatus || null;
  // Report what the account can actually do, not what the row claims: a
  // cancelled subscriber past their paid-through date reads as "free" here
  // exactly as they do at the analyzer gate.
  const plan      = entitlement.active ? "paid" : "free";

  let monthlyRunsUsed  = null;
  let monthlyRunsLimit = null;
  if (plan === "free" && sessionUser.userId) {
    // peekUsage, not getMonthlyUsage: once the USAGE Durable Object is bound
    // it is the authoritative counter, and reading KV here would show a
    // stale number that disagrees with the gate the user just hit.
    monthlyRunsUsed  = await peekUsage(env, sessionUser.userId);
    monthlyRunsLimit = FREE_MONTHLY_LIMIT;
  }

  return new Response(
    JSON.stringify({
      email,
      subStatus,
      plan,
      monthlyRunsUsed,
      monthlyRunsLimit,
      // Billing-state fields (D-1). The dashboard's pill, banners and trial
      // chip key off these three rather than re-deriving state from plan +
      // subStatus — `reason` is the ENTITLEMENT_REASON the resolver actually
      // took, so the UI and the analyzer gate literally cannot disagree.
      // `plan` above keeps its existing meaning (what the account can DO)
      // for back-compat; `active` says the same thing explicitly.
      active: entitlement.active,
      reason: entitlement.reason,
      currentPeriodEnd: entitlement.currentPeriodEnd,
      // The dashboard has no other way to know whether to show a link to
      // /admin — the panel itself is gated server-side by requireAdmin on
      // every /api/admin/* route regardless of what this says, so getting
      // this wrong is a visibility bug, not a security one. Same allowlist
      // check admin.js uses, exported from there so there's one definition.
      isAdmin: isAdmin(env, email),
      // Identity for the header's Account control. The avatar is rendered as
      // an image when a URL is stored and as initials when it is not — never
      // as a broken image, and never as a generic silhouette that gives no
      // signal about which account is signed in.
      //
      // Both are already stored (migrations/0015) and were already editable
      // on the Account screen; they simply were not returned here, so the
      // header had nothing but an email address to work with.
      displayName: (stored && stored.displayName) || null,
      avatarUrl:   (stored && stored.avatarUrl)   || null,
      // Computed server-side so the header and the Account screen show the
      // same two letters. Deriving initials in two places is how "GL" in one
      // corner and "gu" in another happens.
      initials:    initialsFor({ displayName: stored && stored.displayName, email }),
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
