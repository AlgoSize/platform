// Resolve branding, render the HTML report, and (best effort) store it.
//
// One module so that the three callers — the dashboard analyzer, the CI
// ingestion endpoint, and the on-demand report route — cannot drift into
// producing three subtly different documents. Whoever asks, the same run
// yields the same bytes.

import { getOrgById } from "../handlers/_orgs.js";
import { resolveEntitlementForOrg } from "../entitlement.js";
import { ALGOSIZE_BRANDING, brandingFor } from "./branding.js";
import { renderReportHtml } from "./html.js";
import { putReport, getReport } from "./store.js";

/**
 * The branding a given run's report should carry.
 *
 * Resolved from the run's OWNING org, not from the caller — a share link is
 * opened by someone with no account at all, and the report they see must be
 * branded the same as the one the customer generated. Falls back to Algosize
 * branding whenever the org cannot be resolved, which is the safe direction:
 * the failure mode is our name on the document, never someone else's.
 */
export async function brandingForRun(env, run) {
  const orgId = run && run.orgId;
  if (!orgId || !env || !env.DB) return { ...ALGOSIZE_BRANDING };
  try {
    const org = await getOrgById(env, orgId);
    if (!org) return { ...ALGOSIZE_BRANDING };
    const entitlement = await resolveEntitlementForOrg(env, orgId);
    return brandingFor(env, org, entitlement);
  } catch (err) {
    console.error("reports: branding resolution failed", { orgId, message: err && err.message });
    return { ...ALGOSIZE_BRANDING };
  }
}

/** Render a run's report HTML, resolving its branding first. */
export async function renderForRun(env, run, { generatedAt = null } = {}) {
  const branding = await brandingForRun(env, run);
  return renderReportHtml(run, { branding, generatedAt });
}

/**
 * Render and store a completed run's report.
 *
 * Only vuln runs produce a report — the cost and algorithm analyzers have
 * nothing a client would want handed to them, and rendering an empty document
 * for them would fill the bucket with pages nobody opens.
 *
 * Best effort throughout: called from ctx.waitUntil after the caller already
 * has their answer. A failure here costs a cache entry, and the on-demand path
 * in getRunReportHandler renders the same bytes anyway.
 */
export async function storeReportFor(env, ctx, run) {
  if (!run || run.analyzer !== "vuln") return null;
  if (!env || !env.REPORTS) return null;   // no bucket bound yet — see store.js
  try {
    // `createdAt` rather than "now": the report is a statement about when the
    // scan happened. Re-rendering it later must not move the date on a
    // document someone has already filed.
    const html = await renderForRun(env, run, { generatedAt: run.createdAt });
    return await putReport(env, { orgId: run.orgId, runId: run.id, html });
  } catch (err) {
    console.error("reports: render/store failed", { runId: run.id, message: err && err.message });
    return null;
  }
}

/**
 * The report HTML for a run: from R2 when it is there, freshly rendered when
 * it is not.
 *
 * The miss path also backfills, so the first read of an older run — or of any
 * run at all before the bucket existed — populates the cache for the next one.
 * That backfill is deliberately NOT awaited by the caller's response.
 */
export async function reportHtmlFor(env, ctx, run) {
  const cached = await getReport(env, { orgId: run.orgId, runId: run.id });
  if (cached) return { html: cached, source: "r2" };

  const html = await renderForRun(env, run, { generatedAt: run.createdAt });

  if (env && env.REPORTS) {
    const backfill = putReport(env, { orgId: run.orgId, runId: run.id, html })
      .catch(() => null);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(backfill);
  }

  return { html, source: "rendered" };
}
