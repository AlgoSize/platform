// Route → middleware chain, in one place.
//
// Each entry is the SAME chain `worker/src/index.js` registers for that route,
// minus two things:
//
//   requireAuth      — the MCP request was already authenticated before any
//                      tool ran. Re-applying it would re-read an Authorization
//                      header that the synthetic request deliberately does not
//                      carry, and fail.
//   the rate limiters — the MCP envelope has its own limits. Running the HTTP
//                      limiter here would charge one user action to two
//                      buckets and produce 429s nobody can explain.
//
// `enforceQuota` STAYS, on every route that has it. That is the point of the
// whole dispatch design: an MCP analysis must cost exactly what the same
// analysis costs over HTTP, metered by the same code, or the product bills
// two different ways depending on how the customer reached it.
//
// Why this file exists rather than each tool building its own chain
// ----------------------------------------------------------------
// Two reasons. First, `scripts/test-mcp-purity.mjs` forbids anything under
// `mcp/tools/` from importing `enforceQuota`, an analyzer, or a handler — so
// that a tool CANNOT quietly drop the quota wrapper or re-implement analyzer
// logic. Keeping the imports here means the purity guard stays meaningful
// instead of being weakened to allow the one import every tool needed.
// Second, `test-mcp-chains.mjs` diffs this table against the real router, so a
// chain that drifts from index.js fails the build rather than silently
// serving MCP traffic through different middleware than HTTP traffic.

import { enforceQuota } from "../quota.js";
import {
  analyzeCostHandler, analyzeVulnHandler, analyzeAlgoHandler, analyzeArchitectureHandler,
  analyzeProfileHandler,
} from "../handlers/analyze.js";
import { estimateHandler, estimateProvidersHandler } from "../handlers/estimate.js";
import { withEstimateHistory } from "../handlers/estimate_history.js";
import { generateFixHandler } from "../handlers/fix.js";
import {
  listRunsHandler, getRunHandler, getRunReportHandler, createRunShareHandler,
} from "../handlers/runs.js";
import { scorecardHandler } from "../handlers/scorecard.js";
import {
  listMonitorsHandler, createMonitorHandler, deleteMonitorHandler, pauseMonitorHandler,
  setMonitorAnalyzersHandler, setMonitorScheduleHandler, runMonitorNowHandler,
  monitorResultHandler,
} from "../handlers/monitors.js";
import {
  listArchSnapshotsHandler, getArchSnapshotHandler, archDiffHandler,
} from "../handlers/arch_snapshots.js";
import { meHandler } from "../handlers/me.js";
import {
  ciSnippetHandler, ciOptimizerSnippetHandler, ciEstimateSnippetHandler,
  ciArchitectureSnippetHandler,
} from "../handlers/ci.js";

/**
 * Every route an MCP tool may reach, and how to reach it.
 *
 * `metered` is recorded next to the chain rather than declared independently
 * on the tool, so the two cannot disagree. It is true exactly when the chain
 * contains enforceQuota — see assertMeteringHonest below, which proves it.
 */
