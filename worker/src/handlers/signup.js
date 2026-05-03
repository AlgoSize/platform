// POST /api/signup — email-only free-tier signup (Task #19).
//
// No password, no Stripe — just an email address. Creates a user record
// with `plan: "free"`, issues a 30-day session JWT, sets the cookie, and
// returns 200 / 201 so the dashboard JS can redirect.
//
// This is intentionally NOT a login mechanism. If the email is already
// taken — free OR paid — we return 409 instead of issuing a session for
// the existing user. Doing otherwise would let anyone claim any email and
// inherit that user's run history. A real magic-link or OAuth flow is a
// separate follow-up.
//
// Auth: this route runs WITHOUT requireAuth — that's the whole point.

import { issueJWT, buildSessionCookie } from "../auth.js";
import { createFreeUser } from "./_users.js";

// Pragmatic email regex: requires `@` with non-empty local + domain parts
// and a TLD. We're not trying to perfectly match RFC 5322 — Stripe (paid
// signup) does its own deliverability check, and free signups can be
// hardened with a verification email later (out of scope for #19).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;  // RFC 5321 path length limit

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export async function signupHandler(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
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

  const { user, alreadyExisted } = await createFreeUser(env, { email });

  if (alreadyExisted) {
    // Don't leak whether the existing record is free or paid — both get the
    // same generic "already in use" message. The marketing copy on the form
    // tells users to log in via Stripe Checkout if they're paid; we have no
    // free-user login flow yet.
    return jsonResponse(
      {
        error:   "email_taken",
        message: "An account with this email already exists. If you have a paid subscription, sign in by starting a new checkout with the same email.",
      },
      409,
    );
  }

  const token  = await issueJWT(env, user.userId, user.email, user.subStatus);
  const cookie = buildSessionCookie(env, token, {
    secure: !env.SITE_ORIGIN.startsWith("http://localhost"),
  });

  return jsonResponse(
    {
      ok:               true,
      email:            user.email,
      plan:             user.plan,
      monthlyRunsUsed:  0,
      monthlyRunsLimit: 5,
      redirectUrl:      "/dashboard/",
    },
    201,
    { "Set-Cookie": cookie },
  );
}
