// API key issuance, lookup and lifecycle. See migrations/0005_api_keys.sql.
//
// Keys authenticate AS THE ORGANISATION (migrations/0004) — the same
// billing subject the Stripe subscription and entitlement resolve against.
// A key is not tied to the member who created it, so org membership can
// change without touching keys.
//
// The plaintext key exists at rest nowhere, including here: only
// sha256(key) is stored, and only createApiKey ever sees the plaintext, for
// the single response that returns it.

const KEY_PREFIX_TAG     = "ask_live_";
const KEY_RANDOM_BYTES   = 32;
// "ask_live_" (9 chars) + 7 chars of entropy — enough to tell keys apart in
// a list, nowhere near enough to reconstruct or brute-force the rest.
const DISPLAY_PREFIX_LEN = 16;

function base64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function sha256Hex(input) {
  const bytes  = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newKeyId() {
  return "key_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/** Mint a fresh plaintext key. Exported so tests can assert on its shape. */
export function generateApiKey() {
  const bytes = new Uint8Array(KEY_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return KEY_PREFIX_TAG + base64url(bytes);
}

function rowToKey(row) {
  if (!row) return null;
  return {
    keyId:      row.key_id,
    orgId:      row.org_id,
    name:       row.name,
    prefix:     row.prefix,
    createdBy:  row.created_by,
    createdAt:  row.created_at,
    lastUsedAt: typeof row.last_used_at === "number" ? row.last_used_at : null,
    revokedAt:  typeof row.revoked_at === "number" ? row.revoked_at : null,
  };
}

/**
 * Create a key for an org.
 *
 * Returns `{ key, record }` — `key` is the ONE AND ONLY time the plaintext
 * exists outside this function's stack frame. Callers must return it in the
 * creation response and never log it, and must not expect to recover it
 * afterward — `record` (and every later read) carries only the hash's
 * public face: id, name, prefix, timestamps.
 */
export async function createApiKey(env, { orgId, name, createdBy }) {
  const key    = generateApiKey();
  const hash   = await sha256Hex(key);
  const prefix = key.slice(0, DISPLAY_PREFIX_LEN);
  const now    = Math.floor(Date.now() / 1000);
  const keyId  = newKeyId();

  await env.DB.prepare(
    `INSERT INTO api_keys (key_id, org_id, name, key_hash, prefix, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(keyId, orgId, name, hash, prefix, createdBy, now).run();

  return {
    key,
    record: rowToKey({
      key_id: keyId, org_id: orgId, name, prefix,
      created_by: createdBy, created_at: now, last_used_at: null, revoked_at: null,
    }),
  };
}

/** All of an org's keys, newest first. Never returns key_hash. */
export async function listApiKeys(env, orgId) {
  const { results } = await env.DB
    .prepare("SELECT * FROM api_keys WHERE org_id = ? ORDER BY created_at DESC")
    .bind(orgId)
    .all();
  return (results || []).map(rowToKey);
}

/** A single key, scoped to the org — defense in depth for the DELETE route. */
export async function getApiKey(env, orgId, keyId) {
  const row = await env.DB
    .prepare("SELECT * FROM api_keys WHERE key_id = ? AND org_id = ?")
    .bind(keyId, orgId)
    .first();
  return rowToKey(row);
}

/** Revoke a key. Returns true iff a live key was actually revoked. */
export async function revokeApiKey(env, orgId, keyId) {
  const result = await env.DB.prepare(
    "UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND org_id = ? AND revoked_at IS NULL",
  ).bind(Math.floor(Date.now() / 1000), keyId, orgId).run();
  return !!(result.meta && result.meta.changes);
}

/**
 * Verify a plaintext key presented on a request.
 *
 * Returns `{ keyId, orgId }` for a live (non-revoked) key, or null for
 * anything else — unknown, malformed, or revoked. The hash is computed even
 * on a lookup miss so a bad key and a good key take the same shape of work;
 * that is not a load-bearing timing guarantee once D1 is in the loop, but it
 * costs nothing and avoids the cheapest tell ("the query never even ran").
 */
export async function verifyApiKey(env, plaintext) {
  const hash = await sha256Hex(plaintext);
  const row  = await env.DB.prepare("SELECT * FROM api_keys WHERE key_hash = ?").bind(hash).first();
  if (!row || row.revoked_at !== null) return null;
  return { keyId: row.key_id, orgId: row.org_id };
}

/**
 * Fire-and-forget last_used_at bump. Caller wraps this in ctx.waitUntil so a
 * key's traffic never waits on the write — see requireAuth in src/auth.js.
 */
export async function touchApiKeyLastUsed(env, keyId) {
  await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE key_id = ?")
    .bind(Math.floor(Date.now() / 1000), keyId)
    .run();
}
