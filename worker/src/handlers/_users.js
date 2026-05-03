// USERS KV access helpers shared by the checkout, webhook, and signup handlers.
//
// Layout in the USERS namespace:
//   user:<userId>   → JSON {
//                       userId, email, plan, stripeCustomerId, subStatus,
//                       createdAt, updatedAt
//                     }
//   email:<email>   → userId (lookup index)
//   cust:<custId>   → userId (Stripe customer id index, used by the webhook
//                     to resolve customer.subscription.deleted events)
//
// `plan` is "free" | "paid" (Task #19). Records written before Task #19
// shipped don't have the field — `getUserById` patches them on read so the
// rest of the codebase can rely on the field being present. Existing rows
// are treated as "paid" because the only way to land in USERS pre-#19 was
// through a successful Stripe checkout.

function newUserId() {
  // 24-char base32-ish ID. crypto.randomUUID is available in Workers.
  return "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

// Patch missing fields on read so callers don't have to check. Keeps the
// migration cost zero — no batch backfill needed.
function normalize(user) {
  if (!user) return null;
  if (!user.plan) {
    // Pre-Task-#19 records all came from a paid Stripe checkout, so default
    // them to "paid". Free-tier rows written by /api/signup always set the
    // field explicitly.
    user.plan = user.stripeCustomerId ? "paid" : "free";
  }
  return user;
}

export async function getUserByEmail(env, email) {
  const userId = await env.USERS.get(`email:${email.toLowerCase()}`);
  if (!userId) return null;
  return getUserById(env, userId);
}

export async function getUserByCustomerId(env, customerId) {
  const userId = await env.USERS.get(`cust:${customerId}`);
  if (!userId) return null;
  return getUserById(env, userId);
}

export async function getUserById(env, userId) {
  const raw = await env.USERS.get(`user:${userId}`);
  return raw ? normalize(JSON.parse(raw)) : null;
}

async function writeUser(env, user) {
  await env.USERS.put(`user:${user.userId}`, JSON.stringify(user));
  await env.USERS.put(`email:${user.email.toLowerCase()}`, user.userId);
  // Free users have no Stripe customer — only write the cust→userId index
  // for paid records, otherwise we'd pollute the namespace with `cust:`
  // keys whose values cannot be resolved from any Stripe webhook.
  if (user.stripeCustomerId) {
    await env.USERS.put(`cust:${user.stripeCustomerId}`, user.userId);
  }
  return user;
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
  const existing =
    (await getUserByCustomerId(env, stripeCustomerId)) ||
    (await getUserByEmail(env, email));

  if (existing) {
    const updated = {
      ...existing,
      email,
      stripeCustomerId,
      subStatus,
      plan: "paid",
      updatedAt: now,
    };
    return writeUser(env, updated);
  }

  const user = {
    userId: newUserId(),
    email,
    plan: "paid",
    stripeCustomerId,
    subStatus,
    createdAt: now,
    updatedAt: now,
  };
  return writeUser(env, user);
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
  const existing = await getUserByEmail(env, email);
  if (existing) return { user: existing, alreadyExisted: true };

  const now = Math.floor(Date.now() / 1000);
  const user = {
    userId: newUserId(),
    email,
    plan: "free",
    stripeCustomerId: "",   // empty — free users have no Stripe customer
    subStatus: null,        // null — no subscription
    createdAt: now,
    updatedAt: now,
  };
  await writeUser(env, user);
  return { user, alreadyExisted: false };
}

/** Flip the user's subscription status. Used by customer.subscription.deleted. */
export async function setSubStatusByCustomerId(env, customerId, subStatus) {
  const user = await getUserByCustomerId(env, customerId);
  if (!user) return null;
  const updated = { ...user, subStatus, updatedAt: Math.floor(Date.now() / 1000) };
  // Cancellation does NOT downgrade a paid record back to "free" — a former
  // paid customer keeps unlimited until their subscription period ends, and
  // the account-level decision (re-enroll, delete, etc.) is out of scope.
  await env.USERS.put(`user:${user.userId}`, JSON.stringify(updated));
  return updated;
}
