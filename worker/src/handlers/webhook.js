// POST /api/stripe/webhook
//
// Verifies Stripe's signature using Web Crypto, then handles:
//   checkout.session.completed          → idempotently create/refresh user
//   customer.subscription.created       → mirror status, period, seats, tier
//   customer.subscription.updated       → same (this is how a Portal tier or
//                                          seat change reaches our database)
//   customer.subscription.deleted       → cancel, keeping the paid-through date
//   customer.subscription.trial_will_end → 3-day trial reminder email
//   invoice.paid                        → back to active, clears past_due
//   invoice.payment_failed              → past_due + dunning email
//
// All other event types are accepted with 200 so Stripe stops retrying.
//
// Until the lifecycle events above were added, the only two we handled were
// checkout and cancel, which left the database wrong in every case in
// between: a customer who changed tier or seat count in the Customer Portal
// kept whatever they first signed up with, and a failed payment was invisible
// — no status change, no email, no dunning at all.
//
// `sub_status` therefore now carries Stripe's own subscription status
// ("active" | "trialing" | "past_due" | "canceled" | "unpaid" | "incomplete"
// | …) rather than only the "active"/"inactive" pair the original two
// handlers wrote. src/entitlement.js owns the mapping from that status to
// what we actually serve; nothing here decides access.
//
// `plan` stays "paid" across every one of these transitions, including
// cancellation. It records that this is a billing account, not whether the
// account is currently entitled — that question is `sub_status` plus
// `current_period_end`, and it has exactly one reader.
//
// Stripe webhooks are server-to-server: we can't set cookies on the user's
// browser from here. The user-facing cookie + redirect happens in the
// /api/checkout/success handler (see handlers/checkout.js). The webhook is
// the source of truth for subscription state changes (especially cancels).
//
// Idempotency (Task #20): Stripe is at-least-once delivery — retries on
// 5xx responses and occasional duplicates from their side mean the same
// event id can arrive twice. We dedup on `event.id` using a key in the
// SESSIONS KV namespace (`stripeEvent:<id>`, 7-day TTL — longer than
// Stripe's max retry window of ~3 days). The check runs AFTER signature
// verification so an attacker can't pollute our dedup table by spamming
// the endpoint with bogus event ids.

import { verifyStripeSignature, stripeFetch } from "../stripe.js";
import { upsertUserFromCheckout } from "./_users.js";
import {
  getOrgByCustomerId,
  getOrgBillingEmail,
  updateOrgSubscriptionByCustomerId,
  setOrgSubStatusByCustomerId,
} from "./_orgs.js";
import { captureException, captureMessage } from "../observability.js";
import { sendTransactional as defaultSendTransactional } from "../email/transactional.js";
import { paymentFailed, trialEndingSoon } from "../email/templates.js";
import { recordWebhookDelivery, recordEmailSend, WEBHOOK_OUTCOME } from "../oplog.js";
import { writeAudit, AUDIT_ACTIONS, SYSTEM_ACTOR } from "../audit.js";

// 7 days, a few days longer than Stripe's documented retry window. Picked
// long enough that a delayed retry can't slip past the dedup table, short
// enough that the table doesn't grow unbounded — at typical event volumes
// (a few hundred /day) this caps live keys around the low thousands.
const STRIPE_EVENT_TTL_SECONDS = 60 * 60 * 24 * 7;

function eventDedupKey(eventId) {
  return `stripeEvent:${eventId}`;
}

/** True if we've already successfully handled this Stripe event id. */
async function hasProcessed(env, eventId) {
  if (!eventId) return false;          // defensive — can't dedup what has no id
  const hit = await env.SESSIONS.get(eventDedupKey(eventId));
  return hit !== null;
}

/**
 * Mark an event id as processed. Called only AFTER successful handling so
 * a transient KV/handler failure leaves the slot open for Stripe's next
 * retry to actually do the work.
 */
