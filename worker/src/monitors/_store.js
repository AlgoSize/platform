// Monitor rows + the per-tier repo limit. See migrations/0006_monitors.sql.

function newMonitorId() {
  return "mon_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export const SCHEDULES = Object.freeze(["daily", "weekly"]);

// What a monitor can run on its schedule (migrations/0016). Every entry reads
// ONLY committed repository files — that constraint is what lets these join
// the sweep at all under the product's no-credentials rule.
//
// "vuln" is mandatory: the API refuses a set without it, because a monitor
// row that watches nothing still occupies a plan slot and reads as coverage.
export const MONITOR_ANALYZERS = Object.freeze(["vuln", "arch", "estimate", "algo", "cost"]);

/**
 * Normalise a requested analyzer set.
 *
 * Returns the sorted valid set (vuln forced in, unknowns dropped, "vuln"
 * first for readability), or null when the input is not an array at all —
 * the caller treats that as "not provided" and defaults.
 */
export function normalizeAnalyzers(raw) {
  if (!Array.isArray(raw)) return null;
  const set = new Set(["vuln"]);
  for (const a of raw) {
    if (typeof a === "string" && MONITOR_ANALYZERS.includes(a)) set.add(a);
  }
  return MONITOR_ANALYZERS.filter((a) => set.has(a));
}

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
    // What the previous sweep found NEW (migrations/0009). null means no
    // sweep has completed since the column existed — deliberately distinct
    // from a delta of zero, which means "swept, nothing new". The UI must
    // render the two differently or it invents a clean bill of health for a
    // monitor that has never reported.
    lastDelta:       parseDelta(row.last_delta_json),
    // Which analyzers this monitor runs (migrations/0016). NULL — every row
    // written before the column existed, and every monitor created without
    // choosing — reads as ["vuln"]: exactly what those monitors always did.
    analyzers:       parseAnalyzers(row.analyzers),
    // Per-analyzer baselines, same contract as lastAdvisoryIds: null means
    // "never ran", never "ran and found nothing".
    lastArchKeys:    parseIdList(row.last_arch_keys),
    // Which analyzers declined to produce a result last sweep, and why.
    // null = no sweep has recorded this yet; [] = a sweep ran and nothing
    // was skipped. Readers must keep those apart — see migration 0022.
    lastSkips:       parseSkips(row.last_skips_json),
    lastEstimate:    parseEstimateBaseline(row.last_estimate_json),
    lastAlgo:        parseAlgoBaseline(row.last_algo_json),
    // The cloud-spend analyzer's LATEST figures (migrations/0023). Not a
    // baseline: nothing diffs against it, because a bill differs every day
    // and "Tuesday is not Monday" is not a finding. It exists so the
    // scorecard has something to grade — without it the only analyzer you
    // can schedule and never see was this one.
    lastCost:        parseCostSummary(row.last_cost_json),
    // What the X-ray READ last sweep (migrations/0023), so a zero can carry
    // its own evidence instead of asking to be believed.
    lastArchScope:   parseArchScope(row.last_arch_scope_json),
    // What the SOURCE scanner found last sweep (migrations/0024). The sweep
    // has always performed this scan and always thrown the answer away, which
    // let a repository with zero CVEs and twelve injection findings grade as
    // clean. Carries fingerprints so the next sweep can diff.
    lastSource:      parseSourceBaseline(row.last_source_json),
    // Per-severity tally of the last completed run's advisories
    // (migrations/0017). null = never recorded; the scorecard renders that as
    // "not graded" rather than inventing an A.
    lastSeverities:  parseSeverities(row.last_severity_json),
    // Health of the LAST attempt (migrations/0017). null = never attempted,
    // which is the only honest "baseline pending" — every completed attempt
    // writes one of 'ok' | 'failed' | 'skipped', so a repo that fails nightly
    // can no longer masquerade as a monitor created this morning.
    lastStatus:      typeof row.last_status === "string" ? row.last_status : null,
    lastError:       typeof row.last_error === "string" ? row.last_error : null,
    lastAttemptAt:   typeof row.last_attempt_at === "number" ? row.last_attempt_at : null,
    // Hour of day (UTC, 0-23) this monitor wants to run at. null = whenever
    // the sweep runs, which is what every pre-0017 row does.
    runAtHour:       typeof row.run_at_hour === "number" ? row.run_at_hour : null,
    createdBy:       row.created_by || null,
    createdAt:       row.created_at,
    pausedAt:        typeof row.paused_at === "number" ? row.paused_at : null,
  };
}

