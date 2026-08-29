// MCP session lifecycle, backed by the SESSIONS KV namespace.
//
// A session is bookkeeping, NOT a credential. The client re-presents its
// bearer token on every single request; the session id only carries the
// negotiated protocol state that would otherwise have to be re-sent each
// time — revision, client info, capabilities, log level.
//
// That distinction is the reason no token, key, hash or secret is stored in
// the record. If a session id leaked it would let an attacker resume a
// conversation's *settings*, and nothing else: every request it rides on
// still has to carry a bearer that resolves to the same org, and
// `assertSessionOwner` refuses when it does not.
//
// It lives in the existing SESSIONS namespace rather than a new one because a
// new KV binding is a new thing to provision in every environment and one
// more line in DEPLOY.md that can be forgotten on staging. The `mcp:sess:`
// prefix keeps it clear of the `sess:` keys requireAuth reads.

import { sessionRefFor, sessionLabelKey } from "./telemetry.js";

const KEY_PREFIX = "mcp:sess:";

// 24 hours. Long enough that a working session survives a lunch break, short
// enough that an abandoned one is not still resumable tomorrow. KV enforces
// this itself, so an expired session simply reads as absent — there is no
// sweep to run and no way for a stale record to linger.
const TTL_SECONDS = 24 * 60 * 60;

function sessionId() {
  // crypto.randomUUID is available in workerd and in Node 20+, which is what
  // the test scripts run under, so there is no polyfill branch to maintain.
  return crypto.randomUUID();
}

/**
 * Open a session for a client that has just completed `initialize`.
 *
 * The org is stamped in at creation and never changes. A session cannot be
 * "moved" to another org by presenting a different token later — see
 * `assertSessionOwner`, which is the check that makes that true.
 */
export async function createSession(env, {
  protocolVersion, clientInfo, capabilities, orgId, userId = null, authMethod, scopes = [],
}) {
  const id  = sessionId();
  const now = Math.floor(Date.now() / 1000);
  const record = {
    protocolVersion,
    clientInfo:   clientInfo || null,
    capabilities: capabilities || {},
    orgId,
    userId,
    authMethod,
    scopes,
    // Set by notifications/initialized. Until then the client is mid-handshake
    // and, per the spec, should only be pinging.
    ready:     false,
    logLevel:  "info",
    createdAt: now,
    lastSeenAt: now,
  };
  await env.SESSIONS.put(KEY_PREFIX + id, JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
  });
  // A second pointer keyed by the session REF (the truncated hash the
  // tool-call log stores), holding only the client's self-reported name and
  // version. It exists so the usage feed can label a recent session
  // "Claude Code 2.1.4" without the log ever storing the raw id — and it
  // shares the record's TTL on purpose: when it expires, the session's rows
  // fall back to being identified by time span and credential, which is the
  // designed behaviour for old sessions, not a failure. Best-effort: a
  // session without a label is degraded, a session that failed to open is
  // broken, and this write must never turn the first into the second.
  try {
    const ref = await sessionRefFor(id);
    if (ref) {
      await env.SESSIONS.put(sessionLabelKey(ref),
        JSON.stringify({ clientInfo: record.clientInfo }),
        { expirationTtl: TTL_SECONDS });
    }
  } catch { /* label stays absent */ }
  return { id, record };
}

/** Read a session. Returns null when unknown or expired — the caller cannot tell the two apart, and does not need to. */
export async function getSession(env, id) {
  if (!id) return null;
  const raw = await env.SESSIONS.get(KEY_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A record we cannot parse is a record we cannot trust. Treating it as
    // absent makes the client re-initialize, which repairs it; returning a
    // half-object would push the corruption further into the request.
    return null;
  }
}

/**
 * Merge fields into a session and refresh its TTL.
 *
 * Best-effort by design: this runs on the response path of ordinary requests
 * (to bump lastSeenAt), and a KV hiccup there must not fail a tool call that
 * already succeeded. Returns true when the write landed.
 */
export async function updateSession(env, id, patch) {
  const current = await getSession(env, id);
  if (!current) return false;
  const next = { ...current, ...patch, lastSeenAt: Math.floor(Date.now() / 1000) };
  try {
    await env.SESSIONS.put(KEY_PREFIX + id, JSON.stringify(next), {
      expirationTtl: TTL_SECONDS,
    });
    return true;
  } catch {
    return false;
  }
}

/** Explicit teardown — DELETE /api/mcp. Idempotent: deleting an unknown id is a no-op, not an error. */
export async function deleteSession(env, id) {
  if (!id) return;
  await env.SESSIONS.delete(KEY_PREFIX + id);
}

/**
 * Does this credential own this session?
 *
 * The session id travels in a header and is not secret in the way a token is,
 * so it is treated as a NAME, not a capability: presenting one proves nothing
 * on its own. Every request is authenticated independently, and this asserts
 * the authenticated org matches the org the session was opened for.
 *
 * Without this, a valid token for org B plus a leaked session id from org A
 * would let B inherit A's negotiated state — and, once resources are keyed by
 * session, read across the boundary. Cross-tenant leakage is the worst bug
 * this product could ship, so the check is unconditional rather than a
 * defence-in-depth nicety.
 */
export function assertSessionOwner(session, orgId) {
  return Boolean(session) && session.orgId === orgId;
}
