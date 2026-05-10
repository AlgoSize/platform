import { googleStartHandler, googleCallbackHandler } from "../src/handlers/auth_google.js";
import { getKVNamespace } from "../src/adapters/kv-store.js";
import { createSqliteDb } from "../src/adapters/sqlite-db.js";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  ✓", msg); } else { fail++; console.log("  ✗", msg); } }

const env = {
  SESSIONS: getKVNamespace("test-sessions-" + Date.now()),
  USERS:    getKVNamespace("test-users-" + Date.now()),
  DB:       createSqliteDb(":memory:"),
  JWT_SECRET: "x".repeat(64),
  COOKIE_NAME: "algosize_session",
  SITE_ORIGIN: "http://localhost:5000",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
};

console.log("\n=== /api/auth/google/start ===");
{
  const res = await googleStartHandler(new Request("http://localhost:5000/api/auth/google/start"), env);
  ok(res.status === 302, "302 redirect");
  const loc = res.headers.get("Location");
  ok(loc && loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), "redirects to Google");
  ok(loc.includes("client_id=test-client-id"), "carries client_id");
  ok(loc.includes("scope=openid+email+profile"), "requests openid+email+profile scopes");
  ok(loc.includes("state="), "carries state");
  const u = new URL(loc);
  const state = u.searchParams.get("state");
  ok(state.length > 30, "state is non-trivial");
  const stored = await env.SESSIONS.get(`gstate:${state}`);
  ok(stored !== null, "state stored in KV");
}

console.log("\n=== /api/auth/google/start — not configured ===");
{
  const env2 = { ...env, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" };
  const res = await googleStartHandler(new Request("http://localhost:5000/api/auth/google/start"), env2);
  ok(res.status === 302, "302 redirect");
  ok(res.headers.get("Location").includes("auth=google_not_configured"), "redirects with not_configured error");
}

console.log("\n=== /api/auth/google/callback — bad state ===");
{
  const res = await googleCallbackHandler(
    new Request("http://localhost:5000/api/auth/google/callback?code=x&state=bogus"),
    env,
  );
  ok(res.status === 302, "302 redirect");
  ok(res.headers.get("Location").includes("auth=expired_or_invalid"), "rejects unknown state");
}

console.log("\n=== /api/auth/google/callback — error param ===");
{
  const res = await googleCallbackHandler(
    new Request("http://localhost:5000/api/auth/google/callback?error=access_denied"),
    env,
  );
  ok(res.status === 302, "302 redirect");
  ok(res.headers.get("Location").includes("auth=google_access_denied"), "passes through error param");
}

console.log("\n=== /api/auth/google/callback — missing code ===");
{
  const res = await googleCallbackHandler(
    new Request("http://localhost:5000/api/auth/google/callback"),
    env,
  );
  ok(res.status === 302, "302 redirect");
  ok(res.headers.get("Location").includes("auth=missing_code"), "rejects missing code");
}

console.log("\n=== /api/auth/google/callback — successful flow with email_verified ===");
{
  // Pre-seed valid state
  const state = "valid-state-token";
  await env.SESSIONS.put(`gstate:${state}`, JSON.stringify({ createdAt: 1 }), { expirationTtl: 600 });

  // Mock fetch
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "fake-token", token_type: "Bearer" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return new Response(JSON.stringify({ email: "alice@example.com", email_verified: true, name: "Alice" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("unexpected fetch: " + url);
  };

  const res = await googleCallbackHandler(
    new Request(`http://localhost:5000/api/auth/google/callback?code=ok&state=${state}`),
    env,
  );
  global.fetch = origFetch;

  ok(res.status === 302, "302 redirect");
  ok(res.headers.get("Location").endsWith("/dashboard/"), "redirects to /dashboard/");
  const cookie = res.headers.get("Set-Cookie") || "";
  ok(cookie.includes("algosize_session="), "sets session cookie");
  ok(cookie.includes("HttpOnly"), "cookie is HttpOnly");
  // State should be consumed
  const remaining = await env.SESSIONS.get(`gstate:${state}`);
  ok(remaining === null, "state consumed (single-use)");
}

console.log("\n=== /api/auth/google/callback — email NOT verified is hard-blocked ===");
{
  const state = "unverified-state";
  await env.SESSIONS.put(`gstate:${state}`, JSON.stringify({ createdAt: 1 }), { expirationTtl: 600 });
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.startsWith("https://oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "x" }), { status: 200 });
    }
    return new Response(JSON.stringify({ email: "bob@example.com", email_verified: false }), { status: 200 });
  };
  const res = await googleCallbackHandler(
    new Request(`http://localhost:5000/api/auth/google/callback?code=ok&state=${state}`),
    env,
  );
  global.fetch = origFetch;
  ok(res.status === 302, "302 redirect");
  ok(res.headers.get("Location").includes("auth=email_not_verified"), "blocks unverified email");
  ok(res.headers.get("Set-Cookie") === null, "no cookie issued for unverified email");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
