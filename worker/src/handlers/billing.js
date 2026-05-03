// POST /api/billing/portal — open the Stripe-hosted Customer Portal.
//
// The portal lets users update their card, download invoices, switch plans,
// or cancel — all without us building any billing UI of our own. Stripe
// hosts the entire experience; we just mint a one-shot session URL keyed
// to the user's saved `stripeCustomerId` and redirect.
//
// Auth: gated by `requireAuth` in the router, which attaches
// `request.user = { userId, email, subStatus }` after verifying the JWT.
// We re-read from USERS KV so we always have the latest stripeCustomerId
// (the JWT payload doesn't carry it) and so we can 400 cleanly if the user
// has no Stripe customer attached (e.g. legacy free-tier rows from a
// future Task #19, or a corrupted record).
//
// State changes triggered inside the portal (cancel, payment-method swap)
// arrive back as Stripe webhooks → handlers/webhook.js, which is already
// wired to flip subStatus on `customer.subscription.deleted`. The dashboard
// re-hydrates from /api/me on next page load and reflects the new state.

import { stripeFetch } from "../stripe.js";
import { getUserById } from "./_users.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function billingPortalHandler(request, env) {
  const sessionUser = request.user || {};
  if (!sessionUser.userId) {
    // requireAuth should have short-circuited — defensive belt-and-braces.
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const user = await getUserById(env, sessionUser.userId);
  if (!user || !user.stripeCustomerId) {
    return jsonResponse(
      {
        error:   "no_stripe_customer",
        message: "No Stripe customer is attached to this account. Contact support if this is unexpected.",
      },
      400,
    );
  }

  let session;
  try {
    session = await stripeFetch(env, "/billing_portal/sessions", {
      method: "POST",
      body: {
        customer:   user.stripeCustomerId,
        return_url: `${env.SITE_ORIGIN}/dashboard/`,
      },
    });
  } catch (err) {
    // Full Stripe error is logged for operators but kept out of the client
    // response — users only need a friendly generic message, not Stripe's
    // raw "No configuration provided…" debug strings.
    console.error("billing/portal: stripe error", err);
    return jsonResponse(
      {
        error:   "portal_failed",
        message: "Could not open the billing portal right now. Please try again or contact support.",
      },
      err.status && err.status >= 400 && err.status < 500 ? 400 : 502,
    );
  }

  if (!session || !session.url) {
    return jsonResponse({ error: "portal_failed", message: "no url returned" }, 502);
  }

  return jsonResponse({ url: session.url });
}
