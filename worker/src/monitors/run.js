// Scheduled monitoring: the cron sweep, and the per-monitor check the queue
// consumer runs.
//
// Split in two on purpose. The Cron Trigger fires once (daily, 03:00 UTC) and
// its only job is to decide which monitors are due and put one message per
// monitor on the queue. The actual work — fetch lockfiles, query OSV, diff,
// email — happens one monitor per message.
//
// That split is the whole reason for the queue. A cron handler that looped
// over every monitor inline would run them in one invocation against one CPU
// budget, so a single slow or hanging repo would starve every monitor behind
// it, and a failure partway through would lose the rest of the sweep with no
// retry. One message per monitor means a slow repo delays only itself, and a
// transient GitHub or OSV outage retries just the monitor it hit.

import { runLockfileAudit } from "../handlers/analyze.js";
import { newTreeCache } from "../github.js";
import { persistRun } from "../handlers/runs.js";
import { resolveMonitorRoute, monitorSlackText } from "./routing.js";
import { postToSlack } from "../slack.js";
import { sendTransactional as defaultSendTransactional } from "../email/transactional.js";
import { monitorNewFindings } from "../email/templates.js";
import { captureException } from "../observability.js";
import { countBySeverity } from "../analyzers/audit.js";
import {
  listMonitorsDue,
  cronSweepsHourly,
  getMonitorById,
  recordMonitorRun,
  recordMonitorAttempt,
} from "./_store.js";
import {
  diffAdvisories,
  groupBySeverity,
  countBySeverityOrdered,
  hashKeySet,
} from "./diff.js";
import {
  runArchForMonitor, diffArchFindings,
  runEstimateForMonitor,
  runCostForMonitor, diffEstimate,
  runAlgoForMonitor, diffAlgoGrades,
  diffSourceFindings, sourceBaselineFrom,
} from "./analyzers.js";
import { recordEmailSend } from "../oplog.js";
import { recordSnapshot } from "../arch/snapshots.js";

// Bound on how many monitors one sweep enqueues. Far above any plausible
// near-term monitor count; it exists so a runaway row count can't turn one
// cron tick into an unbounded fan-out. listMonitorsDue orders oldest-run
// first, so if this ever bites, the monitors that have gone longest without
// a check are the ones that make it in.
const MAX_MONITORS_PER_SWEEP = 1000;

/**
 * The Cron Trigger handler. Enqueues one message per due monitor.
 *
 * Returns a small summary object so tests (and a future admin endpoint) can
 * assert what a sweep decided without reading logs.
 */
export async function sweepDueMonitors(env, ctx, { now, cron = null } = {}) {
  const nowSec = typeof now === "number" ? now : Math.floor(Date.now() / 1000);
  // Read straight off the cron expression this invocation was fired with, so
  // "does the sweep tick hourly" can never disagree with the trigger that
  // asked the question. See isDue in monitors/_store.js for what it changes.
  const sweepsHourly = cronSweepsHourly(cron);

  if (!env || !env.DB) {
    console.warn("monitors: no DB binding; skipping sweep");
    return { enqueued: 0, due: 0, skipped: "no_db" };
  }

  let due;
  try {
    due = await listMonitorsDue(env, nowSec, MAX_MONITORS_PER_SWEEP, { sweepsHourly });
  } catch (err) {
    await captureException(env, ctx, err, { tags: { source: "monitors", phase: "sweep_query" } });
    return { enqueued: 0, due: 0, skipped: "query_failed" };
  }

  if (!env.SCAN_QUEUE) {
    // No queue binding — refuse to fall back to running them inline. Inline
    // is the failure mode this design exists to avoid, and doing it silently
    // would make a misconfigured deploy look healthy right up until one slow
    // repo eats the cron invocation.
    await captureException(
      env, ctx,
      new Error("monitors: SCAN_QUEUE binding missing; cannot dispatch sweep"),
      { tags: { source: "monitors", phase: "sweep_dispatch", reason: "no_queue_binding" } },
    );
    return { enqueued: 0, due: due.length, skipped: "no_queue_binding" };
  }

  let enqueued = 0;
  for (const monitor of due) {
    try {
      await env.SCAN_QUEUE.send({ monitorId: monitor.monitorId, enqueuedAt: nowSec });
      enqueued++;
    } catch (err) {
      // One failed send must not abandon the rest of the sweep.
      await captureException(env, ctx, err, {
        tags: { source: "monitors", phase: "sweep_enqueue" },
        extra: { monitorId: monitor.monitorId },
      });
    }
  }

  return { enqueued, due: due.length };
}

