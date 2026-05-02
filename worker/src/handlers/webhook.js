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

import { verifyStripeSignature } from "../stripe.js";
import {
  upsertUserFromCheckout,
  setSubStatusByCustomerId,
} from "./_users.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function stripeWebhookHandler(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error("webhook: STRIPE_WEBHOOK_SECRET is not set");
    return jsonResponse({ error: "server_misconfigured" }, 500);
  }

  // We MUST read the exact bytes Stripe sent — re-stringifying JSON would
  // break the signature.
  const rawBody = await request.text();
  const sigHeader = request.headers.get("Stripe-Signature") || request.headers.get("stripe-signature");

  const verdict = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!verdict.ok) {
    return jsonResponse({ error: "invalid_signature", reason: verdict.reason }, 400);
  }

  let event;
  try { event = JSON.parse(rawBody); } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(env, event);
        return jsonResponse({ received: true, handled: event.type });

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(env, event);
        return jsonResponse({ received: true, handled: event.type });

      default:
        // Acknowledge every other event so Stripe stops retrying.
        return jsonResponse({ received: true, handled: false, type: event.type });
    }
  } catch (err) {
    console.error("webhook handler error", event.type, err);
    // 500 → Stripe retries with backoff. That's the right thing for a
    // transient KV error.
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
