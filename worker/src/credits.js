// The credit ledger.
//
// Credit reduces an Algosize invoice. It is never paid out, never
// transferred, and never converted to cash — not because that is unimplemented
// but because paying money out to customers is a money-transmission question
// and the product promise is a discount. Every surface that renders a balance
// says so in words, not in a footnote.
//
// ---------------------------------------------------------------------------
// Append-only, and why
// ---------------------------------------------------------------------------
// A balance is the SUM of its events. There is no balance column anywhere,
// because a balance column is a number that can disagree with the history
// that produced it, and the first time it does you cannot tell which one is
// wrong. Correcting a mistake means writing a compensating 'adjusted' event,
// which leaves the record intact and legible.
//
// ---------------------------------------------------------------------------
// Two ledgers, one direction of travel
// ---------------------------------------------------------------------------
// Stripe also keeps a balance for every customer, and Stripe's is the one
// that actually reduces an invoice. Ours is the one that explains WHY. They
// are kept in step by making the flow strictly one-way: we write our event
// first, then push it to Stripe, then record Stripe's transaction id back on
// our row. Nothing ever reads Stripe's balance and writes ours from it.
//
// The failure that matters is the middle step: our row exists, Stripe's does
// not, `stripe_txn_id` is NULL. That means we are showing a customer credit
// that will not actually come off their next invoice. It is reported by
// `creditBalance` as `unsynced`, and the account API surfaces it rather than
// hiding it — a discount that silently fails to apply is a billing dispute,
// and it should be visible before the invoice, not after.
//
// ---------------------------------------------------------------------------
// Sign convention — read this before touching the Stripe call
// ---------------------------------------------------------------------------
// OURS:    positive = credit the customer HAS. Earning is +12000.
//                     Applying it to an invoice is -12000.
// STRIPE'S: NEGATIVE = credit the customer has. Stripe models the balance as
//                     "what the customer owes", so a credit is a debt we owe
//                     them, i.e. a negative number.
//
// The two are opposite. Every crossing between them goes through
// `toStripeAmount` below and nowhere else, so there is exactly one line in
// this codebase where the sign flips and it is labelled.

import { stripeFetch } from "./stripe.js";

/** Cents. All money in this module is integer cents, matching Stripe. */
export const CENT = 1;

/** What a completed referral is worth to the referrer. */
export const REFERRAL_CREDIT_CENTS = 12000;   // $120.00

/** How long earned referral credit stays spendable. */
export const CREDIT_TTL_SECONDS = 60 * 60 * 24 * 365;   // 12 months