/**
 * File a sweep's results as runs.
 *
 * A scheduled audit and a CI audit are the same work on the same repository,
 * and until this existed only one of them was answerable. `/api/ci/runs`
 * persists what it finds, so "what did the pipeline flag last night" has an
 * answer with a run id, a report and a SARIF export behind it; a monitor
 * sweep wrote its result onto the monitor row and nowhere else, so the same
 * question about the nightly sweep had no answer at all — not in run history,
 * not through `algosize_list_runs`, not as a downloadable report. The monitor
 * row keeps only the LATEST sweep, so the history was not merely hidden, it
 * did not exist.
 *
 * `source: "monitor"` is what separates the two afterwards, and it is a third
 * value rather than a reuse of "ci": a nightly sweep nobody asked for and a
 * gate that blocked a pull request are different evidence, and a reader
 * filtering for one does not want the other.
 *
 * These runs cost NO quota, deliberately. A sweep the customer scheduled once
 * and then stopped thinking about must not quietly drain the allowance they
 * are keeping for work they are actually doing — a nightly monitor would
 * exhaust a free plan inside a week and the first symptom would be a manual
 * analysis refused for reasons nobody could see. Metering lives on the HTTP
 * routes (`enforceQuota` in the chain); nothing here goes near one.
 *
 * Never throws, and never awaited on the critical path's behalf: the sweep's
 * job is the baseline and the alert. Losing a run row to a D1 hiccup is worth
 * strictly less than re-delivering the message and re-sending every email
 * that already went out.
 */
/**
 * `source.status` from the audit response, as a monitor skip reason.
 *
 * Mapped rather than passed through so the operator-visible vocabulary in
 * handlers/monitors.js stays a closed set — a new status added upstream shows
 * up as the generic `source_failed` with a sentence, instead of reaching the
 * scorecard as an unexplained code nobody has written a fix line for.
 */
const SOURCE_SKIP_REASON = Object.freeze({
  unavailable:     "source_unreadable",
  no_source_files: "no_source_files",
  failed:          "source_failed",
});

async function persistSweepRuns(env, ctx, monitor, filings, nowSec) {
  const ids = {};
  for (const f of filings) {
    try {
      const run = await persistRun(env, {
        orgId:  monitor.orgId,
        // A schedule authenticates as nobody. The org owns the row, exactly as
        // it does for a CI run, so the sweep stays visible to the whole team
        // and outlives whoever created the monitor.
        userId: null,
        analyzer: f.analyzer,
        source:   "monitor",
        // `repo` and `ref` under the names listRuns already reads for CI, so
        // one shaping path serves both origins instead of two that drift.
        // Paths and identities only — never the fetched file contents, which
        // are the customer's source.
        input: {
          monitorId: monitor.monitorId,
          repo:      monitor.repoUrl,
          ref:       monitor.branch || null,
          scheduled: true,
          sweptAt:   nowSec,
        },
        result: f.result,
      });
      if (run && run.id) ids[f.analyzer] = run.id;
    } catch (err) {
      await captureException(env, ctx, err, {
        tags: { source: "monitors", phase: "persist_run", reason: f.analyzer },
        extra: { monitorId: monitor.monitorId, analyzer: f.analyzer },
      });
    }
  }
  return ids;
}

/**
 * The queue consumer's per-message body: run one monitor end to end.
 *
 * Returns a result object describing what happened. Throwing is reserved for
 * conditions a retry could plausibly fix (the audit failed upstream), because
 * throwing is what tells the Queue to redeliver. A monitor that has been
 * deleted or paused since it was enqueued returns quietly instead — retrying
 * that forever would be pointless.
 */
