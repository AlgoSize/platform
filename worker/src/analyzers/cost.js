// Cost analyzer — pure, dependency-free rule engine.
//
// This module is deliberately isolated from HTTP/KV/fetch so that:
//   1. It is trivially unit-testable.
//   2. A future LLM-backed implementation can replace the body of
//      `analyzeCost()` (or live behind a feature flag) without touching the
//      handler layer or the request/response contract.
//
// Public surface:
//   validateCostInput(payload) -> { ok: true, value }       on success
//                              -> { ok: false, error, message } on failure
//   analyzeCost(input)         -> { currentSpend, suggestions, totalSavingsPct }
//
// Suggestion shape:
//   { title: string, impact: "low"|"medium"|"high", savingsEstimate: number,
//     service: string, rule: string }


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ALLOWED_CATEGORIES = new Set([
  "compute", "storage", "database", "egress", "network", "other",
]);

const MAX_SERVICES = 200;

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Validate the request payload. Returns { ok, value } or { ok:false, error, message }.
 * Never throws on bad input — that's the caller's contract for clean 4xx replies.
 */
export function validateCostInput(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid_payload", message: "request body must be a JSON object" };
  }
  const { services } = payload;
  if (!Array.isArray(services) || services.length === 0) {
    return { ok: false, error: "invalid_payload", message: "`services` must be a non-empty array" };
  }
  if (services.length > MAX_SERVICES) {
    return { ok: false, error: "too_many_services", message: `at most ${MAX_SERVICES} services allowed per request` };
  }

  const cleaned = [];
  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    if (s === null || typeof s !== "object" || Array.isArray(s)) {
      return { ok: false, error: "invalid_service", message: `services[${i}] must be an object` };
    }
    if (typeof s.name !== "string" || s.name.trim() === "") {
      return { ok: false, error: "invalid_service", message: `services[${i}].name is required` };
    }
    if (!isFiniteNumber(s.monthlySpend) || s.monthlySpend < 0) {
      return { ok: false, error: "invalid_service", message: `services[${i}].monthlySpend must be a non-negative number` };
    }
    if (s.utilization !== undefined && s.utilization !== null) {
      if (!isFiniteNumber(s.utilization) || s.utilization < 0 || s.utilization > 1) {
        return { ok: false, error: "invalid_service", message: `services[${i}].utilization must be a number between 0 and 1` };
      }
    }
    if (s.category !== undefined && !ALLOWED_CATEGORIES.has(s.category)) {
      return {
        ok: false,
        error: "invalid_service",
        message: `services[${i}].category must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}`,
      };
    }
    cleaned.push(normalizeService(s));
  }
  return { ok: true, value: { services: cleaned } };
}

// Produce the canonical shape detectors operate on. Idempotent: it's safe to
// call this on either raw user input or already-normalized data, which lets
// `analyzeCost` accept either form defensively.
function normalizeService(s) {
  const utilization =
    typeof s.utilization === "number" && Number.isFinite(s.utilization)
      ? s.utilization
      : null;
  return {
    name: typeof s.name === "string" ? s.name.trim() : String(s.name ?? ""),
    monthlySpend: isFiniteNumber(s.monthlySpend) ? s.monthlySpend : 0,
    region: typeof s.region === "string" ? s.region : null,
    instanceSize: typeof s.instanceSize === "string" ? s.instanceSize : null,
    utilization,
    reserved: s.reserved === true,
    category: typeof s.category === "string" && ALLOWED_CATEGORIES.has(s.category)
      ? s.category
      : inferCategory(typeof s.name === "string" ? s.name : ""),
  };
}

// Best-effort category inference when the caller didn't supply one. Used by
// detectors that need to know whether a service is compute-shaped.
function inferCategory(name) {
  const n = name.toLowerCase();
  if (/(ec2|gce|compute|instance|vm|fargate|lambda|kubernetes|k8s|eks|gke|aks)/.test(n)) return "compute";
  if (/(s3|gcs|blob|storage|disk|ebs)/.test(n)) return "storage";
  if (/(rds|aurora|cloud sql|cosmos|dynamodb|mongo|postgres|mysql)/.test(n)) return "database";
  if (/(egress|bandwidth|data.?transfer|cloudfront.*egress)/.test(n)) return "egress";
  if (/(vpc|nat|load.?balancer|alb|nlb|cdn)/.test(n)) return "network";
  return "other";
}


// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------
//
// Each detector takes one normalized service and returns either null (no
// finding) or a suggestion object. They are deliberately independent so an
// LLM-augmented version can drop in detectors that share the same shape.
//
// `savingsEstimate` is monthly USD savings — never larger than the service's
// own spend and rounded to whole dollars.

function round(n) { return Math.round(n); }
function clampSavings(estimate, spend) { return round(Math.max(0, Math.min(estimate, spend))); }

function detectIdleResources(s) {
  if (s.utilization === null) return null;
  if (s.utilization >= 0.2) return null;
  // Idle resources can usually be turned off entirely or right-sized down to
  // a fraction of their current footprint. We assume aggressive consolidation
  // recovers ~80% of spend on truly idle workloads.
  const savings = clampSavings(s.monthlySpend * 0.8, s.monthlySpend);
  if (savings <= 0) return null;
  return {
    title: `Decommission or consolidate idle "${s.name}" (${Math.round(s.utilization * 100)}% utilization)`,
    impact: savings >= 500 ? "high" : savings >= 100 ? "medium" : "low",
    savingsEstimate: savings,
    service: s.name,
    rule: "idle_resources",
  };
}

