// Cloudflare D1 access helpers shared by the checkout, webhook, and signup
// handlers. Migrated from KV in Task #25.
//
// Schema (see worker/migrations/0001_init.sql):
//   users(user_id PK, email UNIQUE, stripe_customer_id UNIQUE,
//         plan, sub_status, created_at, updated_at)
//
// `plan` is "free" | "paid". `sub_status` is "active" | "inactive" | NULL.
// `stripe_customer_id` is NULL for free-tier users — UNIQUE allows multiple
// NULLs in SQLite/D1, so we don't need a sentinel value.
//
// Public function shape (and return shape) is unchanged from the KV-backed
// version so handlers (webhook.js, checkout.js, billing.js, me.js,
// signup.js) didn't need any edits during the migration.

function newUserId() {
  // 24-char base32-ish ID. crypto.randomUUID is available in Workers + Node 20+.
  return "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

// Translate a snake_case D1 row to the camelCase user shape the rest of the
// codebase expects. Centralized here so adding a column doesn't ripple out
// to every handler.
function rowToUser(row) {
  if (!row) return null;
  return {
    userId:           row.user_id,
    email:            row.email,
    // Pre-Task-#19 rows might land here without a plan (the column has a
    // DEFAULT 'free' so the import script populates it). Fall back to the
    // same heuristic the old normalize() used: a paid customer iff there's
    // a Stripe customer attached.
    plan:             row.plan || (row.stripe_customer_id ? "paid" : "free"),
    // Free users get an empty string here so the existing call sites (which
    // do `if (!user.stripeCustomerId)`) keep working without edits.
    stripeCustomerId: row.stripe_customer_id || "",
    subStatus:        row.sub_status,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

export async function getUserByEmail(env, email) {
  if (!email) return null;
  const row = await env.DB
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first();
  return rowToUser(row);
}

export async function getUserByCustomerId(env, customerId) {
  if (!customerId) return null;
  const row = await env.DB
    .prepare("SELECT * FROM users WHERE stripe_customer_id = ?")
    .bind(customerId)
    .first();
  return rowToUser(row);
}

export async function getUserById(env, userId) {
  if (!userId) return null;
  const row = await env.DB
    .prepare("SELECT * FROM users WHERE user_id = ?")
    .bind(userId)
    .first();
  return rowToUser(row);
}

/**
 * Idempotently create or refresh a user record after a successful checkout.
 * Safe to call from BOTH the success_url handler AND the webhook — whichever
 * arrives first wins; the second one updates subStatus + indexes.
 *
 * Always sets plan="paid" — we can only get here through a Stripe payment,
 * which by definition upgrades a free signup. If a previously-free user
 * comes through checkout, their plan flips to "paid" automatically.
 */
export async function upsertUserFromCheckout(env, { email, stripeCustomerId, subStatus }) {
  const now = Math.floor(Date.now() / 1000);
  const lowered = email.toLowerCase();
  const newId = newUserId();

  // Atomic UPSERT — both the success_url handler and the
  // checkout.session.completed webhook can land here concurrently for
  // the same customer. A read-then-insert pattern would race on the
  // UNIQUE(email) / UNIQUE(stripe_customer_id) constraints and 500.
  // SQLite/D1 supports a single ON CONFLICT clause, so we resolve in
  // two passes: ON CONFLICT(stripe_customer_id) covers the common case
  // (same customer hits us twice); a residual UNIQUE(email) race is
  // caught and retried as an update keyed on email.
  const insertSql = `
    INSERT INTO users
      (user_id, email, stripe_customer_id, plan, sub_status, created_at, updated_at)
    VALUES (?, ?, ?, 'paid', ?, ?, ?)
    ON CONFLICT(stripe_customer_id) DO UPDATE SET
      email      = excluded.email,
      plan       = 'paid',
      sub_status = excluded.sub_status,
      updated_at = excluded.updated_at
    RETURNING *`;

  let row;
  try {
    row = await env.DB
      .prepare(insertSql)
      .bind(newId, lowered, stripeCustomerId, subStatus, now, now)
      .first();
  } catch (e) {
    // The remaining race window: a row already exists with this email
    // but a NULL stripe_customer_id (free signup just upgrading), so the
    // ON CONFLICT(stripe_customer_id) branch doesn't fire and we trip
    // UNIQUE(email) instead. Update keyed on email and re-read.
    const msg = String(e && e.message || e);
    if (!/UNIQUE.*users\.email/i.test(msg)) throw e;
    await env.DB.prepare(
      `UPDATE users
          SET stripe_customer_id = ?,
              plan = 'paid',
              sub_status = ?,
              updated_at = ?
        WHERE email = ?`,
    ).bind(stripeCustomerId, subStatus, now, lowered).run();
    row = await env.DB
      .prepare("SELECT * FROM users WHERE email = ?")
      .bind(lowered)
      .first();
  }

  return rowToUser(row);
}

/**
 * Create a free-tier user from the email-only signup endpoint (Task #19).
 * Returns { user, alreadyExisted: bool } so the caller can pick the right
 * status code (200 for an existing record, 201 for a fresh one).
 *
 * If the email is already taken — by either a free or paid user — we do
 * NOT issue a session for it. Free signup is intentionally not a login
 * mechanism: anyone could otherwise claim someone else's email and read
 * their run history. A real magic-link auth flow is a separate follow-up.
 */
export async function createFreeUser(env, { email }) {
  const lowered = email.toLowerCase();
  const existing = await getUserByEmail(env, lowered);
  if (existing) return { user: existing, alreadyExisted: true };

  const now = Math.floor(Date.now() / 1000);
  const userId = newUserId();
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?)`,
  ).bind(userId, lowered, now, now).run();

  const user = {
    userId,
    email:            lowered,
    plan:             "free",
    stripeCustomerId: "",      // empty — free users have no Stripe customer
    subStatus:        null,    // null — no subscription
    createdAt:        now,
    updatedAt:        now,
  };
  return { user, alreadyExisted: false };
}

/** Flip the user's subscription status. Used by customer.subscription.deleted. */
export async function setSubStatusByCustomerId(env, customerId, subStatus) {
  if (!customerId) return null;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `UPDATE users
        SET sub_status = ?, updated_at = ?
      WHERE stripe_customer_id = ?`,
  ).bind(subStatus, now, customerId).run();

  // Cancellation does NOT downgrade a paid record back to "free" — a former
  // paid customer keeps unlimited until their subscription period ends, and
  // the account-level decision (re-enroll, delete, etc.) is out of scope.
  if (!result.meta || !result.meta.changes) return null;
  return getUserByCustomerId(env, customerId);
}
