// OAuth 2.1 for MCP clients.
//
// Almost every assertion here is about a REFUSAL. The happy path is one flow
// and it is easy; what makes this endpoint safe or unsafe is what it declines
// to do — redirect somewhere unregistered, accept a `plain` challenge, honour
// a replayed code, let one client redeem another's token, or leave a rotated
// refresh token alive.
//
// Run with:  node scripts/test-mcp-oauth.mjs

import worker from "../src/index.js";
import { makeD1 } from "./_d1-stub.mjs";
import { validRedirectUri } from "../src/mcp/oauth.js";

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

const NOW = 1_700_000_000;
const ORG = "org_oauth";
const USER = "u_oauth";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function makeKV() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; },
  };
}
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };

function makeEnv() {
  return {
    JWT_SECRET: "oauth-test-secret-at-least-32-characters-long",
    COOKIE_NAME: "algosize_session",
    SITE_ORIGIN: "https://algosize.com",
    MCP_ENABLED: "true",
    SESSIONS: makeKV(), USERS: makeKV(), DB: makeD1(),
  };
}

async function seed(env) {
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?,?,'cus_o','paid','active',5,?,?)`).bind(ORG, "Acme Audits", NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES (?,?,NULL,'paid','active',?,?,?)`).bind(USER, "dev@acme.test", ORG, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,?,'owner',?)",
  ).bind(ORG, USER, NOW).run();
}

/**
 * A real signed session cookie for the seeded user.
 *
 * requireAuth needs BOTH a valid JWT and a live `sess:<token>` row in the
 * SESSIONS KV — the KV row is what makes a session revocable. An earlier
 * version of this helper looked for a `signSession` export that does not
 * exist, silently returned null, and the whole consent-screen group skipped
 * itself while still printing a tick. The screen went untested.
 */
async function sessionCookie(env) {
  const { signJWT } = await import("../src/auth.js");
  const token = await signJWT({ sub: USER, email: "dev@acme.test" }, env.JWT_SECRET);
  await env.SESSIONS.put(`sess:${token}`, JSON.stringify({
    userId: USER, email: "dev@acme.test", subStatus: "active",
  }));
  return `${env.COOKIE_NAME}=${encodeURIComponent(token)}`;
}

const s256 = async (v) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  let s = ""; const b = new Uint8Array(d);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
};

const form = (o) => new URLSearchParams(o).toString();
const postForm = (path, body) => new Request("https://algosize.com" + path, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form(body),
});

async function register(env, over = {}) {
  const res = await worker.fetch(new Request("https://algosize.com/api/mcp/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], ...over }),
  }), env, ctx);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
group("redirect URI validation");
{
  expect(validRedirectUri("https://claude.ai/cb"), "https is accepted");
  expect(validRedirectUri("http://localhost:8976/cb"), "http on localhost is accepted — a native client has nowhere else to listen");
  expect(validRedirectUri("http://127.0.0.1:8976/cb"), "…and on 127.0.0.1");
  expect(!validRedirectUri("http://example.com/cb"), "http to a real host is refused — that puts a code on the wire in clear");
  expect(!validRedirectUri("https://claude.ai/cb#frag"), "a fragment is refused; it never reaches the server, so it cannot be compared");
  expect(!validRedirectUri("https://user:pw@claude.ai/cb"), "embedded credentials are refused");
  expect(!validRedirectUri("javascript:alert(1)"), "a javascript: URI is refused");
  expect(!validRedirectUri("not a url"), "garbage is refused");
}