function parseAnalyzers(raw) {
  if (typeof raw !== "string" || !raw) return ["vuln"];
  try {
    const normalized = normalizeAnalyzers(JSON.parse(raw));
    return normalized || ["vuln"];
  } catch {
    return ["vuln"];
  }
}

/**
 * {"counts":{...},"total":n,"keys":[...],"truncated":bool,"at":sec} or null.
 *
 * Corrupt reads as null — "we have no source result" — never as an empty
 * finding list. An empty list here would render on the scorecard as code that
 * was read and found clean, which is the single most dangerous thing this
 * table can assert about a parse failure.
 */
function parseSourceBaseline(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.total !== "number" || d.total < 0) return null;
    return {
      total:     d.total,
      counts:    (d.counts && typeof d.counts === "object") ? d.counts : {},
      // A non-array reads as null rather than [] for the usual reason: an
      // empty key list means "nothing was found", and the next sweep would
      // diff against it and report the entire codebase as new.
      keys:      Array.isArray(d.keys) ? d.keys.filter((k) => typeof k === "string") : null,
      truncated: d.truncated === true,
      at:        typeof d.at === "number" ? d.at : null,
    };
  } catch {
    return null;
  }
}

/**
 * {"currentSpend":n,"totalSavingsPct":n,"suggestions":n,"at":sec} or null.
 *
 * Corrupt reads as null — "we have no figure" — never as a zero spend. A zero
 * in this column would render on the scorecard as a repository that costs
 * nothing to run, which is the most flattering possible reading of a parse
 * failure and the one this table refuses everywhere else.
 */
function parseCostSummary(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.currentSpend !== "number" || !Number.isFinite(d.currentSpend)) return null;
    return {
      currentSpend:    d.currentSpend,
      totalSavingsPct: typeof d.totalSavingsPct === "number" && Number.isFinite(d.totalSavingsPct)
        ? d.totalSavingsPct : 0,
      suggestions:     typeof d.suggestions === "number" && Number.isFinite(d.suggestions)
        ? d.suggestions : 0,
      at:              typeof d.at === "number" ? d.at : null,
    };
  } catch {
    return null;
  }
}

/**
 * {"services":n,"files":n,"complete":bool,"at":sec} or null.
 *
 * Corrupt reads as null, and a null scope makes the architecture cell fall
 * back to its old wording. The scope only ever ADDS evidence to a number that
 * was already there; it must never be able to remove the number.
 */
function parseArchScope(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.services !== "number" || !Number.isFinite(d.services)) return null;
    return {
      services: d.services,
      files:    typeof d.files === "number" && Number.isFinite(d.files) ? d.files : null,
      complete: d.complete === true,
      at:       typeof d.at === "number" ? d.at : null,
    };
  } catch {
    return null;
  }
}

/** {"byProvider":{id:microUsd},"at":sec} or null. Corrupt reads as null. */
function parseEstimateBaseline(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.byProvider !== "object" || d.byProvider === null) return null;
    const byProvider = {};
    for (const [k, v] of Object.entries(d.byProvider)) {
      if (typeof v === "number" && Number.isFinite(v)) byProvider[k] = v;
    }
    return { byProvider, at: typeof d.at === "number" ? d.at : null };
  } catch {
    return null;
  }
}

/** {"byName":{entry:"O(n)"},"at":sec} or null. Corrupt reads as null. */
function parseAlgoBaseline(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.byName !== "object" || d.byName === null) return null;
    const byName = {};
    for (const [k, v] of Object.entries(d.byName)) {
      if (typeof v === "string" && v) byName[k] = v;
    }
    return { byName, at: typeof d.at === "number" ? d.at : null };
  } catch {
    return null;
  }
}

/**
 * {"critical":n,…} or null. Corrupt reads as null, which renders as "not
 * graded" — never as a clean scorecard cell.
 */
function parseSeverities(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return null;
    const out = {};
    for (const k of ["critical", "high", "medium", "low", "unknown"]) {
      out[k] = typeof d[k] === "number" && Number.isFinite(d[k]) ? d[k] : 0;
    }
    return out;
  } catch {
    return null;
  }
}

/** The stored skip list. Same null-vs-empty discipline as parseIdList. */
function parseSkips(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x) => x && typeof x.analyzer === "string")
      : null;
  } catch {
    return null;
  }
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

