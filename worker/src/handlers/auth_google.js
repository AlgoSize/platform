// Google OAuth 2.0 sign-in (second auth option alongside magic-link).
//
// Two endpoints:
//   GET /api/auth/google/start     — generate CSRF state, redirect to Google consent
//   GET /api/auth/google/callback  — exchange code, verify email, issue session
//
// Why no SDK: the Worker runtime is Web-Fetch + Web-Crypto only, so we hit
// Google's REST endpoints directly with `fetch`. This is the same pattern
// used by the existing Stripe integration in this codebase.
//
// Email validation: Google returns `email_verified: true` only for addresses
// the account owner has actually proven control of. We REQUIRE this — an
// unverified Google email never mints a session.
//
// State CSRF: a random 32-byte token is stored in SESSIONS KV under
// `gstate:<state>` with a 10-minute TTL. The callback deletes the row
// before issuing the session, so a single state can never be redeemed
// twice (matches the magic-link single-use pattern).

import { issueJWT, buildSessionCookie } from "../auth.js";
import { getUserByEmail, createFreeUser } from "./_users.js";

const STATE_TTL_SEC = 10 * 60;        // 10 minutes
const STATE_BYTES   = 32;
const SCOPES        = "openid email profile";

const AUTH_URL     = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL    = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function base64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function newState() {
  const bytes = new Uint8Array(STATE_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function stateKvKey(state) {
  return `gstate:${state}`;
}

function redirectUri(env) {
  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  return `${origin}/api/auth/google/callback`;
}

function isOauthConfigured(env) {
  return env && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET;
}

function redirectTo(url) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

function siteRedirect(env, path) {
  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  return redirectTo(`${origin}${path}`);
}

function siteRedirectWithCookie(env, path, cookie) {
  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}${path}`, "Set-Cookie": cookie },
  });
}

// ---------------------------------------------------------------------------
// GET /api/auth/google/start
// ---------------------------------------------------------------------------
export async function googleStartHandler(request, env) {
  if (!isOauthConfigured(env)) {
    return siteRedirect(env, "/?auth=google_not_configured");
  }
  if (!env.SESSIONS) {
    return siteRedirect(env, "/?auth=server_error");
  }

  const state = newState();
  await env.SESSIONS.put(
    stateKvKey(state),
    JSON.stringify({ createdAt: Math.floor(Date.now() / 1000) }),
    { expirationTtl: STATE_TTL_SEC },
  );

  const params = new URLSearchParams({
    client_id:     env.GOOGLE_CLIENT_ID,
    redirect_uri:  redirectUri(env),
    response_type: "code",
    scope:         SCOPES,
    state,
    access_type:   "online",
    prompt:        "select_account",
    include_granted_scopes: "true",
  });
  return redirectTo(`${AUTH_URL}?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// GET /api/auth/google/callback?code=…&state=…
// ---------------------------------------------------------------------------
export async function googleCallbackHandler(request, env) {
  const url = new URL(request.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    // User declined consent on Google's side, or Google rejected the request.
    return siteRedirect(env, `/?auth=google_${encodeURIComponent(errorParam)}`);
  }
  if (!code || !state) {
    return siteRedirect(env, "/?auth=missing_code");
  }
  if (!isOauthConfigured(env)) {
    return siteRedirect(env, "/?auth=google_not_configured");
  }
  if (!env.SESSIONS) {
    return siteRedirect(env, "/?auth=server_error");
  }

  // Validate + consume state (single-use, CSRF gate).
  const stateRaw = await env.SESSIONS.get(stateKvKey(state));
  if (!stateRaw) {
    return siteRedirect(env, "/?auth=expired_or_invalid");
  }
  await env.SESSIONS.delete(stateKvKey(state));

  // Exchange auth code for an access token.
  let tokenJson;
  try {
    const body = new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri(env),
      grant_type:    "authorization_code",
    });
    const tokenRes = await fetch(TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });
    if (!tokenRes.ok) {
      console.error("google token exchange failed", tokenRes.status, await tokenRes.text());
      return siteRedirect(env, "/?auth=google_token_failed");
    }
    tokenJson = await tokenRes.json();
  } catch (err) {
    console.error("google token exchange error", err);
    return siteRedirect(env, "/?auth=server_error");
  }

  const accessToken = tokenJson && tokenJson.access_token;
  if (!accessToken) {
    return siteRedirect(env, "/?auth=google_token_failed");
  }

  // Fetch user profile (email + email_verified).
  let profile;
  try {
    const profRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profRes.ok) {
      console.error("google userinfo failed", profRes.status, await profRes.text());
      return siteRedirect(env, "/?auth=google_userinfo_failed");
    }
    profile = await profRes.json();
  } catch (err) {
    console.error("google userinfo error", err);
    return siteRedirect(env, "/?auth=server_error");
  }

  const email = (profile && profile.email || "").toLowerCase();
  const emailVerified = profile && profile.email_verified === true;

  if (!email) {
    return siteRedirect(env, "/?auth=google_no_email");
  }
  if (!emailVerified) {
    // Hard-block: the whole point is that Google has verified ownership.
    return siteRedirect(env, "/?auth=email_not_verified");
  }

  // Find or create the user, issue the session cookie, send to dashboard.
  let user = await getUserByEmail(env, email);
  if (!user) {
    const created = await createFreeUser(env, { email });
    user = created.user;
  }

  const sessionToken = await issueJWT(env, user.userId, user.email, user.subStatus);
  const cookie = buildSessionCookie(env, sessionToken, {
    secure: !(env.SITE_ORIGIN || "").startsWith("http://localhost"),
  });
  return siteRedirectWithCookie(env, "/dashboard/", cookie);
}
