// POST /api/estimate — Infrastructure Cost Estimator HTTP boundary.
//
// This file is the sanitizing boundary between user-supplied infrastructure
// configuration and every downstream system that writes something down. The
// estimator core (src/estimator/*) is pure and does no IO; everything that
// could leak lives here, which is why the rules below are enforced in one
// place rather than trusted to each call site.
//
// ---------------------------------------------------------------------------
// WHAT THIS ENDPOINT IS NOT ALLOWED TO RECORD
// ---------------------------------------------------------------------------
//
// Uploaded infrastructure config is among the most sensitive text a customer
// can hand us: internal hostnames, account structure, service topology, and —
// however loudly we tell them not to — occasionally a live credential. So:
//
//   * The request body is never logged, never persisted, and never attached
//     to an error report.
//   * Parsed resource values are never logged. A resource id can be a service
//     name; a region can identify a customer.
//   * Raw exception objects never reach captureException. An audit of
//     observability.js found `error.message` and `error.stack` are shipped to
//     Sentry verbatim, and a parser throwing `Unexpected token ... at position
//     N` can carry a fragment of the document in its message. Unexpected
//     errors are re-cast through sanitizedFailure() below, which keeps the
//     stack frames (code paths — useful, not user data) and replaces the
//     message with a bounded category.
//   * Nothing is sent to an LLM. Parsing and estimation are deterministic.
//   * No customer cloud credential is requested, stored, or used, and no cloud
//     account, billing API or cluster is contacted. The only pricing input is
//     the local versioned catalog, bundled at build time.
//
// The one log line this endpoint emits carries exactly the fields the spec
// allows: request id, input type, resource count, provider ids, duration,
// parser status, error category. See logEstimate().

import { adaptKubernetes } from "../estimator/adapters/k8s.js";
import { adaptTerraformPlan } from "../estimator/adapters/terraform-plan.js";
import { adaptNormalized } from "../estimator/adapters/normalized.js";
import { adaptCompose } from "../estimator/adapters/compose.js";
import { adaptManual } from "../estimator/adapters/manual.js";
import {
  validateSpec, EstimatorError, ERROR_CODES, MAX_CONTENT_BYTES,
} from "../estimator/spec.js";
import {
  loadCatalog, resolveProviders, catalogFreshness, listProviders,
} from "../estimator/catalog.js";
import { estimateInfrastructureCost } from "../estimator/engine.js";
import { SecretDetectedError } from "../analyzers/secrets.js";
import { captureException } from "../observability.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** inputType -> adapter. The closed set is also the API's documented surface. */
const ADAPTERS = Object.freeze({
  kubernetes: adaptKubernetes,
  compose: adaptCompose,
  "terraform-plan": adaptTerraformPlan,
  manual: adaptManual,
  normalized: adaptNormalized,
});

export const INPUT_TYPES = Object.freeze(Object.keys(ADAPTERS));

/** The period an estimate covers when the caller does not name one. */
export const DEFAULT_DURATION = Object.freeze({ value: 1, unit: "month" });

/**
 * Error categories this endpoint may report. Bounded on purpose: a category is
 * safe to log precisely because it is drawn from a fixed list rather than
 * derived from whatever went wrong.
 */
export const ERROR_CATEGORIES = Object.freeze([
  "invalid_json", "unsupported_input_type", "input_too_large",
  "secrets_detected", "parse_failed", "validation_failed",
  "unknown_provider", "catalog_invalid", "internal_error",
]);

/** EstimatorError code -> log category. Anything unmapped is a parse failure. */
function categoryForCode(code) {
  if (code === "secrets_detected") return "secrets_detected";
  if (code === "input_too_large") return "input_too_large";
  if (code === "unsupported_input_type") return "unsupported_input_type";
  if (code === "unknown_provider") return "unknown_provider";
  if (code === "catalog_invalid") return "catalog_invalid";
  if (["invalid_payload", "too_many_resources", "invalid_duration", "invalid_quantity",
       "invalid_cpu_quantity", "invalid_memory_quantity"].includes(code)) return "validation_failed";
  return "parse_failed";
}

/**
 * Re-cast an unexpected error so it can be reported without carrying request
 * data. Keeps `name` and the STACK FRAMES; drops the message.
 *
 * V8 stacks begin with "TypeError: <message>" before the frame list, so the
 * header line is stripped rather than reused — otherwise the message we just
 * decided not to trust would ride along inside the stack string.
 */
export function sanitizedFailure(err, category) {
  const safe = new Error(`estimate failed: ${category}`);
  safe.name = (err && err.name) || "Error";
  const raw = (err && typeof err.stack === "string") ? err.stack : "";
  const firstFrame = raw.search(/^\s*at\s/m);
  safe.stack = firstFrame >= 0
    ? `${safe.name}: estimate failed: ${category}\n${raw.slice(firstFrame)}`
    : `${safe.name}: estimate failed: ${category}`;
  return safe;
}