export async function createMonitor(env, { orgId, repoUrl, branch = null, schedule = "daily",
                                           createdBy = null, analyzers = null, runAtHour = null }) {
  const now = Math.floor(Date.now() / 1000);
  const id  = newMonitorId();
  const set = normalizeAnalyzers(analyzers);
  await env.DB.prepare(
    `INSERT INTO monitors (monitor_id, org_id, repo_url, branch, schedule, created_by, created_at, analyzers, run_at_hour)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, orgId, repoUrl, branch, schedule, createdBy, now,
         set ? JSON.stringify(set) : null, normalizeHour(runAtHour)).run();
  return getMonitorById(env, id);
}

/**
 * An hour-of-day in UTC, or null for "whenever the sweep reaches it".
 *
 * Null is the historical behaviour and stays the default: the sweep runs at
 * 03:00 UTC and every due monitor goes on the queue in that one pass. A
 * stored hour narrows that to one sweep per day — useful for a team that
 * wants the alert to land before standup in their own timezone rather than
 * overnight, and the reason the column is an hour rather than a timestamp is
 * that a monitor is a recurring intent, not an appointment.
 */
export function normalizeHour(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

/**
 * Change when a monitor runs.
 *
 * Deliberately does NOT touch any baseline. Moving a monitor from 03:00 to
 * 14:00 changes the delivery time of the next comparison, not what it is
 * being compared against — clearing baselines here would turn a schedule
 * edit into a silent "everything is new again" email.
 */
export async function setMonitorSchedule(env, orgId, monitorId, { schedule, runAtHour } = {}) {
  const sets = [], binds = [];
  if (schedule !== undefined) { sets.push("schedule = ?"); binds.push(schedule); }
  if (runAtHour !== undefined) { sets.push("run_at_hour = ?"); binds.push(normalizeHour(runAtHour)); }
  if (!sets.length) return getMonitor(env, orgId, monitorId);

  const res = await env.DB.prepare(
    `UPDATE monitors SET ${sets.join(", ")} WHERE monitor_id = ? AND org_id = ?`,
  ).bind(...binds, monitorId, orgId).run();
  if (!(res.meta && res.meta.changes)) return null;
  return getMonitor(env, orgId, monitorId);
}

/**
 * Change which analyzers a monitor runs.
 *
 * Baselines for analyzers being switched OFF are cleared, so switching one
 * back on later starts with an honest baseline run instead of diffing
 * against a set from an arbitrary point in the past — "3 new findings since
 * whenever you last had this on" is a comparison nobody asked for.
 */
export async function setMonitorAnalyzers(env, orgId, monitorId, analyzers) {
  const set = normalizeAnalyzers(analyzers) || ["vuln"];
  const clears = [];
  if (!set.includes("arch"))     clears.push("last_arch_keys = NULL");
  if (!set.includes("estimate")) clears.push("last_estimate_json = NULL");
  if (!set.includes("algo"))     clears.push("last_algo_json = NULL");
  // Cloud spend keeps no diff baseline, but it does keep a standing figure,
  // and a figure from whenever the analyzer was last on is worse than none:
  // it would sit on the scorecard as this month's bill forever.
  if (!set.includes("cost"))     clears.push("last_cost_json = NULL");
  if (!set.includes("arch"))     clears.push("last_arch_scope_json = NULL");
  const res = await env.DB.prepare(
    `UPDATE monitors SET analyzers = ?${clears.length ? ", " + clears.join(", ") : ""}
      WHERE monitor_id = ? AND org_id = ?`,
  ).bind(JSON.stringify(set), monitorId, orgId).run();
  if (!(res.meta && res.meta.changes)) return null;
  return getMonitor(env, orgId, monitorId);
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

/**
 * Record the outcome of a completed run — the next run's diff baseline.
 *
 * `delta` is what THIS run found new, and is stored because it cannot be
 * recovered later: the moment last_advisory_ids is overwritten below, the
 * previous set is gone and the difference is unrecomputable. Passing null
 * leaves the column untouched rather than clearing it, so a caller that does
 * not compute a delta cannot erase the last one that did.
 */
export async function recordMonitorRun(env, monitorId, {
  ranAt, resultHash, advisoryIds, delta = null,
  // Per-analyzer baselines (migrations/0016). `undefined` leaves a column
  // untouched — the contract that makes a transient fetch failure safe: an
  // analyzer that could not run this sweep keeps its old baseline and diffs
  // correctly next time, instead of having its history wiped by an outage.
  archKeys = undefined, estimate = undefined, algo = undefined,
  // The cloud-spend summary and the X-ray's scope (migrations/0023). Same
  // `undefined` contract as the baselines above.
  cost = undefined, archScope = undefined,
  // The source scanner's result for this sweep (migrations/0024). Same
  // `undefined` contract: a sweep that could not read the source leaves the
  // previous result alone rather than erasing it.
  source = undefined,
  // Per-analyzer skips for this sweep (migrations/0022). Same `undefined`
  // contract: a caller that did not compute them leaves the column alone.
  skips = undefined,
  // Per-severity tally of the advisories this run saw (migrations/0017).
  // Same `undefined` contract as the baselines above.
  severities = undefined,
  // Outcome of this attempt (migrations/0017). Defaults to "ok" because every
  // existing caller of this function is on the success path; the failure and
  // skip paths call recordMonitorAttempt below instead, which does NOT touch
  // baselines.
  status = "ok", error = null,
}) {
  const sets  = ["last_run_at = ?", "last_attempt_at = ?", "last_result_hash = ?",
                 "last_advisory_ids = ?", "last_status = ?", "last_error = ?"];
  const binds = [ranAt, ranAt, resultHash, JSON.stringify(advisoryIds), status, error];
  if (delta) { sets.push("last_delta_json = ?"); binds.push(JSON.stringify(delta)); }
  if (archKeys !== undefined) {
    sets.push("last_arch_keys = ?");
    binds.push(archKeys === null ? null : JSON.stringify(archKeys));
  }
  if (estimate !== undefined) {
    sets.push("last_estimate_json = ?");
    binds.push(estimate === null ? null : JSON.stringify(estimate));
  }
  if (algo !== undefined) {
    sets.push("last_algo_json = ?");
    binds.push(algo === null ? null : JSON.stringify(algo));
  }
  if (cost !== undefined) {
    sets.push("last_cost_json = ?");
    binds.push(cost === null ? null : JSON.stringify(cost));
  }
  if (archScope !== undefined) {
    sets.push("last_arch_scope_json = ?");
    binds.push(archScope === null ? null : JSON.stringify(archScope));
  }
  if (source !== undefined) {
    sets.push("last_source_json = ?");
    binds.push(source === null ? null : JSON.stringify(source));
  }
  if (skips !== undefined) {
    sets.push("last_skips_json = ?");
    binds.push(skips === null ? null : JSON.stringify(skips));
  }
  if (severities !== undefined) {
    sets.push("last_severity_json = ?");
    binds.push(severities === null ? null : JSON.stringify(severities));
  }
  binds.push(monitorId);
  await env.DB.prepare(
    `UPDATE monitors SET ${sets.join(", ")} WHERE monitor_id = ?`,
  ).bind(...binds).run();
}

/**
 * Record an attempt that did NOT produce a usable result.
 *
 * Deliberately separate from recordMonitorRun, and deliberately narrow: it
 * writes the status, the reason and the attempt time, and touches no baseline
 * and no result hash. That separation is the whole safety property — a
 * throttled night must leave every diff baseline exactly where the last
 * successful sweep left it, or the next successful sweep reports the entire
 * world as new.
 *
 * `status` is 'failed' (permanent — retrying will not fix it) or 'skipped'
 * (transient — the next sweep may well succeed). last_run_at is NOT advanced
 * for either: "when did this monitor last actually produce a result" is the
 * question that field answers, and a failure did not.
 */
export async function recordMonitorAttempt(env, monitorId, { status, error = null, at = null }) {
  if (!env || !env.DB || !monitorId) return false;
  const sets  = ["last_status = ?", "last_error = ?"];
  const binds = [status, error];
  if (typeof at === "number") { sets.push("last_attempt_at = ?"); binds.push(at); }
  binds.push(monitorId);
  try {
    await env.DB.prepare(
      `UPDATE monitors SET ${sets.join(", ")} WHERE monitor_id = ?`,
    ).bind(...binds).run();
    return true;
  } catch {
    // Health is diagnostic, never load-bearing: failing to record why a sweep
    // failed must not also fail the sweep.
    return false;
  }
}

/**
 * Parse the stored delta. Anything malformed reads as null ("unknown"), never
 * as an empty delta — same rule parseIdList follows, and for the same reason:
 * a corrupt value must not be able to assert that nothing changed.
 */
function parseDelta(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d.total !== "number" || d.total < 0) return null;
    return {
      total:  d.total,
      counts: (d.counts && typeof d.counts === "object") ? d.counts : {},
      at:     typeof d.at === "number" ? d.at : null,
    };
  } catch { return null; }
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
export async function listMonitorsDue(env, nowSec, limit = 1000, opts = {}) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM monitors
      WHERE paused_at IS NULL
      ORDER BY IFNULL(last_run_at, 0) ASC
      LIMIT ?`,
  ).bind(limit).all();
  return (results || []).map(rowToMonitor).filter((m) => isDue(m, nowSec, opts));
}