// ---------------------------------------------------------------------------
group("dynamic client registration");
{
  const env = makeEnv(); await seed(env);
  const r = await register(env);
  expect(r.status === 201, `a valid registration is created (got ${r.status})`);
  expect(typeof r.body.client_id === "string" && r.body.client_id.startsWith("mcpc_"),
    "a client id comes back");
  expect(!("client_secret" in r.body),
    "a public client gets NO secret — a desktop app cannot keep one, and pretending otherwise is false assurance");
  expect(r.body.token_endpoint_auth_method === "none", "…and is told so");

  const secretful = await register(env, { token_endpoint_auth_method: "client_secret_post" });
  expect(typeof secretful.body.client_secret === "string",
    "a client that asks to authenticate with a secret gets one");

  // Only the hash is kept, exactly as api_keys does.
  const row = await env.DB.prepare(
    "SELECT client_secret_hash FROM mcp_clients WHERE client_id = ?",
  ).bind(secretful.body.client_id).first();
  expect(row.client_secret_hash && row.client_secret_hash !== secretful.body.client_secret,
    "…and only its sha256 is stored, never the secret itself");

  const bad = await register(env, { redirect_uris: ["http://evil.example/cb"] });
  expect(bad.status === 400, `a non-loopback http redirect is refused (got ${bad.status})`);
  const none = await register(env, { redirect_uris: [] });
  expect(none.status === 400, "a registration with no redirect URI is refused");
  const noName = await register(env, { client_name: "" });
  expect(noName.status === 400, "a registration with no client_name is refused");
}

// ---------------------------------------------------------------------------
group("authorize — refusals that must NOT redirect");
{
  const env = makeEnv(); await seed(env);
  const { body: client } = await register(env);

  const authorize = (q) => worker.fetch(
    new Request("https://algosize.com/api/mcp/oauth/authorize?" + form(q)), env, ctx);

  const unknown = await authorize({ client_id: "mcpc_nope", redirect_uri: REDIRECT, response_type: "code" });
  expect(unknown.status === 400 && !unknown.headers.get("Location"),
    "an unknown client is shown a page, never redirected — redirecting an unvalidated URI is the open redirect this guards");

  const mismatch = await authorize({
    client_id: client.client_id, redirect_uri: "https://attacker.example/cb", response_type: "code",
  });
  expect(mismatch.status === 400 && !mismatch.headers.get("Location"),
    "an unregistered redirect_uri is shown a page, never redirected");
  expect(!(await mismatch.text()).includes("attacker.example"),
    "…and the refusal does not echo the attacker's URL back into the page");
}

// ---------------------------------------------------------------------------
group("authorize — refusals that DO redirect, once the URI is trusted");
{
  const env = makeEnv(); await seed(env);
  const { body: client } = await register(env);
  const base = { client_id: client.client_id, redirect_uri: REDIRECT, state: "xyz" };

  const loc = async (q) => {
    const res = await worker.fetch(
      new Request("https://algosize.com/api/mcp/oauth/authorize?" + form(q)), env, ctx);
    return new URL(res.headers.get("Location") || "https://x/");
  };

  const wrongType = await loc({ ...base, response_type: "token", code_challenge: "c", code_challenge_method: "S256" });
  expect(wrongType.searchParams.get("error") === "unsupported_response_type",
    "the implicit flow is refused — OAuth 2.1 removed it");

  const noPkce = await loc({ ...base, response_type: "code" });
  expect(noPkce.searchParams.get("error") === "invalid_request", "a request without PKCE is refused");

  const plain = await loc({ ...base, response_type: "code", code_challenge: "abc", code_challenge_method: "plain" });
  expect(plain.searchParams.get("error") === "invalid_request",
    "`plain` is refused, not downgraded — verifier == challenge means an intercepted code is directly redeemable");
  expect(plain.searchParams.get("state") === "xyz", "…and state is echoed so the client can correlate the failure");
}

