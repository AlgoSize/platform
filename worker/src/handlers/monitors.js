// Monitor routes — scheduled repository watching.
//
//   POST   /api/monitors            create (enforces the tier's repo limit)
//   GET    /api/monitors            list this org's monitors
//   DELETE /api/monitors/:id        remove
//   POST   /api/monitors/:id/pause  pause / resume toggle
//
// Monitors belong to the ORGANISATION (migrations/0006), like keys and
// billing. Any member of the org can manage them: unlike API keys — which are
// standing credentials against the org's data — a monitor only causes email
// to the org's own billing address, so the blast radius of a mistake is an
// unwanted alert, not an access grant. Gating monitors behind owner/admin
// would mean the engineer who actually watches the dependencies needs to ask
// someone else to add a repo.

import { resolveEntitlement, resolveEntitlementForOrg } from "../entitlement.js";
import {
  listMonitors,
  getMonitor,
  countMonitors,
  createMonitor,
  deleteMonitor,
  setMonitorPaused,
  setMonitorAnalyzers,
  setMonitorSchedule,
  normalizeAnalyzers,
  normalizeHour,
  monitorLimitFor,
  SCHEDULES,
  MONITOR_ANALYZERS,
} from "../monitors/_store.js";
import { resolveMonitorRoute, describeRoute } from "../monitors/routing.js";
import { inspectMonitor, INSPECTABLE } from "../monitors/inspect.js";
import { auditFromRequest, AUDIT_ACTIONS } from "../audit.js";
import { decorateResultWithAcceptances } from "../risk/decorate.js";

const MAX_URL_LEN    = 300;
const MAX_BRANCH_LEN = 255;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Resolve the caller's org and entitlement in one pass.
 *
 * Accepts BOTH credential types requireAuth issues: a cookie session
 * (request.user) or an API key (request.org). CI that can trigger scans
 * should be able to manage what gets scanned.
 */
export async function requireOrgContext(request, env) {
  if (request.org && request.org.orgId) {
    const entitlement = await resolveEntitlementForOrg(env, request.org.orgId, { request });
    if (!entitlement.org) {
      return { error: jsonResponse({ error: "no_organisation" }, 404) };
    }
    return { orgId: entitlement.org.orgId, entitlement, userId: null };
  }

  const userId = request.user && request.user.userId;
  if (!userId) return { error: jsonResponse({ error: "unauthorized" }, 401) };

  const entitlement = await resolveEntitlement(env, userId, { request });
  if (!entitlement.org) {
    return {
      error: jsonResponse(
        { error: "no_organisation", message: "This account is not a member of any organisation." },
        404,
      ),
    };
  }
  return { orgId: entitlement.org.orgId, entitlement, userId };
}