const WEEK_SECONDS = 7 * 86_400;
// A daily monitor whose last run was 23h ago is still "due" tonight — the
// cron fires at a fixed hour and small drift in when the sweep starts must
// not skip a day. 20h leaves room for that without letting a monitor run
// twice in one sweep.
const DAILY_MIN_GAP = 20 * 3600;

/**
 * The hour a monitor runs at when it has not asked for one.
 *
 * 03:00 UTC, because that is the hour the daily cron fired at before hourly
 * sweeps existed. Pinning the default here is what stops an hourly sweep
 * from silently changing every existing monitor's delivery time: with a
 * 20-hour minimum gap and no hour to hold it to, a "daily" monitor on an
 * hourly cron would run every 20 hours and walk right around the clock.
 */
export const DEFAULT_SWEEP_HOUR = 3;

/**
 * Whether a monitor's cadence says it should run now.
 *
 * `runAtHour` (migrations/0017) holds a monitor back until its own UTC hour
 * has arrived. Only for monitors that have run before — a brand-new monitor
 * is always due, because making someone wait a day to find out their repo
 * URL was wrong is the behaviour the Run-now button exists to avoid, and
 * holding the first sweep back would reintroduce it.
 *
 * `sweepsHourly` says whether the cron ticks more often than daily, and it
 * changes what an unset hour means:
 *
 *   false  one sweep a day. The hour cannot be honoured by a clock that
 *          ticks once, so an unset hour means "this sweep" and a SET hour is
 *          still respected — a monitor asking for 14:00 on a 03:00-only cron
 *          simply never comes due, which is why the deploy note pairs the
 *          hour control with an hourly trigger.
 *   true   the hour is the clock. An unset hour falls back to
 *          DEFAULT_SWEEP_HOUR so every pre-0017 monitor keeps the 03:00 slot
 *          it has always had.
 *
 * The flag is derived from the cron expression the scheduled handler was
 * actually invoked with, not from a separate setting — so it cannot drift
 * out of step with the trigger it describes.
 */
