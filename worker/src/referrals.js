// Referrals — bringing another organisation in, and the credit for doing it.
//
// The whole feature is credit-only. There is no payout path in this module,
// in the schema, or in the API, and that is a product decision rather than a
// gap: see the header of src/credits.js.
//
// ---------------------------------------------------------------------------
// The funnel, and why it has four stages instead of two
// ---------------------------------------------------------------------------
//   invited    someone typed an address into the share box
//   signed_up  an account was created through the link
//   converted  that account started paying
//   credited   the referrer's credit has actually been issued
//
// 'converted' and 'credited' look like the same event and are not. Credit is
// issued by a webhook that can fail — Stripe unreachable, D1 briefly down,
// the org having no Stripe customer yet. Collapsing the two would make a
// failed issuance indistinguishable from a referral that never qualified,
// which is precisely the case someone will email support about.
//
// ---------------------------------------------------------------------------
// Why the code is not guessable
// ---------------------------------------------------------------------------
// The obvious objection — "who cares, attributing a signup to someone else
// just gives THEM free money" — is wrong in one direction that matters. The
// link carries a per-year signup allowance. Anyone who could enumerate codes
// could burn a competitor's entire allowance with throwaway signups, which
// pauses their link and costs them every real referral for the rest of the
// window. So the suffix is 8 random base36 characters (~41 bits) rather than
// something short and memorable.

const SLUG_MAX = 20;
const SUFFIX_LEN = 8;

/** Signups a single link will attribute per window before pausing. */
export const DEFAULT_SIGNUP_LIMIT = 25;

/** How long a signup allowance window lasts. */
export const WINDOW_SECONDS = 60 * 60 * 24 * 365;

function newReferralId() {
  return "ref_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/** Lowercase, hyphenated, ASCII-only. Empty input yields "org". */
function slugify(name) {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return s || "org";
}

function randomSuffix() {
  const bytes = crypto.getRandomValues(new Uint8Array(SUFFIX_LEN));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] % 36).toString(36);
  return out;
}

/**
 * The public URL a code resolves to.
 *
 * `/api/r/<code>` rather than the prettier `/r/<code>` because the API Worker
 * only owns `algosize.com/api/*` — the bare path belongs to the marketing
 * site's Worker, and claiming it needs a Cloudflare route change nobody
 * should have to make before this feature works. If that route is later
 * added, REFERRAL_PATH is the single line to change.
 */
export const REFERRAL_PATH = "/api/r/";

export function referralLink(env, code) {
  const origin = (env && env.SITE_ORIGIN) || "https://algosize.com";
  return `${origin.replace(/\/$/, "")}${REFERRAL_PATH}${encodeURIComponent(code)}`;
}

/**
 * The org's referral code, minting one on first read.
 *
 * Lazily created rather than issued at signup so that an org which never
 * opens the referrals screen never has a row. Collision on the UNIQUE code
 * index is retried a few times; the suffix makes a genuine collision
 * vanishingly unlikely, but "vanishingly unlikely" over enough orgs is a
 * 500 someone eventually sees.
 */
export async function getOrCreateReferralCode(env, orgId, orgName) {
  if (!env || !env.DB || !orgId) return null;

  const existing = await readCode(env, orgId);
  if (existing) return rollWindowIfDue(env, existing);

  const now = Math.floor(Date.now() / 1000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `${slugify(orgName)}-${randomSuffix()}`;
    try {
      await env.DB.prepare(
        `INSERT INTO referral_codes
           (org_id, code, signups_used, signups_limit, window_ends_at, created_at)
         VALUES (?, ?, 0, ?, ?, ?)`)
        .bind(orgId, code, DEFAULT_SIGNUP_LIMIT, now + WINDOW_SECONDS, now)
        .run();
      return {
        orgId, code, signupsUsed: 0, signupsLimit: DEFAULT_SIGNUP_LIMIT,
        windowEndsAt: now + WINDOW_SECONDS, createdAt: now,
      };
    } catch {
      // Either the code collided or another request created this org's row
      // first. Both are resolved by reading — a second row for the same org
      // is impossible, org_id is the primary key.
      const row = await readCode(env, orgId);
      if (row) return rollWindowIfDue(env, row);
    }
  }
  return null;
}

