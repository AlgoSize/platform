// Legacy email-only free-tier signup (Task #19).
//
// NOT ROUTED in production any more — the public `/api/signup` endpoint
// was removed when magic-link auth shipped (see handlers/auth_magic.js).
// Issuing a session without verifying email ownership let anyone claim
// any address and inherit its run history.
//
// The handler is kept (un-routed) because `worker/scripts/test-quota.mjs`
// uses it to fast-create authenticated free users for the quota tests
// without going through the two-step magic-link flow. If the quota tests
// are ever migrated to call the real auth pipeline, this file can be
// deleted outright.

import { issueJWT, buildSessionCookie } from "../auth.js";
import { createFreeUser } from "./_users.js";
import { sendTransactional } from "../email/transactional.js";
import { welcomeFreeSignup } from "../email/templates.js";

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

export async function signupHandler(request, env, ctx) {
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

  // Fire-and-forget welcome email (Task #56). The HTTP response below
  // MUST NOT wait on Gmail — a Workspace outage cannot block signups —
  // so the send rides on ctx.waitUntil and any failure is captured by
  // sendTransactional itself via the observability pipe.
  const welcome = welcomeFreeSignup({ email: user.email });
  const emailPromise = sendTransactional(env, ctx, {
    to:      user.email,
    subject: welcome.subject,
    text:    welcome.text,
    html:    welcome.html,
  });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(emailPromise);
  } else {
    void emailPromise;   // dev / test path with no ExecutionContext
  }

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