async function markProcessed(env, eventId) {
  if (!eventId) return;
  await env.SESSIONS.put(eventDedupKey(eventId), "1", {
    expirationTtl: STRIPE_EVENT_TTL_SECONDS,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `sendTransactional` is injectable so the lifecycle tests can assert exactly
 * how many emails a given event produced without a Gmail credential. The
 * router calls this with three arguments and gets the real sender.
 */
/**
 * Best-effort org attribution for a delivery row.
 *
 * Every event we handle carries a Stripe customer somewhere on data.object,
 * and the org is indexed by that customer id — so this is one indexed read,
 * not a scan. Returning null is a fine outcome: an unattributed delivery
 * still belongs in the global feed, and inventing an org for it would be
 * worse than leaving the column empty.
 */
async function orgIdForEvent(env, event) {
  try {
    const obj = (event && event.data && event.data.object) || {};
    const customerId = typeof obj.customer === "string" ? obj.customer : (obj.customer && obj.customer.id);
    if (!customerId) return null;
    const org = await getOrgByCustomerId(env, customerId);
    return (org && org.orgId) || null;
  } catch {
    return null;
  }
}

export async function stripeWebhookHandler(request, env, ctx, { sendTransactional: sendTxOverride } = {}) {
  const send = sendTxOverride || defaultSendTransactional;
  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error("webhook: STRIPE_WEBHOOK_SECRET is not set");
    // Observability (Task #22): a missing webhook secret is a deploy-time
    // misconfig — capture so it shows up in Sentry alongside the 500.
    await captureException(env, ctx, new Error("STRIPE_WEBHOOK_SECRET is not set"), {
      request, level: "fatal",
      tags: { source: "webhook", reason: "missing_secret" },
    });
    return jsonResponse({ error: "server_misconfigured" }, 500);
  }

  // We MUST read the exact bytes Stripe sent — re-stringifying JSON would
  // break the signature.
  const rawBody = await request.text();
  const sigHeader = request.headers.get("Stripe-Signature") || request.headers.get("stripe-signature");

  const verdict = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!verdict.ok) {
    // Observability (Task #22): signature failures are notable but not
    // exceptions (no stack trace would be meaningful — the failure is a
    // mismatch on a value comparison, not a thrown error). Intentional
    // choice to use captureMessage at "warning" level so Sentry's noise
    // filter doesn't page on a single drop, but a sudden spike (=
    // attacker probing or a key rotation gone wrong) is visible. The
    // verdict_reason tag carries the triage info that a stack would
    // have given us.
    await captureMessage(env, ctx, `stripe signature verification failed: ${verdict.reason}`, {
      request, level: "warning",
      tags: { source: "webhook", reason: "bad_signature", verdict_reason: verdict.reason || "unknown" },
    });
    return jsonResponse({ error: "invalid_signature", reason: verdict.reason }, 400);
  }

  let event;
  try { event = JSON.parse(rawBody); } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  // Dedup BEFORE dispatch. Returning 200 (not 4xx) tells Stripe "we got
  // this, stop retrying" — same outward behavior as a fresh successful
  // handle, just with `deduped: true` so operators can grep for replay
  // activity in logs.
  if (await hasProcessed(env, event.id)) {
    // Logged as `duplicate`, not as an error. A replay that we correctly
    // refused to apply twice is the system working; a feed that paints it
    // red teaches whoever reads it to ignore red rows.
    await recordWebhookDelivery(env, ctx, {
      eventId: event.id, eventType: event.type,
      orgId: null, outcome: WEBHOOK_OUTCOME.DUPLICATE,
    });
    return jsonResponse({ received: true, deduped: true, type: event.type });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(env, event);
        break;

      // Both carry the same object and the same fields we care about, so
      // they share a handler. `.created` also fires for subscriptions started
      // outside checkout (Stripe dashboard, API), which is the case the
      // checkout-only flow used to miss entirely.
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionUpsert(env, ctx, event);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(env, event);
        break;

      case "customer.subscription.trial_will_end":
        await handleTrialWillEnd(env, ctx, event, send);
        break;

      case "invoice.paid":
        await handleInvoicePaid(env, ctx, event);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(env, ctx, event, send);
        break;

      default:
        // Unknown event type — still mark processed so Stripe doesn't
        // retry an event we've already chosen to ignore. The body field
        // `handled: false` is preserved for backward compat with #17.
        await markProcessed(env, event.id);
        await recordWebhookDelivery(env, ctx, {
          eventId: event.id, eventType: event.type,
          orgId: null, outcome: WEBHOOK_OUTCOME.IGNORED,
        });
        return jsonResponse({ received: true, handled: false, type: event.type });
    }

    // Only mark processed AFTER successful handling. If the handler threw
    // we fall into the catch block below which returns 500 → Stripe
    // retries → next attempt finds no dedup row → handler runs again.
    await markProcessed(env, event.id);
    await recordWebhookDelivery(env, ctx, {
      eventId: event.id, eventType: event.type,
      orgId: await orgIdForEvent(env, event), outcome: WEBHOOK_OUTCOME.PROCESSED,
    });
    return jsonResponse({ received: true, handled: event.type });
  } catch (err) {
    console.error("webhook handler error", event.type, err);
    // Observability (Task #22): always tag with the Stripe event id so
    // we can pivot in Sentry from a single failed delivery to the user
    // it was for, and back to the Stripe dashboard's event row. The
    // 500 returned below makes Stripe retry with backoff — desired
    // behavior for a transient KV blip.
    await captureException(env, ctx, err, {
      request,
      tags: {
        source: "webhook",
        event_type: event.type,
        stripe_event_id: event.id || "unknown",
      },
    });
    // Recorded BEFORE the 500 that makes Stripe retry, so the feed shows the
    // failed attempt and the later successful one as two rows. A log that
    // only kept the eventual success would hide the retry entirely, and the
    // retry is the thing worth noticing.
    await recordWebhookDelivery(env, ctx, {
      eventId: event.id, eventType: event.type,
      orgId: null, outcome: WEBHOOK_OUTCOME.FAILED,
      error: (err && err.message) || String(err),
    });
    return jsonResponse({ error: "handler_failed", message: err.message }, 500);
  }
}

