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
const INDEX_PREFIX  = "runShareIndex:";
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
 * Per-run index of minted tokens.
 *
 * The token row is the source of truth and is keyed by token alone, because
 * that is the only thing a public reader presents. But the OWNER needs the
 * opposite lookup — "which links did I mint for this report, and are they
 * still live?" — and KV cannot answer that from the token rows without a
 * prefix scan over every share on the account.
 *
 * So the index is a second, deliberately lossy copy: one row per run holding
 * the tokens minted for it. It can drift (a token row can age out of KV while
 * the index still lists it), which is why listShares re-reads every token
 * rather than trusting the index's contents — the index narrows the search,
 * it does not answer the question.
 */
export const shareIndexKey = (runId) => `${INDEX_PREFIX}${runId}`;

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

  // Index write is best-effort and deliberately non-fatal: a link that works
  // but is missing from the owner's list is a worse outcome than a link that
  // does not exist, so the token row is never rolled back on an index failure.
  try {
    const tokens = await readShareIndex(env, runId);
    if (!tokens.includes(token)) {
      await env.SESSIONS.put(
        shareIndexKey(runId),
        JSON.stringify([...tokens, token]),
        { expirationTtl: MAX_SHARE_DAYS * DAY_SECONDS + DAY_SECONDS },
      );
    }
  } catch { /* the link still works; only the listing is poorer */ }

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

/**
 * Revoke a share link. Deleting the token row is the revocation.
 *
 * `runId` is optional and only prunes the index. Revocation is complete
 * without it — listShares re-reads every token and drops the ones that are
 * gone — so a caller that does not know the run id still revokes correctly,
 * it just leaves a stale entry for the index to shed on its next read.
 */
export async function revokeShare(env, token, runId = null) {
  if (!env || !env.SESSIONS || !token) return false;
  await env.SESSIONS.delete(shareKey(token));
  if (runId) {
    try {
      const tokens = await readShareIndex(env, runId);
      const left   = tokens.filter((t) => t !== token);
      if (left.length !== tokens.length) {
        if (left.length) {
          await env.SESSIONS.put(shareIndexKey(runId), JSON.stringify(left), {
            expirationTtl: MAX_SHARE_DAYS * DAY_SECONDS + DAY_SECONDS,
          });
        } else {
          await env.SESSIONS.delete(shareIndexKey(runId));
        }
      }
    } catch { /* stale index entry; listShares filters it out anyway */ }
  }
  return true;
}

/** Token ids recorded against a run. Never trusted for liveness — see listShares. */
async function readShareIndex(env, runId) {
  const raw = await env.SESSIONS.get(shareIndexKey(runId));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((t) => typeof t === "string") : [];
  } catch { return []; }
}

/**
 * Every live share link for one run, newest first.
 *
 * Each indexed token is re-read, so a row that has aged out of KV or been
 * revoked simply does not appear — the index is a search hint, not a record of
 * what exists. Expired-but-present rows are returned with `expired: true`
 * rather than hidden: "this link stopped working on the 4th" is a different
 * and more useful answer than the link silently vanishing from the list.
 *
 * The index is rewritten when this read finds it stale, so listing is also
 * how the index stays honest — there is no sweeper.
 */
export async function listShares(env, runId, { now = null } = {}) {
  if (!env || !env.SESSIONS || !runId) return [];

  const nowSec = typeof now === "number" ? now : Math.floor(Date.now() / 1000);
  const tokens = await readShareIndex(env, runId);
  if (!tokens.length) return [];

  const rows = await Promise.all(tokens.map(async (token) => {
    const raw = await env.SESSIONS.get(shareKey(token));
    if (!raw) return null;
    let share;
    try { share = JSON.parse(raw); } catch { return null; }
    if (!share || share.runId !== runId) return null;
    return {
      token,
      createdAt: share.createdAt || null,
      createdBy: share.createdBy || null,
      expiresAt: share.expiresAt || null,
      expired:   typeof share.expiresAt === "number" && nowSec >= share.expiresAt,
    };
  }));

  const live = rows.filter(Boolean);

  if (live.length !== tokens.length) {
    try {
      if (live.length) {
        await env.SESSIONS.put(
          shareIndexKey(runId),
          JSON.stringify(live.map((s) => s.token)),
          { expirationTtl: MAX_SHARE_DAYS * DAY_SECONDS + DAY_SECONDS },
        );
      } else {
        await env.SESSIONS.delete(shareIndexKey(runId));
      }
    } catch { /* next read tries again */ }
  }

  return live.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