export async function runMonitorCheck(env, monitorId, ctx, { now, sendTransactional: sendTxOverride } = {}) {
  const nowSec = typeof now === "number" ? now : Math.floor(Date.now() / 1000);
  const send   = sendTxOverride || defaultSendTransactional;

  const monitor = await getMonitorById(env, monitorId);
  if (!monitor) return { status: "gone", monitorId };

  // Re-checked here, not just at enqueue time: a monitor can be paused in the
  // window between the sweep and the consumer picking the message up, and the
  // pause should win.
  if (monitor.pausedAt !== null) return { status: "paused", monitorId };

  // One tree listing for the whole sweep.
  //
  // Three analyzers used to list the SAME tree at the SAME commit: the
  // dependency audit, the source scanner, and the architecture X-ray. Against
  // GitHub's anonymous 60-requests-per-hour-per-IP — and a Cloudflare Worker's
  // egress IP is shared far past this account — that is roughly twenty
  // monitors an hour deployment-wide before the budget is gone, after which
  // every cell downstream reads NOT MEASURED. This cache lives for exactly one
  // monitor's sweep and is then discarded: a tree held across sweeps would be
  // a stale answer presented as a fresh measurement.
  const treeCache = newTreeCache();

  const response = await runLockfileAudit(
    { repoUrl: monitor.repoUrl, branch: monitor.branch || undefined },
    env,
    null,          // no request — this is a scheduled run, not an HTTP call
    ctx,
    { treeCache },
  );

  let result;
  try { result = await response.json(); }
  catch { result = null; }

  if (!response.ok) {
    const code = (result && result.error) || `http_${response.status}`;
    // 4xx means the monitor's own configuration is wrong (bad URL, no
    // lockfile in the repo) — retrying nightly forever won't fix that, and
    // it must not be reported as a vulnerability change either. 5xx means
    // GitHub or OSV was unreachable, which is exactly what a retry is for.
    if (response.status >= 500) {
      // Transient: baselines stay exactly where they are, but the attempt is
      // recorded so the row can render "stale" rather than silently looking
      // like it swept clean last night.
      await recordMonitorAttempt(env, monitorId, {
        status: "skipped", error: code, at: nowSec,
      });
      const err = new Error(`monitor ${monitorId}: audit failed (${code})`);
      await captureException(env, ctx, err, {
        tags: { source: "monitors", phase: "audit", reason: code },
        extra: { monitorId, repoUrl: monitor.repoUrl },
      });
      throw err;   // let the Queue retry
    }
    // Permanent: the monitor's own configuration is wrong, and retrying
    // nightly will not fix it. Recorded so the screen can say so instead of
    // showing "baseline pending" forever — the bug this replaces.
    await recordMonitorAttempt(env, monitorId, {
      status: "failed", error: code, at: nowSec,
    });
    return { status: "audit_error", monitorId, code, retryable: false };
  }

  // The dependency half's own state, read exactly the way `source.status` is
  // read below. A repository with no lockfile used to be a 4xx from the
  // analyzer and took the permanent-failure branch above; now the analyzer
  // keeps going so the source scan still happens, and the dependency half says
  // it was not measured instead.
  //
  // The baseline is the reason this needs its own branch. Diffing an empty
  // advisory list against a stored one does not read as "we did not look" — it
  // reads as EVERY ADVISORY FIXED, and would send an email saying so. So an
  // unmeasured half advances nothing, exactly as an outage in the source scan
  // advances nothing.
  // Declared here rather than beside the secondary analyzers, because the
  // dependency half is now the first thing that can skip.
  const skips = [];

  const depsMeasured = !(result && result.dependencies && result.dependencies.status &&
                         result.dependencies.status !== "ok");
  const advisories = depsMeasured && Array.isArray(result && result.advisories)
    ? result.advisories : [];
  const diff = depsMeasured
    ? diffAdvisories(advisories, monitor.lastAdvisoryIds)
    : {
        // The stored baseline, carried forward byte for byte. recordMonitorRun
        // writes advisoryIds unconditionally — unlike the per-analyzer
        // baselines, it has no `undefined` contract — so "leave it alone" has
        // to be spelled as "write back what is already there".
        currentKeys:   Array.isArray(monitor.lastAdvisoryIds) ? monitor.lastAdvisoryIds : [],
        newAdvisories: [],
        resolvedKeys:  [],
        shouldAlert:   false,
        isBaseline:    false,
      };
  if (!depsMeasured) {
    // no_lockfiles is a permanent, honest answer about the repository, not an
    // outage — the same shape as no_source_files — so it joins
    // NOT_APPLICABLE_REASONS rather than reading as an error someone must fix.
    skips.push({ analyzer: "vuln", reason: "no_lockfiles" });
  }

  // What this sweep will file as runs (see persistSweepRuns below). Collected
  // as the analyzers finish rather than reconstructed afterwards, because an
  // analyzer that skipped has no result to file and the skip list does not
  // carry one.
  const filings = [{ analyzer: "vuln", result }];

  // ---- secondary analyzers (migrations/0016) ------------------------------
  // Each runs only when its toggle is on, reads only committed repo files,
  // and fails SOFT: a skip is captured and its baseline stays untouched
  // (recordMonitorRun writes only baselines explicitly provided), so an
  // outage costs a night's coverage rather than a false "all new" email.
  const analyzers = monitor.analyzers || ["vuln"];
  const fetchImpl = (env && env.FETCH) || globalThis.fetch;

  // ---- source scan (migrations/0024) --------------------------------------
  //
  // runLockfileAudit has ALWAYS performed this scan and returned it as
  // `source`; the sweep read `advisories` beside it and dropped the rest.
  // The scan was paid for — a GitHub tree listing, up to 120 file fetches, a
  // full parse — and thrown away, and the consequence was not merely a missing
  // feature: the scorecard graded the advisory list alone, so a repository
  // with no CVEs and twelve critical injection findings rendered as "A · 0".
  //
  // `source.status` is the field that keeps this honest. Only "ok" means the
  // code was read; every other value is recorded as a skip so the cell says
  // "not measured" rather than showing an empty finding list as a clean bill.
  const source = result && result.source;
  let sourceDiff = null, sourceBaseline;
  if (source && source.status === "ok") {
    const findings = Array.isArray(source.findings) ? source.findings : [];
    sourceDiff = diffSourceFindings(findings, monitor.lastSource);
    sourceBaseline = sourceBaselineFrom(source, sourceDiff, nowSec);
  } else if (source && source.status) {
    // no_source_files is a permanent, honest answer ("this repository has
    // nothing this scanner reads") and gets an empty baseline so a repo that
    // later gains JavaScript baselines from nothing. unavailable/failed are
    // outages: the previous baseline is deliberately left untouched, exactly
    // as the secondary analyzers do, so one bad night cannot report the whole
    // codebase as new tomorrow.
    if (source.status === "no_source_files") {
      sourceBaseline = { total: 0, counts: {}, keys: [], truncated: false, at: nowSec };
    }
    skips.push({ analyzer: "source", reason: SOURCE_SKIP_REASON[source.status] || "source_failed" });
  } else {
    // No block at all. Only reachable against a stored response from before
    // the source scan existed — recorded rather than assumed clean.
    skips.push({ analyzer: "source", reason: "source_unsupported" });
  }

  let archDiff = null, archBaseline, archScope;
  if (analyzers.includes("arch")) {
    const arch = await runArchForMonitor(monitor, env, fetchImpl, treeCache);
    if (arch.status === "ok") {
      archDiff = diffArchFindings(arch.findings, arch.keys, monitor.lastArchKeys);
      archBaseline = archDiff.currentKeys;
      // What the X-ray read, stored beside what it found (migrations/0023).
      // A finding count without a scope is unfalsifiable: zero findings over
      // forty services and zero findings over one file are the same number
      // and completely different news.
      const summary = (arch.result && arch.result.summary) || {};
      const limits  = (arch.result && arch.result.limits) || {};
      archScope = {
        services: typeof summary.nodes === "number" ? summary.nodes : 0,
        files:    typeof limits.filesAnalyzed === "number" ? limits.filesAnalyzed : null,
        complete: summary.complete === true,
        at:       nowSec,
      };
      if (arch.result) filings.push({ analyzer: "arch", result: arch.result });

      // The nightly snapshot (migrations/0018). This is the one that makes the
      // history CONTINUOUS rather than a scattering of whenever-someone-clicked
      // — a repo under watch accumulates a graph per sweep without anyone
      // asking, which is what "drift since last deploy" needs to be able to
      // answer. Awaited rather than fire-and-forget: the sweep is already
      // running on a queue with nothing waiting on it, and a snapshot that
      // silently loses the race with the isolate shutting down is worse than
      // one that costs a few extra milliseconds. It still cannot throw.
      if (arch.result && arch.result.graph) {
        await recordSnapshot(env, ctx, {
          orgId:     monitor.orgId,
          repoUrl:   monitor.repoUrl,
          branch:    monitor.branch,
          source:    "monitor",
          graph:     arch.result.graph,
          findingCount: arch.findings.length,
          capturedAt: nowSec,
        });
      }
    } else if (arch.status === "no_manifests") {
      // A permanent condition, not an outage: record the empty set so a repo
      // that later gains a manifest baselines from "nothing", and the run
      // status says why nothing was compared.
      archBaseline = [];
      skips.push({ analyzer: "arch", reason: "no_manifests" });
    } else {
      skips.push({ analyzer: "arch", reason: arch.reason });
    }
  }

  let estDiff = null, estBaseline, estProviders = null;
  if (analyzers.includes("estimate")) {
    const est = await runEstimateForMonitor(monitor, env, ctx, fetchImpl);
    if (est.status === "ok") {
      estDiff = diffEstimate(est.byProvider, monitor.lastEstimate);
      estBaseline = { byProvider: est.byProvider, at: nowSec };
      estProviders = est.providers;
      if (est.result) filings.push({ analyzer: "estimate", result: est.result });
    } else if (est.status === "no_compose") {
      estBaseline = { byProvider: {}, at: nowSec };
      skips.push({ analyzer: "estimate", reason: "no_compose" });
    } else {
      skips.push({ analyzer: "estimate", reason: est.reason });
    }
  }

  // Cloud spend. Files a run and shows a standing result; deliberately keeps
  // no baseline and raises no alert — a bill differs every day, so a diff
  // would report Tuesday differing from Monday as a finding. See
  // runCostForMonitor for the whole argument.
  let costSummary;
  if (analyzers.includes("cost")) {
    const cost = await runCostForMonitor(monitor, env, ctx, fetchImpl);
    if (cost.status === "ok") {
      filings.push({ analyzer: "cost", result: cost.result });
      // Stored as the LATEST figure, never compared against the last one
      // (migrations/0023). Keeping no baseline was the right call for
      // alerting and the wrong one for the scorecard, which grades from
      // stored results and so could not see this analyzer at all.
      const r = cost.result || {};
      costSummary = {
        currentSpend:    typeof r.currentSpend === "number" ? r.currentSpend : 0,
        totalSavingsPct: typeof r.totalSavingsPct === "number" ? r.totalSavingsPct : 0,
        suggestions:     Array.isArray(r.suggestions) ? r.suggestions.length : 0,
        at:              nowSec,
      };
    } else if (cost.status === "no_cur") {
      skips.push({ analyzer: "cost", reason: "no_cur" });
    } else {
      skips.push({ analyzer: "cost", reason: cost.reason });
    }
  }

  let algoDiff = null, algoBaseline, algoSkippedEntries = [];
  if (analyzers.includes("algo")) {
    const algo = await runAlgoForMonitor(monitor, env, fetchImpl);
    if (algo.status === "ok") {
      algoDiff = diffAlgoGrades(algo.grades, monitor.lastAlgo);
      algoBaseline = { byName: algo.grades, at: nowSec };
      algoSkippedEntries = algo.skippedEntries || [];
      filings.push({ analyzer: "algo", result: { grades: algo.grades, skippedEntries: algo.skippedEntries || [] } });
    } else if (algo.status === "no_config") {
      algoBaseline = { byName: {}, at: nowSec };
      skips.push({ analyzer: "algo", reason: "no_config" });
    } else {
      skips.push({ analyzer: "algo", reason: algo.reason });
    }
  }

  // Transient skips are worth an operator's eyes; permanent ones are the
  // owner's configuration and would only be noise in Sentry.
  for (const skip of skips) {
    // sandbox_not_configured belongs here too: it is ours to fix, not the
    // repository owner's, and it will not clear on its own the way a throttle
    // or a transient sandbox outage does.
    if (skip.reason === "github_throttled" || skip.reason === "sandbox_unreachable" ||
        skip.reason === "sandbox_not_configured") {
      await captureException(env, ctx,
        new Error(`monitor ${monitorId}: ${skip.analyzer} skipped (${skip.reason})`),
        { tags: { source: "monitors", phase: skip.analyzer, reason: skip.reason },
          extra: { monitorId, repoUrl: monitor.repoUrl } });
    }
  }

  // Record the run BEFORE emailing. If the send fails, the baseline is still
  // advanced — which means the next run reports only what's new relative to
  // tonight rather than re-reporting tonight's list on top of tomorrow's.
  // Losing one email to a mail outage is a better failure than turning the
  // next email into the duplicate-heavy one this feature exists to prevent.
  const recorded = await recordMonitorRun(env, monitorId, {
    ranAt:       nowSec,
    resultHash:  hashKeySet(diff.currentKeys),
    advisoryIds: diff.currentKeys,
    // The severity mix behind that count (migrations/0017). Stored because
    // the identity keys alone cannot be graded: six lows and one critical
    // plus five lows are the same number and a very different repository.
    severities:  countBySeverity(advisories),
    // Recorded so the scorecard can say "not measured" instead of rendering a
    // skipped analyzer's empty baseline as a measured zero.
    skips,
    archKeys:    archBaseline,
    archScope,
    source:      sourceBaseline,
    estimate:    estBaseline,
    algo:        algoBaseline,
    cost:        costSummary,
    // Persist what this run found new (migrations/0009). It has to be written
    // here, in the same statement that advances the baseline, because the
    // moment advisoryIds lands the previous set is gone and this number can
    // never be derived again.
    //
    // A baseline run is recorded as a delta of zero, not as the size of the
    // whole list: the first sweep of a repo "discovers" every advisory, and
    // calling that "+14 new since last run" would be false — there was no
    // last run. diff.isBaseline is exactly that distinction.
    // ...and say WHICH of the two zeroes this is. A baseline zero and a
    // swept-and-found-nothing zero are the same number and opposite claims,
    // and until this flag existed a reader could only tell them apart by
    // noticing that `counts` was empty rather than all-zero. The scorecard
    // shows the second as "no new" and the first as nothing at all.
    delta: {
      total:    diff.isBaseline ? 0 : diff.newAdvisories.length,
      counts:   diff.isBaseline ? {} : countBySeverityOrdered(diff.newAdvisories),
      baseline: !!diff.isBaseline,
      at:       nowSec,
    },
  });

  // An unapplied migration is now survivable (see updateDroppingMissingColumns)
  // — but survivable is not the same as fine, and it must never be quiet. A
  // dropped column means a feature the deployed code believes it has is not
  // being stored, and the only person who can fix that is an operator running
  // `wrangler d1 execute`. So it is captured with the column names in it.
  if (recorded && recorded.droppedColumns && recorded.droppedColumns.length) {
    await captureException(env, ctx,
      new Error(`monitor ${monitorId}: database is missing ${recorded.droppedColumns.join(", ")} — a migration has not been applied`),
      { tags: { source: "monitors", phase: "record_run", reason: "missing_columns" },
        extra: { monitorId, droppedColumns: recorded.droppedColumns } });
  }

  // After the baseline, before the alert. After, because a run row must never
  // be able to cost the sweep its baseline; before, because the alert email
  // carries links and the run ids have to exist by the time it is built.
  const runIds = await persistSweepRuns(env, ctx, monitor, filings, nowSec);

  const anySecondaryAlert =
    (archDiff && archDiff.shouldAlert) ||
    (estDiff && estDiff.shouldAlert) ||
    (algoDiff && algoDiff.shouldAlert) ||
    (sourceDiff && sourceDiff.shouldAlert);

  if (!diff.shouldAlert && !anySecondaryAlert) {
    return {
      status: "no_change",
      monitorId,
      newCount: 0,
      resolvedCount: diff.resolvedKeys.length,
      analyzersRun: analyzers,
      skips,
      runIds,
    };
  }

  // Who actually hears about this. Not the billing owner by construction —
  // every member who has monitor alerts switched on, plus the org's Slack
  // channel if anyone subscribed it. See monitors/routing.js for why this
  // moved out of here.
  const route = await resolveMonitorRoute(env, monitor.orgId);
  if (route.muted) {
    // An org that has switched every channel off is not a failure — it is a
    // choice, and it is reported as its own status so the run feed can say
    // "found something, delivered nowhere" instead of implying an outage.
    return {
      status: "muted",
      monitorId,
      newCount: diff.newAdvisories.length,
      reason: route.reason,
      analyzersRun: analyzers,
      skips,
      runIds,
    };
  }

  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  const message = {
    ...monitorNewFindings({
      repoUrl:       monitor.repoUrl,
      branch:        monitor.branch,
      newAdvisories: diff.newAdvisories,
      groups:        groupBySeverity(diff.newAdvisories),
      counts:        countBySeverityOrdered(diff.newAdvisories),
      fixCommand:    (result && result.fixCommand) || null,
      isBaseline:    diff.isBaseline,
      dashboardUrl:  `${origin}/dashboard/`,
      // Secondary sections — each absent unless its analyzer alerted, so the
      // template (and every existing test of it) is unchanged when a monitor
      // runs vuln alone.
      archSection: archDiff && archDiff.shouldAlert ? {
        newFindings: archDiff.newFindings,
        isBaseline:  archDiff.isBaseline,
      } : null,
      estimateSection: estDiff && estDiff.shouldAlert ? {
        changes:    estDiff.changes,
        isBaseline: estDiff.isBaseline,
        providers:  estProviders,
      } : null,
      algoSection: algoDiff && algoDiff.shouldAlert ? {
        regressions:  algoDiff.regressions,
        improvements: algoDiff.improvements,
        skipped:      algoSkippedEntries,
      } : null,
      // Rule, file and line — deliberately NOT the snippet. Every other
      // surface shows the matched line because the reader asked to see it;
      // an alert email is broadcast to every subscribed member and retained
      // in their mailboxes indefinitely, and a snippet is a verbatim slice of
      // the customer's source. The scanner masks credentials in snippets, but
      // "masked" is a weaker guarantee than "never sent", and a file:line is
      // enough to act on.
      sourceSection: sourceDiff && sourceDiff.shouldAlert ? {
        newFindings: sourceDiff.newFindings.map((f) => ({
          ruleId: f.ruleId, title: f.title, severity: f.severity,
          path: f.path, line: f.line, confidence: f.confidence,
        })),
        isBaseline: sourceDiff.isBaseline,
      } : null,
    }),
  };

  // One message, many addresses — sent individually rather than as a single
  // multi-recipient mail so that one bad address cannot bounce the whole
  // send, and so nobody learns their colleagues' addresses from a To: line.
  const emailResults = [];
  for (const recipient of route.emails) {
    const sent = await send(env, ctx, { to: recipient.email, ...message });
    emailResults.push(sent);
    await recordEmailSend(env, ctx, {
      recipient: recipient.email,
      template:  "monitor_new_findings",
      orgId:     monitor.orgId,
      result:    sent,
    });
  }

  // Slack is best-effort and posted after email. If it fails, the alert has
  // still been delivered on the channel that is guaranteed to exist; the
  // failure is captured for the operator and reported in the run result
  // rather than retried, because a Queue retry here would re-send every
  // email that already succeeded.
  let slackResult = null;
  if (route.slack.enabled) {
    slackResult = await postToSlack(env, ctx, route.slack.url, {
      text: monitorSlackText({
        repoUrl:    monitor.repoUrl,
        branch:     monitor.branch,
        newCount:   diff.newAdvisories.length,
        counts:     countBySeverityOrdered(diff.newAdvisories),
        isBaseline: diff.isBaseline,
        sections:   slackSections({ archDiff, estDiff, algoDiff, sourceDiff }),
        dashboardUrl: `${origin}/dashboard/`,
      }),
    }, fetchImpl);
  }

  return {
    status:        "alerted",
    monitorId,
    newCount:      diff.newAdvisories.length,
    resolvedCount: diff.resolvedKeys.length,
    isBaseline:    diff.isBaseline,
    emailed:       emailResults.some((r) => r && r.sent),
    emailedCount:  emailResults.filter((r) => r && r.sent).length,
    recipientCount: route.emails.length,
    slacked:       !!(slackResult && slackResult.sent),
    slackReason:   slackResult && !slackResult.sent ? slackResult.reason : null,
    analyzersRun:  analyzers,
    archNewCount:      archDiff ? archDiff.newFindings.length : 0,
    sourceNewCount:    sourceDiff ? sourceDiff.newFindings.length : 0,
    estimateChanged:   !!(estDiff && estDiff.shouldAlert),
    algoRegressions:   algoDiff ? algoDiff.regressions.length : 0,
    skips,
    runIds,
  };
}

