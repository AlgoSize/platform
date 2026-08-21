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
  normalizeAnalyzers,
  monitorLimitFor,
  SCHEDULES,
  MONITOR_ANALYZERS,
} from "../monitors/_store.js";
import { auditFromRequest, AUDIT_ACTIONS } from "../audit.js";

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
async function requireOrgContext(request, env) {
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
      ? { total: m.lastDelta.total, counts: m.lastDelta.counts, at: m.lastDelta.at }
      : null,
    // Which analyzers this monitor runs (migrations/0016), plus a one-number
    // summary per secondary analyzer so the row can say what the last sweep
    // knew. Null everywhere follows the house rule: "never ran" is not "ran
    // and found nothing".
    analyzers: m.analyzers,
    archFindingCount: m.lastArchKeys === null ? null : m.lastArchKeys.length,
    lastEstimate: m.lastEstimate
      ? { byProvider: m.lastEstimate.byProvider, at: m.lastEstimate.at }
      : null,
    lastAlgo: m.lastAlgo
      ? { functions: Object.keys(m.lastAlgo.byName).length, at: m.lastAlgo.at }
      : null,
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
      repoUrl, branch, schedule, analyzers,
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
