// Feature flags (migrations/0014).
//
// Deliberately small: a key, on/off, and an optional rollout percentage.
// No targeting rules, no segments, no audiences — those need a product to
// justify them, and building a worse LaunchDarkly nobody asked for is a
// bigger cost than the flexibility is worth today.
//
// Evaluation is deterministic per (flag, subject): the same user gets the
// same answer for a given flag on every request, forever, unless the
// percentage moves. A random draw per request would put a user in the
// variant on one page load and out of it on the next, which reads as a bug
// to them and makes any measurement of the rollout meaningless.

import { captureException } from "./observability.js";

/** A flag key is lowercase, dot- or underscore-separated, and bounded. */
export const FLAG_KEY_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

function rowToFlag(row) {
  return {
    key:         row.flag_key,
    enabled:     row.enabled === 1,
    rolloutPct:  row.rollout_pct,
    description: row.description || null,
    updatedBy:   row.updated_by || null,
    updatedAt:   row.updated_at,
  };
}

export async function listFlags(env) {
  if (!env || !env.DB) return [];
  const res = await env.DB
    .prepare(
      `SELECT flag_key, enabled, rollout_pct, description, updated_by, updated_at
         FROM feature_flags ORDER BY flag_key ASC`,
    )
    .all();
  return ((res && res.results) || []).map(rowToFlag);
}

export async function getFlag(env, key) {
  if (!env || !env.DB || !key) return null;
  const row = await env.DB
    .prepare(
      `SELECT flag_key, enabled, rollout_pct, description, updated_by, updated_at
         FROM feature_flags WHERE flag_key = ?`,
    )
    .bind(key)
    .first();
  return row ? rowToFlag(row) : null;
}

/**
 * Create or update a flag.
 *
 * Returns `{ ok: false, error }` rather than throwing on bad input, because
 * every caller is an HTTP handler that has to turn the problem into a status
 * code and a message anyway.
 */
export async function upsertFlag(env, key, { enabled, rolloutPct, description, updatedBy } = {}) {
  if (!env || !env.DB) return { ok: false, error: "not_configured" };
  if (typeof key !== "string" || !FLAG_KEY_RE.test(key)) {
    return { ok: false, error: "invalid_key" };
  }

  const existing = await getFlag(env, key);

  // A PATCH leaves unmentioned fields alone; a create needs defaults. Off by
  // default is the only safe create: a flag that springs into existence
  // already on is indistinguishable from shipping the feature by accident.
  const nextEnabled =
    enabled === undefined ? (existing ? existing.enabled : false) : Boolean(enabled);

  let nextPct = existing ? existing.rolloutPct : 100;
  if (rolloutPct !== undefined) {
    const n = Number(rolloutPct);
    if (!Number.isInteger(n) || n < 0 || n > 100) return { ok: false, error: "invalid_rollout" };
    nextPct = n;
  }

  const nextDescription =
    description === undefined ? (existing ? existing.description : null) : (description || null);

  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB
      .prepare(
        `INSERT INTO feature_flags (flag_key, enabled, rollout_pct, description, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(flag_key) DO UPDATE SET
           enabled     = excluded.enabled,
           rollout_pct = excluded.rollout_pct,
           description = excluded.description,
           updated_by  = excluded.updated_by,
           updated_at  = excluded.updated_at`,
      )
      .bind(key, nextEnabled ? 1 : 0, nextPct, nextDescription, updatedBy || null, now)
      .run();
  } catch (err) {
    return { ok: false, error: "write_failed", message: (err && err.message) || "unknown error" };
  }

  return {
    ok: true,
    created: !existing,
    flag: { key, enabled: nextEnabled, rolloutPct: nextPct, description: nextDescription, updatedBy: updatedBy || null, updatedAt: now },
    previous: existing,
  };
}

export async function deleteFlag(env, key) {
  if (!env || !env.DB || !key) return { deleted: false };
  const existing = await getFlag(env, key);
  if (!existing) return { deleted: false };
  await env.DB.prepare("DELETE FROM feature_flags WHERE flag_key = ?").bind(key).run();
  return { deleted: true, previous: existing };
}

/**
 * Stable 0-99 bucket for a subject within one flag.
 *
 * The flag key is mixed in so two flags at 10% do not select the same 10% of
 * users — otherwise the first cohort to get one experimental feature gets
 * every experimental feature, and their experience diverges from everyone
 * else's in a way no single rollout accounts for.
 */
async function bucketFor(key, subject) {
  const bytes  = new TextEncoder().encode(`${key}:${subject}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view   = new DataView(digest);
  return view.getUint32(0) % 100;
}

/**
 * Is this flag on for this subject?
 *
 * Fails CLOSED: an unknown flag, an unreachable database, or a missing
 * subject all resolve to false. A flag system that fails open turns a
 * database blip into an unannounced launch of every unfinished feature.
 */
export async function isFlagEnabled(env, ctx, key, subject = null) {
  let flag;
  try {
    flag = await getFlag(env, key);
  } catch (err) {
    await captureException(env, ctx, err, {
      tags:  { source: "flags", reason: "read_failed" },
      extra: { flag: key },
    });
    return false;
  }
  if (!flag || !flag.enabled) return false;
  if (flag.rolloutPct >= 100) return true;
  if (flag.rolloutPct <= 0) return false;
  // Enabled with a partial rollout and nobody to bucket: there is no honest
  // answer, so take the safe one rather than flipping a coin.
  if (!subject) return false;
  return (await bucketFor(key, subject)) < flag.rolloutPct;
}