/** Normalise a GitHub repo URL, or return null if it isn't one. */
function normaliseRepoUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.length > MAX_URL_LEN) return null;
  const m = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)$/i);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}`;
}

function publicMonitor(m) {
  return {
    monitorId: m.monitorId,
    repoUrl:   m.repoUrl,
    branch:    m.branch,
    schedule:  m.schedule,
    lastRunAt: m.lastRunAt,
    paused:    m.pausedAt !== null,
    createdAt: m.createdAt,
    // How many advisories the last completed run saw. Null before the first
    // run — distinct from 0, which means "we looked and found nothing".
    knownAdvisoryCount: m.lastAdvisoryIds === null ? null : m.lastAdvisoryIds.length,
    // What the last sweep found NEW (migrations/0009). Null means no sweep has
    // completed since the column existed, which is NOT the same as a delta of
    // zero — the dashboard renders the first as no badge and the second as
    // "no change", because "we don't know" must never be shown as "all clear".
    lastDelta: m.lastDelta
      ? { total: m.lastDelta.total, counts: m.lastDelta.counts,
          baseline: m.lastDelta.baseline, at: m.lastDelta.at }
      : null,
    // Which analyzers this monitor runs (migrations/0016), plus a one-number
    // summary per secondary analyzer so the row can say what the last sweep
    // knew. Null everywhere follows the house rule: "never ran" is not "ran
    // and found nothing".
    analyzers: m.analyzers,
    archFindingCount: m.lastArchKeys === null ? null : m.lastArchKeys.length,
    lastEstimate: m.lastEstimate
      ? { byProvider: m.lastEstimate.byProvider,
          // Providers the adapter could price nothing for. Sent because
          // byProvider deliberately excludes them, and a watch card with an
          // empty byProvider has to say WHICH kind of nothing it found.
          unpriced: m.lastEstimate.unpriced || [],
          at: m.lastEstimate.at }
      : null,
    lastAlgo: m.lastAlgo
      ? { functions: Object.keys(m.lastAlgo.byName).length, at: m.lastAlgo.at }
      : null,
    // What the last sweep DID NOT do, per analyzer (migrations/0022). The
    // scorecard has read this since it existed; the tool pages could not, so a
    // night the sweep was skipped rendered identically to a night it ran and
    // found nothing. Null — not [] — when no sweep has recorded skips, because
    // a row from before the column is unknown rather than clean.
    lastSkips: Array.isArray(m.lastSkips)
      // The sentence travels with the reason. The client has no copy of this
      // table and should not grow one: two wordings for one skip is how a page
      // ends up explaining a state the server stopped producing.
      ? m.lastSkips.map((s) => ({
          analyzer: s.analyzer,
          reason: s.reason,
          note: explainUnavailable(s.reason),
          fix: fixUnavailable(s.reason),
        }))
      : null,
    // Code findings from the source scan (migrations/0024). Null means no
    // sweep has recorded one — never an implied zero.
    lastSource: m.lastSource
      ? { total: m.lastSource.total, counts: m.lastSource.counts, at: m.lastSource.at }
      : null,
    // Cloud spend (migrations/0023). The cost chip was the one analyzer chip
    // on this row that rendered with no summary at all, for the same reason
    // the scorecard had no column for it: there was nothing stored to show.
    lastCost: m.lastCost
      ? { currentSpend: m.lastCost.currentSpend,
          totalSavingsPct: m.lastCost.totalSavingsPct,
          suggestions: m.lastCost.suggestions,
          at: m.lastCost.at }
      : null,
    // Health of the last ATTEMPT, which is not the same fact as lastRunAt
    // (migrations/0017). A monitor whose last three sweeps were skipped by a
    // GitHub outage still reports a lastRunAt from a week ago and looks
    // healthy; these three fields are what let the UI say "last produced a
    // result 7 days ago, last tried 4 hours ago, and failed".
    //
    // null lastStatus means no sweep has attempted this monitor since the
    // column existed — rendered as "pending", never as "ok".
    lastStatus:     m.lastStatus,
    lastAttemptAt:  m.lastAttemptAt,
    lastError:      m.lastError,
    // Hour-of-day in UTC this monitor prefers, or null for "any sweep".
    runAtHour:      m.runAtHour,
  };
}

// ---------------------------------------------------------------------------
// GET /api/monitors
// ---------------------------------------------------------------------------
export async function listMonitorsHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const monitors = await listMonitors(env, ctxOrg.orgId);
  return jsonResponse({
    monitors:     monitors.map(publicMonitor),
    monitorLimit: monitorLimitFor(env, ctxOrg.entitlement),
    monitorsUsed: monitors.length,
  });
}

// ---------------------------------------------------------------------------
// POST /api/monitors   body {repoUrl, branch?, schedule?}
// ---------------------------------------------------------------------------
export async function createMonitorHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  const repoUrl = normaliseRepoUrl(body && body.repoUrl);
  if (!repoUrl) {
    return jsonResponse(
      { error: "invalid_repo_url", message: "Provide a GitHub repo URL like https://github.com/owner/name" },
      400,
    );
  }

  let branch = null;
  if (body && body.branch !== undefined && body.branch !== null && body.branch !== "") {
    if (typeof body.branch !== "string" || body.branch.length > MAX_BRANCH_LEN) {
      return jsonResponse({ error: "invalid_branch", message: "Branch must be a short string." }, 400);
    }
    branch = body.branch.trim();
  }

  const schedule = (body && body.schedule) || "daily";
  if (!SCHEDULES.includes(schedule)) {
    return jsonResponse(
      { error: "invalid_schedule", message: `Schedule must be one of: ${SCHEDULES.join(", ")}.` },
      400,
    );
  }

  // Optional hour-of-day in UTC (migrations/0017). An out-of-range value is
  // refused rather than clamped: silently turning 25 into 23 would give
  // someone an alert an hour before they expect it forever, with no sign
  // anything was rejected.
  let runAtHour = null;
  if (body && body.runAtHour !== undefined && body.runAtHour !== null) {
    runAtHour = normalizeHour(body.runAtHour);
    if (runAtHour === null) {
      return jsonResponse(
        { error: "invalid_hour", message: "runAtHour must be a whole number from 0 to 23 (UTC), or null for any sweep." },
        400,
      );
    }
  }

  // Which analyzers to run (migrations/0016). Absent means vuln only — the
  // behaviour every monitor had before the column existed. Anything provided
  // must be an array drawn from the known set; "vuln" is forced in by
  // normalizeAnalyzers because a monitor that watches nothing still occupies
  // a plan slot while reading as coverage.
  let analyzers = null;
  if (body && body.analyzers !== undefined) {
    if (!Array.isArray(body.analyzers)) {
      return jsonResponse(
        { error: "invalid_analyzers", message: `analyzers must be an array drawn from: ${MONITOR_ANALYZERS.join(", ")}.` },
        400,
      );
    }
    analyzers = normalizeAnalyzers(body.analyzers);
  }

  // Tier limit, checked at creation. 402 rather than 403 for the same reason
  // quota exhaustion is a 402: the resolution is a purchase, not a permission.
  const limit = monitorLimitFor(env, ctxOrg.entitlement);
  const used  = await countMonitors(env, ctxOrg.orgId);
  if (used >= limit) {
    return jsonResponse(
      {
        error:   "monitor_limit_reached",
        message: limit === 0
          ? "Monitoring isn't included on this plan. Upgrade to schedule recurring scans."
          : `You're monitoring ${used} of ${limit} repositories allowed on this plan. Upgrade for more, or remove a monitor first.`,
        monitorsUsed:  used,
        monitorLimit:  limit,
        upgradeUrl:    `${env.SITE_ORIGIN || ""}/#pricing`,
      },
      402,
    );
  }

  let monitor;
  try {
    monitor = await createMonitor(env, {
      orgId:     ctxOrg.orgId,
      repoUrl, branch, schedule, analyzers, runAtHour,
      createdBy: ctxOrg.userId,
    });
  } catch (err) {
    // The UNIQUE(org_id, repo_url, branch) index — adding the same target
    // twice would double the org's email volume and split the diff baseline
    // across two rows, so it's refused rather than silently duplicated.
    if (/UNIQUE/i.test(String(err && err.message))) {
      return jsonResponse(
        { error: "monitor_exists", message: "This organisation is already monitoring that repository and branch." },
        409,
      );
    }
    throw err;
  }

  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.MONITOR_CREATED,
    targetType: "monitor",
    targetId:   monitor.monitorId,
    orgId:      ctxOrg.orgId,
    metadata:   { repoUrl, branch, schedule },
  });

  return jsonResponse({ ok: true, monitor: publicMonitor(monitor), monitorsUsed: used + 1, monitorLimit: limit }, 201);
}