async function readCode(env, orgId) {
  try {
    const r = await env.DB.prepare(
      `SELECT org_id, code, signups_used, signups_limit, window_ends_at, created_at
         FROM referral_codes WHERE org_id = ?`).bind(orgId).first();
    return r ? rowToCode(r) : null;
  } catch {
    return null;
  }
}

function rowToCode(r) {
  return {
    orgId:        r.org_id,
    code:         r.code,
    signupsUsed:  Number(r.signups_used) || 0,
    signupsLimit: Number(r.signups_limit) || DEFAULT_SIGNUP_LIMIT,
    windowEndsAt: r.window_ends_at ? Number(r.window_ends_at) : null,
    createdAt:    Number(r.created_at) || null,
  };
}

/**
 * Reset the allowance when its window has passed.
 *
 * Done on read rather than by a scheduled job: the allowance only matters at
 * the moment someone looks at it or spends it, and a cron that resets
 * thousands of rows nightly would be work nobody is waiting for.
 */
async function rollWindowIfDue(env, code) {
  const now = Math.floor(Date.now() / 1000);
  if (!code.windowEndsAt || code.windowEndsAt > now) return code;
  const nextEnd = now + WINDOW_SECONDS;
  try {
    await env.DB.prepare(
      "UPDATE referral_codes SET signups_used = 0, window_ends_at = ? WHERE org_id = ?")
      .bind(nextEnd, code.orgId).run();
  } catch { return code; }
  return { ...code, signupsUsed: 0, windowEndsAt: nextEnd };
}

/** Resolve a code to the org that owns it. Null for an unknown code. */
export async function orgForCode(env, code) {
  if (!env || !env.DB || !code) return null;
  try {
    const r = await env.DB.prepare(
      `SELECT org_id, code, signups_used, signups_limit, window_ends_at, created_at
         FROM referral_codes WHERE code = ?`).bind(String(code)).first();
    return r ? rowToCode(r) : null;
  } catch {
    return null;
  }
}

/** Every referral this org has made, newest first. */
export async function listReferrals(env, orgId, { limit = 100 } = {}) {
  if (!env || !env.DB || !orgId) return { referrals: [], complete: false };
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 200);
  try {
    const res = await env.DB.prepare(
      `SELECT referral_id, referred_org_id, label, stage, credit_cents, created_at, updated_at
         FROM referrals WHERE referrer_org_id = ?
        ORDER BY created_at DESC LIMIT ?`).bind(orgId, capped).all();
    return {
      referrals: ((res && res.results) || []).map((r) => ({
        referralId:  r.referral_id,
        label:       r.label,
        stage:       r.stage,
        creditCents: r.credit_cents == null ? null : Number(r.credit_cents),
        createdAt:   Number(r.created_at) || null,
        updatedAt:   Number(r.updated_at) || null,
      })),
      complete: true,
    };
  } catch {
    return { referrals: [], complete: false };
  }
}

/**
 * Record that an address was invited.
 *
 * Purely a bookkeeping entry — sharing a link does not require us to know who
 * it went to, and this exists so the referrer's own list reflects the people
 * they have actually approached. It does NOT consume the signup allowance:
 * the allowance exists to bound attributed signups, and letting someone
 * exhaust it by typing addresses into a box would be a self-inflicted denial
 * of service.
 */
export async function recordInvite(env, referrerOrgId, email) {
  if (!env || !env.DB || !referrerOrgId || !email) return null;
  const now = Math.floor(Date.now() / 1000);
  const referralId = newReferralId();
  try {
    await env.DB.prepare(
      `INSERT INTO referrals
         (referral_id, referrer_org_id, referred_org_id, label, stage, created_at, updated_at, credit_cents)
       VALUES (?, ?, NULL, ?, 'invited', ?, ?, NULL)`)
      .bind(referralId, referrerOrgId, String(email).toLowerCase(), now, now).run();
    return referralId;
  } catch {
    return null;
  }
}

