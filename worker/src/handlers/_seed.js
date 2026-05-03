// TEST-ONLY seeding endpoint.
//
// This handler is wired into the router unconditionally, but it only does
// anything when env.E2E_TEST_SECRET is set AND the caller passes that same
// value in the X-E2E-Auth header. In production the secret is never set
// (it is not declared in wrangler.toml [vars] and never put as a real
// secret), so this endpoint always returns 404 — i.e. it is a no-op in
// the deployed Worker.
//
// Why this exists:
//   The Playwright suite needs to drop in a synthetic session cookie
//   without going through Stripe. Doing that requires:
//     - a row in SESSIONS KV at sess:<jwt>  (checked by requireAuth)
//     - a row in the D1 `users` table        (read by /api/me, billing, etc.)
//   Routing the seed through the Worker itself sidesteps cross-process
//   SQLite races we hit when seeding from outside (`wrangler kv put` /
//   standalone Miniflare).
//
// We also apply the migrations/0001_init.sql schema inline (with IF NOT
// EXISTS) on every call so the e2e suite doesn't need a separate
// `wrangler d1 execute --local --file=…` step in either the dev workflow
// or CI — Miniflare starts D1 with an empty SQLite file.
//
// Body shape (JSON):
//   {
//     "token": "<JWT>",
//     "session": { userId, email, subStatus, iat },
//     "user":    { userId, email, stripeCustomerId, subStatus, createdAt, updatedAt }
//   }

// Inlined subset of migrations/0001_init.sql — just enough for the
// users + runs reads on the dashboard's first paint. Kept here (rather
// than importing the file) because Workers bundling doesn't pull in
// .sql assets, and CREATE TABLE IF NOT EXISTS is cheap to re-run.
const SCHEMA_USERS = `
  CREATE TABLE IF NOT EXISTS users (
    user_id            TEXT PRIMARY KEY,
    email              TEXT NOT NULL UNIQUE,
    stripe_customer_id TEXT UNIQUE,
    plan               TEXT NOT NULL DEFAULT 'free',
    sub_status         TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  )
`;
const SCHEMA_RUNS = `
  CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    analyzer    TEXT NOT NULL,
    input_json  TEXT,
    result_json TEXT,
    ms          REAL,
    headline    TEXT,
    created_at  INTEGER NOT NULL
  )
`;
const SCHEMA_RUNS_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_runs_user_created
    ON runs (user_id, created_at DESC)
`;

export async function seedHandler(request, env) {
  // Hard 404 in any environment that does not opt in.
  if (!env.E2E_TEST_SECRET) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  // Constant-time-ish auth: shared secret in a custom header.
  const auth = request.headers.get("X-E2E-Auth") || "";
  if (auth !== env.E2E_TEST_SECRET) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const { token, session, user } = body || {};
  if (!token || !session || !user || !user.userId || !user.email) {
    return new Response(JSON.stringify({ error: "missing_fields" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // 1. SESSIONS KV — checked by requireAuth on every authed request.
  await env.SESSIONS.put(`sess:${token}`, JSON.stringify(session));

  // 2. D1 users / runs — apply schema (idempotent), then upsert the row.
  if (env.DB) {
    await env.DB.exec(SCHEMA_USERS.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_RUNS.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_RUNS_INDEX.replace(/\s+/g, " ").trim());

    const plan = user.subStatus === "active" ? "paid" : "free";
    await env.DB
      .prepare(
        `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           email              = excluded.email,
           stripe_customer_id = excluded.stripe_customer_id,
           plan               = excluded.plan,
           sub_status         = excluded.sub_status,
           updated_at         = excluded.updated_at`,
      )
      .bind(
        user.userId,
        user.email.toLowerCase(),
        user.stripeCustomerId || null,
        plan,
        user.subStatus || null,
        user.createdAt || Math.floor(Date.now() / 1000),
        user.updatedAt || Math.floor(Date.now() / 1000),
      )
      .run();
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