// ---------------------------------------------------------------------------
// DELETE /api/monitors/:id
// ---------------------------------------------------------------------------
export async function deleteMonitorHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const monitorId = request.params && request.params.id;
  if (!monitorId) return jsonResponse({ error: "invalid_request", message: "No monitor id supplied." }, 400);

  // Read before delete: the repo URL is the only human-readable identifier a
  // monitor has, and after the delete there is nothing left to name it by.
  const before  = await getMonitor(env, ctxOrg.orgId, monitorId);
  const removed = await deleteMonitor(env, ctxOrg.orgId, monitorId);
  if (!removed) {
    return jsonResponse({ error: "not_found", message: "No monitor with that id on this organisation." }, 404);
  }

  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.MONITOR_DELETED,
    targetType: "monitor",
    targetId:   monitorId,
    orgId:      ctxOrg.orgId,
    metadata:   { repoUrl: (before && before.repoUrl) || null, branch: (before && before.branch) || null },
  });

  return jsonResponse({ ok: true, monitorId, removed: true });
}

// ---------------------------------------------------------------------------
// POST /api/monitors/:id/pause   body {paused?: boolean}
// ---------------------------------------------------------------------------
export async function pauseMonitorHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const monitorId = request.params && request.params.id;
  if (!monitorId) return jsonResponse({ error: "invalid_request", message: "No monitor id supplied." }, 400);

  const existing = await getMonitor(env, ctxOrg.orgId, monitorId);
  if (!existing) {
    return jsonResponse({ error: "not_found", message: "No monitor with that id on this organisation." }, 404);
  }

  // Explicit {paused:true|false} when supplied; otherwise toggle. The
  // explicit form is what a UI checkbox should send — a toggle races with
  // itself if two tabs are open.
  let body = null;
  try { body = await request.json(); } catch { /* no body — toggle */ }
  const paused = body && typeof body.paused === "boolean"
    ? body.paused
    : existing.pausedAt === null;

  const updated = await setMonitorPaused(env, ctxOrg.orgId, monitorId, paused);

  // A paused monitor stops sending the alerts someone is relying on, so the
  // pause is logged as its own action rather than a generic "updated".
  await auditFromRequest(request, env, null, {
    action:     paused ? AUDIT_ACTIONS.MONITOR_PAUSED : AUDIT_ACTIONS.MONITOR_RESUMED,
    targetType: "monitor",
    targetId:   monitorId,
    orgId:      ctxOrg.orgId,
    metadata:   { repoUrl: existing.repoUrl, branch: existing.branch || null },
  });

  return jsonResponse({ ok: true, monitor: publicMonitor(updated) });
}

