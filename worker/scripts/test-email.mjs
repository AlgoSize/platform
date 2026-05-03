// Tests for the transactional-email module (Task #56).
//
// Run with:  node scripts/test-email.mjs
//
// Coverage:
//   - parseServiceAccount accepts a well-formed JSON, rejects garbage
//   - buildRfc822Message produces correct multipart/alternative output
//     with both text + html, and a flat text/plain otherwise
//   - sendViaGmail signs a real RS256 JWT, exchanges for an access
//     token, and POSTs the right Gmail send URL with a Bearer token.
//     Uses a real RSA keypair generated at test time — Workers and
//     Node both expose the same Web Crypto SubtleCrypto API.
//   - sendTransactional returns {sent:false, reason:"not_configured"}
//     when GOOGLE_SERVICE_ACCOUNT_JSON / EMAIL_FROM are missing, and
//     captureMessage is called instead of captureException (warn, not
//     error — operator-visible but not Sentry-spam).
//   - sendTransactional routes Gmail-API failures through
//     captureException so on-call sees them.
//   - sendTransactional validates input (recipient / subject / text)
//     and never throws upward.

import {
  parseServiceAccount,
  buildRfc822Message,
  sendViaGmail,
  _resetTokenCacheForTests,
} from "../src/email/google.js";
import { sendTransactional } from "../src/email/transactional.js";
import { welcomeFreeSignup } from "../src/email/templates.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

// ---------------------------------------------------------------------------
// Helpers — fake fetch, ctx, console silencer, real RSA service account
// ---------------------------------------------------------------------------

function makeFetchMock(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const { match, response } of handlers) {
      if (match(String(url))) return await response(init, calls.length);
    }
    return { ok: false, status: 404, async json() { return {}; }, async text() { return "no mock"; } };
  };
  return { fetchImpl, calls };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function makeCtx() {
  const promises = [];
  return { waitUntil: (p) => promises.push(Promise.resolve(p)), _promises: promises };
}

function silenceConsole() {
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  const lines = [];
  console.log   = (...a) => lines.push({ ch: "log",   args: a });
  console.error = (...a) => lines.push({ ch: "error", args: a });
  console.warn  = (...a) => lines.push({ ch: "warn",  args: a });
  return { lines, restore() { console.log = origLog; console.error = origErr; console.warn = origWarn; } };
}