function detectOversizedInstances(s) {
  if (s.category !== "compute") return null;
  if (s.utilization === null || s.utilization >= 0.5 || s.utilization < 0.2) return null;
  // Right-sizing one tier down typically recovers ~40-50%; assume 40% to be
  // conservative and believable.
  const savings = clampSavings(s.monthlySpend * 0.4, s.monthlySpend);
  if (savings <= 0) return null;
  const sizeNote = s.instanceSize ? ` (currently ${s.instanceSize})` : "";
  return {
    title: `Right-size "${s.name}"${sizeNote} — utilization is ${Math.round(s.utilization * 100)}%`,
    impact: savings >= 500 ? "high" : savings >= 100 ? "medium" : "low",
    savingsEstimate: savings,
    service: s.name,
    rule: "oversized_instances",
  };
}

function detectExpensiveEgress(s) {
  if (s.category !== "egress") return null;
  if (s.monthlySpend < 50) return null;
  // CDN + cache hit ratios of 70-90% on hot assets translate to roughly 30%
  // of the egress bill recovered after refactor.
  const savings = clampSavings(s.monthlySpend * 0.3, s.monthlySpend);
  if (savings <= 0) return null;
  return {
    title: `Reduce egress on "${s.name}" via CDN caching, compression, and same-region traffic`,
    impact: savings >= 500 ? "high" : savings >= 100 ? "medium" : "low",
    savingsEstimate: savings,
    service: s.name,
    rule: "expensive_egress",
  };
}

function detectUnreservedCompute(s) {
  if (s.category !== "compute") return null;
  if (s.reserved === true) return null;
  if (s.monthlySpend < 100) return null;
  // Stable workloads on 1-yr Savings Plans / Reserved Instances typically save
  // ~30% off on-demand pricing. We don't apply this to already-flagged idle
  // workloads — the aggregator deduplicates per service.
  if (s.utilization !== null && s.utilization < 0.2) return null;
  const savings = clampSavings(s.monthlySpend * 0.3, s.monthlySpend);
  if (savings <= 0) return null;
  return {
    title: `Commit "${s.name}" to a 1-year Savings Plan / Reserved Instance`,
    impact: savings >= 500 ? "high" : savings >= 100 ? "medium" : "low",
    savingsEstimate: savings,
    service: s.name,
    rule: "unreserved_compute",
  };
}

const DETECTORS = [
  detectIdleResources,
  detectOversizedInstances,
  detectExpensiveEgress,
  detectUnreservedCompute,
];


// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/**
 * Run all detectors against the validated input, dedupe by (service, rule),
 * sort by savings descending, and compute totalSavingsPct.
 *
 * To stay believable, per-service savings is capped at 80% of that service's
 * spend (you can almost never erase a bill entirely without losing the
 * service), and total savings is therefore implicitly bounded.
 */
export function analyzeCost(input) {
  // Normalize defensively. Callers may pass either validator output (already
  // normalized) or raw user input shaped the same way; either is fine.
  const services = (input?.services ?? []).map(normalizeService);
  const currentSpend = round(services.reduce((sum, s) => sum + s.monthlySpend, 0));

  const raw = [];
  for (const s of services) {
    for (const d of DETECTORS) {
      const finding = d(s);
      if (finding) raw.push(finding);
    }
  }

  // De-dup by (service, rule). Since each detector emits at most one finding
  // per service, this is mostly a defensive guard for future detectors.
  const seen = new Set();
  const deduped = [];
  for (const f of raw) {
    const key = `${f.service}::${f.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  // Cap per-service total savings at 80% of that service's spend so that two
  // overlapping rules don't claim impossible savings.
  const spendByService = new Map(services.map((s) => [s.name, s.monthlySpend]));
  const runningPerService = new Map();
  const capped = [];
  // Sort by savings desc so the highest-impact suggestion gets full credit and
  // smaller overlapping ones are trimmed (or dropped) to fit under the cap.
  deduped.sort((a, b) => b.savingsEstimate - a.savingsEstimate);
  for (const f of deduped) {
    const cap = (spendByService.get(f.service) ?? 0) * 0.8;
    const used = runningPerService.get(f.service) ?? 0;
    const room = Math.max(0, cap - used);
    if (room <= 0) continue;
    const trimmed = round(Math.min(f.savingsEstimate, room));
    if (trimmed <= 0) continue;
    runningPerService.set(f.service, used + trimmed);
    capped.push({ ...f, savingsEstimate: trimmed });
  }

  // Final ordering: by savings desc, then by title for stability.
  capped.sort((a, b) => b.savingsEstimate - a.savingsEstimate || a.title.localeCompare(b.title));

  const totalSavings = capped.reduce((sum, f) => sum + f.savingsEstimate, 0);
  const totalSavingsPct = currentSpend > 0
    ? Math.round((totalSavings / currentSpend) * 1000) / 10  // one decimal place
    : 0;

  return {
    currentSpend,
    suggestions: capped,
    totalSavingsPct,
  };
}