/**
 * Log a billing state change under the reserved `system` actor.
 *
 * These changes are made by Stripe, not by a person — and attributing them to
 * whoever happened to be signed in would be worse than not logging them at
 * all. Only fields that actually moved are recorded, so a `.updated` event
 * that changed nothing we store does not manufacture an audit entry.
 */
async function auditBillingChange(env, ctx, before, after, eventType) {
  if (!before && !after) return;
  const org = after || before;
  const changes = {};
  const compare = [
    ["plan",            "plan"],
    ["subStatus",       "subStatus"],
    ["priceId",         "priceId"],
    ["seatsPurchased",  "seatsPurchased"],
    ["currentPeriodEnd", "currentPeriodEnd"],
  ];
  for (const [key] of compare) {
    const from = before ? before[key] : undefined;
    const to   = after  ? after[key]  : undefined;
    if (from !== to) changes[key] = { from: from ?? null, to: to ?? null };
  }
  if (Object.keys(changes).length === 0) return;

  await writeAudit(env, ctx, {
    actor:      SYSTEM_ACTOR,
    action:     AUDIT_ACTIONS.PLAN_CHANGED,
    targetType: "org",
    targetId:   org.orgId,
    orgId:      org.orgId,
    metadata:   { event: eventType, changes },
  });
}

