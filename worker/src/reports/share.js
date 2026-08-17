// Signed share links for a single report.
//
// The use case is the whole point of the tier: a consultancy finishes an audit
// and needs to send the result to a client who will never have an Algosize
// account. A link is the only delivery mechanism that works for that person.
//
// Design constraints, and why each one:
//
//   Read-only, one run.  The token names exactly one run id. It cannot list,
//   cannot re-share, and cannot reach the org's other runs. A link forwarded
//   further than intended leaks one report, not an account.
//
//   Expiring by default.  7 days, capped at 90. A permanent public URL to a
//   vulnerability report is a liability that outlives everyone's memory of
//   creating it, so the default is short and the maximum is bounded.
//
//   Unguessable, not secret-derived.  32 bytes from crypto.getRandomValues.
//   There is no signature to verify because there is no offline verification
//   to do: the token IS the lookup key, and revoking it means deleting the
//   row. An HMAC would let a revoked link keep validating.
//
//   Explicit expiry check as well as a KV TTL.  KV's TTL is eventually
//   consistent and edge caches can serve a row slightly past its expiry. The
//   stored `expiresAt` is checked on every read so the deadline is enforced by
//   our own clock rather than by the storage layer's housekeeping.

const SHARE_PREFIX  = "runShare:";
const TOKEN_BYTES   = 32;

export const DEFAULT_SHARE_DAYS = 7;
export const MAX_SHARE_DAYS     = 90;

const DAY_SECONDS = 86_400;

function base64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function newShareToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export const shareKey = (token) => `${SHARE_PREFIX}${token}`;

/**
 * Clamp a requested lifetime to something defensible.
 *
 * A non-number, or anything out of range, falls back to the default rather
 * than erroring: the caller asked for a share link, and the useful answer to
 * "expiresInDays: banana" is a 7-day link, not a 400.
 */
export function clampShareDays(raw) {
  const n = typeof raw === "number" ? Math.floor(raw) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SHARE_DAYS;
  return Math.min(n, MAX_SHARE_DAYS);
}

/**
 * Mint a share token for one run.
 *
 * `now` is injectable so tests can create a token that is already expired
 * without sleeping through its lifetime.
 */
export async function createShare(env, { runId, orgId, createdBy = null, expiresInDays, now = null } = {}) {
  if (!env || !env.SESSIONS || !runId) return null;

  const nowSec = typeof now === "number" ? now : Math.floor(Date.now() / 1000);
  const days   = clampShareDays(expiresInDays);
  const expiresAt = nowSec + days * DAY_SECONDS;

  const token = newShareToken();
  const record = { runId, orgId: orgId || null, createdBy, createdAt: nowSec, expiresAt };

  await env.SESSIONS.put(shareKey(token), JSON.stringify(record), {
    // Slightly beyond the deadline we enforce ourselves, so the row is still
    // there to produce an honest "this link expired" rather than vanishing
    // into a 404 that reads as "wrong link".
    expirationTtl: days * DAY_SECONDS + DAY_SECONDS,
  });

  return { token, expiresAt, expiresInDays: days, record };
}

/**
 * Resolve a share token.
 *
 * Returns `{ ok: true, share }`, or `{ ok: false, reason }` where reason is
 * "not_found" (never existed, revoked, or aged out of KV) or "expired" (the
 * row is still there but its deadline has passed). The two are kept distinct
 * because they deserve different words to the reader: one means "check the
 * link", the other means "ask for a new one".
 */
export async function readShare(env, token, { now = null } = {}) {
  if (!env || !env.SESSIONS || typeof token !== "string" || !token) {
    return { ok: false, reason: "not_found" };
  }

  const raw = await env.SESSIONS.get(shareKey(token));
  if (!raw) return { ok: false, reason: "not_found" };

  let share;
  try { share = JSON.parse(raw); } catch { return { ok: false, reason: "not_found" }; }
  if (!share || !share.runId) return { ok: false, reason: "not_found" };

  const nowSec = typeof now === "number" ? now : Math.floor(Date.now() / 1000);
  if (typeof share.expiresAt === "number" && nowSec >= share.expiresAt) {
    return { ok: false, reason: "expired", share };
  }

  return { ok: true, share };
}

/** Revoke a share link. Deleting the row is the revocation. */
export async function revokeShare(env, token) {
  if (!env || !env.SESSIONS || !token) return false;
  await env.SESSIONS.delete(shareKey(token));
  return true;
}