// ---------------------------------------------------------------------------
// POST /api/monitors/:id/analyzers   body {analyzers: ["vuln","arch",…]}
// ---------------------------------------------------------------------------
//
// Explicit full-set semantics, like the pause endpoint's explicit form: the
// client sends the set it wants, not a delta, so two tabs cannot race each
// other into a state neither asked for. Baselines for analyzers switched off
// are cleared in the same statement (see setMonitorAnalyzers) so re-enabling
// later starts honest.
export async function setMonitorAnalyzersHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const monitorId = request.params && request.params.id;
  if (!monitorId) return jsonResponse({ error: "invalid_request", message: "No monitor id supplied." }, 400);

  const existing = await getMonitor(env, ctxOrg.orgId, monitorId);
  if (!existing) {
    return jsonResponse({ error: "not_found", message: "No monitor with that id on this organisation." }, 404);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  if (!body || !Array.isArray(body.analyzers)) {
    return jsonResponse(
      { error: "invalid_analyzers", message: `Send {analyzers: [...]} drawn from: ${MONITOR_ANALYZERS.join(", ")}.` },
      400,
    );
  }

  const updated = await setMonitorAnalyzers(env, ctxOrg.orgId, monitorId, body.analyzers);
  if (!updated) {
    return jsonResponse({ error: "not_found", message: "No monitor with that id on this organisation." }, 404);
  }

  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.MONITOR_ANALYZERS_CHANGED,
    targetType: "monitor",
    targetId:   monitorId,
    orgId:      ctxOrg.orgId,
    metadata:   { repoUrl: existing.repoUrl, from: existing.analyzers, to: updated.analyzers },
  });

  return jsonResponse({ ok: true, monitor: publicMonitor(updated) });
}


