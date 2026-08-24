// GET /api/scorecard — one row per monitored repository, one column per
// analyzer.
//
// This endpoint invents nothing. Every cell is read out of a monitor's stored
// baseline, and a baseline that does not exist produces an explicitly
// unmeasured cell rather than a flattering default. That rule is the whole
// design: a scorecard whose blanks read as passes is worse than no scorecard,
// because it converts "we never looked" into "we looked and it was fine".
//
// Four cell kinds, and the difference between them is the product:
//
//   grade    an analyzer ran, produced a result, and this is it
//   stale    it produced a result once, but the last attempt failed or was
//            skipped — the value shown is from an older run and is labelled
//   pending  the analyzer is switched on and has never produced a result
//   off      the analyzer is not switched on for this monitor at all
//
// `off` and `pending` are deliberately distinct. "You have not enabled cost
// analysis" and "cost analysis is enabled and has not found a compose file"
// are different problems with different fixes, and a single grey dash for
// both would hide the second one forever.

import { resolveEntitlement } from "../entitlement.js";
import { listMonitors } from "../monitors/_store.js";
import { gradeForScore, scoreForCounts, worstSeverity } from "../analyzers/audit.js";
import { formatMicroUsd, bigORank } from "../monitors/analyzers.js";

/** Columns, in display order. Ids are stable — the UI keys off them. */
export const SCORECARD_COLUMNS = Object.freeze([
  { id: "security",     label: "Security",     analyzer: "vuln" },
  { id: "cost",         label: "Cost",         analyzer: "estimate" },
  { id: "complexity",   label: "Complexity",   analyzer: "algo" },
  { id: "architecture", label: "Architecture", analyzer: "arch" },
]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

export async function scorecardHandler(request, env) {
  const entitlement = await resolveEntitlement(env, null, { request });
  if (!entitlement || !entitlement.org) {
    return jsonResponse(
      { error: "no_organisation", message: "This account is not a member of any organisation." },
      404,
    );
  }

  const monitors = await listMonitors(env, entitlement.org.orgId);
  return jsonResponse({
    columns: SCORECARD_COLUMNS.map((c) => ({ id: c.id, label: c.label })),
    rows: monitors.map(scorecardRow),
    // Said out loud so the UI never has to guess why a repo is missing: the
    // scorecard grades MONITORED repositories, and a one-off manual scan is
    // not one. Without this line an empty scorecard on an account that has
    // run twenty audits reads as a bug.
    basis: "Rows come from scheduled monitors. A repository has to be under watch to be graded.",
  });
}

function scorecardRow(m) {
  const on = m.analyzers || ["vuln"];
  // A monitor whose last ATTEMPT did not produce a result is showing values
  // from an earlier run. Every cell inherits that, because staleness is a
  // property of the sweep, not of one analyzer.
  const stale = m.lastStatus === "failed" || m.lastStatus === "skipped";

  return {
    monitorId: m.monitorId,
    repo:      shortRepo(m.repoUrl),
    repoUrl:   m.repoUrl,
    branch:    m.branch,
    paused:    m.pausedAt !== null,
    gradedAt:  m.lastRunAt,
    attemptedAt: m.lastAttemptAt,
    status:    m.lastStatus,
    error:     m.lastError,
    cells: {
      security:     securityCell(m, on, stale),
      cost:         costCell(m, on, stale),
      complexity:   complexityCell(m, on, stale),
      architecture: architectureCell(m, on, stale),
    },
  };
}

/** owner/name, from the stored https://github.com/owner/name. */
function shortRepo(url) {
  return String(url || "").replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

function off()                 { return { kind: "off", note: null, value: null, rank: null }; }
function pending(note)         { return { kind: "pending", note, value: null, rank: null }; }
function graded(value, note, rank, stale) {
  return { kind: stale ? "stale" : "grade", value, note, rank };
}

// ---------------------------------------------------------------------------
// Security — the audit's own grade, recomputed from the stored severity mix.
// ---------------------------------------------------------------------------
//
// Recomputed rather than stored so that a change to the grading rules in
// analyzers/audit.js reaches every historical row on the next page load
// instead of leaving a mix of old and new letters on the same screen.
function securityCell(m, on, stale) {
  if (!on.includes("vuln")) return off();          // not reachable today: vuln is mandatory
  const counts = m.lastSeverities;
  if (!counts) {
    return pending(m.lastAdvisoryIds === null
      ? "No sweep has completed yet."
      : "Swept before severities were recorded; the next sweep grades it.");
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // The audit's own scoring function, ceilings included — not a copy of it.
  // A second implementation would eventually put a letter here that the
  // report this cell links to does not show.
  const score = scoreForCounts(counts);

  const worst = worstSeverity(counts);
  return graded(
    `${gradeForScore(score)} · ${total}`,
    total === 0
      ? "No advisories in the last sweep."
      : `Worst is ${worst}; ${total} advisor${total === 1 ? "y" : "ies"} total.`,
    // Rank is "how bad", so higher sorts first — the same direction for every
    // column, which is what lets the UI sort without per-column knowledge.
    100 - score,
    stale,
  );
}

// ---------------------------------------------------------------------------
// Cost — the cheapest provider's monthly total from the last estimate.
// ---------------------------------------------------------------------------
function costCell(m, on, stale) {
  if (!on.includes("estimate")) return off();
  const est = m.lastEstimate;
  if (!est) return pending("No estimate recorded yet.");

  const entries = Object.entries(est.byProvider || {});
  if (!entries.length) {
    // A recorded-but-empty baseline is the sweep's way of saying it looked
    // and found no compose file. That is a real answer, not a missing one.
    return pending("No compose file found in the repository.");
  }
  entries.sort((a, b) => a[1] - b[1]);
  const [providerId, micro] = entries[0];
  return graded(
    formatMicroUsd(micro),
    `Cheapest of ${entries.length} provider${entries.length === 1 ? "" : "s"} — ${providerId}. List prices, not your bill.`,
    micro,
    stale,
  );
}

// ---------------------------------------------------------------------------
// Complexity — the worst Big-O the optimizer measured.
// ---------------------------------------------------------------------------
function complexityCell(m, on, stale) {
  if (!on.includes("algo")) return off();
  const algo = m.lastAlgo;
  if (!algo) return pending("No complexity run recorded yet.");

  const names = Object.keys(algo.byName || {});
  if (!names.length) return pending("No optimizer.config.json in the repository.");

  let worstLabel = null, worstRank = -1;
  for (const name of names) {
    const label = algo.byName[name];
    const rank  = bigORank(label);
    if (rank > worstRank) { worstRank = rank; worstLabel = label; }
  }
  return graded(
    worstLabel,
    `Worst of ${names.length} measured entr${names.length === 1 ? "y" : "ies"}.`,
    worstRank,
    stale,
  );
}

// ---------------------------------------------------------------------------
// Architecture — how many findings the last X-ray left open.
// ---------------------------------------------------------------------------
function architectureCell(m, on, stale) {
  if (!on.includes("arch")) return off();
  const keys = m.lastArchKeys;
  if (keys === null) return pending("No architecture run recorded yet.");
  return graded(
    String(keys.length),
    keys.length === 0
      ? "No findings in the last sweep."
      : `${keys.length} open finding${keys.length === 1 ? "" : "s"}.`,
    keys.length,
    stale,
  );
}
