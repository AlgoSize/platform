// GET /api/scorecard — one row per monitored repository, one column per
// gradable result.
//
// Not one column per ANALYZER: the vuln analyzer produces two answers that a
// reader acts on separately — third-party advisories and findings in the
// repository's own code — and blending them into one grade means a clean
// dependency tree can hide an exploitable codebase.
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
// Every cell that is not a grade also carries a `fix`: the single change that
// would make it one, or null when the answer is "nothing you can do". A grid
// full of accurate blanks is only half a product — the reader still has to
// guess whose move it is.
//
// `off` and `pending` are deliberately distinct. "You have not enabled cost
// analysis" and "cost analysis is enabled and has not found a compose file"
// are different problems with different fixes, and a single grey dash for
// both would hide the second one forever.

import {
  requireOrgContext, explainUnavailable, fixUnavailable, NOT_APPLICABLE_REASONS,
} from "./monitors.js";
import { listMonitors } from "../monitors/_store.js";
import { gradeForScore, scoreForCounts, worstSeverity } from "../analyzers/audit.js";
import { formatMicroUsd, bigORank } from "../monitors/analyzers.js";

/** Columns, in display order. Ids are stable — the UI keys off them. */
export const SCORECARD_COLUMNS = Object.freeze([
  // "Security" was one word over two very different claims, in exactly the
  // way "Cost" was. This column scores the ADVISORY LIST — third-party
  // packages with published CVEs — and nothing else. A repository with no
  // vulnerable dependencies and twelve critical injection findings in its own
  // code graded "A · 0" under the old label, which is the most flattering
  // possible reading of half a scan.
  { id: "security",     label: "Dependencies", analyzer: "vuln",
    idiom: "grade · advisories", glyph: "!" },
  // The other half, from the same analyzer and the same sweep. Deliberately
  // its own column rather than folded into the grade above: the two have
  // different owners and opposite fixes — one is `npm audit fix`, the other is
  // a code change — and a single letter blending them could be traced back to
  // neither report.
  { id: "code",         label: "Code",         analyzer: "vuln",
    idiom: "grade · source findings", glyph: "\u2039\u203a" },
  // Two money columns, and the labels have to keep them apart. "Cost" alone
  // sat above the compose-file ESTIMATOR — a projection from list prices for
  // infrastructure that may not exist yet — while the analyzer that reads
  // your actual bill had no column at all. One of those is a forecast and the
  // other is a fact, and a single word for both is how a reader comes away
  // believing the forecast is the bill.
  { id: "cost",         label: "Infra cost",   analyzer: "estimate",
    idiom: "forecast / mo", glyph: "$\u2192" },
  { id: "spend",        label: "Cloud spend",  analyzer: "cost",
    idiom: "billed / mo", glyph: "$\u2190" },
  { id: "complexity",   label: "Complexity",   analyzer: "algo",
    idiom: "worst vs ceiling", glyph: "\u0192" },
  { id: "architecture", label: "Architecture", analyzer: "arch",
    idiom: "findings", glyph: "\u25ab" },
]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

export async function scorecardHandler(request, env) {
  // The same resolver the monitor endpoints use, so an API key that can read
  // monitors can read their grades — the scorecard is a view of exactly the
  // rows /api/monitors returns, and gating it differently would be a
  // permission surprise with no reason behind it.
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const monitors = await listMonitors(env, ctxOrg.orgId);
  return jsonResponse({
    // idiom and glyph travel WITH the label. The frontend used to hold its
    // own parallel column list to get them, which is how a renamed column
    // ends up captioned as the one it replaced.
    // `analyzer` travels too, so a cell can link into the tool that produced
    // it. Two columns share one analyzer (Dependencies and Code are both the
    // vuln sweep), which is exactly why the frontend must not infer the tool
    // from the column id: it would need its own copy of that mapping, and the
    // day a column moves analyzers the link would point at the old one.
    columns: SCORECARD_COLUMNS.map((c) => ({
      id: c.id, label: c.label, idiom: c.idiom, glyph: c.glyph,
      analyzer: c.analyzer,
    })),
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
    // Trend rides on the row rather than inside the cell so it is obvious at
    // a glance that exactly one column has one, and which.
    trends: { security: depsTrend(m) },
    cells: {
      security:     securityCell(m, on, stale),
      code:         codeCell(m, on, stale),
      cost:         costCell(m, on, stale),
      spend:        spendCell(m, on, stale),
      complexity:   complexityCell(m, on, stale),
      architecture: architectureCell(m, on, stale),
    },
  };
}

/** owner/name, from the stored https://github.com/owner/name. */
function shortRepo(url) {
  return String(url || "").replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

// `fix` is the one thing the reader can change to make this cell produce a
// number, or null when there is nothing for them to do. It is the difference
// between a grid that reports gaps and one that closes them: every empty cell
// on this board was, until now, a true sentence and a dead end.
function off()                 { return { kind: "off", note: null, fix: null, value: null, rank: null }; }
function pending(note, fix = null) { return { kind: "pending", note, fix, value: null, rank: null }; }
/**
 * The analyzer is switched on and the sweep ran, but this analyzer produced
 * nothing — no manifests, no compose file, no runnable config.
 *
 * Its own kind, deliberately. It used to be indistinguishable from a real
 * result: on `no_manifests` the sweep records an EMPTY baseline so a repo
 * that later gains a manifest baselines from nothing, and the architecture
 * column rendered that empty array as "0 · No findings in the last sweep" —
 * a clean bill of health for a repository the X-ray never read. A grid whose
 * zeros cannot be trusted is worse than one with gaps in it.
 */
function unmeasured(note, fix = null) { return { kind: "unmeasured", note, fix, value: null, rank: null }; }

/**
 * There is nothing here to measure, and there was never going to be.
 *
 * `unmeasured` says "we tried and could not". This says "this repository has
 * no such thing" — no docker-compose.yml to price, no cost export to read, no
 * manifests to map. On our own repository two of the six columns are in this
 * state permanently: Algosize runs on Cloudflare, so there is no AWS Cost &
 * Usage Report and no compose stack, and both cells read NOT MEASURED beside
 * three that were genuinely rate-limited. The reader cannot tell a column that
 * failed from a column that has nothing to say, so all five look broken.
 *
 * This is the distinction the compliance catalog already draws between
 * `not_covered` (a fact about the tool) and `insufficient_evidence` (a finding
 * about the customer). The scorecard predates that model and never got it.
 *
 * `fix` is still carried, and deliberately so: "Commit a docker-compose.yml,
 * or point `compose` in algosize.budget.json at the one you already use" is
 * exactly what a reader with a compose stack elsewhere needs. Nothing to
 * measure HERE is not nothing the reader could ever do.
 */
function notApplicable(note, fix = null) { return { kind: "not_applicable", note, fix, value: null, rank: null }; }

/**
 * Why this analyzer produced nothing in the last sweep, or null if it did.
 *
 * `lastSkips` is null on a monitor swept before migration 0022 — unknown, not
 * empty — so an old row keeps its previous rendering rather than claiming
 * every analyzer ran.
 */
function skipFor(m, analyzer) {
  if (!Array.isArray(m.lastSkips)) return null;
  const hit = m.lastSkips.find((s) => s && s.analyzer === analyzer);
  if (!hit) return null;
  return { note: explainUnavailable(hit.reason), fix: fixUnavailable(hit.reason), reason: hit.reason };
}

/**
 * The cell for a recorded skip, in the kind the reason deserves — or null when
 * the analyzer did produce something.
 *
 * One place, so the five columns cannot drift apart on which reasons count as
 * a failure. NOT_APPLICABLE_REASONS is the list, and it lives beside the copy
 * tables in handlers/monitors.js rather than here, because the sentence and
 * its classification are the same decision.
 */
function skipCell(m, analyzer) {
  const skipped = skipFor(m, analyzer);
  if (!skipped) return null;
  return NOT_APPLICABLE_REASONS.has(skipped.reason)
    ? notApplicable(skipped.note, skipped.fix)
    : unmeasured(skipped.note, skipped.fix);
}
/**
 * The movement since the previous sweep, for the ONE column that stores it.
 *
 * `last_delta_json` is written by the sweep itself, because the delta cannot
 * be recomputed on read: `last_advisory_ids` holds the current set, and the
 * previous set is gone the moment it is overwritten. It covers dependency
 * advisories and nothing else.
 *
 * The other five columns store no prior value at all, so they get no trend.
 * Rendering one for them would mean inventing a comparison — and the obvious
 * placeholder, a flat "=", is the worst available answer: it asserts "no
 * change" about a question nothing ever asked. Migration 0009 makes the same
 * point about this column's own NULL, which is why `unknown` is a state here
 * rather than a zero:
 *
 *   null      the monitor has not completed a sweep since the column existed,
 *             or this analyzer has no delta — UNKNOWN, rendered as nothing
 *   baseline  the first sweep. It stores a zero because nothing can be "new"
 *             against a set that did not exist yet, and that zero is NOT a
 *             comparison: rendering it as "no new" would have the grid report
 *             stability across a window one sweep wide.
 *   total 0   a second or later sweep found nothing new — a real "no change"
 *   total > 0 n new advisories, with the severity mix that makes it readable
 */
function depsTrend(m) {
  const d = m.lastDelta;
  if (!d || typeof d.total !== "number") return null;
  if (d.baseline) return null;
  if (d.total === 0) return { direction: "flat", label: "no new", count: 0 };
  // Lead with the worst severity that actually moved: "+2 crit" is the
  // sentence a reader acts on, "+2" is one they have to go and look up.
  const order = ["critical", "high", "medium", "low", "unknown"];
  const worst = order.find((k) => Number(d.counts && d.counts[k]) > 0);
  const short = { critical: "crit", high: "high", medium: "med", low: "low", unknown: "unknown" };
  const n = worst ? Number(d.counts[worst]) : d.total;
  return {
    direction: "up",
    label: "+" + n + (worst ? " " + short[worst] : ""),
    count: d.total,
  };
}

function graded(value, note, rank, stale) {
  return { kind: stale ? "stale" : "grade", value, note, fix: null, rank };
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
// Code — what the source scanner found in the repository's own files.
// ---------------------------------------------------------------------------
//
// Graded on the WORST severity present, not on the count, because that is how
// the finding list is actually triaged: one critical injection outranks forty
// low-confidence style findings, and a column that sorted by volume would put
// the noisy repository above the exploitable one.
//
// The sweep has performed this scan since the SAST engine shipped and stored
// nothing (migrations/0024 fixed that). Rows swept before it read `pending`,
// never zero — a repository whose code was never stored is not a repository
// whose code is clean.
function codeCell(m, on, stale) {
  if (!on.includes("vuln")) return off();          // not reachable: vuln is mandatory
  const skipped = skipCell(m, "source");
  if (skipped) return skipped;

  const src = m.lastSource;
  if (!src) return pending("No source scan recorded yet.");

  const counts = src.counts || {};
  const worst = ["critical", "high", "medium", "low", "info"].find((k) => (counts[k] || 0) > 0);
  if (!worst) {
    // Measured and clean. This IS a real zero — the scan ran, read files, and
    // found nothing — which is why it grades rather than reading as pending.
    return graded("0", "No findings in the last scan.", 0, stale);
  }
  return graded(
    `${SEVERITY_INITIAL[worst]} · ${src.total}`,
    `Worst is ${worst}; ${src.total} finding${src.total === 1 ? "" : "s"} total.`,
    // Same direction as every other column: higher sorts first. Severity
    // dominates, count only breaks ties within a severity band.
    SEVERITY_WEIGHT[worst] + Math.min(src.total, 99) / 100,
    stale,
  );
}

/** Severity as one letter, so the cell reads at a glance beside a count. */
const SEVERITY_INITIAL = Object.freeze({
  critical: "C", high: "H", medium: "M", low: "L", info: "I",
});
const SEVERITY_WEIGHT = Object.freeze({
  critical: 400, high: 300, medium: 200, low: 100, info: 50,
});

// ---------------------------------------------------------------------------
// Cost — the cheapest provider's monthly total from the last estimate.
// ---------------------------------------------------------------------------
function costCell(m, on, stale) {
  if (!on.includes("estimate")) return off();
  const skipped = skipCell(m, "estimate");
  if (skipped) return skipped;
  const est = m.lastEstimate;
  if (!est) return pending("No estimate recorded yet.");

  const entries = Object.entries(est.byProvider || {});
  if (!entries.length) {
    // A recorded-but-empty baseline is the sweep's way of saying it looked
    // and found no compose file. That is a real answer, not a missing one.
    // (Rows swept since migration 0022 take the skipCell branch above; this
    // is the pre-0022 path, and it lands in the same kind either way, so an
    // old row and a new row describing the same repository read alike.)
    return notApplicable("No compose file found in the repository.", fixUnavailable("no_compose"));
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
  const skipped = skipCell(m, "algo");
  if (skipped) return skipped;
  const algo = m.lastAlgo;
  if (!algo) return pending("No complexity run recorded yet.");

  const names = Object.keys(algo.byName || {});
  if (!names.length) {
    return notApplicable("No optimizer.config.json in the repository.", fixUnavailable("no_config"));
  }

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
  const skipped = skipCell(m, "arch");
  if (skipped) return skipped;
  const keys = m.lastArchKeys;
  if (keys === null) return pending("No architecture run recorded yet.");
  return graded(
    String(keys.length),
    archNote(keys.length, m.lastArchScope),
    keys.length,
    stale,
  );
}

/**
 * What the number means, with the evidence behind it when we have it.
 *
 * "No findings in the last sweep" was the same sentence for a sweep that
 * mapped forty services and cleared them and one that mapped a single file
 * and had nothing to say. The scope (migrations/0023) is what separates
 * those, and its absence — a row last swept before the column existed — falls
 * back to the old wording rather than asserting a scope of zero.
 */
function archNote(count, scope) {
  const measured = scope && typeof scope.services === "number"
    ? `${scope.services} service${scope.services === 1 ? "" : "s"}` +
      (scope.complete ? "" : " (partial read)")
    : null;
  if (count === 0) {
    return measured
      ? `No findings across ${measured}.`
      : "No findings in the last sweep.";
  }
  const open = `${count} open finding${count === 1 ? "" : "s"}`;
  return measured ? `${open} across ${measured}.` : `${open}.`;
}

// ---------------------------------------------------------------------------
// Cloud spend — what the committed cost export says you are actually paying.
// ---------------------------------------------------------------------------
//
// Distinct from the Infra cost column in the way a bank statement is distinct
// from a quote. That one prices a compose file against published list rates
// for infrastructure that may never be provisioned; this one reads a Cost &
// Usage Report you committed and reports the total on it.
//
// Graded on WASTE, not on size, which is the only ranking that makes the
// column actionable: the most expensive repository you own is not a problem
// if none of that spend is avoidable, and a small bill that is 60% idle
// capacity is. So the rank is the dollars the analyzer believes are
// recoverable, and the biggest recoverable number sorts to the top.
function spendCell(m, on, stale) {
  if (!on.includes("cost")) return off();
  const skipped = skipCell(m, "cost");
  if (skipped) return skipped;

  const c = m.lastCost;
  // No stored figure and no recorded skip. Either the sweep predates
  // migration 0023 or the analyzer was switched on and has not run yet —
  // both are honestly "pending", and neither is a zero bill.
  if (!c) return pending("No cloud-spend run recorded yet.", fixUnavailable("no_cur"));

  const savings = Math.round(c.currentSpend * (c.totalSavingsPct || 0)) / 100;
  return graded(
    formatUsd(c.currentSpend) + "/mo",
    c.suggestions
      ? `${formatUsd(savings)} of it looks recoverable across ${c.suggestions} suggestion${c.suggestions === 1 ? "" : "s"}.`
      : "Nothing in this export looks recoverable.",
    savings,
    stale,
  );
}

/** Whole dollars with thousands separators — a bill, not a unit price. */
function formatUsd(n) {
  const v = Math.round(Number(n) || 0);
  return "$" + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