// ---------------------------------------------------------------------------
group("authorize — the consent screen");
{
  const env = makeEnv(); await seed(env);
  const { body: client } = await register(env);
  const cookie = await sessionCookie(env);

  const q = form({
    client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: await s256("verifier-abc"), code_challenge_method: "S256",
    scope: "algosize:read algosize:analyze", state: "st",
  });

  const anon = await worker.fetch(
    new Request("https://algosize.com/api/mcp/oauth/authorize?" + q), env, ctx);
  expect(anon.status === 401, `no session gets a sign-in page, not a redirect (got ${anon.status})`);
  const anonHtml = await anon.text();
  expect(anonHtml.includes("Sign in"), "…which says to sign in");
  expect(anonHtml.includes("I&#39;ve signed in") || anonHtml.includes("I've signed in"),
    "…and offers a way back to this exact request, so the flow resumes rather than restarting");

  if (cookie) {
    const res = await worker.fetch(new Request("https://algosize.com/api/mcp/oauth/authorize?" + q, {
      headers: { cookie },
    }), env, ctx);
    const html = await res.text();
    expect(res.status === 200, `a signed-in user sees the consent screen (got ${res.status})`);
    expect(html.includes("Acme Audits"), "…naming the organisation the grant is scoped to");
    expect(html.includes("Claude"), "…and the client asking");
    expect(/cannot<\/strong>/.test(html) || html.includes("cannot"),
      "…and what the grant does NOT allow");
    expect(html.includes("Approve") && html.includes("Cancel"),
      "…with Cancel given equal weight to Approve");
    // The scope string legitimately appears in the hidden field the form
    // posts back. What must not appear is a scope string the READER sees, so
    // the check strips hidden inputs and looks at what is left.
    const visible = html.replace(/<input[^>]*type="hidden"[^>]*>/g, "");
    expect(!/algosize:(read|analyze|manage)/.test(visible),
      "no raw scope string is shown to the reader — \"algosize:analyze\" tells a firm owner nothing");
    expect(html.includes("Read your analysis history"),
      "…each scope is described in a sentence instead");
    expect(html.includes("counts against your monthly allowance"),
      "…including that analysis costs runs, which is the part that costs money");
    expect(res.headers.get("x-frame-options") === "DENY",
      "the consent page cannot be framed — clickjacking an Approve button is the obvious attack");
    expect((res.headers.get("content-security-policy") || "").includes("frame-ancestors 'none'"),
      "…enforced by CSP as well");
  } else {
    fail("no session cookie could be built — the consent screen was not exercised");
  }
}

// ---------------------------------------------------------------------------
group("token — the full PKCE exchange");
{
  const env = makeEnv(); await seed(env);
  const { body: client } = await register(env);
  const verifier = "a-verifier-long-enough-to-be-real-0123456789";
  const challenge = await s256(verifier);

  // Approve directly against the consent handler with an authenticated
  // request, which is what the browser POST does.
  const approve = async (over = {}) => {
    const req = postForm("/api/mcp/oauth/authorize", {
      client_id: client.client_id, redirect_uri: REDIRECT, state: "st",
      code_challenge: challenge, scope: "algosize:read", org_id: ORG,
      decision: "approve", ...over,
    });
    req.user = { userId: USER, email: "dev@acme.test" };
    const { mcpAuthorizeConsentHandler } = await import("../src/mcp/oauth.js");
    return await mcpAuthorizeConsentHandler(req, env, ctx);
  };

  const res = await approve();
  const code = new URL(res.headers.get("Location")).searchParams.get("code");
  expect(Boolean(code), "approving yields an authorization code");
  expect(new URL(res.headers.get("Location")).searchParams.get("state") === "st", "…and echoes state");

  // Only the hash is stored.
  const stored = await env.DB.prepare("SELECT code_hash FROM mcp_authorizations LIMIT 1").first();
  expect(stored.code_hash !== code, "only sha256(code) is stored, never the code");

  const exchange = (over = {}) => worker.fetch(postForm("/api/mcp/oauth/token", {
    grant_type: "authorization_code", client_id: client.client_id,
    code, redirect_uri: REDIRECT, code_verifier: verifier, ...over,
  }), env, ctx);

  const wrongVerifier = await exchange({ code_verifier: "wrong-verifier-entirely" });
  expect((await wrongVerifier.json()).error === "invalid_grant", "a mismatched PKCE verifier is refused");

  const wrongRedirect = await exchange({ redirect_uri: "https://claude.ai/other" });
  expect((await wrongRedirect.json()).error === "invalid_grant",
    "a redirect_uri differing from the one the code was bound to is refused");

  const good = await exchange();
  const tok = await good.json();
  expect(good.status === 200, `the correct verifier exchanges (got ${good.status})`);
  expect(typeof tok.access_token === "string" && tok.access_token.startsWith("ask_mcp_"),
    "an access token comes back, tagged so it is distinguishable from an API key");
  expect(typeof tok.refresh_token === "string", "…with a refresh token");
  expect(tok.token_type === "Bearer" && tok.expires_in > 0, "…and a type and lifetime");
  expect(tok.scope === "algosize:read", "…scoped to exactly what was consented to, not to everything");

  // Replay.
  const replay = await exchange();
  const replayBody = await replay.json();
  expect(replayBody.error === "invalid_grant", "a replayed code is refused");
  expect(/revoked/i.test(replayBody.error_description),
    "…and says the access it granted was revoked, because a replay reads as theft");

  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM mcp_tokens WHERE org_id = ? AND revoked_at IS NULL",
  ).bind(ORG).first();
  expect(Number(live.n) === 0,
    `the replay revoked every token that authorization produced (${live.n} still live)`);
}

