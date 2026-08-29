// OAuth 2.1 for MCP clients that cannot take a pasted API key.
//
// Claude.ai's remote connectors are the reason this exists: the user clicks
// "connect", the host discovers this server from the WWW-Authenticate header,
// registers itself, and runs an authorization-code flow with PKCE. No key ever
// appears in a config file.
//
// OAuth 2.1, not 2.0. The differences that matter here are all removals:
// no implicit grant, no password grant, PKCE mandatory, and exact redirect-URI
// matching. Every one of them closes a hole that 2.0 left open, so none of
// them is configurable.
//
// The security decisions, stated once:
//
//   • S256 only. `plain` makes the verifier and the challenge the same string,
//     which means an intercepted code is directly redeemable — it is not a
//     challenge at all. A client asking for `plain` is refused, not downgraded.
//   • Exact redirect_uri match. No prefix matching, no wildcards. Prefix
//     matching is how an attacker registers `https://good.example/cb` and
//     redeems at `https://good.example/cb.attacker.example`.
//   • Codes are single-use, and a REPLAY revokes the whole token chain. A
//     second use means either a broken client or a stolen code, and the safe
//     reading is theft: the legitimate user re-authorises in seconds, whereas
//     an attacker holding a live chain is unbounded.
//   • Only sha256(secret) is ever stored — for client secrets, codes and
//     tokens alike, exactly as handlers/_api_keys.js does with API keys.

import {
  SCOPES, ALL_SCOPES, SCOPE_DESCRIPTIONS, normalizeScope, sha256Hex, generateToken,
  issueTokenPair, resolveRefreshToken, revokeToken, revokeTokenChain, MCP_TOKEN_TAG,
} from "./tokens.js";
import { issuerFor } from "./metadata.js";
import { requireAuth } from "../auth.js";
import { auditFromRequest } from "../audit.js";
import { MCP_AUDIT_ACTIONS } from "./tokens.js";

// Ten minutes. The spec says codes should be short-lived and single-use; ten
// minutes is long enough for a human to read a consent screen and slow enough
// that a code scraped from a log or a referrer is usually already dead.
const CODE_TTL_SECONDS = 600;

const MAX_REDIRECT_URIS = 10;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });
}

function oauthError(error, description, status = 400) {
  // RFC 6749 §5.2 shape. Clients parse `error` programmatically and show
  // `error_description` to a human, so both are always present.
  return json({ error, error_description: description }, status);
}

// ---------------------------------------------------------------------------
// Redirect URI validation
// ---------------------------------------------------------------------------

/**
 * Is this a redirect target we are willing to send an authorization code to?
 *
 * https anywhere, or http on loopback only. Loopback is carved out because a
 * native client has nowhere else to listen and the traffic never leaves the
 * machine; http to any other host would put a code on the wire in clear.
 *
 * Fragments are refused outright: the fragment is not sent to the server, so a
 * client that registered one is either confused or trying to smuggle something
 * past a comparison that ignores it.
 */
export function validRedirectUri(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash) return false;
  if (u.username || u.password) return false;         // credentials in a redirect are never legitimate
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  }
  return false;
}

/**
 * RFC 8707 resource indicator.
 *
 * The metadata advertises `resource_indicators_supported: true`, so a client
 * is entitled to send `resource` and to expect the token it gets back to be
 * bound to that audience. Advertising it and then ignoring the parameter
 * would claim a security property we do not provide — a token the client
 * believes is audience-restricted, and is not.
 *
 * This server has exactly one resource: its own MCP endpoint. So honouring
 * the parameter completely means checking that any value supplied names that
 * endpoint, and refusing otherwise. There is no second audience we could
 * issue for, which is why nothing needs storing: "bound to the only resource
 * that exists" is the same statement as "issued by this server".
 *
 * Absent is fine — the parameter is optional, and a client that omits it gets
 * the same token it would have got before.
 */
function resourceAccepted(request, env, supplied) {
  if (!supplied) return true;
  const expected = `${issuerFor(request, env)}/api/mcp`;
  // Compared after trimming a trailing slash: a client sending ".../api/mcp/"
  // is naming the same resource, and refusing it would be pedantry that
  // breaks a working integration.
  const norm = (u) => String(u).replace(/\/+$/, "");
  return norm(supplied) === norm(expected);
}

