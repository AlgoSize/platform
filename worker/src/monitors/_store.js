// Monitor rows + the per-tier repo limit. See migrations/0006_monitors.sql.

function newMonitorId() {
  return "mon_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export const SCHEDULES = Object.freeze(["daily", "weekly"]);

// How many monitored repos each plan gets.
//
// Plan-based rather than price-based because there is still exactly one
// STRIPE_PRICE_ID in the config — the Solo/Practice/Firm tiers from the
// pricing work don't exist as Stripe prices yet. When they do, this becomes a
// price_id → limit map (the org already stores price_id, migrations/0003) and
// the env overrides below stay as the escape hatch. Overridable now so the
// limit can be tuned without a deploy.
const DEFAULT_LIMITS = { free: 1, paid: 25 };

export function monitorLimitFor(env, entitlement) {
  const key      = entitlement && entitlement.active ? "paid" : "free";
  const envVar   = key === "paid" ? "MONITOR_LIMIT_PAID" : "MONITOR_LIMIT_FREE";
  const override = env && env[envVar];
  const parsed   = override === undefined ? NaN : parseInt(override, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LIMITS[key];
}

function rowToMonitor(row) {
  if (!row) return null;
  return {
    monitorId:       row.monitor_id,
    orgId:           row.org_id,
    repoUrl:         row.repo_url,
    branch:          row.branch || null,
    schedule:        row.schedule || "daily",
    lastRunAt:       typeof row.last_run_at === "number" ? row.last_run_at : null,
    lastResultHash:  row.last_result_hash || null,
    // Stored as a JSON array; null means "never completed a run", which the
    // diff reads as "this is the baseline". A corrupt value must NOT silently
    // become an empty array — that would make every advisory look new and
    // send the whole list. Fall back to null (baseline) instead, which sends
    // the same email but labels it honestly.
    lastAdvisoryIds: parseIdList(row.last_advisory_ids),
    createdBy:       row.created_by || null,
    createdAt:       row.created_at,
    pausedAt:        typeof row.paused_at === "number" ? row.paused_at : null,
  };
}

function parseIdList(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : null;
  } catch {
    return null;
  }
}

export async function listMonitors(env, orgId) {
  const { results } = await env.DB
    .prepare("SELECT * FROM monitors WHERE org_id = ? ORDER BY created_at DESC")
    .bind(orgId)
    .all();
  return (results || []).map(rowToMonitor);
}

export async function getMonitor(env, orgId, monitorId) {
  const row = await env.DB
    .prepare("SELECT * FROM monitors WHERE monitor_id = ? AND org_id = ?")
    .bind(monitorId, orgId)
    .first();
  return rowToMonitor(row);
}

/** By id alone — the queue consumer has a message, not a session. */
export async function getMonitorById(env, monitorId) {
  const row = await env.DB
    .prepare("SELECT * FROM monitors WHERE monitor_id = ?")
    .bind(monitorId)
    .first();
  return rowToMonitor(row);
}

export async function countMonitors(env, orgId) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM monitors WHERE org_id = ?")
    .bind(orgId)
    .first();
  return row ? row.n : 0;
}

export async function createMonitor(env, { orgId, repoUrl, branch = null, schedule = "daily", createdBy = null }) {
  const now = Math.floor(Date.now() / 1000);
  const id  = newMonitorId();
  await env.DB.prepare(
    `INSERT INTO monitors (monitor_id, org_id, repo_url, branch, schedule, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, orgId, repoUrl, branch, schedule, createdBy, now).run();
  return getMonitorById(env, id);
}

export async function deleteMonitor(env, orgId, monitorId) {
  const res = await env.DB
    .prepare("DELETE FROM monitors WHERE monitor_id = ? AND org_id = ?")
    .bind(monitorId, orgId)
    .run();
  return !!(res.meta && res.meta.changes);
}

/**
 * Pause or resume. Pausing keeps the row and its diff baseline, so resuming
 * doesn't re-alert on everything the org already saw while it was paused.
 */
export async function setMonitorPaused(env, orgId, monitorId, paused) {
  const res = await env.DB.prepare(
    "UPDATE monitors SET paused_at = ? WHERE monitor_id = ? AND org_id = ?",
  ).bind(paused ? Math.floor(Date.now() / 1000) : null, monitorId, orgId).run();
  if (!res.meta || !res.meta.changes) return null;
  return getMonitor(env, orgId, monitorId);
}

/** Record the outcome of a completed run — the next run's diff baseline. */
export async function recordMonitorRun(env, monitorId, { ranAt, resultHash, advisoryIds }) {
  await env.DB.prepare(
    `UPDATE monitors
        SET last_run_at = ?, last_result_hash = ?, last_advisory_ids = ?
      WHERE monitor_id = ?`,
  ).bind(ranAt, resultHash, JSON.stringify(advisoryIds), monitorId).run();
}

/**
 * Monitors the scheduled sweep should enqueue.
 *
 * Paused monitors are excluded in SQL rather than filtered afterward, so a
 * paused monitor never even becomes a queue message — pausing has to mean
 * "costs nothing", not "still runs but throws the result away".
 *
 * Oldest-run-first so that if the sweep ever has to be capped, the monitors
 * that have gone longest without a check are the ones that get in.
 */
export async function listMonitorsDue(env, nowSec, limit = 1000) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM monitors
      WHERE paused_at IS NULL
      ORDER BY IFNULL(last_run_at, 0) ASC
      LIMIT ?`,
  ).bind(limit).all();
  return (results || []).map(rowToMonitor).filter((m) => isDue(m, nowSec));
}

const WEEK_SECONDS = 7 * 86_400;
// A daily monitor whose last run was 23h ago is still "due" tonight — the
// cron fires at a fixed hour and small drift in when the sweep starts must
// not skip a day. 20h leaves room for that without letting a monitor run
// twice in one sweep.
const DAILY_MIN_GAP = 20 * 3600;

/** Whether a monitor's cadence says it should run now. */
export function isDue(monitor, nowSec) {
  if (!monitor || monitor.pausedAt !== null) return false;
  if (monitor.lastRunAt === null) return true;      // never run — always due
  const elapsed = nowSec - monitor.lastRunAt;
  if (monitor.schedule === "weekly") return elapsed >= WEEK_SECONDS;
  return elapsed >= DAILY_MIN_GAP;
}
