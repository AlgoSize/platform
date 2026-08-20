// Referrals and credit — the customer-facing half.
//
//   GET  /api/referrals          link, funnel, balance and credit history
//   POST /api/referrals/invite   record an address the link was shared with
//   GET  /api/r/:code            the public link itself
//
// The attribution mechanism is one cookie and nothing else. No fingerprinting,
// no cross-site pixel, no query parameter carried through five redirects: a
// visitor follows the link, we drop a first-party cookie naming the code, and
// if they create an account before it expires the referral is attributed.
// Someone who clears cookies is not tracked, which is the correct outcome
// rather than a bug to route around.

import { getActiveOrg } from "./_orgs.js";
import {
  getOrCreateReferralCode, listReferrals, recordInvite, referralLink,
  orgForCode, attributeSignup, DEFAULT_SIGNUP_LIMIT,
} from "../referrals.js";
import { creditBalance, listCreditEvents, formatCents, REFERRAL_CREDIT_CENTS } from "../credits.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How long a follow-the-link visit stays attributable. */
export const REF_COOKIE_TTL_SEC = 60 * 60 * 24 * 30;   // 30 days
export const REF_COOKIE = "algosize_ref";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

async function requireOrgOwnerish(request, env) {
  if (request.authMethod === "api_key") {
    return { error: jsonResponse({
      error: "forbidden",
      message: "API keys cannot manage referrals. Sign in to see this.",
    }, 403) };
  }
  const sessionUser = request.user || {};
  if (!sessionUser.userId) return { error: jsonResponse({ error: "unauthorized" }, 401) };
  const active = await getActiveOrg(env, sessionUser.userId);
  if (!active) {
    return { error: jsonResponse({
      error: "no_organisation",
      message: "This account is not a member of any organisation.",
    }, 404) };
  }
  // Any member can see and share the link. Credit accrues to the ORG, so
  // there is no per-person balance to leak, and restricting sharing to
  // owners would make the feature useless at exactly the firms most likely
  // to refer — the ones with people who talk to other firms.
  return { userId: sessionUser.userId, org: active.org, role: active.role };
}

// ---------------------------------------------------------------------------
// GET /api/referrals
// ---------------------------------------------------------------------------
export async function getReferralsHandler(request, env) {
  const ctxOrg = await requireOrgOwnerish(request, env);
  if (ctxOrg.error) return ctxOrg.error;
  const { org } = ctxOrg;

  const code = await getOrCreateReferralCode(env, org.orgId, org.name);
  if (!code) {
    // The ledger and the funnel are readable without a code, but there is no
    // link to show. Reported rather than faked: a referrals page with a blank
    // link box invites someone to copy an empty string.
    return jsonResponse({
      link: null, code: null, reason: "code_unavailable",
      message: "Could not issue a referral link right now. Your existing credit is unaffected.",
      referrals: [], credit: null, terms: termsFor(),
    });
  }

  const [{ referrals }, balance, { events }] = await Promise.all([
    listReferrals(env, org.orgId),
    creditBalance(env, org.orgId),
    listCreditEvents(env, org.orgId, { limit: 50 }),
  ]);

  const limitReached = code.signupsUsed >= code.signupsLimit;

  return jsonResponse({
    code: code.code,
    link: referralLink(env, code.code),
    usage: {
      used:  code.signupsUsed,
      limit: code.signupsLimit,
      windowEndsAt: code.windowEndsAt,
      // Paused, not broken. The distinction is the whole point of the state:
      // credit already earned is untouched and the cap exists to catch abuse,
      // so the copy offers a way to raise it rather than a dead end.
      limitReached,
    },
    referrals: referrals.map((r) => ({
      referralId: r.referralId,
      label:      r.label,
      stage:      r.stage,
      credit:     r.creditCents == null ? null : formatCents(r.creditCents),
      creditCents: r.creditCents,
      at:         r.createdAt,
    })),
    credit: {
      balanceCents:  balance.balanceCents,
      balance:       formatCents(balance.balanceCents),
      expiringCents: balance.expiringCents,
      expiring:      balance.expiringCents ? formatCents(balance.expiringCents) : null,
      expiringAt:    balance.expiringAt,
      unsyncedCents: balance.unsyncedCents,
      // false = the ledger could not be read. Render as unknown, never as $0.
      known:         balance.complete,
      events: events.map((e) => ({
        at: e.createdAt, kind: e.kind, description: e.description,
        amount: e.amount, amountCents: e.amountCents,
        syncedToStripe: e.syncedToStripe,
      })),
    },
    terms: termsFor(),
  });
}