// ---------------------------------------------------------------------------
// POST /api/mcp/oauth/register — RFC 7591 dynamic client registration
// ---------------------------------------------------------------------------
export async function mcpRegisterClientHandler(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return oauthError("invalid_client_metadata", "Request body must be valid JSON."); }

  const name = typeof body.client_name === "string" ? body.client_name.trim().slice(0, 120) : "";
  if (!name) return oauthError("invalid_client_metadata", "client_name is required.");

  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length) return oauthError("invalid_redirect_uri", "At least one redirect_uri is required.");
  if (uris.length > MAX_REDIRECT_URIS) {
    return oauthError("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect URIs.`);
  }
  for (const u of uris) {
    if (typeof u !== "string" || !validRedirectUri(u)) {
      return oauthError("invalid_redirect_uri",
        `"${String(u).slice(0, 120)}" is not acceptable: use https, or http on localhost, with no fragment.`);
    }
  }

  // Public clients (PKCE only, no secret) are the norm for MCP: a desktop app
  // or a browser cannot keep a secret, and pretending otherwise gives false
  // assurance. A secret is issued only when the client asks to authenticate
  // with one.
  const wantsSecret = body.token_endpoint_auth_method === "client_secret_post";
  const clientId = "mcpc_" + crypto.randomUUID().replace(/-/g, "");
  const secret   = wantsSecret ? generateToken().replace(MCP_TOKEN_TAG, "mcps_") : null;
  const now      = Math.floor(Date.now() / 1000);
  const scope    = normalizeScope(body.scope || ALL_SCOPES.join(" "));

  try {
    await env.DB.prepare(
      `INSERT INTO mcp_clients
         (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      clientId, secret ? await sha256Hex(secret) : null, name,
      JSON.stringify(uris), JSON.stringify(["authorization_code", "refresh_token"]),
      scope, now,
    ).run();
  } catch {
    return oauthError("server_error", "The client could not be registered.", 500);
  }

  return json({
    client_id: clientId,
    ...(secret ? { client_secret: secret } : {}),
    client_id_issued_at: now,
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: wantsSecret ? "client_secret_post" : "none",
    scope,
  }, 201);
}

async function loadClient(env, clientId) {
  if (!clientId) return null;
  const row = await env.DB.prepare(
    `SELECT client_id, client_secret_hash, client_name, redirect_uris, scope, disabled_at
       FROM mcp_clients WHERE client_id = ?`,
  ).bind(clientId).first();
  if (!row || row.disabled_at) return null;
  let uris = [];
  try { uris = JSON.parse(row.redirect_uris || "[]"); } catch { uris = []; }
  return { ...row, redirectUris: uris };
}

// ---------------------------------------------------------------------------
// GET /api/mcp/oauth/authorize
// ---------------------------------------------------------------------------
//
// Renders the consent screen, or a sign-in prompt when there is no session.
//
// Errors are split deliberately. A bad client_id or redirect_uri is shown as
// a PAGE and never redirected — redirecting an unvalidated URI is the open
// redirect this endpoint exists to avoid. Every other error redirects back to
// the (now validated) redirect_uri with an OAuth error code, which is what a
// client needs in order to report anything useful.
export async function mcpAuthorizeHandler(request, env, ctx) {
  const url = new URL(request.url);
  const p = Object.fromEntries(url.searchParams.entries());

  const client = await loadClient(env, p.client_id);
  if (!client) {
    return errorPage(env, "Unknown application",
      "This application is not registered with Algosize, so the request cannot be approved. Nothing has been shared.");
  }
  if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
    // Exact match against what was registered. A mismatch here is either a
    // misconfigured client or someone trying to redirect a code elsewhere;
    // either way it must not be followed.
    return errorPage(env, "Redirect address does not match",
      "The address this application asked to be returned to is not one it registered. Nothing has been shared.");
  }

  const back = (error, description) => {
    const u = new URL(p.redirect_uri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (p.state) u.searchParams.set("state", p.state);
    return new Response(null, { status: 302, headers: { Location: u.toString(), "cache-control": "no-store" } });
  };

  if (p.response_type !== "code") {
    return back("unsupported_response_type", "Only the authorization code flow is supported.");
  }
  if (!p.code_challenge) {
    return back("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  }
  if (p.code_challenge_method !== "S256") {
    return back("invalid_request", "Only S256 is accepted for code_challenge_method; plain is not a challenge.");
  }
  if (!resourceAccepted(request, env, p.resource)) {
    return back("invalid_target",
      "The requested resource is not served by this authorization server.");
  }

  // Is there a signed-in person? requireAuth returns a Response on failure.
  const denial = await requireAuth(request, env, ctx);
  const signedIn = !(denial instanceof Response) && request.user && request.user.userId;
  if (!signedIn) return signInPage(env, url, client);

  const orgs = await orgsForUser(env, request.user.userId);
  if (!orgs.length) {
    return errorPage(env, "No organisation",
      "This account is not a member of any organisation, so there is nothing to grant access to.");
  }

  return consentPage(env, {
    client,
    orgs,
    scope: normalizeScope(p.scope),
    params: p,
    email: request.user.email || "",
  });
}

/** Every organisation this person belongs to, for the picker. */
async function orgsForUser(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT o.org_id, o.name, m.role
       FROM memberships m
       JOIN organisations o ON o.org_id = m.org_id
      WHERE m.user_id = ?
      ORDER BY o.name`,
  ).bind(userId).all();
  return ((rows && rows.results) || []).map((r) => ({ orgId: r.org_id, name: r.name, role: r.role }));
}

// ---------------------------------------------------------------------------
// POST /api/mcp/oauth/authorize — the user pressed Approve
// ---------------------------------------------------------------------------
export async function mcpAuthorizeConsentHandler(request, env, ctx) {
  const form = await request.formData().catch(() => null);
  if (!form) return errorPage(env, "Bad request", "The consent form could not be read.");

  const get = (k) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };

  const client = await loadClient(env, get("client_id"));
  if (!client) return errorPage(env, "Unknown application", "This application is not registered with Algosize.");

  const redirectUri = get("redirect_uri");
  if (!client.redirectUris.includes(redirectUri)) {
    return errorPage(env, "Redirect address does not match",
      "The address this application asked to be returned to is not one it registered.");
  }

  const userId = request.user && request.user.userId;
  if (!userId) return errorPage(env, "Not signed in", "Sign in again and retry the connection.");

  const orgId = get("org_id");
  // The org is re-checked against the person's memberships rather than
  // trusted from the form. A grant silently bound to an org the user does not
  // belong to would be a cross-tenant data leak posted from a browser.
  const orgs = await orgsForUser(env, userId);
  if (!orgs.some((o) => o.orgId === orgId)) {
    return errorPage(env, "Organisation not available",
      "That organisation is not one this account belongs to. Nothing has been shared.");
  }

  const state = get("state");
  const back = (params) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (state) u.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { Location: u.toString(), "cache-control": "no-store" } });
  };

  if (get("decision") !== "approve") {
    return back({ error: "access_denied", error_description: "The request was declined." });
  }

  const scope = normalizeScope(get("scope"));
  const code  = generateToken().replace(MCP_TOKEN_TAG, "mcpa_");
  const now   = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(
      `INSERT INTO mcp_authorizations
         (code_hash, client_id, org_id, user_id, scope, code_challenge, code_challenge_method,
          redirect_uri, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'S256', ?, ?)`,
    ).bind(
      await sha256Hex(code), client.client_id, orgId, userId, scope,
      get("code_challenge"), redirectUri, now + CODE_TTL_SECONDS,
    ).run();
  } catch {
    return back({ error: "server_error", error_description: "The approval could not be recorded." });
  }

  // Audited: a person granted a program standing access to an organisation's
  // analysis data. That belongs in the log a human reads, unlike the tool
  // calls that follow, which go to mcp_tool_calls.
  ctx.waitUntil(auditFromRequest(request, env, ctx, {
    action: MCP_AUDIT_ACTIONS.MCP_GRANT_AUTHORIZED,
    orgId,
    targetType: "mcp_client",
    targetId: client.client_id,
    // Client name and scope only. Never the code.
    metadata: { clientName: client.client_name, scope },
  }).catch(() => {}));

  return back({ code });
}

