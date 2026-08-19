// Cost estimation engine — pure.
//
// estimateInfrastructureCost(spec, providers, catalogMeta) -> CostEstimateResult
//
// No IO of any kind: no fetch, no fs, no env, and no reading of the clock —
// `generatedAt` is passed in by the caller. Catalog data arrives as an
// argument. Given the same three inputs this returns byte-identical output
// forever, which is what makes the estimate reproducible and the tests
// meaningful. scripts/test-estimator-isolation.mjs enforces each of those
// properties by reading this file, so they cannot decay into good intentions.
//
// ---------------------------------------------------------------------------
// BOUNDS ARE DERIVED, NOT STORED
// ---------------------------------------------------------------------------
//
// There is no code path that writes `lowerBound` directly. The point estimate
// is the sum of the line items; the bounds are that sum plus the signed deltas
// of the assumptions. So a range can only differ from the point estimate if an
// assumption produced the difference, and the arithmetic that produced it is
// itemised in the response.
//
//     estimatedTotal = Σ lineItems
//     lowerBound     = estimatedTotal + Σ assumption.effect.lowerMicroUsd
//     upperBound     = estimatedTotal + Σ assumption.effect.upperMicroUsd
//
// When every assumption contributes zero, the bounds are OMITTED rather than
// set equal to the total — reporting `lower === total === upper` would claim a
// precision the catalog does not have.
//
// Four causes are deliberately asymmetric:
//
//   minimum_billable_duration  raises the floor only. A 4-minute job on an
//                              hourly-minimum provider costs at least an hour;
//                              a symmetric band would understate guaranteed spend.
//   bundled_plan_allocation    contributes 0/0. A plan-billed provider's TOTAL
//                              is exact — it is the per-component split that is
//                              inferred. Widening the total would make the
//                              provider with the firmer price look vaguer.
//   unknown_egress             capped, never unbounded. An honest "up to N GiB
//                              assumed" beats an infinite band or a silent zero.
//   stale_pricing_catalog      global rather than per-resource, and forces
//                              confidence down regardless of everything else.

import { mulDiv, MILLI, HOURS_PER_UNIT, UNCERTAINTY_CAUSES, UNKNOWN_EGRESS_CEILING_GIB } from "./spec.js";

// How wide an unverified/stale catalog makes an estimate, in percent.
const STALE_CATALOG_BAND_PCT = 15;
// How wide a utilization assumption makes the compute portion, in percent.
const UTILIZATION_BAND_PCT = 25;

function assumption(cause, statement, { lower = 0, upper = 0, resourceId = null, source = null } = {}) {
  if (!UNCERTAINTY_CAUSES.includes(cause)) {
    // Unreachable by design: the closed set is the whole point. Throwing here
    // rather than emitting keeps an unnamed uncertainty from ever shipping.
    throw new Error(`engine: refusing to emit an uncertainty with unknown cause "${cause}"`);
  }
  return {
    cause,
    ...(resourceId ? { resourceId } : {}),
    statement,
    effect: { lowerMicroUsd: Math.round(lower), upperMicroUsd: Math.round(upper) },
    ...(source ? { source } : {}),
  };
}

/**
 * Consumption units for one resource over the whole duration.
 *
 * Everything is integer: milli-quantities multiplied by milli-hours, divided
 * back down once. Replicas (`quantity`) multiply every dimension — a Deployment
 * with 3 replicas consumes three times the vCPU-hours, and forgetting that is
 * the single easiest way to under-report a Kubernetes bill by 3x.
 */
