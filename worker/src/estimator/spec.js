// Infrastructure Cost Estimator — the normalized, provider-neutral model.
//
// This module is the vocabulary every other estimator module speaks: the
// resource shape adapters produce, the uncertainty shape the engine folds into
// bounds, and the exact-money primitives both rely on.
//
// It is pure. No imports beyond the shared secret detector, no IO, no env.
//
// ---------------------------------------------------------------------------
// MONEY IS INTEGER MICRO-USD
// ---------------------------------------------------------------------------
//
// Every monetary value in this subsystem is an integer count of millionths of
// a dollar. $0.04048 per vCPU-hour is 40480, not 0.04048. Floating point is
// never used for money, because 0.1 + 0.2 !== 0.3 and a cost estimate that
// disagrees with itself on re-run is worse than no estimate.
//
// JS numbers hold integers exactly up to 2^53. A $1,000,000 estimate is 1e12
// micro-USD, four orders of magnitude inside that, so plain Number is safe as
// long as nothing ever produces a fraction — which is what mulDiv() enforces.
//
// Quantities follow the same rule: they are integers scaled by 1000 ("milli"),
// so 1.5 vCPU-hours is 1500 milli-vCPU-hours. A resource asking for 100m CPU
// over 730 hours is 73000 milli-vCPU-hours exactly, with no rounding anywhere
// in the chain.

import { assertNoSecrets } from "../analyzers/secrets.js";

export const MILLI = 1000;
export const MICRO_USD_PER_USD = 1_000_000;

// Bounds on what we will accept, so a hostile or accidental payload cannot
// turn into an unbounded loop or an absurd number.
export const MAX_RESOURCES = 500;
export const MAX_DURATION_HOURS = 8760;        // one year
export const MAX_QUANTITY = 10_000;
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

// An unknown egress volume is unbounded above. Rather than model that as an
// infinite upper bound (useless) or zero (dishonest), we assume none and state
// a ceiling the upper bound is computed against.
export const UNKNOWN_EGRESS_CEILING_GIB = 1000;

// Past this age the catalog is presumed to have drifted from list prices.
export const CATALOG_STALE_AFTER_DAYS = 90;

export const RESOURCE_TYPES = Object.freeze([
  "compute", "container", "kubernetes-node", "gpu", "storage",
  "database", "load-balancer", "network", "other",
]);

export const DURATION_UNITS = Object.freeze(["hour", "day", "month"]);

// Hours per unit. A "month" is 730 hours — the same 365/12 average every
// provider in the catalog uses to convert their monthly list price, so a
// monthly plan price divided by this returns the provider's own hourly rate.
export const HOURS_PER_UNIT = Object.freeze({ hour: 1, day: 24, month: 730 });

/**
 * Every reason an estimate can be a range rather than a number.
 *
 * Closed set on purpose: `engine.js` refuses to emit a bound whose cause is not
 * one of these, so "the number is fuzzy for reasons we did not write down"
 * cannot reach a customer-facing report.
 */
export const UNCERTAINTY_CAUSES = Object.freeze([
  "missing_region",
  "missing_instance_type",
  "utilization_assumption",
  "bundled_plan_allocation",
  "unknown_egress",
  "unsupported_managed_service_overhead",
  "minimum_billable_duration",
  "stale_pricing_catalog",
]);

/** Bounded error categories. Errors carry a code and a field path, never a value. */
export const ERROR_CODES = Object.freeze([
  "invalid_payload", "unsupported_input_type", "input_too_large",
  "too_many_resources", "invalid_duration", "invalid_quantity",
  "invalid_cpu_quantity", "invalid_memory_quantity", "unknown_provider",
  "terraform_hcl_not_supported", "malformed_document", "secrets_detected",
  "empty_input", "catalog_invalid",
]);

/**
 * Thrown by adapters, the validator and the catalog loader.
 *
 * `field` is a JSON-pointer-ish path so a user can find the problem, and
 * `code` is from the closed set above. There is deliberately no field for the
 * offending value: an estimator that echoes user content into an error hands
 * that content to every log sink and error reporter downstream. The audit of
 * observability.js found that `error.message` is shipped to Sentry verbatim —
 * so the message must be safe by construction, not by reviewer vigilance.
 */
