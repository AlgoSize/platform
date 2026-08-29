// What an analyzer currently says about a monitored repository.
//
// The monitors screen tells you a repo is watched and that something changed.
// The tool pages could not then SHOW you the thing that changed: each one had
// a manual bench and nothing else, so "3 new architecture findings" in an
// email led to a page where you had to re-upload your own codebase by hand to
// see them. This module closes that gap.
//
// ---------------------------------------------------------------------------
// Why this re-runs the analyzer instead of reading a stored result
// ---------------------------------------------------------------------------
// A monitor's baseline stores identity keys and summary numbers — advisory
// keys, finding keys, per-provider totals, a grade map. That is deliberate:
// a baseline exists to answer "what is different since last night", and
// keeping a full architecture graph or a full advisory list per monitor would
// be a second copy of the customer's codebase, growing every night, going
// stale between sweeps.
//
// So the baseline is not the display. Opening a monitored repo re-reads its
// COMMITTED files and re-runs the analyzer, which is:
//
//   * current — it shows the repo as it is now, not as it was at 03:00
//   * cheap — the same fetch + analyze the sweep does, a few hundred ms
//   * inside the product's invariant — committed repository files only. No
//     cloud account, no credentials, nothing the sweep itself could not read.
//
// and the stored baseline is then used for what it IS good for: diffing, so
// the page can mark which of the findings in front of you are the new ones.
//
// ---------------------------------------------------------------------------
// This NEVER advances a baseline
// ---------------------------------------------------------------------------
// The single most important property here. If opening the X-ray wrote the
// current keys back as the baseline, it would silently consume the delta the
// next sweep's email was going to report — you would look at your findings,
// and tomorrow morning the email would say nothing had changed. Reading a
// result must not change what the next alert says. Nothing in this file
// writes to the monitors table, and nothing may be added that does.

import {
  runArchForMonitor,
  runEstimateForMonitor,
  runAlgoForMonitor,
  diffArchFindings,
  diffEstimate,
  diffAlgoGrades,
  archFindingKey,
} from "./analyzers.js";
import { runLockfileAudit } from "../handlers/analyze.js";
import { diffAdvisories } from "./diff.js";

/** The analyzers a monitor can be inspected for — the same set it can run. */
export const INSPECTABLE = Object.freeze(["vuln", "arch", "estimate", "algo"]);

/**
 * Re-run one analyzer against one monitor's repository.
 *
 * Returns
 *   {
 *     status:   "ok" | "not_enabled" | "unavailable"
 *     reason:   machine-readable cause when status is not "ok"
 *     result:   the analyzer's full output, in exactly the shape the manual
 *               endpoint for that analyzer returns — so the tool page renders
 *               it through the renderer it already has
 *     baseline: { at, status, isBaseline } — what the last SWEEP knew
 *     delta:    which parts of `result` are new since that sweep
 *   }
 *
 * `unavailable` covers every reason the analyzer could not produce a result:
 * GitHub throttled, no manifest in the repo, a malformed config. They are
 * reported with their reason rather than as an empty result, because an empty
 * architecture graph and "we could not read your repo" look identical on
 * screen and mean opposite things.
 */
export async function inspectMonitor(env, ctx, monitor, analyzer, fetchImpl) {
  if (!INSPECTABLE.includes(analyzer)) {
    return { status: "unavailable", reason: "unknown_analyzer" };
  }
  // A monitor only has a baseline for an analyzer it actually runs, and
  // inspecting one it does not run would show a result with a meaningless
  // "nothing is new" beside it. Reported as its own state so the page can
  // offer to switch the analyzer on rather than showing an error.
  const enabled = monitor.analyzers || ["vuln"];
  if (!enabled.includes(analyzer)) {
    return { status: "not_enabled", reason: "analyzer_off", analyzer };
  }

  const baseline = {
    at:     monitor.lastRunAt,
    status: monitor.lastStatus,
    error:  monitor.lastError,
  };

  if (analyzer === "vuln")     return inspectVuln(env, ctx, monitor, baseline);
  if (analyzer === "arch")     return inspectArch(env, monitor, baseline, fetchImpl);
  if (analyzer === "estimate") return inspectEstimate(env, ctx, monitor, baseline, fetchImpl);
  return inspectAlgo(env, monitor, baseline, fetchImpl);
}