// Generate a real RSA-2048 keypair via Web Crypto and serialize the
// private key to PEM (PKCS8) so the module's importPrivateKey path
// runs end-to-end on the same code production will execute.
async function generateServiceAccountJson() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const b64   = Buffer.from(new Uint8Array(pkcs8)).toString("base64");
  // Wrap to 64 chars/line — matches Google's actual format.
  const wrapped = b64.match(/.{1,64}/g).join("\n");
  const pem     = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
  return {
    json: JSON.stringify({
      type: "service_account",
      project_id: "algosize-test",
      private_key_id: "abc",
      private_key: pem,
      client_email: "algosize-mailer@algosize-test.iam.gserviceaccount.com",
      client_id: "1234",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    publicKey,
  };
}

// ---------------------------------------------------------------------------
console.log("\nemail/google — parseServiceAccount\n");
// ---------------------------------------------------------------------------
{
  expect(parseServiceAccount(null) === null,        "null → null");
  expect(parseServiceAccount("") === null,          "empty → null");
  expect(parseServiceAccount("not json") === null,  "garbage → null");
  expect(parseServiceAccount(JSON.stringify({ type: "user" })) === null, "wrong type → null");
  expect(parseServiceAccount(JSON.stringify({ type: "service_account", client_email: "x" })) === null,
    "missing private_key → null");

  const good = parseServiceAccount(JSON.stringify({
    type: "service_account",
    client_email: "a@b.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  }));
  expect(good && good.clientEmail === "a@b.iam.gserviceaccount.com", "extracts clientEmail");
  expect(good && good.tokenUri === "https://oauth2.googleapis.com/token", "defaults tokenUri");
}

// ---------------------------------------------------------------------------
console.log("\nemail/google — buildRfc822Message\n");
// ---------------------------------------------------------------------------
{
  const both = buildRfc822Message({
    from: "Algosize <noreply@algosize.com>",
    to:   "user@example.com",
    subject: "Hello",
    text: "plain body",
    html: "<p>html body</p>",
  });
  expect(both.includes("From: Algosize <noreply@algosize.com>"), "From header");
  expect(both.includes("To: user@example.com"),                   "To header");
  expect(both.includes("Subject: Hello"),                         "Subject header");
  expect(both.includes("multipart/alternative; boundary="),       "multipart for text+html");
  expect(both.includes("text/plain; charset=UTF-8"),              "text/plain part");
  expect(both.includes("text/html; charset=UTF-8"),               "text/html part");
  expect(both.includes("plain body") && both.includes("<p>html body</p>"), "both bodies present");
  expect(both.split("\r\n").length > 5, "uses CRLF line endings");

  const textOnly = buildRfc822Message({
    from: "a@b", to: "c@d", subject: "x", text: "just text",
  });
  expect(!textOnly.includes("multipart/alternative"), "no multipart when only text");
  expect(textOnly.includes("Content-Type: text/plain; charset=UTF-8"), "single text/plain header");

  const utf8 = buildRfc822Message({ from: "a@b", to: "c@d", subject: "Café — 5/月", text: "x" });
  expect(/Subject: =\?UTF-8\?B\?/.test(utf8), "non-ASCII subject is RFC 2047 encoded");
}

// ---------------------------------------------------------------------------
console.log("\nemail/google — sendViaGmail signs JWT, exchanges, sends\n");
// ---------------------------------------------------------------------------
{
  _resetTokenCacheForTests();
  const { json } = await generateServiceAccountJson();

  const handlers = [
    {
      match: (url) => url.includes("oauth2.googleapis.com/token"),
      response: async (init) => {
        const params = new URLSearchParams(init.body);
        const ok1 = params.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer";
        const assertion = params.get("assertion") || "";
        const parts = assertion.split(".");
        const ok2 = parts.length === 3 && parts[0] && parts[1] && parts[2];
        // Validate payload claims.
        const pad = (s) => s + "=".repeat((4 - (s.length % 4)) % 4);
        const decode = (s) => JSON.parse(Buffer.from(pad(s.replace(/-/g, "+").replace(/_/g, "/")), "base64").toString("utf8"));
        let header, payload;
        try { header = decode(parts[0]); payload = decode(parts[1]); } catch { /* */ }
        const ok3 = header && header.alg === "RS256";
        const ok4 = payload && payload.iss === "algosize-mailer@algosize-test.iam.gserviceaccount.com"
                       && payload.sub === "noreply@algosize.com"
                       && payload.scope === "https://www.googleapis.com/auth/gmail.send"
                       && payload.aud === "https://oauth2.googleapis.com/token";
        if (!(ok1 && ok2 && ok3 && ok4)) return jsonResponse({ error: "bad request" }, 400);
        return jsonResponse({ access_token: "ya29.fake-token", expires_in: 3600, token_type: "Bearer" });
      },
    },
    {
      match: (url) => url.includes("gmail.googleapis.com"),
      response: async (init) => {
        const auth = init.headers && init.headers.authorization;
        if (auth !== "Bearer ya29.fake-token") return jsonResponse({ error: "unauth" }, 401);
        const body = JSON.parse(init.body);
        if (typeof body.raw !== "string" || body.raw.length < 32) return jsonResponse({ error: "bad raw" }, 400);
        return jsonResponse({ id: "msg-12345", threadId: "thr-67890", labelIds: ["SENT"] });
      },
    },
  ];

  const { fetchImpl, calls } = makeFetchMock(handlers);
  const env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: json,
    EMAIL_DELEGATED_USER: "noreply@algosize.com",
    FETCH: fetchImpl,
  };
  const result = await sendViaGmail(env, {
    from: "Algosize <noreply@algosize.com>",
    to:   "user@example.com",
    subject: "Hi", text: "Hello", html: "<p>Hello</p>",
  });
  expect(result.sent === true,             "returned sent: true");
  expect(result.messageId === "msg-12345", "returned the gmail message id");
  expect(calls.length === 2,               "exactly two fetches (token + send)");
  expect(calls[0].url.includes("oauth2.googleapis.com"), "first fetch is token endpoint");
  expect(calls[1].url.includes("/users/noreply%40algosize.com/messages/send"), "send URL embeds delegated user");

  // Token cache hit on the second send (should NOT mint a new JWT).
  const r2 = await sendViaGmail(env, { from: "a", to: "b@c", subject: "s", text: "t" });
  expect(r2.sent === true, "second send still succeeds");
  expect(calls.length === 3, "second send only did 1 extra fetch (cache hit on token)");
}

// ---------------------------------------------------------------------------
console.log("\nemail/google — sendViaGmail surfaces 401 and busts cache\n");
// ---------------------------------------------------------------------------
{
  _resetTokenCacheForTests();
  const { json } = await generateServiceAccountJson();
  let callIdx = 0;
  const fetchImpl = async (url) => {
    callIdx++;
    if (String(url).includes("oauth2.googleapis.com")) {
      return jsonResponse({ access_token: `tok-${callIdx}`, expires_in: 3600, token_type: "Bearer" });
    }
    return jsonResponse({ error: "expired" }, 401);
  };
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: json, EMAIL_DELEGATED_USER: "noreply@algosize.com", FETCH: fetchImpl };
  let threw = false;
  try { await sendViaGmail(env, { from: "a", to: "b@c", subject: "s", text: "t" }); }
  catch (err) { threw = err instanceof Error && /gmail_send_failed status=401/.test(err.message); }
  expect(threw, "throws structured error on 401");
  // Next attempt should mint a NEW token (cache busted on 401).
  let mintedAgain = false;
  const fetchImpl2 = async (url) => {
    if (String(url).includes("oauth2.googleapis.com")) { mintedAgain = true; return jsonResponse({ access_token: "tok2", expires_in: 3600 }); }
    return jsonResponse({ id: "ok" });
  };
  env.FETCH = fetchImpl2;
  await sendViaGmail(env, { from: "a", to: "b@c", subject: "s", text: "t" });
  expect(mintedAgain, "401 invalidated the cached token");
}

// ---------------------------------------------------------------------------
console.log("\nemail/transactional — not_configured paths\n");
// ---------------------------------------------------------------------------
{
  const cap = silenceConsole();
  const ctx = makeCtx();
  const r1 = await sendTransactional({}, ctx, { to: "u@example.com", subject: "x", text: "y" });
  const r2 = await sendTransactional({ EMAIL_FROM: "a@b.com" }, ctx, { to: "u@example.com", subject: "x", text: "y" });
  const warnLines = cap.lines.filter((l) => l.ch === "warn" || l.ch === "log");
  cap.restore();
  expect(r1.sent === false && r1.reason === "not_configured", "missing EMAIL_FROM → not_configured");
  expect(r2.sent === false && r2.reason === "not_configured", "missing service account → not_configured");
  expect(warnLines.length >= 2, "logged warning lines (no Sentry error spam)");
}

// ---------------------------------------------------------------------------
console.log("\nemail/transactional — input validation\n");
// ---------------------------------------------------------------------------
{
  const cap = silenceConsole();
  const ctx = makeCtx();
  const env = { EMAIL_FROM: "a@b.com", GOOGLE_SERVICE_ACCOUNT_JSON: "{}", EMAIL_DELEGATED_USER: "x@y.com" };
  const r1 = await sendTransactional(env, ctx, { to: "not-an-email", subject: "x", text: "y" });
  const r2 = await sendTransactional(env, ctx, { to: "a@b.com", subject: "  ", text: "y" });
  const r3 = await sendTransactional(env, ctx, { to: "a@b.com", subject: "x", text: "" });
  cap.restore();
  expect(r1.reason === "invalid_recipient", "rejects bad recipient");
  expect(r2.reason === "missing_subject",   "rejects empty subject");
  expect(r3.reason === "missing_text",      "rejects empty text body");
}

// ---------------------------------------------------------------------------
console.log("\nemail/transactional — Gmail failures captured to Sentry\n");
// ---------------------------------------------------------------------------
{
  _resetTokenCacheForTests();
  const { json } = await generateServiceAccountJson();
  const cap = silenceConsole();
  const ctx = makeCtx();
  const fetchImpl = async (url) => {
    if (String(url).includes("oauth2.googleapis.com")) return jsonResponse({ access_token: "t", expires_in: 3600 });
    return jsonResponse({ error: { code: 500, message: "backend boom" } }, 500);
  };
  const env = {
    EMAIL_FROM: "Algosize <noreply@algosize.com>",
    GOOGLE_SERVICE_ACCOUNT_JSON: json,
    EMAIL_DELEGATED_USER: "noreply@algosize.com",
    FETCH: fetchImpl,
  };
  const r = await sendTransactional(env, ctx, { to: "u@example.com", subject: "Hi", text: "body" });
  const errLines = cap.lines.filter((l) => l.ch === "error");
  cap.restore();
  expect(r.sent === false && r.reason === "send_failed", "Gmail 500 → send_failed");
  expect(errLines.length >= 1, "captureException emitted a structured error log");
  const flat = errLines.map((l) => String(l.args[0])).join("\n");
  expect(flat.includes("email_transactional"), "tagged source=email_transactional");
  expect(!flat.includes("u@example.com"),       "redacted local-part of recipient");
}

// ---------------------------------------------------------------------------
console.log("\nemail/transactional — happy path with welcome template\n");
// ---------------------------------------------------------------------------
{
  _resetTokenCacheForTests();
  const { json } = await generateServiceAccountJson();
  let sentBodyRaw = null;
  const fetchImpl = async (url, init) => {
    if (String(url).includes("oauth2.googleapis.com")) return jsonResponse({ access_token: "t", expires_in: 3600 });
    sentBodyRaw = JSON.parse(init.body).raw;
    return jsonResponse({ id: "msg-1" });
  };
  const env = {
    EMAIL_FROM: "Algosize <noreply@algosize.com>",
    GOOGLE_SERVICE_ACCOUNT_JSON: json,
    EMAIL_DELEGATED_USER: "noreply@algosize.com",
    FETCH: fetchImpl,
  };
  const cap = silenceConsole();
  const ctx = makeCtx();
  const tpl = welcomeFreeSignup({ email: "alice@example.com" });
  const r = await sendTransactional(env, ctx, { to: "alice@example.com", ...tpl });
  cap.restore();
  expect(r.sent === true && r.messageId === "msg-1", "welcome send succeeded");
  const padded = sentBodyRaw + "=".repeat((4 - sentBodyRaw.length % 4) % 4);
  const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  expect(decoded.includes("To: alice@example.com"), "RFC 822 To matches recipient");
  expect(/Welcome to Algosize|=\?UTF-8\?B\?/.test(decoded), "RFC 822 carries template subject (encoded or plain)");
  expect(decoded.includes("dashboard"),             "RFC 822 includes dashboard link");
  expect(decoded.includes("multipart/alternative"), "RFC 822 multipart for text+html");
}

// ---------------------------------------------------------------------------
console.log("\nemail/transactional — never throws upward\n");
// ---------------------------------------------------------------------------
{
  // Even with a fetch that explicitly throws, sendTransactional must
  // resolve to {sent:false, reason:"send_failed"} — handlers fire-and-
  // forget via ctx.waitUntil and a thrown promise would propagate to
  // the runtime as an unhandled rejection.
  _resetTokenCacheForTests();
  const { json } = await generateServiceAccountJson();
  const fetchImpl = async () => { throw new Error("network exploded"); };
  const env = { EMAIL_FROM: "a@b.com", GOOGLE_SERVICE_ACCOUNT_JSON: json, EMAIL_DELEGATED_USER: "x@y.com", FETCH: fetchImpl };
  const cap = silenceConsole();
  const r = await sendTransactional(env, makeCtx(), { to: "u@example.com", subject: "Hi", text: "body" });
  cap.restore();
  expect(r.sent === false && r.reason === "send_failed", "network throw → send_failed (not exception)");
}

// ---------------------------------------------------------------------------
console.log("");
if (failures > 0) {
  console.log(`\x1b[31m${failures} test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mall email tests passed\x1b[0m");
