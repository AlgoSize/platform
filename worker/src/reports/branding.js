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
  accent:      null,      // null = the report's own stylesheet decides
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

/** Minimum contrast between the accent and the white text drawn on it. */
export const MIN_ACCENT_CONTRAST = 4.5;

/** WCAG relative luminance of an #rrggbb colour. */
function luminance(hex) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio of an #rrggbb colour against white. */
export function contrastWithWhite(hex) {
  return 1.05 / (luminance(hex) + 0.05);
}

/**
 * Validate a brand accent colour.
 *
 * `#rrggbb` only — no names, no rgb(), no alpha. The value is written into a
 * `style` attribute in a document that gets forwarded to a third party, and
 * accepting arbitrary CSS colour syntax there is accepting arbitrary CSS.
 *
 * It must also be DARK ENOUGH. The accent is used as a button and badge
 * background with white text on it, so a pale yellow would render as white on
 * white — an invisible "View report" button in a document the customer is
 * handing to their own client. Requiring 4.5:1 against white is the same bar
 * the rest of the report holds itself to, and refusing loudly is far better
 * than shipping an unreadable one.
 *
 * Returns the normalised lowercase hex, or null.
 */
export function safeAccent(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(trimmed)) return null;
  if (contrastWithWhite(trimmed) < MIN_ACCENT_CONTRAST) return null;
  return trimmed;
}

/**
 * The accent a report should actually paint with.
 *
 * NEVER applied to severity colours. A client who could recolour "critical"
 * could make a critical finding look calm, and a report whose whole purpose
 * is to tell someone what is wrong must not let its author tune down how
 * wrong it looks. This is a hard rule, not a default — see the severity ramp
 * in the report stylesheet, which does not read this value at all.
 */
export const ALGOSIZE_ACCENT = "#0f766e";

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
  // Re-validated at render, like the logo URL and for the same reason: a
  // value that passed validation on the day it was written must still pass on
  // the day it is painted, because the rules can tighten between the two.
  const accent      = safeAccent(org && org.brandAccent);
  if (!companyName && !logoUrl && !accent) return { ...ALGOSIZE_BRANDING };

  return {
    companyName: companyName || (org && org.name) || ALGOSIZE_BRANDING.companyName,
    logoUrl,
    accent,
    whiteLabel: true,
  };
}