async function handleCheckoutCompleted(env, event) {
  const session = event.data?.object;
  if (!session) throw new Error("event missing data.object");

  const email = session.customer_details?.email || session.customer_email;
  const customerId = typeof session.customer === "string"
    ? session.customer
    : session.customer?.id;

  if (!email || !customerId) {
    // Nothing we can do — log and ack so Stripe doesn't loop forever.
    console.warn("checkout.session.completed missing email or customer", {
      sessionId: session.id, email, customerId,
    });
    return;
  }

  // The user row carries identity; the ORG carries billing (migrations/0004).
  // upsertUserFromCheckout attaches the customer to the payer's organisation,
  // creating one if this payment is the first thing we've seen from them.
  await upsertUserFromCheckout(env, {
    email,
    stripeCustomerId: customerId,
    subStatus: "active",
  });
}

async function handleSubscriptionDeleted(env, event) {
  const sub = event.data?.object;
  if (!sub) throw new Error("event missing data.object");

  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) {
    console.warn("customer.subscription.deleted missing customer id", { subId: sub.id });
    return;
  }

  // Record what the customer already paid for. src/entitlement.js serves paid
  // features until this timestamp and free after it, which is what turns a
  // cancellation into an actual downgrade instead of a no-op. Stripe sends
  // unix seconds; a missing value leaves the stored one alone.
  const periodEnd = typeof sub.current_period_end === "number" ? sub.current_period_end : null;

  const before  = await getOrgByCustomerId(env, customerId);
  const updated = await setOrgSubStatusByCustomerId(env, customerId, "inactive", periodEnd);
  if (!updated) {
    console.warn("customer.subscription.deleted: no org found for customer", customerId);
    return;
  }
  await auditBillingChange(env, null, before, await getOrgByCustomerId(env, customerId), event.type);
}

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

/**
 * customer.subscription.created / .updated — mirror the subscription onto the
 * user row. This is the only path by which a tier switch or a seat-count
 * change made in the Stripe Customer Portal reaches our database; without it
 * the customer's invoice and their entitlement drift apart silently.
 */
async function handleSubscriptionUpsert(env, ctx, event) {
  const sub = event.data?.object;
  if (!sub) throw new Error("event missing data.object");

  const customerId = customerIdOf(sub);
  if (!customerId) {
    console.warn(`${event.type} missing customer id`, { subId: sub.id });
    return;
  }

  const fields  = subscriptionFields(sub);
  const before  = await getOrgByCustomerId(env, customerId);
  const updated = await updateOrgSubscriptionByCustomerId(env, customerId, fields);
  if (updated) {
    await auditBillingChange(env, ctx, before, await getOrgByCustomerId(env, customerId), event.type);
    return;
  }

  // No org for this customer. Two ways to get here, both real: a subscription
  // created straight from the Stripe dashboard/API (never went through our
  // checkout), or `.created` overtaking `checkout.session.completed` in
  // delivery order. Recover the email from Stripe and attach, so the seat
  // count and tier aren't lost until the next subscription update.
  const email = await resolveCustomerEmail(env, ctx, sub, customerId);
  if (!email) {
    console.warn(`${event.type}: no org for customer and no email to create one`, customerId);
    return;
  }

  await upsertUserFromCheckout(env, {
    email,
    stripeCustomerId: customerId,
    subStatus: fields.subStatus,
  });
  // That attaches the customer to an org and writes identity and status; the
  // remaining subscription columns are filled in by a second pass, now that
  // the customer id resolves to an org.
  await updateOrgSubscriptionByCustomerId(env, customerId, fields);
  await auditBillingChange(env, ctx, null, await getOrgByCustomerId(env, customerId), event.type);
}

/**
 * invoice.paid — the renewal succeeded (or a dunning retry finally landed).
 * Returns the account to `active`, which clears a `past_due` set by an earlier
 * failure, and advances the paid-through date to the period just bought.
 */
