// Filing an estimate in run history — deliberately OUTSIDE the estimator's
// HTTP boundary.
//
// src/handlers/estimate.js is a sanitizing boundary, and its module header is
// explicit about what may not happen inside it: "the request body is never
// logged, never persisted"; "parsed resource values are never logged. A
// resource id can be a service name; a region can identify a customer."
// test-estimate-api.mjs enforces that structurally — it asserts the file
// contains no persistence reach AT ALL, not merely that it persists the right
// subset. A structural guarantee is worth more than a careful one: it cannot
// be eroded by someone adding a field in good faith.
//
// So the recording lives here, wrapping the handler from the outside. It sees
// only what the boundary already decided to return to the caller, and it
// copies a deliberately narrow slice of that into run history.
//
// ---------------------------------------------------------------------------
// WHAT IS KEPT, AND WHY EACH IS SAFE
// ---------------------------------------------------------------------------
//
//   providers[]        provider id/name, the monthly total, its bounds, its
//                      confidence. Derived aggregates. A price reveals
//                      nothing about topology that the price of any similar
//                      stack would not.
//   resourceCount      a COUNT, never the resources. "You priced 7 things" is
//                      not "you run a service called payments-db".
//   duration,
//   currency,
//   catalogVersion     what the number means and which rate card produced it.
//                      Without these the stored total is unreproducible.
//   inputType          "compose" | "kubernetes" | … — the shape of the input,
//                      not the input.
//   warningCount       a count. The warnings THEMSELVES are dropped: they
//                      quote resources by name ("resource 'payments-db' has
//                      no storage class") and are exactly the parsed values
//                      the boundary refuses to record.
//
// Nothing else. Not normalizedSpec, not resource names, not regions, not the
// submitted document. The Report renders what is here and says plainly that
// the specification was not retained, rather than showing an empty table that
// reads like the estimate covered nothing.

import { persistRun, runScopeFor } from "./runs.js";
import { captureException } from "../observability.js";

/**
 * Copy the aggregate slice of an estimate response.
 *
 * An allowlist, not a redaction: it names the fields that may be kept and
 * ignores everything else, so a new field added to the estimator's response
 * is excluded by default rather than included until somebody notices.
 */
export function aggregateOf(payload) {
  if (!payload || typeof payload !== "object") return null;

  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  const priced = providers
    .filter((p) => p && typeof p.estimatedTotalMicroUsd === "number")
    .map((p) => ({
      providerId:             String(p.providerId || ""),
      providerName:           String(p.providerName || p.providerId || ""),
      estimatedTotalMicroUsd: p.estimatedTotalMicroUsd,
      ...(typeof p.lowerBoundMicroUsd === "number" ? { lowerBoundMicroUsd: p.lowerBoundMicroUsd } : {}),
      ...(typeof p.upperBoundMicroUsd === "number" ? { upperBoundMicroUsd: p.upperBoundMicroUsd } : {}),
      ...(p.confidence ? { confidence: String(p.confidence) } : {}),
    }));

  if (!priced.length) return null;   // nothing priced is nothing worth filing

  const resources = (payload.normalizedSpec && payload.normalizedSpec.resources) || [];

  return {
    providers: priced,
    resourceCount: Array.isArray(resources) ? resources.length : 0,
    warningCount: Array.isArray(payload.warnings) ? payload.warnings.length : 0,
    duration: payload.duration || null,
    currency: payload.currency || "USD",
    pricingCatalogVersion: payload.pricingCatalogVersion || null,
    inputType: payload.inputType || null,
    disclaimer: payload.disclaimer || null,
    // Said in the stored record itself, so an exported JSON that outlives this
    // session still explains why it has no resource list.
    specRetained: false,
    specNote: "The submitted specification was not retained. Only per-provider " +
              "totals and a resource count are kept — see handlers/estimate_history.js.",
  };
}

/**
 * Wrap the estimate handler so a successful estimate is filed as a run.
 *
 * Applied in the router, outside enforceQuota, so a request rejected for
 * quota never reaches it. Best-effort in both directions: a persistence
 * failure never changes the response, and the response is returned unread if
 * it is not a 200 JSON body.
 */
export function withEstimateHistory(handler) {
  return async function estimateWithHistory(request, env, ctx) {
    const response = await handler(request, env, ctx);
    if (!response || response.status !== 200) return response;

    // The response body can only be read once, so it is cloned. The clone is
    // what this function inspects; the original is returned untouched.
    let payload = null;
    try { payload = await response.clone().json(); }
    catch { return response; }

    const aggregate = aggregateOf(payload);
    if (!aggregate) return response;

    const filing = (async () => {
      try {
        const scope = await runScopeFor(request, env);
        if (!scope) return;
        await persistRun(env, {
          userId:   scope.userId,
          orgId:    scope.orgId,
          analyzer: "estimate",
          source:   request.authMethod === "api_key" ? "ci" : "manual",
          // The input record is the SHAPE of the request, never its content.
          input:    { inputType: aggregate.inputType, resourceCount: aggregate.resourceCount },
          result:   aggregate,
        });
      } catch (err) {
        await captureException(env, ctx, err, {
          request, tags: { source: "estimate_history", phase: "persist" },
        });
      }
    })();
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(filing);

    return response;
  };
}
