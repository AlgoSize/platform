// MCP OAuth scopes and token storage.
//
// Mirrors handlers/_api_keys.js deliberately: the plaintext token exists in
// exactly one stack frame, only sha256(token) reaches the database, and every
// later read works from the hash. The reasoning there applies verbatim here —
// a token we cannot reconstruct is a token a database leak cannot hand over.
//
// Revocation NEVER deletes a row. `revoked_at` is set instead, so "who had
// access, and when did it stop" survives — which is the question an audit
// asks and a DELETE destroys.

import { AUDIT_ACTIONS } from "../audit.js";

export const MCP_TOKEN_TAG = "ask_mcp_";

const TOKEN_RANDOM_BYTES = 32;

// One hour for access, thirty days for refresh. Short access tokens are what
// make revocation meaningful: a grant the user revokes stops working within
// the hour even for a client that never checks back, because the token it
// holds simply expires and the refresh that would renew it is already dead.
const ACCESS_TTL_SECONDS  = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The three scopes, narrowest first.
 *
 * There is deliberately no scope for creating API keys, changing billing,
 * managing members, or anything under /api/admin. Those routes have no tool at
 * all — see tools/index.js — so no combination of scopes an MCP client can
 * obtain lets it escalate its own access. A connected assistant can analyse
 * and organise; it cannot mint credentials or move money.
 */
export const SCOPES = Object.freeze({
  READ:    "algosize:read",
  ANALYZE: "algosize:analyze",
  MANAGE:  "algosize:manage",
});

export const ALL_SCOPES = Object.freeze([SCOPES.READ, SCOPES.ANALYZE, SCOPES.MANAGE]);

// Shown on the consent screen. Written in plain language rather than as scope
// strings, because "algosize:analyze" tells a firm owner nothing about what
// they are about to approve, and the consent screen is the one moment they
// get to decide.
export const SCOPE_DESCRIPTIONS = Object.freeze({
  [SCOPES.READ]:    "Read your analysis history, reports, scorecard, monitors and architecture snapshots.",
  [SCOPES.ANALYZE]: "Run analyses on code and infrastructure you provide. Each run counts against your monthly allowance.",
  [SCOPES.MANAGE]:  "Create, change and delete scheduled monitors, and create shareable report links.",
});

export async function sha256Hex(input) {
  const bytes  = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Mint a plaintext token. The only place the secret exists. */
export function generateToken() {
  const bytes = new Uint8Array(TOKEN_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return MCP_TOKEN_TAG + base64url(bytes);
}

function newTokenId() {
  return "mcpt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/**
 * Normalise a requested scope string to the subset we actually grant.
 *
 * Unknown scopes are dropped rather than rejected, per OAuth 2.1: a client
 * asking for something we do not offer gets what we do offer, and learns the
 * truth from the `scope` in the token response. Requesting nothing at all
 * yields read — the least that is still useful, never everything.
 */
export function normalizeScope(requested) {
  const asked = String(requested || "").split(/\s+/).filter(Boolean);
  const granted = ALL_SCOPES.filter((s) => asked.includes(s));
  return granted.length ? granted.join(" ") : SCOPES.READ;
}

/** Does this granted scope string carry `required`? */
export function hasScope(granted, required) {
  if (!granted) return false;
  const list = Array.isArray(granted) ? granted : String(granted).split(/\s+/);
  return list.includes(required);
}

/**
 * Issue an access + refresh pair for one grant.
 *
 * Returns the plaintexts once. `parentTokenId` links a rotated refresh token
 * to the one it replaced, so a whole chain can be revoked together when a
 * replayed refresh suggests the token was stolen.
 */
export async function issueTokenPair(env, { clientId, orgId, userId, scope, parentTokenId = null, now }) {
  const issuedAt = now ?? Math.floor(Date.now() / 1000);
  const access   = generateToken();
  const refresh  = generateToken();
  const accessId  = newTokenId();
  const refreshId = newTokenId();

  // The access token is recorded as a CHILD of the refresh token issued
  // alongside it, not as its sibling.
  //
  // Both used to carry the same parent, which made them siblings — and
  // revokeTokenChain only walks parent→child. So revoking a refresh token, the
  // thing that happens when someone disconnects a client, left the access
  // token issued with it alive and working for up to a full hour. The grant
  // looked revoked and was not.
  //
  // Parenting the access token to its own refresh token makes the chain
  // oldRefresh → newRefresh → newAccess, so revoking any refresh token reaches
  // every credential descended from it, including its own access token.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mcp_tokens
         (token_id, token_hash, token_type, client_id, org_id, user_id, scope, expires_at, parent_token_id)
       VALUES (?, ?, 'refresh', ?, ?, ?, ?, ?, ?)`,
    ).bind(refreshId, await sha256Hex(refresh), clientId, orgId, userId ?? null, scope,
           issuedAt + REFRESH_TTL_SECONDS, parentTokenId),
    env.DB.prepare(
      `INSERT INTO mcp_tokens
         (token_id, token_hash, token_type, client_id, org_id, user_id, scope, expires_at, parent_token_id)
       VALUES (?, ?, 'access', ?, ?, ?, ?, ?, ?)`,
    ).bind(accessId, await sha256Hex(access), clientId, orgId, userId ?? null, scope,
           issuedAt + ACCESS_TTL_SECONDS, refreshId),
  ]);

  return {
    accessToken:  access,
    refreshToken: refresh,
    accessTokenId:  accessId,
    refreshTokenId: refreshId,
    expiresIn: ACCESS_TTL_SECONDS,
    scope,
  };
}

async function resolveToken(env, raw, type, { now, touch = false } = {}) {
  if (!raw || !raw.startsWith(MCP_TOKEN_TAG)) return null;
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT token_id, token_hash, token_type, client_id, org_id, user_id, scope,
            expires_at, revoked_at, parent_token_id
       FROM mcp_tokens
      WHERE token_hash = ? AND token_type = ?`,
  ).bind(await sha256Hex(raw), type).first();

  if (!row) return null;
  // Revoked and expired are reported the same way — as "no". The caller has no
  // use for the difference and telling a bearer *why* their token failed is
  // free information for someone probing with stolen material.
  if (row.revoked_at) return { ...row, valid: false, reason: "revoked" };
  if (row.expires_at <= nowSec) return { ...row, valid: false, reason: "expired" };
  if (touch) {
    // Best-effort, and never awaited by the caller on the response path —
    // last_used_at is for the connections list, not for correctness.
    env.DB.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE token_id = ?")
      .bind(nowSec, row.token_id).run().catch(() => {});
  }
  return { ...row, valid: true, reason: null };
}

export function resolveAccessToken(env, raw, opts = {}) {
  return resolveToken(env, raw, "access", { ...opts, touch: true });
}

export function resolveRefreshToken(env, raw, opts = {}) {
  return resolveToken(env, raw, "refresh", opts);
}

/** Revoke one token by id. */
export async function revokeToken(env, tokenId, { now } = {}) {
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE mcp_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL",
  ).bind(nowSec, tokenId).run();
}

/**
 * Revoke a token and everything descended from it.
 *
 * Called when a refresh token is presented twice. A second use of a
 * single-use token means either a buggy client or a stolen token, and the
 * safe reading is theft: the legitimate holder can re-authorise in seconds,
 * whereas leaving a live chain in an attacker's hands is unbounded. Walks
 * `parent_token_id` forward rather than deleting, so the chain stays readable
 * afterwards.
 */
export async function revokeTokenChain(env, rootTokenId, { now } = {}) {
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  let frontier = [rootTokenId];
  const seen = new Set();
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      await revokeToken(env, id, { now: nowSec });
      const kids = await env.DB.prepare(
        "SELECT token_id FROM mcp_tokens WHERE parent_token_id = ?",
      ).bind(id).all();
      for (const k of (kids && kids.results) || []) next.push(k.token_id);
    }
    frontier = next;
  }
  return seen.size;
}