// ---------------------------------------------------------------------------
// POST /api/mcp/oauth/token
// ---------------------------------------------------------------------------
export async function mcpTokenHandler(request, env, ctx) {
  const form = await request.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "The token request must be form-encoded.");
  const get = (k) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };

  const grantType = get("grant_type");
  const client = await loadClient(env, get("client_id"));
  if (!client) return oauthError("invalid_client", "Unknown client.", 401);

  // A confidential client must prove it is itself. A public one registered
  // without a secret, and requiring one here would break it.
  if (client.client_secret_hash) {
    const presented = get("client_secret");
    if (!presented || (await sha256Hex(presented)) !== client.client_secret_hash) {
      return oauthError("invalid_client", "Client authentication failed.", 401);
    }
  }

  // Checked for both grants: a refresh is a fresh token issuance, so a client
  // could otherwise widen the audience at renewal time even though it could
  // not at authorization time.
  if (!resourceAccepted(request, env, get("resource"))) {
    return oauthError("invalid_target",
      "The requested resource is not served by this authorization server.");
  }

  if (grantType === "authorization_code") return await exchangeCode(request, env, ctx, client, get);
  if (grantType === "refresh_token")      return await refresh(request, env, ctx, client, get);
  return oauthError("unsupported_grant_type",
    "Supported grants: authorization_code, refresh_token.");
}