export class EstimatorError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = "EstimatorError";
    this.code = ERROR_CODES.includes(code) ? code : "invalid_payload";
    this.field = field;
  }
  toSafeJSON() {
    return { error: this.code, message: this.message, ...(this.field ? { field: this.field } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Exact money and quantity arithmetic
// ---------------------------------------------------------------------------

/**
 * (a * b) / d, rounded half-up, staying on integers throughout.
 *
 * The one place a division happens, so it is the one place rounding can be
 * introduced — and it rounds deterministically rather than inheriting whatever
 * the float unit does.
 */
export function mulDiv(a, b, d) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !d) return 0;
  const product = a * b;
  if (!Number.isSafeInteger(product)) {
    // Degrade precision rather than silently return a wrong integer: split the
    // division across the operands so the magnitude stays representable.
    return Math.round((a / d) * b);
  }
  return Math.round(product / d);
}

/** micro-USD -> a display string. Never used in arithmetic. */
export function formatMicroUsd(micro) {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  // Round to cents FIRST, then split. Splitting first and rounding the
  // remainder lets 999_808 round to 100 cents and render as "$23.100" —
  // the carry has to happen before the dollar figure is taken.
  const totalCents = Math.round(abs / 10_000);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(cents).padStart(2, "0")}`;
}

/** A number of units -> integer milli-units, rejecting nonsense. */
export function toMilli(value, field) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EstimatorError("invalid_quantity", "Expected a non-negative number.", field);
  }
  return Math.round(value * MILLI);
}

// ---------------------------------------------------------------------------
// Kubernetes-style quantity parsing
// ---------------------------------------------------------------------------

/**
 * CPU: "100m" -> 100 milli-cores, "2" -> 2000, "0.5" -> 500.
 *
 * Kubernetes' milli-suffix is exactly our internal unit, so the common case is
 * integer-to-integer with no conversion at all.
 */
export function parseCpuToMilli(raw, field = "cpu") {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) throw new EstimatorError("invalid_cpu_quantity", "CPU must be a non-negative number.", field);
    return Math.round(raw * MILLI);
  }
  if (typeof raw !== "string") throw new EstimatorError("invalid_cpu_quantity", "CPU must be a string or number.", field);
  const s = raw.trim();
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(s);
  if (!m) throw new EstimatorError("invalid_cpu_quantity", 'CPU must look like "500m" or "2".', field);
  const n = Number(m[1]);
  return m[2] === "m" ? Math.round(n) : Math.round(n * MILLI);
}

const MEM_SUFFIX = Object.freeze({
  // binary
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
  // decimal
  k: 1000, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5,
});

/**
 * Memory: "256Mi" / "1Gi" / "512M" / bare bytes -> integer milli-GiB.
 *
 * Both suffix families are supported because Kubernetes accepts both and they
 * are NOT equal — 1G is 1e9 bytes, 1Gi is 2^30. Treating them as the same
 * understates memory by 7%, which is a real cost error at scale.
 */
export function parseMemoryToMilliGiB(raw, field = "memory") {
  if (raw === undefined || raw === null || raw === "") return null;
  let bytes;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) throw new EstimatorError("invalid_memory_quantity", "Memory must be a non-negative number.", field);
    bytes = raw;
  } else if (typeof raw === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z]{0,2})$/.exec(raw.trim());
    if (!m) throw new EstimatorError("invalid_memory_quantity", 'Memory must look like "512Mi", "2Gi" or a byte count.', field);
    const n = Number(m[1]);
    const suffix = m[2];
    if (!suffix) bytes = n;
    else if (MEM_SUFFIX[suffix] !== undefined) bytes = n * MEM_SUFFIX[suffix];
    else throw new EstimatorError("invalid_memory_quantity", `Unrecognised memory suffix.`, field);
  } else {
    throw new EstimatorError("invalid_memory_quantity", "Memory must be a string or number.", field);
  }
  return Math.round((bytes / 1024 ** 3) * MILLI);
}

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

/** Duration -> integer milli-hours. */
export function durationToMilliHours(duration) {
  if (!duration || typeof duration !== "object") {
    throw new EstimatorError("invalid_duration", "Provide a duration as { value, unit }.", "duration");
  }
  const { value, unit } = duration;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new EstimatorError("invalid_duration", "Duration value must be a positive number.", "duration.value");
  }
  if (!DURATION_UNITS.includes(unit)) {
    throw new EstimatorError("invalid_duration", `Duration unit must be one of: ${DURATION_UNITS.join(", ")}.`, "duration.unit");
  }
  const hours = value * HOURS_PER_UNIT[unit];
  if (hours > MAX_DURATION_HOURS) {
    throw new EstimatorError("invalid_duration", `Duration exceeds the ${MAX_DURATION_HOURS}-hour maximum.`, "duration");
  }
  return Math.round(hours * MILLI);
}

/**
 * Validate and canonicalise a spec produced by an adapter or supplied directly.
 *
 * Returns `{ spec, warnings }`. A resource carrying neither CPU nor memory is a
 * warning, never a silent zero — an unpriced resource that reports $0 reads as
 * "free", which is the single most misleading thing this tool could say.
 */
export function validateSpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EstimatorError("invalid_payload", "Spec must be a JSON object.", "");
  }
  const warnings = [];
  const milliHours = durationToMilliHours(input.duration);

  const rawResources = input.resources;
  if (!Array.isArray(rawResources) || rawResources.length === 0) {
    throw new EstimatorError("empty_input", "No resources found. Provide at least one resource to estimate.", "resources");
  }
  if (rawResources.length > MAX_RESOURCES) {
    throw new EstimatorError("too_many_resources", `At most ${MAX_RESOURCES} resources can be estimated at once.`, "resources");
  }

  const seen = new Set();
  const resources = rawResources.map((r, i) => {
    const field = `resources[${i}]`;
    if (!r || typeof r !== "object") throw new EstimatorError("invalid_payload", "Each resource must be an object.", field);

    const type = RESOURCE_TYPES.includes(r.type) ? r.type : "other";
    if (!RESOURCE_TYPES.includes(r.type)) {
      warnings.push({ code: "unknown_resource_type", field, message: "Resource type not recognised; treated as \"other\" and reported as unsupported." });
    }

    let id = typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 120) : `resource-${i + 1}`;
    while (seen.has(id)) id = `${id}-${seen.size}`;
    seen.add(id);

    const quantity = r.quantity === undefined ? 1 : r.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new EstimatorError("invalid_quantity", `Quantity must be an integer between 1 and ${MAX_QUANTITY}.`, `${field}.quantity`);
    }

    const cpuMilli = r.cpuMilli !== undefined ? r.cpuMilli : parseCpuToMilli(r.cpuCores, `${field}.cpuCores`);

    // `memoryGiB` names its own unit, so a bare number here is GiB. That is
    // NOT the Kubernetes rule, where a bare number in `resources.requests.
    // memory` is BYTES — parseMemoryToMilliGiB implements the Kubernetes rule
    // and is correct for the k8s adapter, so it may only be applied to a
    // suffixed string. Passing `memoryGiB: 4` through it would read as 4 bytes
    // and silently price a 4 GiB container at zero memory.
    let memMilliGiB;
    if (r.memoryMilliGiB !== undefined) {
      memMilliGiB = r.memoryMilliGiB;
    } else if (typeof r.memoryGiB === "string") {
      memMilliGiB = parseMemoryToMilliGiB(r.memoryGiB, `${field}.memoryGiB`);
    } else {
      memMilliGiB = toMilli(r.memoryGiB, `${field}.memoryGiB`);
    }

    const priceable = type === "storage" || type === "network"
      ? (r.storageGiB || r.egressGiB || r.ingressGiB)
      : (cpuMilli || memMilliGiB || r.gpuCount);
    if (!priceable) {
      warnings.push({
        code: "resource_without_capacity", field,
        message: "Resource declares no CPU, memory, GPU, storage or network volume, so it cannot be priced. It is reported as unsupported rather than counted as free.",
      });
    }

    return {
      id, type, quantity,
      cpuMilli: cpuMilli || 0,
      memoryMilliGiB: memMilliGiB || 0,
      gpuCount: Number.isInteger(r.gpuCount) && r.gpuCount > 0 ? r.gpuCount : 0,
      gpuType: typeof r.gpuType === "string" ? r.gpuType.slice(0, 60) : null,
      storageMilliGiB: toMilli(r.storageGiB, `${field}.storageGiB`),
      iops: Number.isInteger(r.iops) && r.iops > 0 ? r.iops : 0,
      egressMilliGiB: toMilli(r.egressGiB, `${field}.egressGiB`),
      ingressMilliGiB: toMilli(r.ingressGiB, `${field}.ingressGiB`),
      region: typeof r.region === "string" ? r.region.trim().slice(0, 60) : null,
      capacityBasis: r.capacityBasis === "limits" ? "limits" : "requests",
      priceable: Boolean(priceable),
    };
  });

  return {
    spec: {
      name: typeof input.name === "string" ? input.name.slice(0, 120) : null,
      durationMilliHours: milliHours,
      resources,
    },
    warnings,
  };
}

/**
 * Reject any raw document containing credentials, before it is parsed.
 *
 * Deliberately the FIRST thing every adapter does: parsing a document that
 * contains a key means the key exists in memory in structured form, and from
 * there one careless log line leaks it. Refusing up front keeps the blast
 * radius to a single string that is discarded on throw.
 */
export function rejectSecrets(text) {
  if (typeof text !== "string") return;
  if (text.length > MAX_CONTENT_BYTES) {
    throw new EstimatorError("input_too_large", `Input exceeds the ${Math.floor(MAX_CONTENT_BYTES / 1024 / 1024)} MB limit.`, "content");
  }
  assertNoSecrets(text);   // throws SecretDetectedError — names and lines only
}
