// Who the report says it came from.
//
// By default every report is branded Algosize. An org on the TOP tier may
// replace that with their own company name and logo, because the product they
// are actually buying at that price is the ability to hand this document to
// their own client without our name on it.
//
// Two rules make this safe, and both matter:
//
//   1. Entitlement is resolved at RENDER time, never trusted from the row.
//      The columns exist on any org (migrations/0008) but they only apply
//      while the subscription that paid for them is live. A consultancy that
//      downgrades stops white-labelling on their next report, not whenever
//      someone remembers to clear the column.
//
//   2. The logo URL is re-validated at render time even though it was
//      validated at write time. It ends up in an `<img src>` inside a document
//      whose entire purpose is to be forwarded to a third party, so a
//      `javascript:` or `data:` URL here would be stored XSS with a delivery
//      mechanism attached. https:// only, no exceptions, checked twice.

import { PLANS, INTERVALS } from "../stripe.js";

/** The tier that may white-label. Top of the three the pricing page sells. */
export const WHITE_LABEL_TIER = "firm";

export const ALGOSIZE_BRANDING = Object.freeze({
  companyName: "Algosize",
  logoUrl:     null,
  whiteLabel:  false,
});

/**
 * Which tier an org is on, derived from the Stripe price it is subscribed to.
 *
 * The org row stores `price_id` (migrations/0003) and the tier prices are
 * configured per (plan × interval) as STRIPE_PRICE_<PLAN>_<INTERVAL> (see
 * resolvePrice in src/stripe.js), so the mapping is just that config read
 * backwards. Deriving it means there is no second place to update when a
 * price changes, and no tier column to drift out of sync with Stripe.
 *
 * Returns a plan name from PLANS, or null when the price is not one of the
 * tier prices — which covers a free org, an org on the legacy single
 * STRIPE_PRICE_ID, and an org whose price was created outside this config.
 * "Not one of our tiers" is deliberately not "the top tier".
 */
export function tierForOrg(env, org) {
  const priceId = org && org.priceId;
  if (!priceId || !env) return null;

  for (const plan of PLANS) {
    for (const interval of INTERVALS) {
      const key = `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;
      if (env[key] && env[key] === priceId) return plan;
      // A per-seat tier bills two line items; the subscription's stored price
      // may be either one, so the seat price maps to the same tier.
      if (env[`${key}_SEAT`] && env[`${key}_SEAT`] === priceId) return plan;
    }
  }
  return null;
}

/**
 * Whether this org may white-label right now.
 *
 * Both halves are required: the top tier AND a live entitlement. A Firm
 * subscription that lapsed past its grace window is `active: false`, and an
 * unpaid account must not keep shipping unbranded reports.
 */
export function mayWhiteLabel(env, org, entitlement) {
  if (!entitlement || !entitlement.active) return false;
  return tierForOrg(env, org) === WHITE_LABEL_TIER;
}

/**
 * Validate a logo URL for use in an `<img src>`.
 *
 * https only. Not http (a mixed-content image silently fails to load in the
 * middle of a document someone is presenting), not protocol-relative, and
 * certainly not javascript: or data:. Returns the normalised URL or null.
 */
export function safeLogoUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let url;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== "https:") return null;
  return url.toString();
}

export const MAX_COMPANY_NAME_LEN = 120;

/** Validate a display name. Escaping happens at render; this bounds the size. */
export function safeCompanyName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_COMPANY_NAME_LEN) return null;
  return trimmed;
}

/**
 * Resolve the branding a report should carry.
 *
 * Falls back to Algosize branding for every case that isn't an entitled
 * top-tier org with something set — including an entitled org that set a logo
 * we would refuse to render. A report that silently drops the logo but keeps
 * the custom name is stranger than one that is simply ours.
 */
export function brandingFor(env, org, entitlement) {
  if (!mayWhiteLabel(env, org, entitlement)) return { ...ALGOSIZE_BRANDING };

  const companyName = safeCompanyName(org && org.brandCompanyName);
  const logoUrl     = safeLogoUrl(org && org.brandLogoUrl);
  if (!companyName && !logoUrl) return { ...ALGOSIZE_BRANDING };

  return {
    companyName: companyName || (org && org.name) || ALGOSIZE_BRANDING.companyName,
    logoUrl,
    whiteLabel: true,
  };
}
