// Magic-link email auth.
//
// Two endpoints:
//   POST /api/auth/request-link    — accept {email}, mint a one-time token,
//                                    store it in SESSIONS KV with a short TTL,
//                                    email a sign-in link to the address.
//   GET  /api/auth/verify?token=…  — validate token, find/create the user,
//                                    issue a session cookie, 302 to /dashboard/.
//
// Token storage uses the existing SESSIONS KV namespace under a `magic:`
// prefix. Tokens are single-use (deleted on verify), 15-minute TTL, and
// 32 bytes of crypto.getRandomValues entropy (base64url-encoded).
//
// The request endpoint ALWAYS returns the same 200 shape regardless of
// whether the email is already on file — never reveal which addresses have
// accounts. (Same enumeration-safe pattern Stripe / Linear / GitHub use.)

import { issueJWT, buildSessionCookie } from "../auth.js";
import { getUserByEmail, createFreeUser } from "./_users.js";
import { sendTransactional } from "../email/transactional.js";
import { magicLinkEmail } from "../email/templates.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;
const TOKEN_TTL_SEC = 15 * 60;       // 15 minutes
const TOKEN_BYTES = 32;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function base64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function newMagicToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function magicKvKey(token) {
  return `magic:${token}`;
}

// ---------------------------------------------------------------------------
// POST /api/auth/request-link  — body {email}
// ---------------------------------------------------------------------------
export async function requestMagicLinkHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch {
    return jsonResponse({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
  }

  const rawEmail = body && typeof body.email === "string" ? body.email.trim() : "";
  if (!rawEmail || rawEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(rawEmail)) {
    return jsonResponse(
      { error: "invalid_email", message: "Please provide a valid email address." },
      400,
    );
  }
  const email = rawEmail.toLowerCase();

  if (!env || !env.SESSIONS) {
    return jsonResponse(
      { error: "not_configured", message: "Sign-in service is not configured." },
      500,
    );
  }

  const token = newMagicToken();
  await env.SESSIONS.put(
    magicKvKey(token),
    JSON.stringify({ email, createdAt: Math.floor(Date.now() / 1000) }),
    { expirationTtl: TOKEN_TTL_SEC },
  );

  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  const verifyUrl = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;

  // Fire-and-forget send. Even if the address has no account, we still
  // attempt the send (an attacker probing for accounts gets the same
  // 200 + "check your inbox" copy regardless of whether mail goes out).
  const tmpl = magicLinkEmail({ email, verifyUrl, ttlMinutes: TOKEN_TTL_SEC / 60 });
  const sendPromise = sendTransactional(env, ctx, {
    to:      email,
    subject: tmpl.subject,
    text:    tmpl.text,
    html:    tmpl.html,
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(sendPromise);
  else void sendPromise;

  return jsonResponse({
    ok: true,
    message: "If that email is valid, we've sent a sign-in link. Check your inbox (and spam).",
    ttlMinutes: TOKEN_TTL_SEC / 60,
  }, 200);
}

// ---------------------------------------------------------------------------
// GET /api/auth/verify?token=…   — 302 to /dashboard/ on success
// ---------------------------------------------------------------------------
export async function verifyMagicLinkHandler(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const origin = (env && env.SITE_ORIGIN || "").replace(/\/$/, "");

  function redirect(path) {
    return new Response(null, { status: 302, headers: { Location: `${origin}${path}` } });
  }
  function redirectWithCookie(path, cookie) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${origin}${path}`, "Set-Cookie": cookie },
    });
  }

  if (!token || typeof token !== "string") {
    return redirect("/?auth=missing_token");
  }

  if (!env || !env.SESSIONS) {
    return redirect("/?auth=server_error");
  }

  const raw = await env.SESSIONS.get(magicKvKey(token));
  if (!raw) {
    return redirect("/?auth=expired_or_invalid");
  }

  // Single-use: delete the token before issuing the session so a re-used
  // link can never mint two sessions.
  await env.SESSIONS.delete(magicKvKey(token));

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return redirect("/?auth=server_error"); }

  const email = (payload && payload.email || "").toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return redirect("/?auth=server_error");
  }

  // Find existing user OR create a free one. Magic link is BOTH login and
  // signup — verifying ownership of the address is the whole gate.
  let user = await getUserByEmail(env, email);
  if (!user) {
    const created = await createFreeUser(env, { email });
    user = created.user;
  }

  const sessionToken = await issueJWT(env, user.userId, user.email, user.subStatus);
  const cookie = buildSessionCookie(env, sessionToken, {
    secure: !(env.SITE_ORIGIN || "").startsWith("http://localhost"),
  });

  return redirectWithCookie("/dashboard/", cookie);
}
