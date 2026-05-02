// JWT (HS256) issuance/verification + requireAuth middleware.
//
// Tokens are signed with env.JWT_SECRET and ALSO stored in the SESSIONS KV
// namespace with a 30-day TTL. Storing in KV gives us:
//   1. server-side revocation (delete the KV row → token is dead),
//   2. a place to attach session metadata that shouldn't live in the JWT.
//
// requireAuth resolves the token from either an `Authorization: Bearer <jwt>`
// header or a `<COOKIE_NAME>=<jwt>` cookie. Tampered or expired tokens are
// rejected with 401.

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;  // 30 days
const ALG = "HS256";
const TYP = "JWT";

// ---------------------------------------------------------------------------
// base64url helpers (Web Crypto returns ArrayBuffer; JWT spec is base64url
// without padding)
// ---------------------------------------------------------------------------

function base64UrlEncodeBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlEncodeString(str) {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function base64UrlDecodeToBytes(input) {
  const pad = input.length % 4;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + (pad ? "=".repeat(4 - pad) : "");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeToString(input) {
  return new TextDecoder().decode(base64UrlDecodeToBytes(input));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// ---------------------------------------------------------------------------
// Pure JWT primitives — no KV access. Useful for tests.
// ---------------------------------------------------------------------------

/**
 * Sign a JWT with the given payload and secret. Adds `iat` and `exp` if not
 * provided. Returns the compact JWS string.
 */
export async function signJWT(payload, secret, ttlSeconds = SESSION_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    iat: now,
    exp: now + ttlSeconds,
    ...payload,
  };
  const headerSeg  = base64UrlEncodeString(JSON.stringify({ alg: ALG, typ: TYP }));
  const payloadSeg = base64UrlEncodeString(JSON.stringify(fullPayload));
  const signingInput = `${headerSeg}.${payloadSeg}`;

  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const sigSeg = base64UrlEncodeBytes(new Uint8Array(sigBuf));

  return `${signingInput}.${sigSeg}`;
}

/**
 * Verify a JWT. Returns the decoded payload on success. Returns null if the
 * token is malformed, has a bad signature, or is expired.
 */
export async function verifyJWT(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;

  // Header sanity
  let header;
  try {
    header = JSON.parse(base64UrlDecodeToString(headerSeg));
  } catch {
    return null;
  }
  if (header.alg !== ALG || header.typ !== TYP) return null;

  // Re-sign and timing-safe compare
  const key = await hmacKey(secret);
  const expectedBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
  );
  const expectedSeg = base64UrlEncodeBytes(new Uint8Array(expectedBuf));
  if (!timingSafeEqual(sigSeg, expectedSeg)) return null;

  // Payload + expiry
  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadSeg));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return null;

  return payload;
}

// ---------------------------------------------------------------------------
// Issue + Revoke (these touch KV)
// ---------------------------------------------------------------------------

// Minimum JWT signing secret length, in characters. HS256 wants at least the
// hash output size (32 bytes). We require 32+ characters of secret material.
const MIN_JWT_SECRET_LEN = 32;

function requireSecret(env) {
  if (!env || typeof env.JWT_SECRET !== "string" || env.JWT_SECRET.length < MIN_JWT_SECRET_LEN) {
    throw new Error(
      `JWT_SECRET is missing or too short (need >= ${MIN_JWT_SECRET_LEN} chars). ` +
      "Set it in worker/.dev.vars (local) or `wrangler secret put JWT_SECRET` (production).",
    );
  }
}

/**
 * Issue a session JWT for a user, store it in SESSIONS KV with a 30-day TTL,
 * and return the token. Callers (e.g. the Stripe webhook in Task #4) decide
 * whether to put the token in a cookie, send it back as JSON, or both.
 */
export async function issueJWT(env, userId, email, subStatus) {
  requireSecret(env);
  const token = await signJWT(
    { sub: userId, email, subStatus },
    env.JWT_SECRET,
    SESSION_TTL_SECONDS,
  );
  // Store the token itself as the KV key. Value carries the user identity so
  // requireAuth can return it without re-decoding.
  await env.SESSIONS.put(
    `sess:${token}`,
    JSON.stringify({ userId, email, subStatus, iat: Math.floor(Date.now() / 1000) }),
    { expirationTtl: SESSION_TTL_SECONDS },
  );
  return token;
}

/** Revoke a session by deleting it from KV. */
export async function revokeJWT(env, token) {
  await env.SESSIONS.delete(`sess:${token}`);
}

// ---------------------------------------------------------------------------
// Cookie helper + requireAuth middleware
// ---------------------------------------------------------------------------

function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

function readBearer(request) {
  const h = request.headers.get("Authorization") || "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim() || null;
}

/**
 * Build a Set-Cookie header string for a session token.
 * 30-day Max-Age, HttpOnly, SameSite=Lax, Secure when not localhost.
 */
export function buildSessionCookie(env, token, { secure = true } = {}) {
  const parts = [
    `${env.COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearSessionCookie(env) {
  return [
    `${env.COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

/**
 * requireAuth — itty-router middleware.
 *
 * Resolves token from `Authorization: Bearer ...` header first, then cookie.
 * Verifies the JWT, then double-checks SESSIONS KV (so revoked tokens fail
 * even if not yet expired). On success, attaches `request.user = { userId,
 * email, subStatus }` and returns undefined so routing continues. On failure,
 * returns a 401 Response and short-circuits the route.
 */
export async function requireAuth(request, env) {
  requireSecret(env);
  const token = readBearer(request) || readCookie(request, env.COOKIE_NAME);
  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized", reason: "missing_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) {
    return new Response(JSON.stringify({ error: "unauthorized", reason: "invalid_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const sessionRaw = await env.SESSIONS.get(`sess:${token}`);
  if (!sessionRaw) {
    return new Response(JSON.stringify({ error: "unauthorized", reason: "session_revoked" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const session = JSON.parse(sessionRaw);
  request.user = {
    userId: session.userId ?? payload.sub,
    email:  session.email  ?? payload.email,
    subStatus: session.subStatus ?? payload.subStatus,
  };
  request.token = token;
  // returning undefined → itty-router proceeds to the next handler
}