function consumptionFor(resource, durationMilliHours) {
  const q = resource.quantity;
  const hours = durationMilliHours;                    // milli-hours
  const months = mulDiv(hours, MILLI, HOURS_PER_UNIT.month * MILLI); // milli-months

  return {
    durationMilliHours: hours,
    // milli-unit × milli-hour / MILLI  ->  milli-unit-hours
    vcpuMilliHours:     mulDiv(resource.cpuMilli * q, hours, MILLI),
    memoryMilliGiBHours: mulDiv(resource.memoryMilliGiB * q, hours, MILLI),
    gpuMilliHours:      mulDiv(resource.gpuCount * q * MILLI, hours, MILLI),
    storageMilliGiBMonths: mulDiv(resource.storageMilliGiB * q, months, MILLI),
    iopsMilliHours:     mulDiv(resource.iops * q * MILLI, hours, MILLI),
    egressMilliGiB:     resource.egressMilliGiB * q,
    ingressMilliGiB:    resource.ingressMilliGiB * q,
    replicas:           q,
  };
}

function emptyConsumption() {
  return {
    durationMilliHours: 0, vcpuMilliHours: 0, memoryMilliGiBHours: 0, gpuMilliHours: 0,
    storageMilliGiBMonths: 0, iopsMilliHours: 0, egressMilliGiB: 0, ingressMilliGiB: 0, replicas: 0,
  };
}

function addConsumption(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] + b[k];
  return out;
}

/**
 * @param {number|null} costOverrideMicroUsd  when the true cost cannot be
 *   recovered by multiplying the displayed unit price — see pricePlan(), where
 *   the billed figure derives from the monthly list price and the hourly rate
 *   is a rounded display value.
 */
function lineItem(resourceId, category, quantityMilli, unit, unitPriceMicroUsd, sourceUrl, extra = {}, costOverrideMicroUsd = null) {
  return {
    resourceId,
    category,
    quantity: quantityMilli / MILLI,
    unit,
    unitPriceMicroUsd,
    estimatedCostMicroUsd: costOverrideMicroUsd === null
      ? mulDiv(quantityMilli, unitPriceMicroUsd, MILLI)
      : costOverrideMicroUsd,
    pricingSource: sourceUrl,
    ...extra,
  };
}

/** Smallest plan that fits both CPU and memory. Null when nothing is big enough. */
function selectPlan(provider, resource) {
  const needCpuMilli = resource.cpuMilli;
  const needMemMilliGiB = resource.memoryMilliGiB;
  const fits = provider.plans
    .filter((p) => p.vcpu * MILLI >= needCpuMilli && p.memoryGiB * MILLI >= needMemMilliGiB)
    .sort((a, b) => a.priceMicroUsdPerMonth - b.priceMicroUsdPerMonth);
  return fits[0] || null;
}

/** Price one resource on a metered (dimension-billed) provider. */
function priceMetered(provider, resource, cons, opts) {
  const items = [];
  const assumptions = [];
  const d = provider.dimensions;

  if (cons.vcpuMilliHours > 0 && d.vcpuHour) {
    items.push(lineItem(resource.id, "compute-vcpu", cons.vcpuMilliHours, "vCPU-hour", d.vcpuHour.priceMicroUsd, d.vcpuHour.sourceUrl));
  }
  if (cons.memoryMilliGiBHours > 0 && d.memoryGiBHour) {
    items.push(lineItem(resource.id, "compute-memory", cons.memoryMilliGiBHours, "GiB-hour", d.memoryGiBHour.priceMicroUsd, d.memoryGiBHour.sourceUrl));
  }
  if (cons.storageMilliGiBMonths > 0 && d.storageGiBMonth) {
    items.push(lineItem(resource.id, "storage", cons.storageMilliGiBMonths, "GiB-month", d.storageGiBMonth.priceMicroUsd, d.storageGiBMonth.sourceUrl));
  }
  if (cons.egressMilliGiB > 0 && d.egressGiB) {
    const allowanceMilli = (provider.includedAllowances?.egressGiBPerMonth || 0) * MILLI;
    const billable = Math.max(0, cons.egressMilliGiB - allowanceMilli);
    if (allowanceMilli > 0) {
      assumptions.push(assumption("unsupported_managed_service_overhead",
        `${Math.min(allowanceMilli, cons.egressMilliGiB) / MILLI} GiB of egress was treated as covered by the included monthly allowance.`,
        { resourceId: resource.id, source: d.egressGiB.sourceUrl }));
    }
    if (billable > 0) {
      items.push(lineItem(resource.id, "egress", billable, "GiB", d.egressGiB.priceMicroUsd, d.egressGiB.sourceUrl));
    }
  }
  if (cons.ingressMilliGiB > 0 && d.ingressGiB) {
    items.push(lineItem(resource.id, "ingress", cons.ingressMilliGiB, "GiB", d.ingressGiB.priceMicroUsd, d.ingressGiB.sourceUrl));
  }
  return { items, assumptions };
}

