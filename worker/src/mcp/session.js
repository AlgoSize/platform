/**
 * KV-backed MCP session lifecycle.
 * Sessions are stored in the existing SESSIONS KV namespace under
 * the key `mcp:sess:<id>` with a 24-hour TTL.
 * Sessions contain NO credential material — the client re-presents
 * its bearer on every request.
 */

import { randomHex } from '../auth.js';

const SESSION_TTL_SECONDS = 86400; // 24 h
const KV_PREFIX = 'mcp:sess:';

/**
 * Create a new session after a successful initialize handshake.
 */
export async function createSession(env, { protocolVersion, clientInfo, capabilities, orgId, userId, authMethod, mcpScopes }) {
  const id = randomHex(32);
  const now = Date.now();
  const record = {
    id,
    protocolVersion,
    clientInfo:   clientInfo   ?? null,
    capabilities: capabilities ?? {},
    orgId,
    userId:       userId ?? null,
    authMethod,
    mcpScopes,
    createdAt:    now,
    lastSeenAt:   now,
  };
  await env.SESSIONS.put(`${KV_PREFIX}${id}`, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return id;
}

/**
 * Load and refresh a session. Returns null if not found or expired.
 */
export async function getSession(env, id) {
  if (!id) return null;
  const raw = await env.SESSIONS.get(`${KV_PREFIX}${id}`);
  if (!raw) return null;
  const record = JSON.parse(raw);
  // Refresh TTL on access
  record.lastSeenAt = Date.now();
  await env.SESSIONS.put(`${KV_PREFIX}${id}`, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return record;
}

/**
 * Delete a session (client-initiated teardown).
 */
export async function deleteSession(env, id) {
  if (!id) return;
  await env.SESSIONS.delete(`${KV_PREFIX}${id}`);
}
