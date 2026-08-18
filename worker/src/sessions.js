// The per-user session index.
//
// SESSIONS KV already holds every live session at `sess:<jwt>`, but that
// layout answers only one question — "is this token valid" — and the token is
// the key, so there is no way to ask "which sessions does this user have"
// without listing the whole namespace and fetching every value.
//
// This module adds a second key per session:
//
//   usess:<userId>:<sessionId>  ->  { token, issuedAt, userAgent, ip }
//
// sessionId is sha256(token), truncated. Three reasons it is a hash and not
// the token itself:
//
//   - Key length. A JWT plus a user id plus the prefix approaches KV's key
//     limit; a fixed 32-char digest does not.
//   - It gives the UI a stable handle for "revoke this session" that can
//     travel through a URL. Routing the raw JWT through the frontend to
//     identify a session would put a live credential in a request path, an
//     access log, and browser history.
//   - The index is one key per session rather than a JSON array, so two
//     concurrent logins cannot clobber each other the way a read-modify-write
//     on a shared array would.
//
// KNOWN GAP: sessions issued before this shipped have no index entry and will
// not be listed. That is genuinely unknown, not zero, and every caller that
// renders a count has to say so. Sessions carry a 30-day TTL, so the gap
// closes on its own within one session lifetime.

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

async function sha256Hex(input) {
  const bytes  = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable, non-secret handle for a session token. */
export async function sessionIdFor(token) {
  return (await sha256Hex(token)).slice(0, 32);
}

export function userSessionPrefix(userId) {
  return `usess:${userId}:`;
}

export function userSessionKey(userId, sessionId) {
  return `${userSessionPrefix(userId)}${sessionId}`;
}

/**
 * Record a newly-issued session against its user.
 *
 * `request` is optional and only used for display metadata. A login that
 * cannot determine the user agent still gets indexed — an entry with an
 * unknown device is far more useful than no entry at all.
 */
export async function indexSession(env, userId, token, request = null) {
  if (!env || !env.SESSIONS || !userId || !token) return null;
  const sessionId = await sessionIdFor(token);
  const entry = {
    token,
    issuedAt:  Math.floor(Date.now() / 1000),
    userAgent: (request && request.headers.get("User-Agent")) || null,
    // Cloudflare sets these; absent in local dev and in tests, where null is
    // the honest answer rather than a placeholder like "unknown location".
    ip:      (request && request.headers.get("CF-Connecting-IP")) || null,
    country: (request && request.headers.get("CF-IPCountry")) || null,
  };
  // Same TTL as the session itself, so the index expires with what it
  // describes and never accumulates entries for sessions that are long gone.
  await env.SESSIONS.put(userSessionKey(userId, sessionId), JSON.stringify(entry), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return sessionId;
}

/**
 * All indexed sessions for a user, newest first.
 *
 * Each entry is confirmed against the authoritative `sess:` key before being
 * returned. KV list is eventually consistent, so an index entry can outlive
 * the session it points at — returning it would show a revoked session as
 * live, which is the one error this list must not make. Confirmed-dead
 * entries are pruned as a side effect.
 *
 * `currentToken`, when supplied, marks which entry is the caller's own
 * session so the UI can label it and warn before revoking it.
 */
export async function listUserSessions(env, userId, { currentToken = null } = {}) {
  if (!env || !env.SESSIONS || !userId) return { sessions: [], complete: false };

  const listed = await env.SESSIONS.list({ prefix: userSessionPrefix(userId) });
  const keys   = (listed && listed.keys) || [];
  const currentId = currentToken ? await sessionIdFor(currentToken) : null;

  const sessions = [];
  const stale = [];
  for (const k of keys) {
    const raw = await env.SESSIONS.get(k.name);
    if (!raw) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (!entry || !entry.token) continue;

    const live = await env.SESSIONS.get(`sess:${entry.token}`);
    if (!live) { stale.push(k.name); continue; }

    const sessionId = k.name.slice(userSessionPrefix(userId).length);
    sessions.push({
      sessionId,
      issuedAt:  entry.issuedAt || null,
      userAgent: entry.userAgent || null,
      ip:        entry.ip || null,
      country:   entry.country || null,
      current:   currentId !== null && sessionId === currentId,
    });
  }

  // Best-effort cleanup; a failure here costs nothing but a repeat next read.
  for (const name of stale) {
    try { await env.SESSIONS.delete(name); } catch { /* prune again next time */ }
  }

  sessions.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
  return {
    sessions,
    // `list_complete` false means KV paginated. Rather than looping cursors
    // for a list that should never exceed a handful of entries, we report the
    // truncation so the caller can say "showing the first N" instead of
    // implying it showed everything.
    complete: listed ? listed.list_complete !== false : false,
  };
}

/**
 * Revoke one indexed session by its handle.
 *
 * Deletes the session itself first: if the second delete fails, the outcome
 * is an orphaned index entry (harmless, pruned on the next read) rather than
 * a live session that has disappeared from the list — which would leave
 * someone unable to see or revoke a session that still works.
 */
export async function revokeUserSession(env, userId, sessionId) {
  if (!env || !env.SESSIONS || !userId || !sessionId) return { revoked: false, reason: "invalid_request" };
  const key = userSessionKey(userId, sessionId);
  const raw = await env.SESSIONS.get(key);
  if (!raw) return { revoked: false, reason: "not_found" };

  let entry;
  try { entry = JSON.parse(raw); } catch { entry = null; }
  if (entry && entry.token) await env.SESSIONS.delete(`sess:${entry.token}`);
  await env.SESSIONS.delete(key);
  return { revoked: true, reason: null };
}

/** Remove the index entry for a token that is being revoked by value (logout). */
export async function unindexSession(env, userId, token) {
  if (!env || !env.SESSIONS || !userId || !token) return;
  await env.SESSIONS.delete(userSessionKey(userId, await sessionIdFor(token)));
}

/** Revoke every session a user has, returning how many were removed. */
export async function revokeAllUserSessions(env, userId, { exceptToken = null } = {}) {
  if (!env || !env.SESSIONS || !userId) return { revoked: 0, complete: false };
  const listed = await env.SESSIONS.list({ prefix: userSessionPrefix(userId) });
  const keys   = (listed && listed.keys) || [];
  const keepId = exceptToken ? await sessionIdFor(exceptToken) : null;

  let revoked = 0;
  for (const k of keys) {
    const sessionId = k.name.slice(userSessionPrefix(userId).length);
    if (keepId && sessionId === keepId) continue;
    const raw = await env.SESSIONS.get(k.name);
    if (raw) {
      try {
        const entry = JSON.parse(raw);
        if (entry && entry.token) await env.SESSIONS.delete(`sess:${entry.token}`);
      } catch { /* entry unreadable — still drop the index key below */ }
    }
    await env.SESSIONS.delete(k.name);
    revoked += 1;
  }
  return { revoked, complete: listed ? listed.list_complete !== false : false };
}