/** Price one resource on a plan-billed provider. */
function pricePlan(provider, resource, cons, opts) {
  const items = [];
  const assumptions = [];
  const plan = selectPlan(provider, resource);

  if (!plan) {
    return { items, assumptions, unsupported: {
      resourceId: resource.id,
      reason: "no_plan_large_enough",
      message: `No ${provider.providerName} plan in this catalog is large enough for the requested CPU and memory.`,
    } };
  }

  // Both plan-billed providers here bill hourly UP TO a monthly cap: run the
  // whole month and you pay the monthly list price, never more.
  //
  // The cost is therefore derived from the monthly price directly, not by
  // rounding to an hourly rate and multiplying back — that double rounding put
  // a full month of a $24 Droplet at $23.999808, which is both wrong and the
  // kind of wrong that makes a customer distrust every other number on the
  // page. The hourly figure is still shown, but as a display rate.
  const capHours = provider.planBillingCapHours || HOURS_PER_UNIT.month;
  const capMilliHours = capHours * MILLI;
  const hourlyMicroUsd = mulDiv(plan.priceMicroUsdPerMonth, 1, capHours);
  const cappedMilliHours = Math.min(cons.durationMilliHours, capMilliHours);
  const planMilliHours = cappedMilliHours * resource.quantity;

  const exactPlanCost = mulDiv(
    plan.priceMicroUsdPerMonth * resource.quantity, cappedMilliHours, capMilliHours);

  items.push(lineItem(resource.id, "compute-plan", planMilliHours, "plan-hour", hourlyMicroUsd, plan.sourceUrl, {
    sku: plan.sku,
    displayName: plan.displayName,
    billingModel: "plan",
    monthlyListPriceMicroUsd: plan.priceMicroUsdPerMonth,
    billingCapHours: capHours,
    note: `Billed hourly up to a ${capHours}-hour monthly cap. Cost is computed from the monthly list price; the hourly figure shown is rounded for display.`,
  }, exactPlanCost));

  // The allocated split: shown so the comparison table has CPU and RAM columns
  // for every provider, but priced at ZERO and flagged, because DigitalOcean
  // and Hetzner do not sell vCPU-hours and inventing a rate for them would be
  // fabricating a number the provider has never published.
  items.push(lineItem(resource.id, "compute-vcpu", cons.vcpuMilliHours, "vCPU-hour", 0, plan.sourceUrl,
    { allocated: true, note: "Included in the plan price; not billed separately." }));
  items.push(lineItem(resource.id, "compute-memory", cons.memoryMilliGiBHours, "GiB-hour", 0, plan.sourceUrl,
    { allocated: true, note: "Included in the plan price; not billed separately." }));

  assumptions.push(assumption("bundled_plan_allocation",
    `${provider.providerName} bills the whole ${plan.displayName} plan, not CPU and memory separately. The per-vCPU and per-GiB lines are allocated for comparison and carry no price of their own — the plan line is the billed figure. Plan headroom over the request is not refunded.`,
    { resourceId: resource.id, source: plan.sourceUrl }));

  // Storage above what the plan includes.
  const includedStorageMilli = (plan.includedStorageGiB || 0) * MILLI;
  const monthsMilli = mulDiv(cons.durationMilliHours, MILLI, HOURS_PER_UNIT.month * MILLI);
  const includedStorageMilliMonths = mulDiv(includedStorageMilli * resource.quantity, monthsMilli, MILLI);
  const billableStorage = Math.max(0, cons.storageMilliGiBMonths - includedStorageMilliMonths);
  if (billableStorage > 0 && provider.dimensions?.storageGiBMonth) {
    items.push(lineItem(resource.id, "storage", billableStorage, "GiB-month",
      provider.dimensions.storageGiBMonth.priceMicroUsd, provider.dimensions.storageGiBMonth.sourceUrl));
  }

  // Egress above the plan's included transfer.
  const includedEgressMilli = (plan.includedEgressGiB || 0) * MILLI * resource.quantity;
  const billableEgress = Math.max(0, cons.egressMilliGiB - includedEgressMilli);
  if (billableEgress > 0 && provider.dimensions?.egressGiB) {
    items.push(lineItem(resource.id, "egress", billableEgress, "GiB",
      provider.dimensions.egressGiB.priceMicroUsd, provider.dimensions.egressGiB.sourceUrl));
  }

  return { items, assumptions };
}