/**
 * The Queue consumer entry point — one batch of messages.
 *
 * Each message is acked or retried individually: one monitor's failure must
 * not redeliver (and re-email) the monitors that succeeded alongside it in
 * the same batch.
 */
export async function handleMonitorQueue(batch, env, ctx, opts = {}) {
  for (const message of batch.messages || []) {
    const monitorId = message.body && message.body.monitorId;
    if (!monitorId) {
      message.ack();          // malformed and unfixable — don't redeliver
      continue;
    }
    try {
      await runMonitorCheck(env, monitorId, ctx, opts);
      message.ack();
    } catch (err) {
      await captureException(env, ctx, err, {
        tags: { source: "monitors", phase: "queue_consume" },
        extra: { monitorId },
      });
      message.retry();
    }
  }
}

/**
 * The dead-letter consumer — where a monitor message goes to be noticed.
 *
 * `algosize-scans-dlq` has existed in production since 2026-08-18 and had no
 * consumer bound to it, which made it a hole rather than a safety net: a
 * message that exhausted its three retries landed there, was retained for the
 * queue's retention window (four days by default), and was then purged. No
 * alert, no D1 row beyond whatever `recordMonitorAttempt` wrote on the
 * retryable attempts, and no way afterwards to know it had happened. A
 * permanently-broken monitor simply went quiet, which is indistinguishable
 * from a repository that stopped having problems.
 *
 * This does NOT re-run the sweep. A message reaches the DLQ only after
 * runMonitorCheck threw three times, and the throw path is reserved for
 * conditions a retry could plausibly fix (5xx from GitHub or OSV) — three
 * consecutive failures means the retry premise was wrong, and a fourth attempt
 * would fail the same way while looking like progress. The job here is
 * visibility: say loudly that a monitor gave up, and record the attempt so the
 * dashboard stops rendering the row as merely stale.
 *
 * Always acks. A retry() here would return the message to the DLQ it is
 * already in, and a DLQ with no onward destination retries until retention
 * expires — turning one dead message into hundreds of duplicate alerts for the
 * same dead monitor.
 */