/**
 * The rules, returned as data rather than hard-coded in the page.
 *
 * The UI renders these strings verbatim. Keeping them here means the amount
 * in the email, the amount on the referrals screen and the amount actually
 * credited all come from REFERRAL_CREDIT_CENTS, and cannot drift apart when
 * one of the three is changed.
 */
function termsFor() {
  return {
    creditPerReferral: formatCents(REFERRAL_CREDIT_CENTS),
    creditPerReferralCents: REFERRAL_CREDIT_CENTS,
    signupLimit: DEFAULT_SIGNUP_LIMIT,
    earnRule: `You earn ${formatCents(REFERRAL_CREDIT_CENTS)} in credit when a referred organisation's first invoice is paid — not at signup, and not for a trial that never converts.`,
    // Said in the API, not only in the UI, so any surface that renders a
    // balance carries the qualifier with it.
    cashPolicy: "Credit reduces your Algosize bill. It is not withdrawable as cash and cannot be transferred.",
    expiry: "Earned credit is valid for 12 months from the day it is issued.",
  };
}

// ---------------------------------------------------------------------------
// POST /api/referrals/invite — note an address the link was shared with
// ---------------------------------------------------------------------------
//
// Bookkeeping only. It does not send anything and does not consume the signup
// allowance: the allowance bounds attributed SIGNUPS, and letting someone
// exhaust it by typing addresses into a box would be a self-inflicted denial
// of service on their own earning.
export async function inviteReferralHandler(request, env) {
  const ctxOrg = await requireOrgOwnerish(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Body must be JSON." }, 400); }

  const email = body && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return jsonResponse({ error: "invalid_email", message: "Enter a valid email address." }, 400);
  }

  const referralId = await recordInvite(env, ctxOrg.org.orgId, email);
  if (!referralId) {
    return jsonResponse({
      error: "could_not_record",
      message: "Could not add that to your referral list. The link itself still works.",
    }, 500);
  }
  return jsonResponse({ ok: true, referralId, label: email, stage: "invited" });
}

// ---------------------------------------------------------------------------
// GET /api/r/:code — the public link
// ---------------------------------------------------------------------------
//
// Unauthenticated by design: the whole point is that it is followed by
// someone who does not have an account yet.
//
// An unknown code still redirects to the site. Showing a stranger a 404
// because the person who sent them the link has since closed their account
// would be a bad first impression of a product they were recommended, and
// the failure is ours to absorb rather than theirs to debug.
//
// The cookie is SameSite=Lax and NOT HttpOnly-sensitive in the usual way —
// it carries no authority, only an attribution hint that the server
// re-validates against referral_codes before it means anything.
export async function referralLandingHandler(request, env) {
  const origin = (env.SITE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
  const raw = (request.params && request.params.code) || "";
  const code = String(raw).slice(0, 64);

  const owner = code ? await orgForCode(env, code) : null;

  const headers = { Location: owner ? `${origin}/?ref=1` : `${origin}/` };
  if (owner) {
    headers["Set-Cookie"] = [
      `${REF_COOKIE}=${encodeURIComponent(owner.code)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${REF_COOKIE_TTL_SEC}`,
      origin.startsWith("http://localhost") ? null : "Secure",
    ].filter(Boolean).join("; ");
  }
  return new Response(null, { status: 302, headers });
}

/**
 * Attribute a brand-new account to whatever referral cookie it arrived with.
 *
 * Called from the two sign-up paths (magic link, Google) right after a user
 * is created for the first time. Never throws and never blocks: a signup must
 * not fail because a referral could not be recorded, and the person signing
 * up has no stake in the outcome either way.
 *
 * Silent on every refusal — unknown code, self-referral, allowance exhausted.
 * The person creating the account is not the audience for any of those, and
 * the referrer sees the truth on their own referrals screen, where the funnel
 * is the record.
 */
export async function attributeSignupFromRequest(env, request, user) {
  try {
    const code = readReferralCookie(request);
    if (!code || !user || !user.userId) return null;

    const active = await getActiveOrg(env, user.userId);
    if (!active) return null;

    return await attributeSignup(env, code, {
      referredOrgId: active.org.orgId,
      label: active.org.name || user.email,
    });
  } catch {
    return null;
  }
}

/** Read the attribution cookie off an inbound request. */
export function readReferralCookie(request) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === REF_COOKIE) {
      const v = decodeURIComponent(part.slice(eq + 1));
      return v ? v.slice(0, 64) : null;
    }
  }
  return null;
}