/** Revoke every live token for one client on one org — the "disconnect" button. */
export async function revokeClientTokens(env, orgId, clientId, { now } = {}) {
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    `UPDATE mcp_tokens SET revoked_at = ?
      WHERE org_id = ? AND client_id = ? AND revoked_at IS NULL`,
  ).bind(nowSec, orgId, clientId).run();
  return (res && res.meta && res.meta.changes) || 0;
}

/**
 * The connected-clients list for one org.
 *
 * Grouped by client so the UI shows "Claude Desktop, connected 3 days ago",
 * not one row per token rotation. Revoked clients are still listed — the
 * design brief asks for revoked entries to remain visible as history, and
 * that is also the only way someone can answer "did I already turn that off".
 */
export async function listConnections(env, orgId) {
  const rows = await env.DB.prepare(
    `SELECT t.client_id,
            c.client_name,
            MIN(t.rowid)         AS first_row,
            MAX(t.last_used_at)  AS last_used_at,
            MAX(t.expires_at)    AS expires_at,
            MAX(t.scope)         AS scope,
            MAX(t.user_id)       AS user_id,
            SUM(CASE WHEN t.revoked_at IS NULL THEN 1 ELSE 0 END) AS live_tokens
       FROM mcp_tokens t
       LEFT JOIN mcp_clients c ON c.client_id = t.client_id
      WHERE t.org_id = ?
      GROUP BY t.client_id, c.client_name
      ORDER BY last_used_at DESC NULLS LAST`,
  ).bind(orgId).all();

  return ((rows && rows.results) || []).map((r) => ({
    clientId:   r.client_id,
    clientName: r.client_name || "Unknown client",
    scope:      r.scope,
    approvedBy: r.user_id || null,
    lastUsedAt: typeof r.last_used_at === "number" ? r.last_used_at : null,
    expiresAt:  typeof r.expires_at === "number" ? r.expires_at : null,
    // "Connected" means at least one token still works. A client whose tokens
    // all expired naturally reads as disconnected without anyone revoking it,
    // which is the truth.
    active: Number(r.live_tokens) > 0,
  }));
}

// New audit actions, named in the existing dotted style. MCP_TOOL_CALLED is
// deliberately absent: a chatty assistant makes hundreds of calls an hour and
// would bury every human action in the audit log. Tool calls go to
// mcp_tool_calls instead, which is built for that volume and queryable on its
// own; the audit log keeps the events a person actually performed.
export const MCP_AUDIT_ACTIONS = Object.freeze({
  MCP_CLIENT_REGISTERED: "mcp.client_registered",
  MCP_GRANT_AUTHORIZED:  "mcp.grant_authorized",
  MCP_GRANT_REVOKED:     "mcp.grant_revoked",
});

// Re-exported so callers import one audit vocabulary rather than two.
export const ALL_AUDIT_ACTIONS = Object.freeze({ ...AUDIT_ACTIONS, ...MCP_AUDIT_ACTIONS });
