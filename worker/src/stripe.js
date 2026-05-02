// Stripe REST API client + webhook signature verification.
//
// Uses fetch + Web Crypto only — no node-stripe SDK (workers can't run it).
// All calls hit https://api.stripe.com/v1/* with `Authorization: Bearer
// <STRIPE_SECRET_KEY>`. Bodies are application/x-www-form-urlencoded as
// Stripe's REST API expects.

const STRIPE_API = "https://api.stripe.com/v1";

// Default tolerance for webhook timestamps, matching stripe-node's default.
const DEFAULT_WEBHOOK_TOLERANCE_SEC = 5 * 60;

// ---------------------------------------------------------------------------
// Form-encoded body builder. Stripe wants nested params as
// `line_items[0][price]=...` etc. Recurses arrays + objects.
// ---------------------------------------------------------------------------
function appendFormParams(params, key, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => appendFormParams(params, `${key}[${i}]`, v));
  } else if (typeof value === "object") {
    for (const k of Object.keys(value)) {
      appendFormParams(params, `${key}[${k}]`, value[k]);
    }
  } else {
    params.append(key, String(value));
  }
}

export function buildFormBody(obj) {
  const params = new URLSearchParams();
  for (const k of Object.keys(obj)) appendFormParams(params, k, obj[k]);
  return params.toString();
}

// ---------------------------------------------------------------------------
// Generic Stripe API call. Throws StripeError on non-2xx.
// ---------------------------------------------------------------------------
export class StripeError extends Error {
  constructor(status, body) {
    super(`Stripe API ${status}: ${body?.error?.message || JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export async function stripeFetch(env, path, { method = "POST", body, idempotencyKey } = {}) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set. See worker/.dev.vars.example.");
  }
  const headers = {
    "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": "2024-06-20",
  };
  let init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = typeof body === "string" ? body : buildFormBody(body);
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`${STRIPE_API}${path}`, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(res.status, json);
  return json;
}

// ---------------------------------------------------------------------------
// Checkout session helpers
// ---------------------------------------------------------------------------

/**
 * Create a Checkout Session for the monthly subscription plan.
 * `successUrl` MUST contain the literal `{CHECKOUT_SESSION_ID}` placeholder
 * — Stripe substitutes the real session id when redirecting the user back.
 */
export function createCheckoutSession(env, { successUrl, cancelUrl, customerEmail }) {
  if (!env.STRIPE_PRICE_ID) {
    throw new Error("STRIPE_PRICE_ID is not set. See worker/.dev.vars.example.");
  }
  const body = {
    mode: "subscription",
    "line_items[0][price]": env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: "true",
  };
  if (customerEmail) body.customer_email = customerEmail;
  return stripeFetch(env, "/checkout/sessions", { method: "POST", body });
}

/** Retrieve a Checkout Session, used by the success_url handler. */
export function retrieveCheckoutSession(env, id) {
  return stripeFetch(env, `/checkout/sessions/${encodeURIComponent(id)}`, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Web Crypto HMAC-SHA256).
//
// Stripe's `Stripe-Signature` header looks like:
//   t=1639492800,v1=abc123...,v1=def456...,v0=...
// We HMAC the string `${t}.${rawBody}` with the webhook secret and compare
// against any v1 entry using a timing-safe equality check.
// ---------------------------------------------------------------------------

function parseSignatureHeader(header) {
  if (typeof header !== "string" || !header) return null;
  const out = { t: null, v1: [] };
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") out.t = v;
    else if (k === "v1") out.v1.push(v);
  }
  if (!out.t || out.v1.length === 0) return null;
  return out;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToHex(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function hmacSha256Hex(secret, signedPayload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  return bytesToHex(sig);
}

/**
 * Verify a Stripe webhook signature.
 * - rawBody  : exact request body string Stripe sent (DO NOT re-stringify JSON).
 * - header   : value of the `Stripe-Signature` header.
 * - secret   : env.STRIPE_WEBHOOK_SECRET.
 * - now      : seconds since epoch (overridable for tests). Default = real time.
 * - tolerance: max allowed |now - t| in seconds. Default = 5 min.
 *
 * Returns { ok: true } on success or { ok: false, reason } on failure.
 */
export async function verifyStripeSignature(rawBody, header, secret, {
  now = Math.floor(Date.now() / 1000),
  tolerance = DEFAULT_WEBHOOK_TOLERANCE_SEC,
} = {}) {
  if (!secret) return { ok: false, reason: "no_secret_configured" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "missing_or_malformed_header" };

  const t = parseInt(parsed.t, 10);
  if (!Number.isFinite(t)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: "timestamp_outside_tolerance" };

  const expected = await hmacSha256Hex(secret, `${parsed.t}.${rawBody}`);
  for (const v1 of parsed.v1) {
    if (timingSafeEqualHex(v1, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature_mismatch" };
}

/** Test-only helper: build a valid Stripe-Signature header for a body. */
export async function buildSignatureHeader(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return `t=${t},v1=${sig}`;
}