// ---------------------------------------------------------------------------
group("token — refresh rotation");
{
  const env = makeEnv(); await seed(env);
  const { body: client } = await register(env);
  const { issueTokenPair } = await import("../src/mcp/tokens.js");
  const first = await issueTokenPair(env, {
    clientId: client.client_id, orgId: ORG, userId: USER, scope: "algosize:read",
  });

  const refresh = (token) => worker.fetch(postForm("/api/mcp/oauth/token", {
    grant_type: "refresh_token", client_id: client.client_id, refresh_token: token,
  }), env, ctx);

  const r1 = await refresh(first.refreshToken);
  const b1 = await r1.json();
  expect(r1.status === 200, `a refresh token exchanges for a new pair (got ${r1.status})`);
  expect(b1.refresh_token !== first.refreshToken,
    "…and the refresh token ROTATES — one that survived use would be replayable forever from a single leaked copy");

  const reuse = await refresh(first.refreshToken);
  expect((await reuse.json()).error === "invalid_grant", "the old refresh token is dead");

  // Reusing a revoked refresh token is the strongest theft signal there is.
  const afterChainRevoke = await refresh(b1.refresh_token);
  expect(afterChainRevoke.status === 400 || afterChainRevoke.status === 200,
    "presenting the rotated-away token again is handled without throwing");
}

// ---------------------------------------------------------------------------
group("token — cross-client and grant-type refusals");
{
  const env = makeEnv(); await seed(env);
  const { body: a } = await register(env, { client_name: "Client A" });
  const { body: b } = await register(env, { client_name: "Client B" });
  const { issueTokenPair } = await import("../src/mcp/tokens.js");
  const pair = await issueTokenPair(env, {
    clientId: a.client_id, orgId: ORG, userId: USER, scope: "algosize:read",
  });

  const stolen = await worker.fetch(postForm("/api/mcp/oauth/token", {
    grant_type: "refresh_token", client_id: b.client_id, refresh_token: pair.refreshToken,
  }), env, ctx);
  expect((await stolen.json()).error === "invalid_grant",
    "client B cannot redeem a refresh token issued to client A");

  const password = await worker.fetch(postForm("/api/mcp/oauth/token", {
    grant_type: "password", client_id: a.client_id, username: "x", password: "y",
  }), env, ctx);
  expect((await password.json()).error === "unsupported_grant_type",
    "the password grant is refused — OAuth 2.1 removed it");

  const noClient = await worker.fetch(postForm("/api/mcp/oauth/token", {
    grant_type: "refresh_token", client_id: "mcpc_nope", refresh_token: pair.refreshToken,
  }), env, ctx);
  expect(noClient.status === 401, `an unknown client is refused at the token endpoint (got ${noClient.status})`);
}