// ---------------------------------------------------------------------------
// vuln — the dependency audit
// ---------------------------------------------------------------------------
async function inspectVuln(env, ctx, monitor, baseline) {
  const response = await runLockfileAudit(
    { repoUrl: monitor.repoUrl, branch: monitor.branch || undefined },
    env, null, ctx,
  );
  let result;
  try { result = await response.json(); } catch { result = null; }
  if (!response.ok || !result) {
    return {
      status: "unavailable",
      reason: (result && result.error) || `http_${response.status}`,
      baseline,
    };
  }

  const advisories = Array.isArray(result.advisories) ? result.advisories : [];
  const diff = diffAdvisories(advisories, monitor.lastAdvisoryIds);
  return {
    status: "ok",
    result,
    baseline: { ...baseline, isBaseline: diff.isBaseline },
    delta: {
      // Keys rather than whole objects: the page already has the full
      // advisory in `result`, and sending it twice would double the payload
      // for a repo with a few hundred findings.
      newKeys:      diff.newAdvisories.map((a) => advisoryIdOf(a)).filter(Boolean),
      resolvedKeys: diff.resolvedKeys,
    },
  };
}

function advisoryIdOf(a) {
  if (!a || typeof a !== "object") return null;
  return `${a.id || "unknown"}/${a.ecosystem || "unknown"}/${a.package || "unknown"}`;
}

// ---------------------------------------------------------------------------
// arch — the X-ray
// ---------------------------------------------------------------------------
async function inspectArch(env, monitor, baseline, fetchImpl) {
  const run = await runArchForMonitor(monitor, env, fetchImpl);
  if (run.status !== "ok") {
    return { status: "unavailable", reason: run.reason || run.status, baseline };
  }
  const diff = diffArchFindings(run.findings, run.keys, monitor.lastArchKeys);
  return {
    status: "ok",
    result: run.result,
    baseline: { ...baseline, isBaseline: diff.isBaseline },
    delta: {
      newKeys: diff.newFindings.map(archFindingKey).filter(Boolean),
      // Findings the last sweep saw that are gone now. Worth showing: it is
      // the only proof that last sprint's refactor actually landed.
      resolvedKeys: (monitor.lastArchKeys || []).filter((k) => !run.keys.includes(k)),
    },
  };
}

// ---------------------------------------------------------------------------
// estimate — the infrastructure cost estimator
// ---------------------------------------------------------------------------
async function inspectEstimate(env, ctx, monitor, baseline, fetchImpl) {
  const run = await runEstimateForMonitor(monitor, env, ctx, fetchImpl);
  if (run.status !== "ok") {
    return { status: "unavailable", reason: run.reason || run.status, baseline };
  }
  const diff = diffEstimate(run.byProvider, monitor.lastEstimate);
  return {
    status: "ok",
    result: run.result,
    baseline: { ...baseline, isBaseline: diff.isBaseline },
    delta: { changes: diff.changes },
  };
}

// ---------------------------------------------------------------------------
// algo — the optimizer's watchlist
// ---------------------------------------------------------------------------
async function inspectAlgo(env, monitor, baseline, fetchImpl) {
  const run = await runAlgoForMonitor(monitor, env, fetchImpl);
  if (run.status !== "ok") {
    // `skippedEntries` rides along so a total failure names which entry
    // failed and why, instead of a sentence telling the reader to go and
    // check the file and function names themselves.
    return { status: "unavailable", reason: run.reason || run.status, baseline,
             skipped: run.skippedEntries || [] };
  }
  const previous = monitor.lastAlgo && monitor.lastAlgo.byName;
  const diff = diffAlgoGrades(run.grades, previous);
  return {
    status: "ok",
    // Shaped for the optimizer page rather than borrowed from a manual run:
    // the bench measures ONE function, and a watchlist is a table of many
    // against their ceilings. Different question, different shape.
    result: {
      entries: (run.entries || []).map((e) => ({
        name:         (e && (e.name || e.functionName)) || "unnamed",
        file:         e && e.file,
        functionName: e && e.functionName,
        ceiling:      (e && e.ceiling) || null,
        grade:        run.grades[(e && (e.name || e.functionName)) || "unnamed"] || null,
      })),
      skipped: run.skippedEntries || [],
    },
    baseline: { ...baseline, isBaseline: diff.isBaseline },
    delta: { regressions: diff.regressions, improvements: diff.improvements },
  };
}
