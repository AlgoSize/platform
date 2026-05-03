// algosize-sandbox — a tiny CF Worker whose only job is to run user-supplied
// JS in its OWN isolate. The main `algosize` Worker calls it via a service
// binding so a user's runaway loop can't burn down the main API Worker's
// per-request CPU budget.
//
// The actual sandbox logic lives in `worker/src/analyzers/sandbox_runner.js`
// — we import it from here so:
//   1. The main Worker can also use it directly when SANDBOX is not bound
//      (tests, single-Worker dev mode).
//   2. There is exactly one source of truth for the regex pre-check + timing.
//
// Wrangler bundles imported JS files at build time, so the cross-package
// import is fine — both Workers ship a self-contained bundle.

import { runUserCode } from "../../worker/src/analyzers/sandbox_runner.js";

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object") {
      return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
    }
    // Hardcode the 1 s policy server-side. Callers cannot override it —
    // accepting a caller-supplied timeoutMs would let a malicious or
    // misbehaving caller bypass the CPU budget the sandbox is meant to
    // enforce. The sandbox owns the policy, period.
    const result = await runUserCode(body.code, body.input, { timeoutMs: 1000 });
    return jsonResponse(result, 200);
  },
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