/**
 * Attribute a newly-created org to a referral code.
 *
 * Refuses in three cases, each reported distinctly because they need
 * different responses from whoever is looking at the result:
 *
 *   unknown_code   the link was mistyped or the referrer was deleted
 *   self_referral  the code belongs to the org being referred. Not an error
 *                  worth surfacing to the signer-up, but never creditable.
 *   limit_reached  the allowance is spent. The signup still succeeds — this
 *                  function is called from a path where refusing to create
 *                  the account would be an absurd response to a referral
 *                  bookkeeping problem.
 *
 * Never throws, for the same reason: a signup must not fail because the
 * referral table did.
 */
export async function attributeSignup(env, code, { referredOrgId, label }) {
  if (!env || !env.DB || !code || !referredOrgId) {
    return { attributed: false, reason: "invalid_request" };
  }

  const owner = await orgForCode(env, code);
  if (!owner) return { attributed: false, reason: "unknown_code" };
  if (owner.orgId === referredOrgId) return { attributed: false, reason: "self_referral" };

  const rolled = await rollWindowIfDue(env, owner);
  if (rolled.signupsUsed >= rolled.signupsLimit) {
    return { attributed: false, reason: "limit_reached" };
  }

  const now = Math.floor(Date.now() / 1000);
  const referralId = newReferralId();
  try {
    // The UNIQUE index on referred_org_id is what makes this safe to call
    // more than once for the same org: a second attribution loses, which is
    // the correct outcome — an org is referred by exactly one referrer, and
    // the first link they came through is the one that counts.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO referrals
           (referral_id, referrer_org_id, referred_org_id, label, stage, created_at, updated_at, credit_cents)
         VALUES (?, ?, ?, ?, 'signed_up', ?, ?, NULL)`)
        .bind(referralId, rolled.orgId, referredOrgId, String(label || referredOrgId), now, now),
      env.DB.prepare(
        "UPDATE referral_codes SET signups_used = signups_used + 1 WHERE org_id = ?")
        .bind(rolled.orgId),
    ]);
    return { attributed: true, reason: null, referralId, referrerOrgId: rolled.orgId };
  } catch {
    return { attributed: false, reason: "already_attributed" };
  }
}

/**
 * The referral an org arrived through, if any — and only while it is still
 * waiting to be credited.
 *
 * Used by the webhook on first payment. Filtering to the two pre-credit
 * stages here rather than at the call site means a redelivered
 * `invoice.paid` for an already-credited referral finds nothing and does
 * nothing, without the caller having to remember that rule.
 */
export async function pendingReferralForOrg(env, referredOrgId) {
  if (!env || !env.DB || !referredOrgId) return null;
  try {
    const r = await env.DB.prepare(
      `SELECT referral_id, referrer_org_id, label, stage
         FROM referrals
        WHERE referred_org_id = ? AND stage IN ('signed_up','converted')`)
      .bind(referredOrgId).first();
    return r ? {
      referralId: r.referral_id, referrerOrgId: r.referrer_org_id,
      label: r.label, stage: r.stage,
    } : null;
  } catch {
    return null;
  }
}

/** Move a referral to a later stage, recording the credit when it lands. */
export async function setReferralStage(env, referralId, stage, { creditCents = null } = {}) {
  if (!env || !env.DB || !referralId) return false;
  try {
    await env.DB.prepare(
      `UPDATE referrals SET stage = ?, updated_at = ?,
              credit_cents = COALESCE(?, credit_cents)
        WHERE referral_id = ?`)
      .bind(stage, Math.floor(Date.now() / 1000), creditCents, referralId).run();
    return true;
  } catch {
    return false;
  }
}