/**
 * Estimate one spec across many providers.
 *
 * @param {object} spec       validated spec from spec.js
 * @param {Array}  providers  provider catalog objects (from catalog.js)
 * @param {object} meta       { catalogVersion, freshnessByProvider, options, generatedAt }
 */
export function estimateInfrastructureCost(spec, providers, meta = {}) {
  const options = meta.options || {};
  const warnings = [];
  const results = [];

  for (const provider of providers) {
    const lineItems = [];
    const assumptions = [];
    const unsupportedResources = [];
    let consumption = emptyConsumption();

    for (const resource of spec.resources) {
      if (!resource.priceable) {
        unsupportedResources.push({
          resourceId: resource.id,
          reason: "no_capacity_declared",
          message: "Resource declares no CPU, memory, GPU, storage or network volume, so it has no priceable dimension. Reported as unsupported rather than counted as zero cost.",
        });
        continue;
      }
      if (resource.type === "gpu" || resource.gpuCount > 0) {
        unsupportedResources.push({
          resourceId: resource.id,
          reason: "gpu_not_in_catalog",
          message: `No GPU pricing is present for ${provider.providerName} in this catalog version.`,
        });
        continue;
      }

      const cons = consumptionFor(resource, spec.durationMilliHours);
      consumption = addConsumption(consumption, cons);

      const priced = provider.billingModel === "plan"
        ? pricePlan(provider, resource, cons, options)
        : priceMetered(provider, resource, cons, options);

      if (priced.unsupported) { unsupportedResources.push(priced.unsupported); continue; }
      lineItems.push(...priced.items);
      assumptions.push(...priced.assumptions);

      // Region: priced at the catalog's default when the spec did not say.
      if (!resource.region && !options.region) {
        assumptions.push(assumption("missing_region",
          `No region was supplied, so ${provider.defaultRegion || provider.regions[0]} list pricing was used. Other regions can differ materially.`,
          { resourceId: resource.id, source: provider.sourceUrl }));
      }
    }

    const estimatedTotal = lineItems.reduce((s, li) => s + li.estimatedCostMicroUsd, 0);

    // ---- uncertainties that scale with the total, added after it is known ----

    if (typeof options.cpuUtilization === "number" && options.cpuUtilization < 1) {
      const band = mulDiv(estimatedTotal, UTILIZATION_BAND_PCT, 100);
      assumptions.push(assumption("utilization_assumption",
        `Capacity was priced at the declared request, not at measured usage. A ${Math.round(options.cpuUtilization * 100)}% average utilization assumption widens the estimate by ±${UTILIZATION_BAND_PCT}%.`,
        { lower: -band, upper: band }));
    }

    if (options.egressGiB === undefined || options.egressGiB === null) {
      const hasEgress = consumption.egressMilliGiB > 0;
      if (!hasEgress) {
        const dim = provider.dimensions?.egressGiB;
        const ceilingCost = dim ? mulDiv(UNKNOWN_EGRESS_CEILING_GIB * MILLI, dim.priceMicroUsd, MILLI) : 0;
        assumptions.push(assumption("unknown_egress",
          `Egress volume was not supplied and is priced as zero. The upper bound assumes up to ${UNKNOWN_EGRESS_CEILING_GIB} GiB/month rather than an unbounded range.`,
          { lower: 0, upper: ceilingCost, source: dim?.sourceUrl }));
      }
    }

    // Minimum billable duration raises the floor only.
    const minSeconds = provider.minimumBillableSeconds || 0;
    const durationSeconds = mulDiv(spec.durationMilliHours, 3600, MILLI);
    if (minSeconds > 0 && durationSeconds < minSeconds && estimatedTotal > 0) {
      const shortfall = mulDiv(estimatedTotal, minSeconds - durationSeconds, Math.max(1, durationSeconds));
      assumptions.push(assumption("minimum_billable_duration",
        `${provider.providerName} bills a minimum of ${minSeconds} seconds per resource. A run shorter than that is charged as if it lasted the minimum, so the true cost cannot be below that floor.`,
        { lower: shortfall, upper: shortfall, source: provider.sourceUrl }));
    }

    const freshness = (meta.freshnessByProvider || {})[provider.providerId];
    if (freshness && freshness.stale) {
      const band = mulDiv(estimatedTotal, STALE_CATALOG_BAND_PCT, 100);
      assumptions.push(assumption("stale_pricing_catalog",
        `Pricing for ${provider.providerName} ${freshness.reason}. List prices may have moved, so the estimate is widened by ±${STALE_CATALOG_BAND_PCT}%.`,
        { lower: -band, upper: band, source: provider.sourceUrl }));
    }

    // ---- fold assumptions into bounds ----
    const lowerDelta = assumptions.reduce((s, a) => s + a.effect.lowerMicroUsd, 0);
    const upperDelta = assumptions.reduce((s, a) => s + a.effect.upperMicroUsd, 0);
    const hasRange = lowerDelta !== 0 || upperDelta !== 0;

    results.push({
      providerId: provider.providerId,
      providerName: provider.providerName,
      billingModel: provider.billingModel,
      currency: "USD",
      estimatedTotalMicroUsd: estimatedTotal,
      // Omitted, not equalised, when nothing widened the estimate.
      ...(hasRange ? {
        lowerBoundMicroUsd: Math.max(0, estimatedTotal + lowerDelta),
        upperBoundMicroUsd: estimatedTotal + upperDelta,
      } : {}),
      confidence: deriveConfidence(assumptions, unsupportedResources),
      consumption,
      lineItems,
      assumptions,
      unsupportedResources,
      pricingCatalogVersion: provider.catalogVersion,
      pricingLastVerified: provider.lastVerified,
      pricingSourceUrl: provider.sourceUrl,
      limitations: provider.limitations,
    });
  }

  // Cheapest first; a provider that could not price anything sorts last
  // regardless of its total, because "$0 because we know nothing" must never
  // win a comparison.
  results.sort((a, b) => {
    const aDead = a.lineItems.length === 0, bDead = b.lineItems.length === 0;
    if (aDead !== bDead) return aDead ? 1 : -1;
    return a.estimatedTotalMicroUsd - b.estimatedTotalMicroUsd;
  });

  return {
    normalizedSpec: spec,
    providers: results,
    warnings,
    generatedAt: meta.generatedAt || null,
    pricingCatalogVersion: meta.catalogVersion || null,
    currency: "USD",
  };
}

/**
 * Confidence from the causes present, never hand-set.
 *
 * Two providers carrying the same uncertainties must report the same
 * confidence; leaving it to a human is how that stops being true.
 */
export function deriveConfidence(assumptions, unsupportedResources = []) {
  const causes = new Set(assumptions.map((a) => a.cause));
  if (causes.has("stale_pricing_catalog") || causes.has("missing_instance_type") || unsupportedResources.length > 0) {
    return "low";
  }
  if (causes.has("utilization_assumption") || causes.has("unknown_egress") ||
      causes.has("missing_region") || causes.has("bundled_plan_allocation")) {
    return "medium";
  }
  return "high";
}
