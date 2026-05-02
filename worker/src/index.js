// Algosize Worker — request router.
//
// This file wires the API surface but keeps every business handler as a stub
// that returns 501 Not Implemented. Real implementations land in:
//   Task #4: /api/checkout, /api/stripe/webhook, /api/me
//   Task #5: /api/analyze/cost
//   Task #6: /api/analyze/vuln
//   Task #7: /api/analyze/algo
//
// requireAuth + the JWT primitives in src/auth.js are exported and tested
// (`npm test`) so downstream tasks can wrap their real handlers in
// requireAuth without further plumbing.

import { Router } from "itty-router";
import { handlePreflight, withCors, corsHeaders } from "./cors.js";

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

// ---- Stub routes (all return 501; downstream tasks fill them in) -----------
router.post("/api/checkout",        () => notImplemented("POST /api/checkout"));
router.post("/api/stripe/webhook",  () => notImplemented("POST /api/stripe/webhook"));
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
