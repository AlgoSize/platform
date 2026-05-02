// Algosize Worker — request router.
//
// Real handlers wired in this task:
//   POST /api/checkout            → Stripe Checkout Session creator
//   GET  /api/checkout/success    → Stripe success_url callback (sets cookie)
//   POST /api/stripe/webhook      → signature-verified webhook
//
// Still stubs (filled in by later tasks):
//   GET  /api/me                  (Task #10)
//   POST /api/analyze/cost        (Task #5)
//   POST /api/analyze/vuln        (Task #6)
//   POST /api/analyze/algo        (Task #7)

import { Router } from "itty-router";
import { handlePreflight, withCors, corsHeaders } from "./cors.js";
import { checkoutHandler, checkoutSuccessHandler } from "./handlers/checkout.js";
import { stripeWebhookHandler } from "./handlers/webhook.js";

const router = Router();

// ---- CORS preflight (must run before any other handler) --------------------
router.all("*", handlePreflight);

// ---- Helpers ---------------------------------------------------------------
const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

const notImplemented = (route) =>
  json({ error: "not_implemented", route, message: `${route} is stubbed; implementation pending.` }, 501);

// ---- Real routes (Task #4) -------------------------------------------------
router.post("/api/checkout",          checkoutHandler);
router.get( "/api/checkout/success",  checkoutSuccessHandler);
router.post("/api/stripe/webhook",    stripeWebhookHandler);

// ---- Stub routes (downstream tasks fill them in) ---------------------------
router.get( "/api/me",              () => notImplemented("GET /api/me"));
router.post("/api/analyze/cost",    () => notImplemented("POST /api/analyze/cost"));
router.post("/api/analyze/vuln",    () => notImplemented("POST /api/analyze/vuln"));
router.post("/api/analyze/algo",    () => notImplemented("POST /api/analyze/algo"));

// ---- 404 fallthrough -------------------------------------------------------
router.all("*", (request) => {
  const url = new URL(request.url);
  return json({ error: "not_found", path: url.pathname }, 404);
});

// ---- Worker entry ----------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    try {
      const response = await router.fetch(request, env, ctx);
      return withCors(response, request, env);
    } catch (err) {
      // Last-resort error handler — never leak internals.
      console.error("worker error", err);
      return new Response(
        JSON.stringify({ error: "internal_error" }),
        { status: 500, headers: { "content-type": "application/json", ...corsHeaders(request, env) } },
      );
    }
  },
};