async function exchangeCode(request, env, ctx, client, get) {
  const code = get("code");
  if (!code) return oauthError("invalid_request", "code is required.");

  const codeHash = await sha256Hex(code);
  const row = await env.DB.prepare(
    `SELECT code_hash, client_id, org_id, user_id, scope, code_challenge,
            redirect_uri, expires_at, consumed_at
       FROM mcp_authorizations WHERE code_hash = ?`,
  ).bind(codeHash).first();

  if (!row) return oauthError("invalid_grant", "That authorization code is not valid.");

  if (row.consumed_at) {
    // A replayed code. Either the client is broken or the code was stolen;
    // theft is the assumption that fails safe, so every token this
    // authorization ever produced is revoked. The user re-authorises in
    // seconds; an attacker holding a live chain is unbounded.
    ctx.waitUntil(revokeTokensForAuthorization(env, row).catch(() => {}));
    return oauthError("invalid_grant",
      "That authorization code has already been used. For safety, any access it granted has been revoked — reconnect to continue.");
  }
  if (row.expires_at <= Math.floor(Date.now() / 1000)) {
    return oauthError("invalid_grant", "That authorization code has expired. Start the connection again.");
  }
  if (row.client_id !== client.client_id) {
    return oauthError("invalid_grant", "That code was issued to a different client.");
  }
  // Exact match, again — the value presented here must equal the one the code
  // was bound to, not merely be one the client registered.
  if (get("redirect_uri") !== row.redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri does not match the one used to obtain this code.");
  }

  const verifier = get("code_verifier");
  if (!verifier) return oauthError("invalid_request", "code_verifier is required.");
  if ((await s256(verifier)) !== row.code_challenge) {
    return oauthError("invalid_grant", "The PKCE verifier does not match the challenge.");
  }

  // Consume FIRST, and only proceed if this request is the one that consumed
  // it. `consumed_at IS NULL` in the WHERE makes the update the atomic claim,
  // so two simultaneous redemptions cannot both mint tokens.
  const claim = await env.DB.prepare(
    "UPDATE mcp_authorizations SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL",
  ).bind(Math.floor(Date.now() / 1000), codeHash).run();
  if (!claim || !claim.meta || claim.meta.changes !== 1) {
    return oauthError("invalid_grant", "That authorization code has already been used.");
  }

  const pair = await issueTokenPair(env, {
    clientId: client.client_id, orgId: row.org_id, userId: row.user_id, scope: row.scope,
  });
  return tokenResponse(pair);
}

