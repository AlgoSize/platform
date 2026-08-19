// Normalized JSON adapter — the escape hatch.
//
// Everything the other adapters do is "read someone's config and guess what it
// means". This one accepts the model directly, for callers who already know
// their shape and do not want a parser between them and the estimate. It is
// also the adapter every other adapter is really targeting, so keeping it
// honest keeps the whole subsystem honest.
//
// It still refuses credentials and still validates: "the user typed it" is not
// a reason to trust a payload.

import { EstimatorError, rejectSecrets, RESOURCE_TYPES } from "../spec.js";

export function adaptNormalized(input, opts = {}) {
  let payload = input;

  if (typeof input === "string") {
    if (!input.trim()) {
      throw new EstimatorError("empty_input", "No JSON content was provided.", "content");
    }
    rejectSecrets(input);
    try { payload = JSON.parse(input); }
    catch {
      throw new EstimatorError("malformed_document", "Content is not valid JSON.", "content");
    }
  } else if (input && typeof input === "object") {
    // An already-parsed object still gets the secret check, against its
    // serialized form — a caller can hand us a parsed kubeconfig just as
    // easily as a pasted one.
    rejectSecrets(JSON.stringify(input));
  } else {
    throw new EstimatorError("invalid_payload", "Expected a JSON object or a JSON string.", "content");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new EstimatorError("invalid_payload", "Normalized input must be a JSON object.", "content");
  }

  const rawResources = payload.resources;
  if (!Array.isArray(rawResources) || rawResources.length === 0) {
    throw new EstimatorError("empty_input", "Provide a `resources` array with at least one entry.", "resources");
  }

  const warnings = [];
  const resources = rawResources.map((r, i) => {
    if (!r || typeof r !== "object") {
      throw new EstimatorError("invalid_payload", "Each resource must be an object.", `resources[${i}]`);
    }
    if (r.type !== undefined && !RESOURCE_TYPES.includes(r.type)) {
      warnings.push({
        code: "unknown_resource_type",
        message: `Resource ${i + 1} has type "${String(r.type).slice(0, 40)}", which is not a known type; it will be reported as unsupported.`,
      });
    }
    // `metadata` is dropped on purpose: it is free-form, user-authored, and
    // travels straight into persisted history and any exported report. There
    // is no pricing dimension that needs it, so carrying it would be storing
    // arbitrary customer strings for no benefit.
    if (r.metadata !== undefined) {
      warnings.push({
        code: "metadata_dropped",
        message: `Resource ${i + 1} carried a metadata block. It was dropped rather than stored — metadata is not used for pricing and may contain identifying labels.`,
      });
    }
    const { metadata, ...rest } = r;
    return rest;
  });

  return {
    name: typeof payload.name === "string" ? payload.name : undefined,
    duration: payload.duration,
    resources,
    warnings,
  };
}
