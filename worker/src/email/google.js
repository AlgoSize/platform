// Gmail API transport for transactional email (Task #56).
//
// Why Gmail API and not SMTP relay?
//   Cloudflare Workers can only do HTTP/HTTPS (`fetch`). The
//   `smtp-relay.gmail.com:587` flow requires a raw TCP connection with
//   STARTTLS, which Workers don't support. Gmail API over HTTPS is the
//   only Workspace transport that runs from a Worker.
//
// The send flow:
//
//   1. Mint an RS256-signed JWT from the Workspace service-account
//      private key. Claims:
//        iss   = service-account client_email
//        sub   = workspace mailbox we impersonate (e.g. noreply@algosize.com)
//        scope = "https://www.googleapis.com/auth/gmail.send"
//        aud   = "https://oauth2.googleapis.com/token"
//        iat / exp = now / now+3600
//   2. Exchange the JWT for an OAuth access token at
//      https://oauth2.googleapis.com/token (grant_type=jwt-bearer).
//      Cache the token in-memory per isolate for token.expires_in - 60s.
//   3. POST the RFC 822 message (base64url-encoded) to
//      https://gmail.googleapis.com/gmail/v1/users/<sub>/messages/send.
//
// All network IO goes through `env.FETCH || globalThis.fetch` so tests
// can inject a fake fetch (same convention as observability.js).

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

// Per-isolate access-token cache. Keyed by client_email + sub so swapping
// the impersonated mailbox doesn't accidentally reuse a token scoped to
// a different user.
const tokenCache = new Map();

/**
 * Parse a Workspace service-account JSON blob and return only the
 * fields we need. Returns null on anything malformed (so a misconfigured
 * secret never throws upward — caller falls through to "no transport").
 */
export function parseServiceAccount(raw) {
  if (!raw || typeof raw !== "string") return null;
  let json;
  try { json = JSON.parse(raw); } catch { return null; }
  if (!json || json.type !== "service_account") return null;
  const { client_email, private_key, token_uri } = json;
  if (typeof client_email !== "string" || !client_email.includes("@")) return null;
  if (typeof private_key !== "string" || !private_key.includes("PRIVATE KEY")) return null;
  return {
    clientEmail: client_email,
    privateKeyPem: private_key,
    tokenUri: typeof token_uri === "string" ? token_uri : TOKEN_URL,
  };
}

// ---------------------------------------------------------------------------
// JWT signing — RS256 over Web Crypto
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes) {
  let s;
  if (typeof bytes === "string") {
    s = btoa(bytes);
  } else {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    s = btoa(bin);
  }
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToDer(pem) {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function importPrivateKey(pem) {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signServiceAccountJwt({ clientEmail, privateKeyPem, tokenUri }, sub) {
  const header  = { alg: "RS256", typ: "JWT" };
  const nowSec  = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   clientEmail,
    sub,
    scope: GMAIL_SCOPE,
    aud:   tokenUri,
    iat:   nowSec,
    exp:   nowSec + 3600,
  };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// Access-token exchange (with in-memory cache)
// ---------------------------------------------------------------------------

async function fetchAccessToken(serviceAccount, sub, fetchImpl) {
  const assertion = await signServiceAccountJwt(serviceAccount, sub);
  const body = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT,
    assertion,
  }).toString();
  const res = await fetchImpl(serviceAccount.tokenUri, {
    method:  "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`google_token_exchange_failed status=${res.status} body=${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json || typeof json.access_token !== "string") {
    throw new Error("google_token_exchange_invalid_response");
  }
  return {
    accessToken: json.access_token,
    expiresAt:   Date.now() + (Number(json.expires_in || 3600) * 1000),
  };
}

async function getAccessToken(serviceAccount, sub, fetchImpl) {
  const cacheKey = `${serviceAccount.clientEmail}|${sub}`;
  const cached   = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;
  const fresh = await fetchAccessToken(serviceAccount, sub, fetchImpl);
  tokenCache.set(cacheKey, fresh);
  return fresh.accessToken;
}

// Exposed for tests so they can start each run with a clean cache.
export function _resetTokenCacheForTests() { tokenCache.clear(); }

// ---------------------------------------------------------------------------
// RFC 822 message + Gmail API send
// ---------------------------------------------------------------------------

// Header values must be ASCII; non-ASCII subjects need RFC 2047 encoding
// (`=?UTF-8?B?<base64>?=`). We always encode just to be safe — Subjects with
// emojis or accents otherwise get mangled in some clients.
function encodeHeader(value) {
  const s = String(value);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=`;
}

export function buildRfc822Message({ from, to, subject, text, html, replyTo }) {
  const boundary = `algosize_${crypto.randomUUID().replace(/-/g, "")}`;
  const lines = [
    `From: ${encodeHeader(from)}`,
    `To: ${encodeHeader(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
  ];
  if (replyTo) lines.push(`Reply-To: ${encodeHeader(replyTo)}`);
  if (html && text) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("", `--${boundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 7bit", "", text);
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/html; charset=UTF-8",  "Content-Transfer-Encoding: 7bit", "", html);
    lines.push(`--${boundary}--`);
  } else if (html) {
    lines.push("Content-Type: text/html; charset=UTF-8",  "Content-Transfer-Encoding: 7bit", "", html);
  } else {
    lines.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 7bit", "", text || "");
  }
  return lines.join("\r\n");
}

function rfc822ToGmailRaw(rfc822) {
  // Gmail API expects URL-safe base64 of the raw message bytes.
  return base64UrlEncode(new TextEncoder().encode(rfc822));
}

/**
 * Send a single message via the Gmail API. Throws on any non-2xx —
 * callers in transactional.js wrap this in try/catch and route failures
 * through observability so the Worker NEVER takes a 500 because of an
 * email send.
 */
export async function sendViaGmail(env, { from, to, subject, text, html, replyTo }) {
  const raw = env && env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sub = env && env.EMAIL_DELEGATED_USER;
  if (!raw || !sub) {
    const missing = [
      !raw ? "GOOGLE_SERVICE_ACCOUNT_JSON" : null,
      !sub ? "EMAIL_DELEGATED_USER" : null,
    ].filter(Boolean).join(", ");
    throw new Error(`google_email_not_configured missing=${missing}`);
  }
  const serviceAccount = parseServiceAccount(raw);
  if (!serviceAccount) {
    throw new Error("google_email_invalid_service_account_json");
  }
  const fetchImpl = (env && env.FETCH) || globalThis.fetch;
  const accessToken = await getAccessToken(serviceAccount, sub, fetchImpl);

  const rfc822 = buildRfc822Message({ from, to, subject, text, html, replyTo });
  const url    = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(sub)}/messages/send`;
  const res    = await fetchImpl(url, {
    method:  "POST",
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw: rfc822ToGmailRaw(rfc822) }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    // 401 likely means the access token expired between our fetch and
    // gmail's read — bust the cache so the next send mints a fresh one.
    if (res.status === 401) tokenCache.delete(`${serviceAccount.clientEmail}|${sub}`);
    throw new Error(`gmail_send_failed status=${res.status} body=${detail.slice(0, 200)}`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* gmail always returns JSON, but be defensive */ }
  return {
    sent:      true,
    messageId: body && body.id || null,
  };
}
