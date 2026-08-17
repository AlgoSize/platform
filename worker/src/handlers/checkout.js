// POST /api/checkout       — create a Stripe Checkout Session.
// GET  /api/checkout/success — Stripe `success_url` callback. Confirms the
//                              payment, creates/loads the user, sets the
//                              session cookie, redirects to /dashboard/.
//
// We implement the success callback here (not in the webhook) because the
// webhook is server-to-server and can't set cookies on the user's browser.
// The webhook handler still creates/updates the user record idempotently as
// the source of truth — see handlers/webhook.js.

import { createCheckoutSession, retrieveCheckoutSession, resolvePrice, PLANS, INTERVALS } from "../stripe.js";
import { issueJWT, buildSessionCookie } from "../auth.js";
import { upsertUserFromCheckout } from "./_users.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

// Upper bound on seats a single Checkout Session may request. Anything larger
// is a sales conversation, not a self-serve card payment.
const MAX_SEATS_PER_CHECKOUT = 100;

function wantsJson(request) {
  const accept = request.headers.get("Accept") || "";
  if (accept.includes("application/json")) return true;
  // fetch() defaults to "*/*"; treat XHR/fetch as JSON consumers.
  const xrw = request.headers.get("X-Requested-With");
  return xrw === "fetch" || xrw === "XMLHttpRequest";
}

/**
 * POST /api/checkout
 *
 * Creates a Stripe Checkout Session for the monthly plan and returns the URL.
 *  - If the caller asks for JSON (fetch from the landing page), responds
 *    `{ url, id }` with status 200.
 *  - Otherwise (raw <form> POST with no JS), responds with a 303 redirect
 *    straight to the Stripe Checkout URL. This is a graceful fallback.
 */
export async function checkoutHandler(request, env) {
  // Optional {seats} for team purchases. The endpoint is public (it's the
  // pricing page's button), so this is buyer-declared intent, not an
  // entitlement — they are charged for exactly what they ask for. Clamped so a
  // typo or a scripted request can't create a 10,000-seat Checkout Session.
  let seats = 1;
  // Optional {plan, interval} — which tier on the pricing page was clicked.
  // Absent means the legacy single-price checkout, which is what every caller
  // predating tiered pricing sends.
  let plan = null;
  let interval = "monthly";
  try {
    const body = await request.clone().json();
    if (body && Number.isInteger(body.seats)) {
      seats = Math.min(Math.max(body.seats, 1), MAX_SEATS_PER_CHECKOUT);
    }
    if (body && typeof body.plan === "string") plan = body.plan.toLowerCase();
    if (body && typeof body.interval === "string") interval = body.interval.toLowerCase();
  } catch {
    // No body, or a form POST — the default of one seat stands.
  }

  // Refuse an unknown tier, and refuse a known tier with no price configured,
  // BEFORE talking to Stripe. Falling through to a different price would mean
  // a buyer who clicked "$599/month" gets billed some other amount, which is a
  // billing dispute rather than a bug report. A visible 400 is the better
  // failure: it is obvious in testing and impossible to mistake for a sale.
  if (plan && !resolvePrice(env, { plan, interval })) {
    const known = PLANS.includes(plan) && INTERVALS.includes(interval);
    return jsonResponse(
      {
        error: "plan_not_available",
        message: known
          ? `The ${plan} plan isn't available for ${interval} billing yet. Email hello@algosize.com and we'll set it up.`
          : `Unknown plan "${plan}". Choose one of: ${PLANS.join(", ")}.`,
        plan,
        interval,
      },
      known ? 503 : 400,
    );
  }

  let session;
  try {
    session = await createCheckoutSession(env, {
      successUrl: `${env.SITE_ORIGIN}/api/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${env.SITE_ORIGIN}/#pricing`,
      quantity:   seats,
      plan,
      interval,
    });
  } catch (err) {
    console.error("checkout: stripe error", err);
    return jsonResponse(
      { error: "checkout_failed", message: err.message || "stripe error" },
      err.status && err.status >= 400 && err.status < 500 ? 400 : 502,
    );
  }

  if (!session.url) {
    return jsonResponse({ error: "checkout_failed", message: "no url returned" }, 502);
  }

  if (wantsJson(request)) {
    return jsonResponse({ url: session.url, id: session.id });
  }
  return Response.redirect(session.url, 303);
}

/**
 * GET /api/checkout/success?session_id=cs_test_xxx
 *
 * Stripe redirects the user here after a successful payment. We:
 *   1. Verify the session is paid (don't trust the query string alone).
 *   2. Upsert the user record in USERS KV.
 *   3. Issue a JWT, set the session cookie.
 *   4. 303 → /dashboard/.
 *
 * The cookie is HttpOnly Secure SameSite=Lax in production; Secure is
 * dropped on http://localhost so dev works.
 */
export async function checkoutSuccessHandler(request, env) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId || !sessionId.startsWith("cs_")) {
    return new Response("missing or invalid session_id", { status: 400 });
  }

  let session;
  try {
    session = await retrieveCheckoutSession(env, sessionId);
  } catch (err) {
    console.error("checkout/success: stripe error", err);
    return new Response("could not verify checkout session", { status: 502 });
  }

  // Require BOTH a paid payment_status AND a completed session status before
  // we mint anything. Either alone is insufficient: a session can be marked
  // "complete" with payment_status="unpaid" (e.g. delayed bank debits), and a
  // session can be "paid" but not yet "complete". We refuse to issue a
  // session cookie unless the user has actually paid.
  if (session.payment_status !== "paid" || session.status !== "complete") {
    console.warn("checkout/success: session not paid+complete", {
      sessionId: session.id,
      payment_status: session.payment_status,
      status: session.status,
    });
    return new Response("checkout session is not paid", { status: 402 });
  }

  const email = session.customer_details?.email || session.customer_email;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!email || !customerId) {
    return new Response("checkout session missing customer details", { status: 502 });
  }

  const user = await upsertUserFromCheckout(env, {
    email,
    stripeCustomerId: customerId,
    subStatus: "active",
  });

  const token  = await issueJWT(env, user.userId, user.email, user.subStatus);
  const cookie = buildSessionCookie(env, token, { secure: !env.SITE_ORIGIN.startsWith("http://localhost") });

  return new Response(null, {
    status: 303,
    headers: {
      "Location":   `${env.SITE_ORIGIN}/dashboard/`,
      "Set-Cookie": cookie,
    },
  });
}