async function handleInvoicePaid(env, ctx, event) {
  const invoice = event.data?.object;
  if (!invoice) throw new Error("event missing data.object");

  const customerId = customerIdOf(invoice);
  if (!customerId) {
    console.warn("invoice.paid missing customer id", { invoiceId: invoice.id });
    return;
  }

  const updated = await updateOrgSubscriptionByCustomerId(env, customerId, {
    plan:             "paid",
    subStatus:        "active",
    // `undefined` when the invoice carries no line period, which leaves the
    // stored paid-through date alone rather than clearing it.
    currentPeriodEnd: invoicePeriodEnd(invoice),
  });
  if (!updated) {
    console.warn("invoice.paid: no org found for customer", customerId);
  }
}

/**
 * invoice.payment_failed — flag the account `past_due` and tell the customer.
 *
 * `past_due` does NOT cut access off here: src/entitlement.js keeps serving
 * until `current_period_end`, which is what gives Stripe's ~2 weeks of retries
 * room to succeed. The email is the actual product behaviour — a silent
 * failure is how a subscription dies of an expired card.
 */
async function handleInvoicePaymentFailed(env, ctx, event, send) {
  const invoice = event.data?.object;
  if (!invoice) throw new Error("event missing data.object");

  const customerId = customerIdOf(invoice);
  if (!customerId) {
    console.warn("invoice.payment_failed missing customer id", { invoiceId: invoice.id });
    return;
  }

  const org = await updateOrgSubscriptionByCustomerId(env, customerId, {
    subStatus: "past_due",
  });
  if (!org) {
    console.warn("invoice.payment_failed: no org found for customer", customerId);
    return;
  }

  // Dunning goes to whoever owns the billing relationship, not to whichever
  // member happened to trigger something — on a seated plan those are
  // routinely different people, and only the owner can fix the card.
  const billingEmail = await getOrgBillingEmail(env, org.orgId);
  if (!billingEmail) return;

  // Awaited rather than queued on ctx.waitUntil: sendTransactional never
  // throws (it funnels its own failures to Sentry), so awaiting cannot turn a
  // mail outage into a 500 and a Stripe retry storm. What it does buy is that
  // the dedup row is only written once the send has been attempted, and the
  // event dedup above is what makes "exactly one email per failed invoice"
  // true even when Stripe redelivers.
  const result = await send(env, ctx, {
    to: billingEmail,
    ...paymentFailed({
      email:        billingEmail,
      amountDue:    formatMoney(invoice.amount_due, invoice.currency),
      accessEndsOn: formatDateUtc(org.currentPeriodEnd),
      payUrl:       invoice.hosted_invoice_url || null,
      attemptCount: typeof invoice.attempt_count === "number" ? invoice.attempt_count : null,
    }),
  });
  // Of every message this Worker sends, this is the one whose non-delivery
  // costs the most: the customer loses access on a card they were never told
  // had failed.
  await recordEmailSend(env, ctx, {
    recipient: billingEmail, template: "payment_failed", orgId: org.orgId, result,
  });
}

/**
 * customer.subscription.trial_will_end — Stripe fires this three days before
 * a trial converts. Purely a notification: no row changes, because nothing
 * about the subscription has changed yet.
 */
async function handleTrialWillEnd(env, ctx, event, send) {
  const sub = event.data?.object;
  if (!sub) throw new Error("event missing data.object");

  const customerId = customerIdOf(sub);
  if (!customerId) {
    console.warn("customer.subscription.trial_will_end missing customer id", { subId: sub.id });
    return;
  }

  const org = await getOrgByCustomerId(env, customerId);
  const billingEmail = org && await getOrgBillingEmail(env, org.orgId);
  if (!billingEmail) {
    console.warn("customer.subscription.trial_will_end: no org found for customer", customerId);
    return;
  }

  const price = firstItem(sub)?.price;
  const result = await send(env, ctx, {
    to: billingEmail,
    ...trialEndingSoon({
      email:       billingEmail,
      trialEndsOn: formatDateUtc(sub.trial_end),
      amount:      price ? formatMoney(price.unit_amount, price.currency) : null,
    }),
  });
  await recordEmailSend(env, ctx, {
    recipient: billingEmail, template: "trial_ending", orgId: org.orgId, result,
  });
}