// ---------------------------------------------------------------------------
// POST /api/monitors/:id/schedule   body {schedule?, runAtHour?}
// ---------------------------------------------------------------------------
//
// Split from the analyzers endpoint because they answer different questions
// and fail differently: changing WHAT a monitor watches clears baselines,
// changing WHEN it runs must not. Merging them into one PATCH would make it
// possible to lose a baseline by editing a time.
export async function setMonitorScheduleHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const monitorId = request.params && request.params.id;
  if (!monitorId) return jsonResponse({ error: "invalid_request", message: "No monitor id supplied." }, 400);

  const existing = await getMonitor(env, ctxOrg.orgId, monitorId);
  if (!existing) {
    return jsonResponse({ error: "not_found", message: "No monitor with that id on this organisation." }, 404);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  const patch = {};
  if (body && body.schedule !== undefined) {
    if (!SCHEDULES.includes(body.schedule)) {
      return jsonResponse(
        { error: "invalid_schedule", message: `Schedule must be one of: ${SCHEDULES.join(", ")}.` },
        400,
      );
    }
    patch.schedule = body.schedule;
  }
  if (body && body.runAtHour !== undefined) {
    // null is a real value here — it means "any sweep", the default.
    if (body.runAtHour !== null && normalizeHour(body.runAtHour) === null) {
      return jsonResponse(
        { error: "invalid_hour", message: "runAtHour must be a whole number from 0 to 23 (UTC), or null for any sweep." },
        400,
      );
    }
    patch.runAtHour = body.runAtHour;
  }
  if (!Object.keys(patch).length) {
    return jsonResponse({ error: "invalid_request", message: "Send schedule, runAtHour, or both." }, 400);
  }

  const updated = await setMonitorSchedule(env, ctxOrg.orgId, monitorId, patch);
  if (!updated) {
    return jsonResponse({ error: "not_found", message: "No monitor with that id on this organisation." }, 404);
  }

  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.MONITOR_SCHEDULE_CHANGED,
    targetType: "monitor",
    targetId:   monitorId,
    orgId:      ctxOrg.orgId,
    metadata:   {
      repoUrl: existing.repoUrl,
      from: { schedule: existing.schedule, runAtHour: existing.runAtHour },
      to:   { schedule: updated.schedule,  runAtHour: updated.runAtHour },
    },
  });

  return jsonResponse({ ok: true, monitor: publicMonitor(updated) });
}

// ---------------------------------------------------------------------------
// POST /api/monitors/:id/run   — run this monitor now
// ---------------------------------------------------------------------------
//
// Enqueues rather than running inline, and says so in the response. A monitor
// check fetches manifests, queries OSV and may run three more analyzers; done
// inside the request it would sit against one CPU budget with a browser
// waiting on it, and a timeout would leave the caller unable to tell whether
// the run happened. Putting it on the same queue the cron sweep uses means
// the manual path and the scheduled path are the same code with the same
// retry behaviour — so "it works when I click it but not overnight" cannot
// happen.
//
// Returns 202: accepted, not completed. The UI polls the monitor list for the
// new lastAttemptAt rather than being told a result that does not exist yet.
export async function runMonitorNowHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const monitorId = request.params && request.params.id;
  if (!monitorId) return jsonResponse({ error: "invalid_request", message: "No monitor id supplied." }, 400);

  const monitor = await getMonitor(env, ctxOrg.orgId, monitorId);
  if (!monitor) {
    return jsonResponse({ error: "not_found", message: "No monitor with that id on this organisation." }, 404);
  }

  // A paused monitor stays paused. Running it on demand would advance the
  // baseline, so resuming later would compare against a run the owner had
  // already decided not to take — and the first real sweep would report
  // nothing new when plenty had changed.
  if (monitor.pausedAt !== null) {
    return jsonResponse(
      { error: "monitor_paused", message: "This monitor is paused. Resume it before running a check." },
      409,
    );
  }

  if (!env.SCAN_QUEUE) {
    return jsonResponse(
      { error: "queue_unavailable", message: "Scheduled scanning isn't available in this environment." },
      503,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    await env.SCAN_QUEUE.send({ monitorId, enqueuedAt: now, manual: true });
  } catch {
    return jsonResponse(
      { error: "enqueue_failed", message: "Could not queue the run. Try again in a moment." },
      503,
    );
  }

  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.MONITOR_RUN_REQUESTED,
    targetType: "monitor",
    targetId:   monitorId,
    orgId:      ctxOrg.orgId,
    metadata:   { repoUrl: monitor.repoUrl, branch: monitor.branch },
  });

  return jsonResponse({
    ok: true,
    queued: true,
    monitorId,
    message: "Queued. The result appears on this monitor when the run finishes.",
  }, 202);
}

