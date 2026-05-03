// POST /api/stripe/webhook
//
// Verifies Stripe's signature using Web Crypto, then handles:
//   checkout.session.completed   → idempotently create/refresh user (active)
//   customer.subscription.deleted → flip user subStatus to "inactive"
//
// All other event types are accepted with 200 so Stripe stops retrying.
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

import { verifyStripeSignature } from "../stripe.js";
import {
  upsertUserFromCheckout,
  setSubStatusByCustomerId,
} from "./_users.js";
import { captureException, captureMessage } from "../observability.js";

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

export async function stripeWebhookHandler(request, env, ctx) {
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
    return jsonResponse({ received: true, deduped: true, type: event.type });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(env, event);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(env, event);
        break;

      default:
        // Unknown event type — still mark processed so Stripe doesn't
        // retry an event we've already chosen to ignore. The body field
        // `handled: false` is preserved for backward compat with #17.
        await markProcessed(env, event.id);
        return jsonResponse({ received: true, handled: false, type: event.type });
    }

    // Only mark processed AFTER successful handling. If the handler threw
    // we fall into the catch block below which returns 500 → Stripe
    // retries → next attempt finds no dedup row → handler runs again.
    await markProcessed(env, event.id);
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
    return jsonResponse({ error: "handler_failed", message: err.message }, 500);
  }
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

  const updated = await setSubStatusByCustomerId(env, customerId, "inactive");
  if (!updated) {
    console.warn("customer.subscription.deleted: no user found for customer", customerId);
  }
}