// ---------------------------------------------------------------------------
// Stripe object readers
//
// Every one of these tolerates a missing field rather than throwing: a webhook
// that 500s is a webhook Stripe retries forever, and none of these values is
// worth blocking the rest of the update on.
// ---------------------------------------------------------------------------

/** `customer` is an id string, or an expanded object when the caller expanded it. */
function customerIdOf(obj) {
  return typeof obj.customer === "string" ? obj.customer : obj.customer?.id || null;
}

function firstItem(sub) {
  return sub.items?.data?.[0] || null;
}

/**
 * Stripe moved `current_period_end` from the subscription onto the
 * subscription item in the 2025-03-31 API version. Read both so the handler
 * keeps working across an API-version bump on the Stripe side, which is a
 * setting we don't control from here.
 */
function subscriptionPeriodEnd(sub) {
  if (typeof sub.current_period_end === "number") return sub.current_period_end;
  const item = firstItem(sub);
  if (item && typeof item.current_period_end === "number") return item.current_period_end;
  return undefined;
}

function invoicePeriodEnd(invoice) {
  const line = invoice.lines?.data?.[0];
  return typeof line?.period?.end === "number" ? line.period.end : undefined;
}

/**
 * Map a Stripe subscription onto the columns we store. Fields Stripe didn't
 * send are left `undefined`, which updateSubscriptionByCustomerId reads as
 * "don't touch" — so a partial event can't blank a column we already know.
 */
function subscriptionFields(sub) {
  const item = firstItem(sub);
  return {
    // Always "paid": this records that the account bills through Stripe, not
    // that it is currently entitled. See the header.
    plan:             "paid",
    subStatus:        typeof sub.status === "string" && sub.status ? sub.status : "inactive",
    currentPeriodEnd: subscriptionPeriodEnd(sub),
    // The line-item quantity IS the seat count — this is what makes a seat
    // change made in the Customer Portal reach the invite gate.
    seatsPurchased:   typeof item?.quantity === "number" ? item.quantity : undefined,
    priceId:          item?.price?.id || undefined,
  };
}

/**
 * Find the email for a customer we have no row for. Prefers the expanded
 * customer object on the event; otherwise asks Stripe. Never throws — a
 * failure here means we skip creating the row, not that the whole event fails.
 */
async function resolveCustomerEmail(env, ctx, sub, customerId) {
  if (sub.customer && typeof sub.customer === "object" && sub.customer.email) {
    return sub.customer.email;
  }
  if (!env.STRIPE_SECRET_KEY) return null;
  try {
    const customer = await stripeFetch(env, `/customers/${encodeURIComponent(customerId)}`, { method: "GET" });
    return customer?.email || null;
  } catch (err) {
    await captureMessage(env, ctx, `stripe customer lookup failed for ${customerId}: ${err.message}`, {
      level: "warning",
      tags: { source: "webhook", reason: "customer_lookup_failed" },
    });
    return null;
  }
}

/** Unix seconds → "June 1, 2026" in UTC. Null-safe: returns null, not "Invalid Date". */
function formatDateUtc(unixSeconds) {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/**
 * Stripe's minor units → a display string ("$29.00"). Zero-decimal currencies
 * (JPY, KRW) are not divided by 100 — doing so would show a customer ¥2.90
 * for a ¥290 charge.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

function formatMoney(amountMinorUnits, currency) {
  if (typeof amountMinorUnits !== "number" || !Number.isFinite(amountMinorUnits)) return null;
  const code = (currency || "usd").toLowerCase();
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(code);
  const value = zeroDecimal ? amountMinorUnits : amountMinorUnits / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code.toUpperCase(),
      minimumFractionDigits: zeroDecimal ? 0 : 2,
    }).format(value);
  } catch {
    // Unknown currency code — still show the customer a number.
    return `${value.toFixed(zeroDecimal ? 0 : 2)} ${code.toUpperCase()}`;
  }
}
