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
    current_period_end INTEGER,
    active_org_id      TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  )
`;
// Entitlement resolves through the ORGANISATION (migrations/0004), so a
// seeded session needs an org and a membership as well as a user row.
// Without them /api/me 500s on a missing table, and with the tables but no
// membership the seeded "paid" session resolves to free — either way the
// dashboard the e2e suite is asserting against is not the one users get.
const SCHEMA_ORGS = `
  CREATE TABLE IF NOT EXISTS organisations (
    org_id             TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    stripe_customer_id TEXT UNIQUE,
    plan               TEXT NOT NULL DEFAULT 'free',
    sub_status         TEXT,
    current_period_end INTEGER,
    seats_purchased    INTEGER NOT NULL DEFAULT 1,
    price_id           TEXT,
    brand_company_name TEXT,
    brand_logo_url     TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  )
`;
// NOTE — do NOT put `--` comments inside these schema strings. They are
// executed as `SCHEMA_X.replace(/\s+/g, " ")`, which collapses the newlines a
// `--` comment needs to terminate, so the comment swallows the rest of the
// statement and D1 fails with "incomplete input". Explanations go here, in JS.
//
// brand_company_name / brand_logo_url are the white-label report branding from
// migrations/0008. Both nullable; whether an org may actually USE them is
// resolved at render time from the live entitlement, never stored.
const SCHEMA_MEMBERSHIPS = `
  CREATE TABLE IF NOT EXISTS memberships (
    org_id     TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, user_id)
  )
`;

// migrations/0005 and 0006. Absent here until GET /api/admin/schema-check
// pointed out that a wrangler-dev database had neither — which meant every
// Team-screen and Monitors-screen request 500ed with "no such table" in the
// one environment Playwright runs against, while passing everywhere else.
const SCHEMA_API_KEYS = `
  CREATE TABLE IF NOT EXISTS api_keys (
    key_id       TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  )
`;
const SCHEMA_MONITORS = `
  CREATE TABLE IF NOT EXISTS monitors (
    monitor_id        TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL,
    repo_url          TEXT NOT NULL,
    branch            TEXT,
    schedule          TEXT NOT NULL DEFAULT 'daily',
    last_run_at       INTEGER,
    last_result_hash  TEXT,
    last_advisory_ids TEXT,
    created_by        TEXT,
    created_at        INTEGER NOT NULL,
    paused_at         INTEGER,
    last_delta_json   TEXT
  )
`;
// migrations/0008, for a database whose organisations table predates it.
// migrations/0009, for a persisted database whose monitors table predates it.
const MONITORS_BACKFILL_COLUMNS = [
  "ALTER TABLE monitors ADD COLUMN last_delta_json TEXT",
];

const ORGS_BACKFILL_COLUMNS = [
  "ALTER TABLE organisations ADD COLUMN brand_company_name TEXT",
  "ALTER TABLE organisations ADD COLUMN brand_logo_url TEXT",
];

// Columns added to `users` after the original inline schema above shipped.
// A database file left over from an earlier run already has the table, so
// CREATE TABLE IF NOT EXISTS silently skips the new columns — these bring it
// up to date. Each is expected to fail with "duplicate column name" on a
// fresh table that already declared it, which is not an error worth raising.
const USERS_BACKFILL_COLUMNS = [
  "ALTER TABLE users ADD COLUMN current_period_end INTEGER",
  "ALTER TABLE users ADD COLUMN active_org_id TEXT",
  // migrations/0003 — read back by handlers/_users.js.
  "ALTER TABLE users ADD COLUMN quantity INTEGER",
  "ALTER TABLE users ADD COLUMN price_id TEXT",
  // migrations/0011 — read back by the admin panel's user drawer.
  "ALTER TABLE users ADD COLUMN auth_method TEXT",
];
const SCHEMA_RUNS = `
  CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    org_id      TEXT,
    source      TEXT,
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
const SCHEMA_RUNS_ORG_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_runs_org_created
    ON runs (org_id, created_at DESC)
