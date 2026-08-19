// Pricing catalog — load, validate, and report freshness.
//
// The catalog is the ONLY place a price exists. No module below this one may
// contain a number denominated in money: a rate inlined into business logic is
// a rate nobody updates when the provider changes it, and the first symptom is
// a customer quoting our estimate back at us.
//
// Catalog data reaches the engine as an ARGUMENT, never as a module-level
// import inside the engine. That is what keeps `estimateInfrastructureCost`
// pure and testable against fixtures — and what makes "the engine performs no
// IO" a structural property rather than a promise.
//
// The JSON files are imported statically so the bundler inlines them at build
// time. There is no fs, no fetch, and nothing to configure at runtime.

import catalogIndex from "../../pricing/catalog.json" with { type: "json" };
import awsProvider from "../../pricing/providers/aws.json" with { type: "json" };
import doProvider from "../../pricing/providers/digitalocean.json" with { type: "json" };
import hetznerProvider from "../../pricing/providers/hetzner.json" with { type: "json" };
import akamaiLinodeProvider from "../../pricing/providers/akamai-linode.json" with { type: "json" };
import vultrProvider from "../../pricing/providers/vultr.json" with { type: "json" };

import { EstimatorError, CATALOG_STALE_AFTER_DAYS } from "./spec.js";

const PROVIDER_FILES = Object.freeze({
  aws: awsProvider,
  digitalocean: doProvider,
  hetzner: hetznerProvider,
  "akamai-linode": akamaiLinodeProvider,
  vultr: vultrProvider,
});

/** Fields every provider file must carry before it may price anything. */
const REQUIRED_PROVIDER_FIELDS = Object.freeze([
  "providerId", "providerName", "category", "billingModel", "currency",
  "catalogVersion", "effectiveDate", "lastVerified", "sourceUrl",
  "limitations", "regions",
]);

function assertProviderShape(p, id) {
  for (const f of REQUIRED_PROVIDER_FIELDS) {
    if (p[f] === undefined || p[f] === null) {
      throw new EstimatorError("catalog_invalid", `Provider "${id}" is missing required catalog field "${f}".`, `pricing/providers/${id}.json`);
    }
  }
  if (p.currency !== "USD") {
    // Rather than convert. A converted price is a price plus an exchange rate
    // we did not source, dated at a moment we did not record.
    throw new EstimatorError("catalog_invalid", `Provider "${id}" is not priced in USD; currency conversion is deliberately not implemented.`, `pricing/providers/${id}.json`);
  }
  if (p.billingModel === "plan" && !Array.isArray(p.plans)) {
    throw new EstimatorError("catalog_invalid", `Plan-billed provider "${id}" has no plans array.`, `pricing/providers/${id}.json`);
  }
  if (p.billingModel === "metered" && !p.dimensions) {
    throw new EstimatorError("catalog_invalid", `Metered provider "${id}" has no dimensions.`, `pricing/providers/${id}.json`);
  }
}

/** Whole days between an ISO date and `now`, or null if unparseable. */
export function ageInDays(isoDate, now = Date.now()) {
  const t = Date.parse(isoDate);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

/**
 * Is this catalog old enough, or unverified enough, to widen every estimate?
 *
 * Two independent triggers. `verificationStatus` covers a catalog nobody has
 * checked against the provider's page yet — which is the state a seed catalog
 * ships in, and pretending otherwise would be the exact false precision this
 * subsystem exists to avoid. Age covers a catalog that was verified once and
 * has since drifted.
 */
export function catalogFreshness(provider, now = Date.now()) {
  const age = ageInDays(provider.lastVerified, now);
  const unverified = provider.verificationStatus !== "verified";
  const stale = unverified || age === null || age > CATALOG_STALE_AFTER_DAYS;
  return {
    lastVerified: provider.lastVerified,
    ageInDays: age,
    verificationStatus: provider.verificationStatus || "unknown",
    stale,
    reason: unverified
      ? "catalog has not been verified against the provider's published pricing"
      : age === null ? "catalog verification date is unreadable"
      : age > CATALOG_STALE_AFTER_DAYS ? `catalog was last verified ${age} days ago`
      : null,
  };
}

/** Load, validate and freeze the catalog. Throws EstimatorError if malformed. */
export function loadCatalog() {
  if (!catalogIndex || !Array.isArray(catalogIndex.providers)) {
    throw new EstimatorError("catalog_invalid", "Catalog index is missing its providers list.", "pricing/catalog.json");
  }
  const providers = {};
  for (const id of catalogIndex.providers) {
    const p = PROVIDER_FILES[id];
    if (!p) throw new EstimatorError("catalog_invalid", `Catalog names provider "${id}" but no provider file is bundled for it.`, "pricing/catalog.json");
    assertProviderShape(p, id);
    if (p.catalogVersion !== catalogIndex.catalogVersion) {
      throw new EstimatorError("catalog_invalid", `Provider "${id}" is at a different catalog version than the index; releasing a partially-updated catalog would mix price vintages inside one comparison.`, `pricing/providers/${id}.json`);
    }
    providers[id] = p;
  }
  return Object.freeze({
    schemaVersion: catalogIndex.schemaVersion,
    catalogVersion: catalogIndex.catalogVersion,
    currency: catalogIndex.currency,
    effectiveDate: catalogIndex.effectiveDate,
    lastVerified: catalogIndex.lastVerified,
    verificationStatus: catalogIndex.verificationStatus,
    notice: catalogIndex.notice,
    providers: Object.freeze(providers),
  });
}

/** Provider descriptors for a UI picker. No prices — just identity and caveats. */
export function listProviders(catalog) {
  return Object.values(catalog.providers).map((p) => ({
    id: p.providerId,
    name: p.providerName,
    category: p.category,
    billingModel: p.billingModel,
    regions: p.regions,
    pricingVersion: p.catalogVersion,
    sourceUrl: p.sourceUrl,
    assumptions: p.limitations,
  }));
}

/** Resolve requested ids, rejecting unknown ones by name only. */
export function resolveProviders(catalog, ids) {
  const wanted = Array.isArray(ids) && ids.length ? ids : Object.keys(catalog.providers);
  const out = [];
  for (const id of wanted) {
    const p = catalog.providers[id];
    if (!p) throw new EstimatorError("unknown_provider", `Unknown provider "${String(id).slice(0, 40)}".`, "options.providers");
    out.push(p);
  }
  return out;
}