export function isDue(monitor, nowSec, { sweepsHourly = false } = {}) {
  if (!monitor || monitor.pausedAt !== null) return false;
  if (monitor.lastRunAt === null) return true;      // never run — always due
  const elapsed = nowSec - monitor.lastRunAt;

  const wanted = typeof monitor.runAtHour === "number"
    ? monitor.runAtHour
    : (sweepsHourly ? DEFAULT_SWEEP_HOUR : null);
  if (wanted !== null) {
    // Compare against the sweep's own hour rather than a stored "next run"
    // timestamp: the cron is the clock, and a monitor whose hour has not come
    // around yet simply is not due on this tick.
    const hourNow = Math.floor(nowSec / 3600) % 24;
    if (hourNow !== wanted) return false;
  }

  if (monitor.schedule === "weekly") return elapsed >= WEEK_SECONDS;
  return elapsed >= DAILY_MIN_GAP;
}

/**
 * Does this cron expression fire more than once a day?
 *
 * Deliberately narrow: it answers the one question isDue needs, from the
 * string Cloudflare hands the scheduled handler. Anything it cannot read
 * confidently returns false, which is the conservative answer — a sweep that
 * wrongly believes it is hourly would hold every monitor back to 03:00.
 */
export function cronSweepsHourly(cron) {
  if (typeof cron !== "string") return false;
  const fields = cron.trim().split(/\s+/);
  if (fields.length < 2) return false;
  const hour = fields[1];
  return hour === "*" || hour.indexOf("/") !== -1 || hour.indexOf(",") !== -1 ||
         hour.indexOf("-") !== -1;
}