/**
 * The ONLY log line this endpoint writes.
 *
 * Every field here is either a fixed enum, a count, or an identifier we
 * generated. Nothing derived from document content appears — not a resource
 * id, not a region, not a byte of the upload.
 */
function logEstimate(fields) {
  console.log("estimate", JSON.stringify({
    requestId:     fields.requestId,
    inputType:     fields.inputType || null,
    resourceCount: typeof fields.resourceCount === "number" ? fields.resourceCount : null,
    providerIds:   fields.providerIds || null,
    durationMs:    fields.durationMs,
    parserStatus:  fields.parserStatus,
    errorCategory: fields.errorCategory || null,
  }));
}

/** cf-ray when Cloudflare gave us one; otherwise a fresh opaque id. */
function requestIdOf(request) {
  const ray = request && request.headers && request.headers.get("cf-ray");
  if (ray) return String(ray).slice(0, 64);
  return `est_${crypto.randomUUID()}`;
}

/** Wall-clock for the log line only. Never reaches the estimate itself. */
const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

export async function estimateHandler(request, env, ctx) {
  const requestId = requestIdOf(request);
  const started = now();
  const elapsed = () => Math.round(now() - started);

  let body;
  try {
    body = await request.json();
  } catch {
    logEstimate({ requestId, durationMs: elapsed(), parserStatus: "rejected", errorCategory: "invalid_json" });
    return json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    logEstimate({ requestId, durationMs: elapsed(), parserStatus: "rejected", errorCategory: "validation_failed" });
    return json({ error: "invalid_payload", message: "Request body must be a JSON object." }, 400);
  }

  const inputType = typeof body.inputType === "string" ? body.inputType : "";
  const adapter = ADAPTERS[inputType];
  if (!adapter) {
    logEstimate({ requestId, durationMs: elapsed(), parserStatus: "rejected", errorCategory: "unsupported_input_type" });
    return json({
      error: "unsupported_input_type",
      message: `inputType must be one of: ${INPUT_TYPES.join(", ")}.`,
      supported: INPUT_TYPES,
    }, 400);
  }

  const content = body.content;
  if (content === undefined || content === null) {
    logEstimate({ requestId, inputType, durationMs: elapsed(), parserStatus: "rejected", errorCategory: "validation_failed" });
    return json({ error: "empty_input", message: "Provide `content` to estimate." }, 400);
  }

  // Size ceiling before parsing. Measured on the string form so an object
  // payload is bounded too — a 50 MB JSON array of resources costs the same
  // memory as a 50 MB manifest.
  const sizeProbe = typeof content === "string" ? content : safeStringify(content);
  if (sizeProbe === null) {
    logEstimate({ requestId, inputType, durationMs: elapsed(), parserStatus: "rejected", errorCategory: "validation_failed" });
    return json({ error: "invalid_payload", message: "`content` could not be read as text or JSON." }, 400);
  }
  if (sizeProbe.length > MAX_CONTENT_BYTES) {
    logEstimate({ requestId, inputType, durationMs: elapsed(), parserStatus: "rejected", errorCategory: "input_too_large" });
    return json({
      error: "input_too_large",
      message: `Input exceeds the ${Math.floor(MAX_CONTENT_BYTES / (1024 * 1024))} MB limit. Split it or remove resources you are not pricing.`,
    }, 413);
  }

  const options = (body.options && typeof body.options === "object" && !Array.isArray(body.options))
    ? body.options : {};

  // ---- parse -------------------------------------------------------------
  let adapted;
  try {
    adapted = adapter(content, { capacityBasis: options.capacityBasis });
  } catch (err) {
    return failure(err, { requestId, inputType, elapsed, env, ctx, request, stage: "parse" });
  }

  // ---- validate ----------------------------------------------------------
  // A config file states what runs, never for how long. Rather than reject
  // every upload for a field no manifest contains, the period defaults to one
  // month — the question people actually mean by "what does this cost" — and
  // is echoed back in the response so the number is never a mystery period.
  const duration = options.duration !== undefined ? options.duration
    : adapted.duration !== undefined ? adapted.duration
    : DEFAULT_DURATION;

  let spec, validationWarnings;
  try {
    const v = validateSpec({
      name: adapted.name,
      duration,
      resources: adapted.resources,
    });
    spec = v.spec;
    validationWarnings = v.warnings;
  } catch (err) {
    return failure(err, { requestId, inputType, elapsed, env, ctx, request, stage: "validate" });
  }

  // ---- price -------------------------------------------------------------
  let catalog, providers;
  try {
    catalog = loadCatalog();
    providers = resolveProviders(catalog, options.providers);
  } catch (err) {
    return failure(err, {
      requestId, inputType, elapsed, env, ctx, request, stage: "catalog",
      resourceCount: spec.resources.length,
    });
  }

  const providerIds = providers.map((p) => p.providerId);
  const freshnessByProvider = {};
  for (const p of providers) freshnessByProvider[p.providerId] = catalogFreshness(p);

  let result;
  try {
    result = estimateInfrastructureCost(spec, providers, {
      catalogVersion: catalog.catalogVersion,
      freshnessByProvider,
      options: {
        region: options.region,
        egressGiB: options.egressGiB,
        cpuUtilization: options.cpuUtilization,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return failure(err, {
      requestId, inputType, elapsed, env, ctx, request, stage: "engine",
      resourceCount: spec.resources.length, providerIds,
    });
  }

  const warnings = [
    ...(adapted.warnings || []),
    ...(validationWarnings || []),
    ...(result.warnings || []),
  ];

  logEstimate({
    requestId, inputType,
    resourceCount: spec.resources.length,
    providerIds,
    durationMs: elapsed(),
    parserStatus: "ok",
  });

  return json({
    ...result,
    warnings,
    requestId,
    inputType,
    // Echoed so the period the total covers is explicit, including when it
    // was defaulted rather than chosen.
    duration,
    durationWasDefaulted: options.duration === undefined && adapted.duration === undefined,
    // Repeated in the payload so a client that renders the JSON directly, or
    // an exported file that outlives this session, still carries the caveat.
    disclaimer: DISCLAIMER,
    notice: catalog.notice,
    catalogFreshness: freshnessByProvider,
  }, 200);
}

/**
 * The line that must appear anywhere an estimate is shown or exported.
 * Exported so the UI and the report renderer use this exact wording rather
 * than three drifting copies.
 */
export const DISCLAIMER = Object.freeze({
  estimate: "This is an estimate calculated from the configuration you provided, using published list prices. It is not a bill, a quote, or a prediction of your actual invoice.",
  privacy: "We estimate from the configuration you provide. We do not connect to or access your cloud account.",
});

/** Bounded failure response + the single log line. Never leaks user content. */
function failure(err, { requestId, inputType, elapsed, env, ctx, request, stage, resourceCount, providerIds }) {
  // A detected credential is reported through the error's own safe shape:
  // key names and line numbers, never the value. The user needs to know which
  // line to fix; nobody needs the secret itself.
  if (err instanceof SecretDetectedError) {
    logEstimate({
      requestId, inputType, resourceCount, providerIds,
      durationMs: elapsed(), parserStatus: "rejected", errorCategory: "secrets_detected",
    });
    return json(err.toSafeJSON(), 400);
  }

  if (err instanceof EstimatorError || (err && ERROR_CODES.includes(err.code))) {
    const category = categoryForCode(err.code);
    logEstimate({
      requestId, inputType, resourceCount, providerIds,
      durationMs: elapsed(), parserStatus: "rejected", errorCategory: category,
    });
    // EstimatorError messages are safe by construction — spec.js documents
    // that the class carries no field for the offending value, precisely so
    // the message can cross this boundary.
    const status = err.code === "catalog_invalid" ? 500 : 400;
    return json({ error: err.code, message: err.message, field: err.field || undefined }, status);
  }

  // Unexpected: a real bug. Report the code path, not the request.
  logEstimate({
    requestId, inputType, resourceCount, providerIds,
    durationMs: elapsed(), parserStatus: "failed", errorCategory: "internal_error",
  });
  void captureException(env, ctx, sanitizedFailure(err, `${stage}_failed`), {
    request,
    userId: request && request.user && request.user.userId,
    // No `extra`: anything derived from the payload is exactly what must not
    // be attached here.
    tags: { source: "estimator", stage, requestId },
  });
  return json({
    error: "estimate_failed",
    message: "The estimate could not be completed. The configuration was not stored.",
  }, 500);
}

/** JSON.stringify that returns null instead of throwing on a cyclic payload. */
function safeStringify(value) {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/estimate/providers — catalog metadata for the UI's picker.
 *
 * Carries no prices: the picker needs identity, billing model and caveats, and
 * shipping the rate card to every dashboard load would make the catalog a
 * public API we never intended to publish.
 */
export async function estimateProvidersHandler(request, env, ctx) {
  let catalog;
  try {
    catalog = loadCatalog();
  } catch (err) {
    void captureException(env, ctx, sanitizedFailure(err, "catalog_invalid"), {
      request, tags: { source: "estimator", stage: "catalog" },
    });
    return json({ error: "catalog_invalid", message: "The pricing catalog could not be loaded." }, 500);
  }
  const providers = listProviders(catalog).map((p) => ({
    ...p,
    freshness: catalogFreshness(catalog.providers[p.id]),
  }));
  return json({
    catalogVersion: catalog.catalogVersion,
    currency: catalog.currency,
    notice: catalog.notice,
    disclaimer: DISCLAIMER,
    inputTypes: INPUT_TYPES,
    providers,
  }, 200);
}
