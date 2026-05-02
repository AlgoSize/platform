// USERS KV access helpers shared by the checkout and webhook handlers.
//
// Layout in the USERS namespace:
//   user:<userId>   → JSON { userId, email, stripeCustomerId, subStatus, createdAt, updatedAt }
//   email:<email>   → userId (lookup index)
//   cust:<custId>   → userId (Stripe customer id index, used by the webhook
//                     to resolve customer.subscription.deleted events)

function newUserId() {
  // 24-char base32-ish ID. crypto.randomUUID is available in Workers.
  return "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
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
  return raw ? JSON.parse(raw) : null;
}

async function writeUser(env, user) {
  await env.USERS.put(`user:${user.userId}`, JSON.stringify(user));
  await env.USERS.put(`email:${user.email.toLowerCase()}`, user.userId);
  await env.USERS.put(`cust:${user.stripeCustomerId}`, user.userId);
  return user;
}

/**
 * Idempotently create or refresh a user record after a successful checkout.
 * Safe to call from BOTH the success_url handler AND the webhook — whichever
 * arrives first wins; the second one updates subStatus + indexes.
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
      updatedAt: now,
    };
    return writeUser(env, updated);
  }

  const user = {
    userId: newUserId(),
    email,
    stripeCustomerId,
    subStatus,
    createdAt: now,
    updatedAt: now,
  };
  return writeUser(env, user);
}

/** Flip the user's subscription status. Used by customer.subscription.deleted. */
export async function setSubStatusByCustomerId(env, customerId, subStatus) {
  const user = await getUserByCustomerId(env, customerId);
  if (!user) return null;
  const updated = { ...user, subStatus, updatedAt: Math.floor(Date.now() / 1000) };
  await env.USERS.put(`user:${user.userId}`, JSON.stringify(updated));
  return updated;
}