// ---------------------------------------------------------------------------
// GET /api/monitors/route   — where the next alert actually goes
// ---------------------------------------------------------------------------
//
// Not a restatement of the notification settings. This is the resolver the
// sweep itself uses (monitors/routing.js), so what the card shows and what
// gets delivered cannot drift apart — which is the entire point, given that
// this whole path was previously mailing one hardcoded address while the
// settings screen implied otherwise.
export async function monitorRouteHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const route = await resolveMonitorRoute(env, ctxOrg.orgId);
  return jsonResponse(describeRoute(route));
}


// ---------------------------------------------------------------------------
// GET /api/monitors/:id/result/:analyzer
// ---------------------------------------------------------------------------
//
// The full current result of one analyzer on one monitored repository, in
// exactly the shape that analyzer's manual endpoint returns — so the tool
// page renders it with the renderer it already has rather than a second one
// that could drift.
//
// This is what connects the monitors to the tools. Before it, an email saying
// "3 new architecture findings" led to a page where the only way to see them
// was to re-upload your own codebase by hand.
//
// It RE-RUNS the analyzer rather than reading a stored result, and it never
// writes a baseline. Both of those are load-bearing — see the header of
// monitors/inspect.js for why.
export async function monitorResultHandler(request, env, ctx) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const monitorId = request.params && request.params.id;
  const analyzer  = request.params && request.params.analyzer;
  if (!monitorId) {
    return jsonResponse({ error: "invalid_request", message: "No monitor id supplied." }, 400);
  }
  if (!INSPECTABLE.includes(analyzer)) {
    return jsonResponse({
      error: "invalid_analyzer",
      message: `Analyzer must be one of: ${INSPECTABLE.join(", ")}.`,
    }, 400);
  }

  const monitor = await getMonitor(env, ctxOrg.orgId, monitorId);
  if (!monitor) {
    return jsonResponse({ error: "not_found", message: "No monitor with that id on this organisation." }, 404);
  }

  const fetchImpl = (env && env.FETCH) || globalThis.fetch;
  let inspection;
  try {
    inspection = await inspectMonitor(env, ctx, monitor, analyzer, fetchImpl);
  } catch (err) {
    // An analyzer that throws here must not read as "your repo is clean".
    return jsonResponse({
      error: "inspect_failed",
      message: "The analyzer could not be run against this repository just now.",
      detail: String((err && err.message) || err).slice(0, 200),
    }, 502);
  }

  if (inspection.status === "not_enabled") {
    // 200, not an error: the monitor exists and is healthy, this analyzer is
    // simply switched off for it. The page offers to turn it on.
    return jsonResponse({
      status:   "not_enabled",
      analyzer,
      monitorId,
      repoUrl:  monitor.repoUrl,
      branch:   monitor.branch,
      message:  "This monitor does not run that analyzer. Switch it on and the next sweep will record a baseline.",
    });
  }

  if (inspection.status !== "ok") {
    // Also 200. "We could not read your repo" is a real answer about the
    // repo, not a failure of this request — and an empty graph rendered as
    // an error page loses the reason, which is the only actionable part.
    return jsonResponse({
      status:   "unavailable",
      analyzer,
      monitorId,
      repoUrl:  monitor.repoUrl,
      branch:   monitor.branch,
      reason:   inspection.reason,
      message:  explainUnavailable(inspection.reason),
      baseline: inspection.baseline,
      // Present when the analyzer knows WHICH entries failed and why. The
      // optimizer's no_entries_ran is the case that needs it: without the
      // per-entry reasons, "check the file and function names" is the only
      // thing anyone can be told, and it is advice rather than information.
      ...(inspection.skipped && inspection.skipped.length
        ? { skipped: inspection.skipped } : {}),
    });
  }

  // Accepted risks are applied here, and this endpoint is the reason the read
  // path had to exist at all: it is what #/scanner shows for a monitored
  // repository, so it is where the reader who just pressed "Accept this risk"
  // looks to see whether it took. Nothing is stored on this path — the
  // inspection is recomputed on every call — so there is no raw copy to keep
  // apart from the decorated one.
  const result = await decorateResultWithAcceptances(env, inspection.result, {
    orgId: ctxOrg.orgId, repoUrl: monitor.repoUrl,
  });

  return jsonResponse({
    status:     "ok",
    analyzer,
    monitorId,
    repoUrl:    monitor.repoUrl,
    branch:     monitor.branch,
    // Recomputed now, from committed files — NOT the 03:00 snapshot. Said in
    // the payload so the page can date what it is showing honestly.
    computedAt: Math.floor(Date.now() / 1000),
    result,
    baseline:   inspection.baseline,
    delta:      inspection.delta,
  });
}