`;
// Wrangler dev's local D1 persists between runs, so an e2e box that seeded
// before migrations/0007 has a runs table missing org_id/source and every
// /api/runs read 500s with "no such column". Same lazy-ALTER pattern as
// USERS_BACKFILL_COLUMNS below: apply, ignore "duplicate column".
const RUNS_BACKFILL_COLUMNS = [
  "ALTER TABLE runs ADD COLUMN org_id TEXT",
  "ALTER TABLE runs ADD COLUMN source TEXT",
];

// migrations/0010 and 0012-0014 — the tables the admin panel reads. All four
// are append-only logs or a tiny key/value store, so an e2e database that has
// them but no rows renders exactly what a brand-new production database
// renders: an empty list, not an error. That is the state worth testing.
//
// Same rule as above about `--` comments: none inside these strings.
const SCHEMA_AUDIT_LOG = `
  CREATE TABLE IF NOT EXISTS audit_log (
    audit_id      TEXT PRIMARY KEY,
    actor         TEXT NOT NULL,
    actor_user_id TEXT,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    org_id        TEXT,
    metadata_json TEXT,
    created_at    INTEGER NOT NULL
  )
`;
const SCHEMA_AUDIT_LOG_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC)
`;
const SCHEMA_WEBHOOK_DELIVERIES = `
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id   TEXT PRIMARY KEY,
    event_id      TEXT,
    event_type    TEXT NOT NULL,
    org_id        TEXT,
    outcome       TEXT NOT NULL,
    error_message TEXT,
    received_at   INTEGER NOT NULL
  )
`;
const SCHEMA_EMAIL_SENDS = `
  CREATE TABLE IF NOT EXISTS email_sends (
    send_id   TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    template  TEXT NOT NULL,
    org_id    TEXT,
    outcome   TEXT NOT NULL,
    reason    TEXT,
    sent_at   INTEGER NOT NULL
  )
`;
const SCHEMA_FEATURE_FLAGS = `
  CREATE TABLE IF NOT EXISTS feature_flags (
    flag_key    TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 0,
    rollout_pct INTEGER NOT NULL DEFAULT 100,
    description TEXT,
    updated_by  TEXT,
    updated_at  INTEGER NOT NULL
  )
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
    await env.DB.exec(SCHEMA_ORGS.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_MEMBERSHIPS.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_API_KEYS.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_MONITORS.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_AUDIT_LOG.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_AUDIT_LOG_INDEX.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_WEBHOOK_DELIVERIES.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_EMAIL_SENDS.replace(/\s+/g, " ").trim());
    await env.DB.exec(SCHEMA_FEATURE_FLAGS.replace(/\s+/g, " ").trim());
    for (const sql of USERS_BACKFILL_COLUMNS.concat(RUNS_BACKFILL_COLUMNS, ORGS_BACKFILL_COLUMNS, MONITORS_BACKFILL_COLUMNS)) {
      try { await env.DB.exec(sql); } catch { /* column already present */ }
    }
    // AFTER the backfill ALTERs: on a persisted pre-0007 table this index
    // references a column the ALTER above just added.
    await env.DB.exec(SCHEMA_RUNS_ORG_INDEX.replace(/\s+/g, " ").trim());

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

    // The organisation the seeded user owns, carrying the plan and status
    // entitlement actually reads. Derived from the user id the same way the
    // 0004 backfill derives it, so re-seeding the same user is idempotent.
    const now   = Math.floor(Date.now() / 1000);
    const orgId = `org_${user.userId}`;
    await env.DB
      .prepare(
        `INSERT INTO organisations
           (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           plan       = excluded.plan,
           sub_status = excluded.sub_status,
           updated_at = excluded.updated_at`,
      )
      .bind(orgId, user.email.toLowerCase(), user.stripeCustomerId || null,
            plan, user.subStatus || null, now, now)
      .run();

    await env.DB
      .prepare(
        `INSERT INTO memberships (org_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)
         ON CONFLICT(org_id, user_id) DO NOTHING`,
      )
      .bind(orgId, user.userId, now)
      .run();

    await env.DB
      .prepare("UPDATE users SET active_org_id = ? WHERE user_id = ?")
      .bind(orgId, user.userId)
      .run();
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