export async function handleMonitorDlq(batch, env, ctx) {
  for (const message of batch.messages || []) {
    const monitorId = message.body && message.body.monitorId;
    try {
      await captureException(
        env, ctx,
        new Error(`monitor ${monitorId || "(unknown)"} exhausted its retries and was dead-lettered`),
        {
          tags:  { source: "monitors", phase: "dead_letter" },
          extra: {
            monitorId: monitorId || null,
            // Cloudflare tracks this across the original queue's attempts, so
            // it says how many times the sweep actually ran before giving up.
            attempts: message.attempts ?? null,
            queue: batch.queue || null,
          },
        },
      );
      // The monitor row should say "failed", not sit at whatever the last
      // retryable attempt left. recordMonitorAttempt deliberately touches no
      // baseline, so this cannot corrupt the next successful sweep's diff.
      if (monitorId) {
        await recordMonitorAttempt(env, monitorId, {
          status: "failed",
          error:  "dead_lettered",
          at:     Math.floor(Date.now() / 1000),
        });
      }
    } catch {
      // Observability failing must not strand the message. There is nowhere
      // for it to go from here, and a throw would abort the rest of the batch.
    }
    message.ack();
  }
}

/**
 * One line per secondary analyzer that alerted, for the Slack body.
 *
 * Kept beside the caller rather than in routing.js because it reads the diff
 * shapes that only this module knows about.
 */
function slackSections({ archDiff, estDiff, algoDiff, sourceDiff }) {
  const out = [];
  // Code first: it is the only section that can name a critical severity, and
  // Slack truncates.
  if (sourceDiff && sourceDiff.shouldAlert && sourceDiff.newFindings.length) {
    const n = sourceDiff.newFindings.length;
    const crit = sourceDiff.newFindings.filter((f) => f.severity === "critical").length;
    out.push(`${n} new code finding${n === 1 ? "" : "s"}${crit ? ` (${crit} critical)` : ""}`);
  }
  if (archDiff && archDiff.shouldAlert && archDiff.newFindings.length) {
    out.push(`${archDiff.newFindings.length} new architecture finding${archDiff.newFindings.length === 1 ? "" : "s"}`);
  }
  if (estDiff && estDiff.shouldAlert && estDiff.changes && estDiff.changes.length) {
    out.push(`${estDiff.changes.length} infrastructure cost change${estDiff.changes.length === 1 ? "" : "s"}`);
  }
  if (algoDiff && algoDiff.shouldAlert && algoDiff.regressions.length) {
    out.push(`${algoDiff.regressions.length} complexity regression${algoDiff.regressions.length === 1 ? "" : "s"}`);
  }
  return out;
}