/**
 * A sentence for each way an analyzer can decline to produce a result.
 *
 * Exported because the scorecard needs the SAME sentences: a cell that says
 * "not measured" has to say why, and two independently-worded lists is how
 * the panel and the grid end up disagreeing about the same sweep.
 */
/**
 * Reasons that mean "there is nothing here to measure", as opposed to
 * "we tried and could not".
 *
 * The distinction matters because these five are FACTS ABOUT THE REPOSITORY
 * and are permanent: a repo with no compose file will never have an infra-cost
 * forecast, and rendering that identically to a sweep that was rate-limited
 * tells a reader something is broken when nothing is. It is the same split the
 * compliance catalog already draws between "not covered" and "insufficient
 * evidence", and for the same reason — one is a limit of the tool, the other
 * is a gap in what we know.
 *
 * Everything NOT in this set stays "not measured": transient outages, a
 * rejected credential, an invalid config. Those are somebody's to fix, which
 * is why they keep a remedy line and these do not.
 */
export const NOT_APPLICABLE_REASONS = Object.freeze(new Set([
  "no_compose",       // no docker-compose.yml to price
  "no_cur",           // no cost export named — absent config is consent
  "no_config",        // no optimizer.config.json, so nothing is watched
  "no_manifests",     // nothing for the X-ray to map
  "no_source_files",  // no files in a language the code scanner reads
]));

