// Manual-entry adapter — the form path.
//
// adapters/normalized.js accepts the model as an API caller would already
// know it: correctly typed, units implied by field names. An HTML form cannot
// produce that. Every value arrives as a string, empty fields arrive as "",
// and a user typing into a box labelled "Memory (GiB)" types `4`, not `4Gi`.
//
// ---------------------------------------------------------------------------
// THE BUG THIS ADAPTER EXISTS TO PREVENT
// ---------------------------------------------------------------------------
//
// validateSpec resolves `memoryGiB` like this:
//
//     typeof r.memoryGiB === "string"  ->  parseMemoryToMilliGiB(...)
//     otherwise                        ->  toMilli(...)   // i.e. GiB
//
// parseMemoryToMilliGiB implements the Kubernetes rule, where a bare number is
// BYTES. That is correct for a k8s manifest and catastrophic for a form: post
// `memoryGiB: "4"` from an input box and the resource is priced at 4 bytes of
// memory — a silent zero, on a field whose own name says GiB.
//
// So this adapter resolves units itself and emits the unambiguous `cpuMilli` /
// `memoryMilliGiB` fields, leaving validateSpec no inference to get wrong. A
// bare number in a GiB-labelled box means GiB; an explicitly suffixed value
// (`512Mi`, `2Gi`) is honoured as written.

import {
  EstimatorError, rejectSecrets, parseCpuToMilli, parseMemoryToMilliGiB,
  toMilli, RESOURCE_TYPES, MILLI,
} from "../spec.js";

/** A form field the user left alone. "" is the HTML spelling of "absent". */
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * A number typed into a form box. Rejects rather than coercing junk, because
 * Number("") is 0 and Number("abc") is NaN — both of which would otherwise
 * become a silent zero on a priced dimension.
 */
function numField(raw, field, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (isBlank(raw)) return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    throw new EstimatorError("invalid_payload", "Value must be a number.", field);
  }
  if (integer && !Number.isInteger(n)) {
    throw new EstimatorError("invalid_payload", "Value must be a whole number.", field);
  }
  if (n < min || n > max) {
    throw new EstimatorError("invalid_payload", `Value must be between ${min} and ${max}.`, field);
  }
  return n;
}

/**
 * Memory from a box labelled GiB.
 *
 * Bare number -> GiB (what the label promises). Suffixed -> parsed by the
 * Kubernetes rule, which is the right reading of an explicit `512Mi`/`2G`.
 */
function memoryField(raw, field) {
  if (isBlank(raw)) return null;
  const t = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(t)) return toMilli(Number(t), field);
  return parseMemoryToMilliGiB(t, field);
}

/** CPU from a box labelled cores. parseCpuToMilli already reads `0.5` and `500m`. */
function cpuField(raw, field) {
  if (isBlank(raw)) return null;
  return parseCpuToMilli(String(raw).trim(), field);
}

/**
 * Adapt a manual-entry payload into the normalized model.
 *
 * @param {object|string} input  { name?, duration?, resources: [row, ...] }
 * @returns {{resources: Array, warnings: Array, name?: string, duration?: object}}
 */
export function adaptManual(input, opts = {}) {
  let payload = input;
  if (typeof input === "string") {
    if (!input.trim()) throw new EstimatorError("empty_input", "No manual entry was provided.", "content");
    rejectSecrets(input);
    try { payload = JSON.parse(input); }
    catch { throw new EstimatorError("malformed_document", "Manual entry is not valid JSON.", "content"); }
  } else if (input && typeof input === "object") {
    // Same reasoning as the normalized adapter: a form can be POSTed with a
    // credential pasted into any free-text box, so the serialized form is
    // checked before anything is read out of it.
    rejectSecrets(JSON.stringify(input));
  } else {
    throw new EstimatorError("invalid_payload", "Expected a manual-entry object.", "content");
  }

  const rows = payload.resources;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new EstimatorError("empty_input", "Add at least one resource row.", "resources");
  }

  const warnings = [];
  const resources = [];
  let blankRows = 0;

  rows.forEach((row, i) => {
    const field = `resources[${i}]`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new EstimatorError("invalid_payload", "Each resource row must be an object.", field);
    }

    // A form almost always carries trailing empty rows the user never filled.
    // Dropping them is the correct reading of the user's intent; erroring on
    // them would make the form feel broken for doing nothing wrong.
    const anyValue = ["name", "id", "cpuCores", "memoryGiB", "storageGiB", "egressGiB",
      "ingressGiB", "gpuCount", "quantity", "region", "iops"]
      .some((k) => !isBlank(row[k]));
    if (!anyValue) { blankRows++; return; }

    const rawType = isBlank(row.type) ? "container" : String(row.type).trim();
    const type = RESOURCE_TYPES.includes(rawType) ? rawType : "other";
    if (!RESOURCE_TYPES.includes(rawType)) {
      warnings.push({
        code: "unknown_resource_type", field,
        message: `Row ${i + 1} has an unrecognised type; it will be reported as unsupported rather than priced.`,
      });
    }

    const label = !isBlank(row.name) ? String(row.name).trim()
      : !isBlank(row.id) ? String(row.id).trim()
      : `row-${i + 1}`;

    const cpuMilli = cpuField(row.cpuCores, `${field}.cpuCores`);
    const memoryMilliGiB = memoryField(row.memoryGiB, `${field}.memoryGiB`);
    const storageGiB = numField(row.storageGiB, `${field}.storageGiB`);
    const egressGiB = numField(row.egressGiB, `${field}.egressGiB`);
    const ingressGiB = numField(row.ingressGiB, `${field}.ingressGiB`);
    const gpuCount = numField(row.gpuCount, `${field}.gpuCount`, { integer: true, max: 1024 });
    const quantity = numField(row.quantity, `${field}.quantity`, { integer: true, min: 1, max: 10_000 });
    const iops = numField(row.iops, `${field}.iops`, { integer: true, max: 1_000_000 });

    resources.push({
      id: label.slice(0, 120),
      type,
      quantity: quantity === null ? 1 : quantity,
      // Emitted as milli-units so validateSpec has no unit inference to do.
      cpuMilli: cpuMilli || 0,
      memoryMilliGiB: memoryMilliGiB || 0,
      gpuCount: gpuCount || 0,
      gpuType: isBlank(row.gpuType) ? null : String(row.gpuType).trim().slice(0, 60),
      storageGiB: storageGiB === null ? undefined : storageGiB,
      egressGiB: egressGiB === null ? undefined : egressGiB,
      ingressGiB: ingressGiB === null ? undefined : ingressGiB,
      iops: iops || 0,
      region: isBlank(row.region) ? undefined : String(row.region).trim().slice(0, 60),
      capacityBasis: opts.capacityBasis === "limits" ? "limits" : "requests",
    });
  });

  if (resources.length === 0) {
    throw new EstimatorError("empty_input", "Every resource row was left empty. Fill in at least one.", "resources");
  }
  if (blankRows > 0) {
    warnings.push({
      code: "blank_rows_skipped",
      message: `${blankRows} empty row${blankRows === 1 ? " was" : "s were"} skipped.`,
    });
  }

  return {
    name: typeof payload.name === "string" ? payload.name : undefined,
    duration: payload.duration,
    resources,
    warnings,
  };
}
