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
import { getOrgBillingEmail } from "../handlers/_orgs.js";
import { sendTransactional as defaultSendTransactional } from "../email/transactional.js";
import { monitorNewFindings } from "../email/templates.js";
import { captureException } from "../observability.js";
import {
  listMonitorsDue,
  getMonitorById,
  recordMonitorRun,
} from "./_store.js";
import {
  diffAdvisories,
  groupBySeverity,
  countBySeverityOrdered,
  hashKeySet,
} from "./diff.js";

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
export async function sweepDueMonitors(env, ctx, { now } = {}) {
  const nowSec = typeof now === "number" ? now : Math.floor(Date.now() / 1000);

  if (!env || !env.DB) {
    console.warn("monitors: no DB binding; skipping sweep");
    return { enqueued: 0, due: 0, skipped: "no_db" };
  }

  let due;
  try {
    due = await listMonitorsDue(env, nowSec, MAX_MONITORS_PER_SWEEP);
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

  const response = await runLockfileAudit(
    { repoUrl: monitor.repoUrl, branch: monitor.branch || undefined },
    env,
    null,          // no request — this is a scheduled run, not an HTTP call
    ctx,
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
      const err = new Error(`monitor ${monitorId}: audit failed (${code})`);
      await captureException(env, ctx, err, {
        tags: { source: "monitors", phase: "audit", reason: code },
        extra: { monitorId, repoUrl: monitor.repoUrl },
      });
      throw err;   // let the Queue retry
    }
    return { status: "audit_error", monitorId, code, retryable: false };
  }

  const advisories = Array.isArray(result && result.advisories) ? result.advisories : [];
  const diff = diffAdvisories(advisories, monitor.lastAdvisoryIds);

  // Record the run BEFORE emailing. If the send fails, the baseline is still
  // advanced — which means the next run reports only what's new relative to
  // tonight rather than re-reporting tonight's list on top of tomorrow's.
  // Losing one email to a mail outage is a better failure than turning the
  // next email into the duplicate-heavy one this feature exists to prevent.
  await recordMonitorRun(env, monitorId, {
    ranAt:       nowSec,
    resultHash:  hashKeySet(diff.currentKeys),
    advisoryIds: diff.currentKeys,
    // Persist what this run found new (migrations/0009). It has to be written
    // here, in the same statement that advances the baseline, because the
    // moment advisoryIds lands the previous set is gone and this number can
    // never be derived again.
    //
    // A baseline run is recorded as a delta of zero, not as the size of the
    // whole list: the first sweep of a repo "discovers" every advisory, and
    // calling that "+14 new since last run" would be false — there was no
    // last run. diff.isBaseline is exactly that distinction.
    delta: {
      total:  diff.isBaseline ? 0 : diff.newAdvisories.length,
      counts: diff.isBaseline ? {} : countBySeverityOrdered(diff.newAdvisories),
      at:     nowSec,
    },
  });

  if (!diff.shouldAlert) {
    return {
      status: "no_change",
      monitorId,
      newCount: 0,
      resolvedCount: diff.resolvedKeys.length,
    };
  }

  const to = await getOrgBillingEmail(env, monitor.orgId);
  if (!to) {
    return { status: "no_recipient", monitorId, newCount: diff.newAdvisories.length };
  }

  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  const sent = await send(env, ctx, {
    to,
    ...monitorNewFindings({
      repoUrl:       monitor.repoUrl,
      branch:        monitor.branch,
      newAdvisories: diff.newAdvisories,
      groups:        groupBySeverity(diff.newAdvisories),
      counts:        countBySeverityOrdered(diff.newAdvisories),
      fixCommand:    (result && result.fixCommand) || null,
      isBaseline:    diff.isBaseline,
      dashboardUrl:  `${origin}/dashboard/`,
    }),
  });

  return {
    status:        "alerted",
    monitorId,
    newCount:      diff.newAdvisories.length,
    resolvedCount: diff.resolvedKeys.length,
    isBaseline:    diff.isBaseline,
    emailed:       !!(sent && sent.sent),
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