export function explainUnavailable(reason) {
  const MAP = {
    no_manifests:       "No manifests or config files were found in this repository, so there is nothing to map.",
    no_compose:         "No compose file was found in this repository, so there is nothing to price.",
    // Absent config is consent, not an error: a repository that has not named
    // a CUR is telling us not to read its billing data.
    no_cur:             "No `cur` is named in algosize.budget.json, so no cost export is being watched.",
    cur_missing:        "algosize.budget.json names a cost export, but that file is not committed.",
    cur_too_large:      "The committed cost export is too large to read on a scheduled sweep.",
    budget_invalid:     "algosize.budget.json is present but is not valid JSON.",
    cost_failed:        "The cost analyzer could not read the committed export.",
    no_config:          "No optimizer.config.json was found at the repository root, so no function is being watched.",
    config_invalid:     "optimizer.config.json is present but is not valid JSON.",
    no_entries_ran:     "Every entry in optimizer.config.json was skipped. Each one's reason is listed below.",
    github_throttled:   "GitHub rate-limited the request. This clears on its own; try again shortly.",
    // Ours, and it says so. This used to fall through the same branch as a
    // 404, so an expired deployment token made every repository on the
    // platform read as though it did not exist.
    github_unauthorized:
      "Our GitHub credential was rejected, so the repository could not be read. This is a " +
      "deployment setting on our side, not a problem with your repository.",
    sandbox_unreachable:"The measurement sandbox is unreachable right now. The nightly sweep will retry.",
    // Deliberately says whose problem it is. The previous behaviour reported
    // this as every entry in the config failing, which reads as "your config
    // is wrong" — and sent people to check a file in which nothing was wrong.
    sandbox_not_configured:
      "The measurement sandbox is not configured on this deployment, so no function can be " +
      "graded. This is a deployment setting, not a problem with your optimizer.config.json.",
    // Source scanner (migrations/0024). `no_source_files` is a fact about the
    // repository, not a failure; the other two are ours, and say so.
    no_source_files:    "No files in a language the code scanner reads were found in this repository.",
    source_unreadable:  "The repository's source could not be read (private repository, or GitHub rate-limited the request). The dependency audit is unaffected.",
    source_failed:      "The code scanner errored on this repository's source. The dependency audit is unaffected.",
    source_unsupported: "This sweep predates source scanning, so no code was read. The next sweep scans it.",
    bad_repo_url:       "This monitor's repository URL could not be parsed.",
    analyzer_failed:    "The analyzer could not process this repository's files.",
  };
  return MAP[reason] || "The analyzer could not produce a result for this repository just now.";
}

/**
 * The one thing to change to make this analyzer produce a result — or null
 * when there is nothing the reader can do.
 *
 * explainUnavailable says what happened. On its own that is a dead end: "No
 * compose file was found in this repository" is true, and leaves a reader
 * looking at an empty cell with no idea whether it is their move or ours.
 * Every entry below names a file and a change; the reasons that clear on
 * their own (a throttle, a transient sandbox outage) deliberately return null
 * rather than inventing busywork, and sandbox_not_configured returns a
 * sentence that says the work is OURS, because pointing the repository owner
 * at their own config was exactly the bug that made it worth saying.
 */
export function fixUnavailable(reason) {
  const MAP = {
    no_manifests:
      "Commit a manifest the X-ray can read — package.json, requirements.txt, go.mod, a compose file or Terraform — on the branch this monitor watches.",
    no_compose:
      "Commit a docker-compose.yml, or point `compose` in algosize.budget.json at the one you already use.",
    // Ours to fix, not theirs. The remedy is a catalog entry on our side, so
    // the sentence says so rather than asking them to change their file.
    no_priceable_resources:
      "Nothing to do on your side — the configuration is readable, but none of the resources in it are in our pricing catalog yet. Tell us which provider and resource types you need and we will add them.",
    no_cur:
      "Set `cur` in algosize.budget.json to the path of a committed Cost & Usage Report export.",
    cur_missing:
      "Commit the export `cur` names, or change `cur` to a path that exists on this branch.",
    cur_too_large:
      "Commit a monthly rollup of the export rather than the full line-item report.",
    budget_invalid:
      "Fix the JSON in algosize.budget.json — the sweep cannot parse it as written.",
    cost_failed:
      "Check the committed export is a Cost & Usage Report CSV with its header row intact.",
    no_config:
      "Add an optimizer.config.json at the repository root naming the functions to measure.",
    config_invalid:
      "Fix the JSON in optimizer.config.json — the sweep cannot parse it as written.",
    no_entries_ran:
      "Open the Algorithm optimizer for this repository; every entry's own reason is listed there.",
    no_source_files:
      "Nothing to change unless you expected code here — the scanner reads JavaScript, TypeScript, Python, shell, and config files.",
    source_unreadable:
      "If the repository is private, the scanner cannot read it; public repositories clear on their own once GitHub's rate limit resets.",
    bad_repo_url:
      "Re-create this monitor with a https://github.com/owner/name URL.",
    sandbox_not_configured:
      "Nothing to change in your repository — this one is ours, and the next sweep grades it once the sandbox is deployed.",
  };
  return MAP[reason] || null;
}