function newEventId() {
  return "crd_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/** The one place our sign convention becomes Stripe's. See the header. */
function toStripeAmount(ourCents) {
  return -ourCents;
}

/**
 * Format cents as a display string. Used by the API so the UI never has to
 * decide how to round money, and so the number in an email and the number on
 * screen are produced by the same function.
 */
export function formatCents(cents) {
  const n = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * An org's credit position.
 *
 * Returns `{ balanceCents, earnedCents, unsyncedCents, expiringCents,
 * expiringAt, complete }`.
 *
 * `complete: false` means the ledger could not be read at all — a pre-0015
 * database or an unreachable D1. The caller must render that as unknown, not
 * as zero: telling someone they have no credit when we simply could not look
 * is the one wrong answer this function must never give.
 */
export async function creditBalance(env, orgId) {
  const empty = {
    balanceCents: 0, earnedCents: 0, unsyncedCents: 0,
    expiringCents: 0, expiringAt: null, complete: false,
  };
  if (!env || !env.DB || !orgId) return empty;

  try {
    const row = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(amount_cents), 0)                                        AS balance,
         COALESCE(SUM(CASE WHEN kind = 'earned' THEN amount_cents ELSE 0 END), 0) AS earned,
         COALESCE(SUM(CASE WHEN kind = 'earned' AND stripe_txn_id IS NULL
                           THEN amount_cents ELSE 0 END), 0)                   AS unsynced
       FROM credit_events WHERE org_id = ?`).bind(orgId).first();

    // The soonest expiry that still has unspent credit behind it. Approximate
    // by design: credit is fungible, so "which $120 expires" is a question
    // with no true answer. Showing the nearest expiry date on the smaller of
    // (that grant, the whole balance) is the honest version of a question
    // that does not have an exact one.
    const next = await env.DB.prepare(
      `SELECT amount_cents, expires_at FROM credit_events
        WHERE org_id = ? AND kind = 'earned' AND expires_at IS NOT NULL AND expires_at > ?
        ORDER BY expires_at ASC LIMIT 1`)
      .bind(orgId, Math.floor(Date.now() / 1000)).first();

    const balanceCents = Number(row && row.balance) || 0;
    return {
      balanceCents,
      earnedCents:   Number(row && row.earned) || 0,
      unsyncedCents: Number(row && row.unsynced) || 0,
      expiringCents: next ? Math.min(Number(next.amount_cents) || 0, Math.max(balanceCents, 0)) : 0,
      expiringAt:    next ? Number(next.expires_at) || null : null,
      complete: true,
    };
  } catch {
    return empty;
  }
}

/**
 * The credit history, newest first. Rendered verbatim in the account area, so
 * `description` is written at event time and never reconstructed later — by
 * the time someone reads it the referral it names may have been deleted.
 */
export async function listCreditEvents(env, orgId, { limit = 50 } = {}) {
  if (!env || !env.DB || !orgId) return { events: [], complete: false };
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    const res = await env.DB.prepare(
      `SELECT event_id, kind, amount_cents, description, referral_id,
              stripe_txn_id, expires_at, created_at
         FROM credit_events WHERE org_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`).bind(orgId, capped).all();
    return {
      events: ((res && res.results) || []).map((r) => ({
        eventId:     r.event_id,
        kind:        r.kind,
        amountCents: Number(r.amount_cents) || 0,
        amount:      formatCents(Number(r.amount_cents) || 0),
        description: r.description,
        referralId:  r.referral_id || null,
        // Surfaced per-row, not just in aggregate: "this specific $120 has not
        // reached Stripe" is more actionable than "$120 of your balance hasn't".
        syncedToStripe: !!r.stripe_txn_id,
        expiresAt:   r.expires_at ? Number(r.expires_at) : null,
        createdAt:   Number(r.created_at) || null,
      })),
      complete: true,
    };
  } catch {
    return { events: [], complete: false };
  }
}

/**
 * Write one ledger event.
 *
 * Ledger-only — it does not talk to Stripe. `earnCredit` is the function that
 * does both, and it is the one every caller should reach for; this is
 * separate so the ledger write can succeed independently of Stripe being up.
 */
export async function recordCreditEvent(env, {
  orgId, kind, amountCents, description, referralId = null,
  stripeTxnId = null, expiresAt = null,
}) {
  if (!env || !env.DB || !orgId) return null;
  const eventId = newEventId();
  await env.DB.prepare(
    `INSERT INTO credit_events
       (event_id, org_id, kind, amount_cents, description, referral_id,
        stripe_txn_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, orgId, kind, amountCents, description, referralId,
          stripeTxnId, expiresAt, Math.floor(Date.now() / 1000))
    .run();
  return eventId;
}

/**
 * Grant credit and push it to Stripe.
 *
 * Order matters and is not interchangeable. The ledger row is written FIRST,
 * without a Stripe transaction id, and only then is Stripe called. If Stripe
 * fails we are left owing the customer a discount we can see and retry; if we
 * called Stripe first and our write failed, the customer would have credit
 * nobody could explain and nothing would ever reconcile it.
 *
 * Never throws. A referral that qualifies must not be lost because Stripe had
 * a bad minute — the webhook that calls this has already been acknowledged by
 * the time we get here, and throwing would make Stripe redeliver an event
 * whose only remaining work is a retryable side effect.
 *
 * @returns {Promise<{ok, eventId, stripeTxnId, reason}>}
 */
export async function earnCredit(env, {
  orgId, stripeCustomerId, amountCents, description, referralId = null,
  expiresAt = Math.floor(Date.now() / 1000) + CREDIT_TTL_SECONDS,
}) {
  if (!env || !env.DB || !orgId || !Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, eventId: null, stripeTxnId: null, reason: "invalid_request" };
  }

  let eventId;
  try {
    eventId = await recordCreditEvent(env, {
      orgId, kind: "earned", amountCents, description, referralId, expiresAt,
    });
  } catch (err) {
    console.error("credits: ledger write failed", err);
    return { ok: false, eventId: null, stripeTxnId: null, reason: "ledger_write_failed" };
  }

  // A free org has no Stripe customer yet. The credit is real and stays on
  // the ledger; it reaches Stripe the first time they check out, via
  // syncUnsyncedCredit below. Reporting this as a failure would be wrong —
  // nothing went wrong, there is simply nowhere to put it yet.
  if (!stripeCustomerId || !env.STRIPE_SECRET_KEY) {
    return { ok: true, eventId, stripeTxnId: null, reason: "no_stripe_customer" };
  }

  try {
    const txn = await stripeFetch(env, `/customers/${encodeURIComponent(stripeCustomerId)}/balance_transactions`, {
      method: "POST",
      body: {
        amount:      toStripeAmount(amountCents),   // negative — see header
        currency:    "usd",
        description: description || "Algosize referral credit",
      },
      // The referral is the natural idempotency key: a webhook redelivery for
      // the same referral must not credit twice, and Stripe enforcing that is
      // stronger than us checking first and racing with ourselves.
      idempotencyKey: referralId ? `credit_${referralId}` : `credit_${eventId}`,
    });
    if (txn && txn.id) {
      await env.DB.prepare("UPDATE credit_events SET stripe_txn_id = ? WHERE event_id = ?")
        .bind(txn.id, eventId).run();
      return { ok: true, eventId, stripeTxnId: txn.id, reason: null };
    }
    return { ok: true, eventId, stripeTxnId: null, reason: "stripe_no_id" };
  } catch (err) {
    console.error("credits: stripe balance transaction failed", err);
    return { ok: true, eventId, stripeTxnId: null, reason: "stripe_unreachable" };
  }
}

/**
 * Push any earned credit that never reached Stripe.
 *
 * Called when an org acquires a Stripe customer (checkout) and available for
 * an operator to run against a specific org after an outage. Idempotent per
 * event: the event id is the Stripe idempotency key, so re-running cannot
 * double-credit.
 */
export async function syncUnsyncedCredit(env, orgId, stripeCustomerId) {
  if (!env || !env.DB || !orgId || !stripeCustomerId || !env.STRIPE_SECRET_KEY) {
    return { synced: 0, failed: 0 };
  }
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT event_id, amount_cents, description, referral_id
         FROM credit_events
        WHERE org_id = ? AND kind = 'earned' AND stripe_txn_id IS NULL`).bind(orgId).all();
    rows = (res && res.results) || [];
  } catch {
    return { synced: 0, failed: 0 };
  }

  let synced = 0, failed = 0;
  for (const r of rows) {
    try {
      const txn = await stripeFetch(env, `/customers/${encodeURIComponent(stripeCustomerId)}/balance_transactions`, {
        method: "POST",
        body: {
          amount:      toStripeAmount(Number(r.amount_cents) || 0),
          currency:    "usd",
          description: r.description || "Algosize referral credit",
        },
        idempotencyKey: r.referral_id ? `credit_${r.referral_id}` : `credit_${r.event_id}`,
      });
      if (txn && txn.id) {
        await env.DB.prepare("UPDATE credit_events SET stripe_txn_id = ? WHERE event_id = ?")
          .bind(txn.id, r.event_id).run();
        synced += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { synced, failed };
}