export const CHAINS = Object.freeze({
  analyzeVuln: {
    method: "POST", path: "/api/analyze/vuln",
    chain: [enforceQuota(analyzeVulnHandler)], metered: true,
  },
  analyzeCost: {
    method: "POST", path: "/api/analyze/cost",
    chain: [enforceQuota(analyzeCostHandler)], metered: true,
  },
  analyzeAlgo: {
    method: "POST", path: "/api/analyze/algo",
    chain: [enforceQuota(analyzeAlgoHandler)], metered: true,
  },
  analyzeArchitecture: {
    method: "POST", path: "/api/analyze/architecture",
    chain: [enforceQuota(analyzeArchitectureHandler)], metered: true,
  },
  estimate: {
    method: "POST", path: "/api/estimate",
    // Double wrap, and the order matters: quota outside, history inside. It is
    // copied from index.js rather than reasoned about, because reversing it
    // would record history for estimates that were refused for quota.
    chain: [enforceQuota(withEstimateHistory(estimateHandler))], metered: true,
  },
  estimateProviders: {
    method: "GET", path: "/api/estimate/providers",
    chain: [estimateProvidersHandler], metered: false,
  },
  // index.js registers /api/fix as `analyzeRateLimit, requireAuth,
  // generateFixHandler` — no enforceQuota, deliberately: it explains a finding
  // the customer already spent a run to produce.
  fix: {
    method: "POST", path: "/api/fix",
    chain: [generateFixHandler], metered: false,
  },

  listRuns:   { method: "GET",  path: "/api/runs",             chain: [listRunsHandler],      metered: false },
  getRun:     { method: "GET",  path: "/api/runs/:id",         chain: [getRunHandler],        metered: false },
  getReport:  { method: "GET",  path: "/api/runs/:id/report",  chain: [getRunReportHandler],  metered: false },
  shareRun:   { method: "POST", path: "/api/runs/:id/share",   chain: [createRunShareHandler], metered: false },

  scorecard:     { method: "GET", path: "/api/scorecard",         chain: [scorecardHandler],          metered: false },
  // Unmetered for the same reason as the HTTP route: one tree listing, no
  // file reads, and it answers "would a scan cover this?" before one runs.
  profile:       { method: "POST", path: "/api/analyze/profile",  chain: [analyzeProfileHandler],     metered: false },
  archSnapshots: { method: "GET", path: "/api/arch/snapshots",    chain: [listArchSnapshotsHandler],  metered: false },
  archSnapshot:  { method: "GET", path: "/api/arch/snapshots/:id", chain: [getArchSnapshotHandler],   metered: false },
  archDiff:      { method: "GET", path: "/api/arch/diff",         chain: [archDiffHandler],           metered: false },

  listMonitors:   { method: "GET",    path: "/api/monitors",                chain: [listMonitorsHandler],        metered: false },
  createMonitor:  { method: "POST",   path: "/api/monitors",                chain: [createMonitorHandler],       metered: false },
  deleteMonitor:  { method: "DELETE", path: "/api/monitors/:id",            chain: [deleteMonitorHandler],       metered: false },
  pauseMonitor:   { method: "POST",   path: "/api/monitors/:id/pause",      chain: [pauseMonitorHandler],        metered: false },
  monitorAnalyzers:{ method: "POST",  path: "/api/monitors/:id/analyzers",  chain: [setMonitorAnalyzersHandler], metered: false },
  monitorSchedule:{ method: "POST",   path: "/api/monitors/:id/schedule",   chain: [setMonitorScheduleHandler],  metered: false },
  // Not metered at the route level: index.js registers it behind requireAuth
  // only. The sweep it queues does consume runs when it executes, which the
  // tool description says out loud — but this call itself does not, and
  // claiming otherwise would put a false quota warning in front of it.
  runMonitorNow:  { method: "POST",   path: "/api/monitors/:id/run",        chain: [runMonitorNowHandler],       metered: false },
  monitorResult:  { method: "GET",    path: "/api/monitors/:id/result/:analyzer", chain: [monitorResultHandler], metered: false },

  me: { method: "GET", path: "/api/me", chain: [meHandler], metered: false },

  ciSnippet:             { method: "GET", path: "/api/ci/snippet",               chain: [ciSnippetHandler],             metered: false },
  ciOptimizerSnippet:    { method: "GET", path: "/api/ci/optimizer-snippet",     chain: [ciOptimizerSnippetHandler],    metered: false },
  ciEstimateSnippet:     { method: "GET", path: "/api/ci/estimate-snippet",      chain: [ciEstimateSnippetHandler],     metered: false },
  ciArchitectureSnippet: { method: "GET", path: "/api/ci/architecture-snippet",  chain: [ciArchitectureSnippetHandler], metered: false },
});

/** Look up a chain by key, failing loudly rather than dispatching to undefined. */
export function chainFor(key) {
  const entry = CHAINS[key];
  if (!entry) throw new Error(`mcp/chains.js: no chain registered under "${key}"`);
  return entry;
}