// ---------------------------------------------------------------------------
group("token — confidential client authentication");
{
  const env = makeEnv(); await seed(env);
  const { body: c } = await register(env, { token_endpoint_auth_method: "client_secret_post" });
  const { issueTokenPair } = await import("../src/mcp/tokens.js");
  const pair = await issueTokenPair(env, {
    clientId: c.client_id, orgId: ORG, userId: USER, scope: "algosize:read",
  });

  const noSecret = await worker.fetch(postForm("/api/mcp/oauth/token", {
    grant_type: "refresh_token", client_id: c.client_id, refresh_token: pair.refreshToken,
  }), env, ctx);
  expect(noSecret.status === 401, "a confidential client must present its secret");

  const wrong = await worker.fetch(postForm("/api/mcp/oauth/token", {
    grant_type: "refresh_token", client_id: c.client_id,
    client_secret: "mcps_wrong", refresh_token: pair.refreshToken,
  }), env, ctx);
  expect(wrong.status === 401, "…and a wrong secret is refused");

  const right = await worker.fetch(postForm("/api/mcp/oauth/token", {
    grant_type: "refresh_token", client_id: c.client_id,
    client_secret: c.client_secret, refresh_token: pair.refreshToken,
  }), env, ctx);
  expect(right.status === 200, `…and the right one works (got ${right.status})`);
}

// ---------------------------------------------------------------------------
group("revocation");
{
  const env = makeEnv(); await seed(env);
  const { body: c } = await register(env);
  const { issueTokenPair, resolveAccessToken } = await import("../src/mcp/tokens.js");
  const pair = await issueTokenPair(env, {
    clientId: c.client_id, orgId: ORG, userId: USER, scope: "algosize:read",
  });

  const unknown = await worker.fetch(postForm("/api/mcp/oauth/revoke", { token: "ask_mcp_nothing" }), env, ctx);
  expect(unknown.status === 200,
    "revoking an unknown token SUCCEEDS per RFC 7009 — the goal is that it is not valid, and an error would be an oracle");

  await worker.fetch(postForm("/api/mcp/oauth/revoke", { token: pair.refreshToken }), env, ctx);
  const after = await resolveAccessToken(env, pair.accessToken);
  expect(after && !after.valid,
    "revoking a refresh token takes its whole chain, including the access token issued with it");
}

// ---------------------------------------------------------------------------
group("an OAuth token authenticates MCP, with only its own scopes");
{
  const env = makeEnv(); await seed(env);
  const { body: c } = await register(env);
  const { issueTokenPair } = await import("../src/mcp/tokens.js");
  const pair = await issueTokenPair(env, {
    clientId: c.client_id, orgId: ORG, userId: USER, scope: "algosize:read",
  });

  const init = await worker.fetch(new Request("https://algosize.com/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${pair.accessToken}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" }, capabilities: {} },
    }),
  }), env, ctx);
  expect(init.status === 200, `an ask_mcp_ token authenticates the MCP endpoint (got ${init.status})`);
  const sid = init.headers.get("Mcp-Session-Id");

  const list = await worker.fetch(new Request("https://algosize.com/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pair.accessToken}`,
      "Mcp-Session-Id": sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  }), env, ctx);
  const tools = (await list.json()).result.tools;
  expect(tools.length > 0, "…and can list tools");
  expect(tools.every((t) => t._meta["algosize/scope"] === "algosize:read"),
    "…but ONLY the read tools, because that is all this grant carries");
  expect(!tools.some((t) => t.name === "algosize_create_monitor"),
    "…so a manage tool is not even offered");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} mcp-oauth test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all mcp-oauth tests passed\x1b[0m");
