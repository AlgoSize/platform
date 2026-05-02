// POST /api/checkout       — create a Stripe Checkout Session.
// GET  /api/checkout/success — Stripe `success_url` callback. Confirms the
//                              payment, creates/loads the user, sets the
//                              session cookie, redirects to /dashboard/.
//
// We implement the success callback here (not in the webhook) because the
// webhook is server-to-server and can't set cookies on the user's browser.
// The webhook handler still creates/updates the user record idempotently as
// the source of truth — see handlers/webhook.js.

import { createCheckoutSession, retrieveCheckoutSession } from "../stripe.js";
import { issueJWT, buildSessionCookie } from "../auth.js";
import { upsertUserFromCheckout } from "./_users.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

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
  let session;
  try {
    session = await createCheckoutSession(env, {
      successUrl: `${env.SITE_ORIGIN}/api/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${env.SITE_ORIGIN}/#pricing`,
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