async function refresh(request, env, ctx, client, get) {
  const presented = get("refresh_token");
  if (!presented) return oauthError("invalid_request", "refresh_token is required.");

  const token = await resolveRefreshToken(env, presented);
  if (!token) return oauthError("invalid_grant", "That refresh token is not valid.");
  if (!token.valid) {
    // A revoked refresh token being presented is the strongest signal of a
    // stolen chain there is, so the whole chain goes.
    if (token.reason === "revoked") {
      ctx.waitUntil(revokeTokenChain(env, token.token_id).catch(() => {}));
    }
    return oauthError("invalid_grant",
      token.reason === "expired"
        ? "That refresh token has expired. Reconnect to continue."
        : "That refresh token is no longer valid. Reconnect to continue.");
  }
  if (token.client_id !== client.client_id) {
    return oauthError("invalid_grant", "That refresh token was issued to a different client.");
  }

  // Rotation: the presented token dies as the new pair is born. A refresh
  // token that stayed valid after use would be replayable forever from a
  // single leaked copy.
  await revokeToken(env, token.token_id);
  const pair = await issueTokenPair(env, {
    clientId: client.client_id, orgId: token.org_id, userId: token.user_id,
    scope: token.scope, parentTokenId: token.token_id,
  });
  return tokenResponse(pair);
}

function tokenResponse(pair) {
  return json({
    access_token:  pair.accessToken,
    token_type:    "Bearer",
    expires_in:    pair.expiresIn,
    refresh_token: pair.refreshToken,
    scope:         pair.scope,
  });
}

/** Revoke everything descended from one authorization, after a code replay. */
async function revokeTokensForAuthorization(env, row) {
  const rows = await env.DB.prepare(
    `SELECT token_id FROM mcp_tokens
      WHERE client_id = ? AND org_id = ? AND revoked_at IS NULL`,
  ).bind(row.client_id, row.org_id).all();
  for (const t of (rows && rows.results) || []) await revokeToken(env, t.token_id);
}

/** base64url(sha256(verifier)) — the S256 transformation. */
async function s256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let s = "";
  const bytes = new Uint8Array(digest);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// ---------------------------------------------------------------------------
// POST /api/mcp/oauth/revoke — RFC 7009
// ---------------------------------------------------------------------------
export async function mcpRevokeHandler(request, env, ctx) {
  const form = await request.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "The revocation request must be form-encoded.");
  const raw = form.get("token");
  if (typeof raw !== "string" || !raw) {
    // RFC 7009 says an unknown token is a SUCCESS. The endpoint's job is to
    // ensure the token is not valid afterwards, and a token that never existed
    // already satisfies that — reporting an error would also turn the endpoint
    // into an oracle for guessing valid tokens.
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }

  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare(
    "SELECT token_id, token_type, org_id, client_id FROM mcp_tokens WHERE token_hash = ?",
  ).bind(hash).first();

  if (row) {
    // Revoking a refresh token takes its descendants with it; revoking an
    // access token takes only itself, since the refresh token behind it is a
    // separate credential the client may still legitimately hold.
    if (row.token_type === "refresh") await revokeTokenChain(env, row.token_id);
    else await revokeToken(env, row.token_id);

    ctx.waitUntil(auditFromRequest(request, env, ctx, {
      action: MCP_AUDIT_ACTIONS.MCP_GRANT_REVOKED,
      orgId: row.org_id,
      targetType: "mcp_client",
      targetId: row.client_id,
      metadata: { tokenType: row.token_type },
    }).catch(() => {}));
  }

  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
