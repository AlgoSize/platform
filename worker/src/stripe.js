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

/** The tiers the pricing page sells, and the two billing periods. */
export const PLANS     = Object.freeze(["solo", "practice", "firm"]);
export const INTERVALS = Object.freeze(["monthly", "annual"]);

/**
 * Resolve which Stripe price(s) a requested tier bills against.
 *
 * Config is one env var per (plan × interval), plus an optional `_SEAT`
 * companion for tiers that charge a base fee plus a per-seat fee:
 *
 *   STRIPE_PRICE_SOLO_MONTHLY
 *   STRIPE_PRICE_PRACTICE_MONTHLY        base fee
 *   STRIPE_PRICE_PRACTICE_MONTHLY_SEAT   per-seat fee, quantity = seats
 *   STRIPE_PRICE_FIRM_ANNUAL             …and so on
 *
 * Returns `null` when the requested tier has no price configured. Callers MUST
 * treat that as a refusal and must not fall back to another price: the whole
 * point of resolving per-tier is that clicking "Firm — $599" can never quietly
 * charge the Solo amount. A tier that isn't wired up yet fails loudly and
 * visibly instead.
 *
 * With no `plan` at all this returns the legacy single-price config, so every
 * caller that predates tiered pricing behaves exactly as it did before.
 */
export function resolvePrice(env, { plan, interval } = {}) {
  if (!plan) {
    return env.STRIPE_PRICE_ID ? { base: env.STRIPE_PRICE_ID, seat: null, perSeat: false } : null;
  }

  const p = String(plan).toLowerCase();
  const i = String(interval || "monthly").toLowerCase();
  if (!PLANS.includes(p) || !INTERVALS.includes(i)) return null;

  const key  = `STRIPE_PRICE_${p.toUpperCase()}_${i.toUpperCase()}`;
  const base = env[key];
  if (!base) return null;

  const seat = env[`${key}_SEAT`] || null;
  return { base, seat, perSeat: !!seat };
}

/**
 * Create a Checkout Session.
 *
 * `successUrl` MUST contain the literal `{CHECKOUT_SESSION_ID}` placeholder
 * — Stripe substitutes the real session id when redirecting the user back.
 *
 * `plan`/`interval` select the tier (see resolvePrice). Omit both to bill the
 * legacy single STRIPE_PRICE_ID.
 */
export function createCheckoutSession(env, { successUrl, cancelUrl, customerEmail, quantity, orgId, plan, interval } = {}) {
  const price = resolvePrice(env, { plan, interval });
  if (!price) {
    throw new Error(
      plan
        ? `No Stripe price configured for plan "${plan}" (${interval || "monthly"}). See worker/.dev.vars.example.`
        : "STRIPE_PRICE_ID is not set. See worker/.dev.vars.example.",
    );
  }

  // Seats. This was hardcoded to "1", which is why the product could not sell
  // a team: the subscription Stripe billed for never had more than one seat on
  // it no matter what the buyer wanted. Defaults to 1 so every existing caller
  // behaves exactly as before.
  const seats = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;

  const body = {
    mode: "subscription",
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: "true",
  };

  if (price.perSeat) {
    // Base fee billed once, seats billed on their own line. A single line item
    // cannot express "$149 plus $39 a seat", and folding the base into the
    // seat price would overcharge every account past the first seat.
    body["line_items[0][price]"]    = price.base;
    body["line_items[0][quantity]"] = "1";
    body["line_items[1][price]"]    = price.seat;
    body["line_items[1][quantity]"] = String(seats);
  } else {
    body["line_items[0][price]"]    = price.base;
    body["line_items[0][quantity]"] = String(seats);
  }

  if (customerEmail) body.customer_email = customerEmail;
  if (orgId) {
    // Both locations on purpose: client_reference_id comes back on the
    // checkout session, and the metadata copy rides on the subscription so
    // later subscription.updated events can be resolved to an org without
    // guessing from the email.
    body.client_reference_id = orgId;
    body["subscription_data[metadata][org_id]"] = orgId;
  }
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