//
// Server-rendered, with no JavaScript and no external assets. This surface is
// reached mid-OAuth-flow from another application; a page that depended on the
// dashboard bundle loading would fail in exactly the contexts (a popup, a
// restricted webview) where connectors are most often approved.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(title, bodyHtml, status = 200) {
  return new Response(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Algosize</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0a0d14; color:#f1f3f6; padding:24px;
         font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { width:100%; max-width:460px; background:#131825; border:1px solid #1e2532;
          border-radius:16px; padding:28px; }
  h1 { font-size:1.25rem; margin:0 0 6px; letter-spacing:-0.02em; }
  p { color:#8a93a3; margin:0 0 16px; }
  .who { font-weight:600; color:#f1f3f6; }
  ul { list-style:none; padding:0; margin:0 0 18px; }
  li { display:flex; gap:10px; padding:9px 0; border-bottom:1px solid #1e2532; }
  li:last-child { border-bottom:0; }
  .tick { color:#5eead4; flex:0 0 auto; }
  .cannot { background:#0d1118; border:1px solid #1e2532; border-radius:10px;
            padding:12px 14px; margin:0 0 18px; font-size:0.86rem; color:#8a93a3; }
  label { display:block; font-size:0.8rem; color:#8a93a3; margin:0 0 6px; }
  select { width:100%; padding:10px 12px; border-radius:10px; background:#0d1118;
           color:#f1f3f6; border:1px solid #2a3340; font-size:0.95rem; margin:0 0 18px; }
  .row { display:flex; gap:10px; }
  button, .btn { flex:1; padding:11px 16px; border-radius:10px; font-size:0.95rem;
                 font-weight:600; cursor:pointer; text-align:center; text-decoration:none;
                 border:1px solid #2a3340; background:#0d1118; color:#f1f3f6; }
  button.primary { background:#5eead4; color:#04241f; border-color:#5eead4; }
  button:focus-visible, select:focus-visible, .btn:focus-visible {
    outline:2px solid #5eead4; outline-offset:2px; }
  code { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:0.85rem; color:#8a93a3;
         word-break:break-all; }
  .foot { font-size:0.78rem; color:#5b6373; margin:16px 0 0; }
</style>
</head><body><div class="card">${bodyHtml}</div></body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // This page carries a consent decision, so it must never be framed by
      // another site — clickjacking a "Approve" button is the obvious attack.
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

function errorPage(env, title, message) {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`, 400);
}

function signInPage(env, url, client) {
  const origin = issuerFor({ url: url.toString() }, env);
  // The authorize URL is preserved so returning here after sign-in resumes
  // exactly this request — same scopes, same PKCE challenge, same state.
  const resume = url.pathname + url.search;
  return page("Sign in to continue", `
    <h1>Sign in to Algosize</h1>
    <p><span class="who">${esc(client.client_name)}</span> is asking to connect to your Algosize
       organisation. Sign in first, then come back to approve it.</p>
    <div class="row">
      <a class="btn" href="${esc(origin)}/dashboard/" target="_blank" rel="noopener">Open Algosize</a>
      <a class="btn" href="${esc(resume)}" style="background:#5eead4;color:#04241f;border-color:#5eead4">I've signed in</a>
    </div>
    <p class="foot">Nothing is shared until you approve it on the next screen.</p>
  `, 401);
}

function consentPage(env, { client, orgs, scope, params, email }) {
  const granted = scope.split(/\s+/).filter(Boolean);
  const items = granted.map((s) =>
    `<li><span class="tick" aria-hidden="true">✓</span><span>${esc(SCOPE_DESCRIPTIONS[s] || s)}</span></li>`).join("");

  // The picker is a select only when there is a real choice. With one
  // organisation it is a hidden field plus a plain statement of which one,
  // because a dropdown with a single option invites a click that changes
  // nothing and hides the fact there was no decision to make.
  const orgField = orgs.length === 1
    ? `<input type="hidden" name="org_id" value="${esc(orgs[0].orgId)}">
       <p>Access will be granted to <span class="who">${esc(orgs[0].name)}</span>.</p>`
    : `<label for="org">Which organisation?</label>
       <select id="org" name="org_id" required>
         ${orgs.map((o) => `<option value="${esc(o.orgId)}">${esc(o.name)} · ${esc(o.role)}</option>`).join("")}
       </select>`;

  const hidden = ["client_id", "redirect_uri", "state", "code_challenge"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] || "")}">`).join("");

  return page("Approve connection", `
    <h1>Connect ${esc(client.client_name)}?</h1>
    <p>It is asking for access to your Algosize data${email ? ` as <span class="who">${esc(email)}</span>` : ""}.</p>
    <ul>${items}</ul>
    <div class="cannot">
      It <strong>cannot</strong> create API keys, change billing, add or remove members, or
      reach admin settings. You can disconnect it at any time from Algosize.
    </div>
    <form method="POST" action="/api/mcp/oauth/authorize">
      ${hidden}
      <input type="hidden" name="scope" value="${esc(scope)}">
      ${orgField}
      <div class="row">
        <button type="submit" name="decision" value="deny">Cancel</button>
        <button type="submit" name="decision" value="approve" class="primary">Approve</button>
      </div>
    </form>
    <p class="foot">Returns to <code>${esc(params.redirect_uri)}</code></p>
  `);
}
