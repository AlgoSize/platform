// Organisation, membership and seat access. The org is the billing subject:
// everything Stripe tells us lands here, and src/entitlement.js reads only
// from here. See migrations/0004_orgs.sql.
//
// The billing columns still present on `users` are a pre-migration snapshot
// and are not consulted for access by anything.

export const ROLES = Object.freeze(["owner", "admin", "member"]);

/** Roles permitted to invite and remove members. */
const MANAGER_ROLES = new Set(["owner", "admin"]);

export function canManageMembers(role) {
  return MANAGER_ROLES.has(role);
}

function newOrgId() {
  return "org_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function rowToOrg(row) {
  if (!row) return null;
  return {
    orgId:            row.org_id,
    name:             row.name,
    stripeCustomerId: row.stripe_customer_id || "",
    plan:             row.plan === "paid" ? "paid" : "free",
    subStatus:        row.sub_status,
    currentPeriodEnd: typeof row.current_period_end === "number" ? row.current_period_end : null,
    // Pre-0004 rows and any row written without a quantity are single-seat.
    seatsPurchased:   typeof row.seats_purchased === "number" && row.seats_purchased > 0
      ? row.seats_purchased
      : 1,
    priceId:          row.price_id || null,
    // White-label report branding (migrations/0008). Present on the row does
    // NOT mean permitted to use — see brandingFor in src/reports/branding.js.
    brandCompanyName: row.brand_company_name || null,
    brandLogoUrl:     row.brand_logo_url || null,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

/**
 * Set (or clear) an org's white-label branding.
 *
 * Entitlement is the caller's job — this writes what it is given. `null`
 * clears a field; `undefined` leaves it alone, so clearing the logo does not
 * also wipe the company name.
 */
export async function updateOrgBranding(env, orgId, { companyName, logoUrl } = {}) {
  if (!orgId) return null;
  const sets = [];
  const vals = [];
  if (companyName !== undefined) { sets.push("brand_company_name = ?"); vals.push(companyName); }
  if (logoUrl     !== undefined) { sets.push("brand_logo_url = ?");     vals.push(logoUrl); }
  if (!sets.length) return getOrgById(env, orgId);

  sets.push("updated_at = ?");
  vals.push(Math.floor(Date.now() / 1000));

  await env.DB
    .prepare(`UPDATE organisations SET ${sets.join(", ")} WHERE org_id = ?`)
    .bind(...vals, orgId)
    .run();
  return getOrgById(env, orgId);
}

export async function getOrgById(env, orgId) {
  if (!orgId) return null;
  const row = await env.DB.prepare("SELECT * FROM organisations WHERE org_id = ?").bind(orgId).first();
  return rowToOrg(row);
}

export async function getOrgByCustomerId(env, customerId) {
  if (!customerId) return null;
  const row = await env.DB
    .prepare("SELECT * FROM organisations WHERE stripe_customer_id = ?")
    .bind(customerId)
    .first();
  return rowToOrg(row);
}

/**
 * The org a user's requests act as: their `active_org_id` when it still
 * corresponds to a live membership, otherwise their oldest membership.
 *
 * The fallback matters — a user removed from the org they had selected must
 * land somewhere real rather than resolving to nothing and losing access to
 * their own personal org. Returns { org, role } or null when the user belongs
 * to no org at all.
 */
export async function getActiveOrg(env, userId) {
  if (!userId) return null;

  const row = await env.DB.prepare(
    `SELECT o.*, m.role AS membership_role
       FROM memberships m
       JOIN organisations o ON o.org_id = m.org_id
       JOIN users u        ON u.user_id = m.user_id
      WHERE m.user_id = ?
      ORDER BY (m.org_id = u.active_org_id) DESC, m.created_at ASC
      LIMIT 1`,
  ).bind(userId).first();

  if (!row) return null;
  return { org: rowToOrg(row), role: row.membership_role };
}

/**
 * Where billing mail for an org goes: the owner's address. Falls back to any
 * member with an email so a dunning notice still reaches a human if the owner
 * row has somehow lost its address.
 */
export async function getOrgBillingEmail(env, orgId) {
  if (!orgId) return null;
  const row = await env.DB.prepare(
    `SELECT u.email
       FROM memberships m
       JOIN users u ON u.user_id = m.user_id
      WHERE m.org_id = ? AND u.email IS NOT NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               m.created_at ASC
      LIMIT 1`,
  ).bind(orgId).first();
  return row ? row.email : null;
}

export async function getMembership(env, orgId, userId) {
  if (!orgId || !userId) return null;
  const row = await env.DB
    .prepare("SELECT * FROM memberships WHERE org_id = ? AND user_id = ?")
    .bind(orgId, userId)
    .first();
  if (!row) return null;
  return { orgId: row.org_id, userId: row.user_id, role: row.role, createdAt: row.created_at };
}

/** Members with their email, oldest first. Owners sort ahead of everyone. */
export async function listMembers(env, orgId) {
  const { results } = await env.DB.prepare(
    `SELECT m.user_id, m.role, m.created_at, u.email
       FROM memberships m
       LEFT JOIN users u ON u.user_id = m.user_id
      WHERE m.org_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               m.created_at ASC`,
  ).bind(orgId).all();
  return (results || []).map((r) => ({
    userId:   r.user_id,
    email:    r.email || null,
    role:     r.role,
    joinedAt: r.created_at,
  }));
}

/**
 * Seats in use = current members + invites that have been sent and not yet
 * accepted. Counting outstanding invites is what stops an admin from issuing
 * twenty invites against three seats and discovering the problem only when
 * the seventeenth person clicks their link.
 */
export async function countSeatsUsed(env, orgId, pendingInvites = 0) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ?")
    .bind(orgId)
    .first();
  return (row ? row.n : 0) + pendingInvites;
}

export async function addMember(env, orgId, userId, role = "member") {
  const now = Math.floor(Date.now() / 1000);
  // Idempotent: re-accepting an invite for an existing member is a no-op
  // rather than a UNIQUE violation, and never demotes an owner to member.
  await env.DB.prepare(
    `INSERT INTO memberships (org_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id, user_id) DO NOTHING`,
  ).bind(orgId, userId, role, now).run();
  return getMembership(env, orgId, userId);
}

/**
 * Remove a member. Owners cannot be removed — an org with no owner has nobody
 * who can pay for it or add anyone back, so the operation is refused rather
 * than left to produce an orphan. Returns a reason string on refusal.
 */
export async function removeMember(env, orgId, userId) {
  const membership = await getMembership(env, orgId, userId);
  if (!membership)                return { removed: false, reason: "not_a_member" };
  if (membership.role === "owner") return { removed: false, reason: "cannot_remove_owner" };

  await env.DB.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?")
    .bind(orgId, userId).run();

  // If that was their active org, clear the pointer so getActiveOrg falls back
  // to a membership that still exists instead of a dangling id.
  await env.DB.prepare(
    "UPDATE users SET active_org_id = NULL, updated_at = ? WHERE user_id = ? AND active_org_id = ?",
  ).bind(Math.floor(Date.now() / 1000), userId, orgId).run();

  return { removed: true };
}

/**
 * Create an org owned by `userId` and make it their active one. Used for new
 * signups, and by the checkout path when a payment arrives for someone who has
 * no org yet.
 */
export async function createOrgForUser(env, userId, { name, stripeCustomerId = null, plan = "free",
                                                     subStatus = null, currentPeriodEnd = null,
                                                     seatsPurchased = 1 } = {}) {
  const now   = Math.floor(Date.now() / 1000);
  const orgId = newOrgId();

  await env.DB.prepare(
    `INSERT INTO organisations
       (org_id, name, stripe_customer_id, plan, sub_status, current_period_end,
        seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(orgId, name || userId, stripeCustomerId, plan, subStatus, currentPeriodEnd,
         seatsPurchased, now, now).run();

  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
  ).bind(orgId, userId, now).run();

  await env.DB.prepare("UPDATE users SET active_org_id = ?, updated_at = ? WHERE user_id = ?")
    .bind(orgId, now, userId).run();

  return getOrgById(env, orgId);
}

/**
 * Ensure a user has an org, creating their personal one if not.
 *
 * The email is read directly rather than via _users.js so this module has no
 * import back into the one that calls it — createFreeUser needs to create an
 * org, and a cycle between the two is not worth the shared helper.
 */
export async function ensureOrgForUser(env, userId) {
  const existing = await getActiveOrg(env, userId);
  if (existing) return existing.org;
  const row = await env.DB.prepare("SELECT email FROM users WHERE user_id = ?").bind(userId).first();
  return createOrgForUser(env, userId, { name: (row && row.email) || userId });
}

// ---------------------------------------------------------------------------
// Stripe writes. These mirror what handlers/_users.js used to do for users,
// moved here because the org is now the billing subject.
// ---------------------------------------------------------------------------

// Columns the Stripe lifecycle webhooks may write, keyed by the camelCase name
// callers use. The UPDATE interpolates these column names into SQL, so this
// allowlist is what keeps that safe — values are always bound. Never build it
// from caller input.
const SUBSCRIPTION_COLUMNS = Object.freeze({
  plan:             "plan",
  subStatus:        "sub_status",
  currentPeriodEnd: "current_period_end",
  seatsPurchased:   "seats_purchased",
  priceId:          "price_id",
});

/**
 * Write whichever subscription fields the caller knows, leaving the rest alone.
 * `undefined` means "don't touch"; an explicit `null` clears the column. A
 * renewal invoice must not wipe the seat count just because it doesn't carry
 * one.
 *
 * Returns the refreshed org, or null when no org matched the customer id —
 * which is the caller's signal that we've received a subscription for a
 * customer we've never seen, not an error.
 */
export async function updateOrgSubscriptionByCustomerId(env, customerId, fields = {}) {
  if (!customerId) return null;

  const sets = [];
  const vals = [];
  for (const [field, column] of Object.entries(SUBSCRIPTION_COLUMNS)) {
    if (fields[field] === undefined) continue;
    sets.push(`${column} = ?`);
    vals.push(fields[field]);
  }
  if (!sets.length) return getOrgByCustomerId(env, customerId);

  sets.push("updated_at = ?");
  vals.push(Math.floor(Date.now() / 1000));

  const result = await env.DB
    .prepare(`UPDATE organisations SET ${sets.join(", ")} WHERE stripe_customer_id = ?`)
    .bind(...vals, customerId)
    .run();

  if (!result.meta || !result.meta.changes) return null;
  return getOrgByCustomerId(env, customerId);
}

/**
 * Flip an org's subscription status, optionally recording the paid-through
 * date. Used by customer.subscription.deleted. Omitting the period end leaves
 * the stored one alone rather than clearing a date entitlement still needs.
 */
export async function setOrgSubStatusByCustomerId(env, customerId, subStatus, currentPeriodEnd = null) {
  return updateOrgSubscriptionByCustomerId(env, customerId, {
    subStatus,
    currentPeriodEnd: currentPeriodEnd === null ? undefined : currentPeriodEnd,
  });
}

/**
 * Attach a Stripe customer to the org a user acts as — creating one if they
 * have none, and refusing to overwrite somebody else's.
 *
 * The refusal is the important part. A member who already sits on a team's
 * paid org and then buys their own subscription would otherwise stamp their
 * new customer id over the team's org, silently moving the whole team's
 * billing onto one member's card. When the active org already belongs to a
 * different Stripe customer, the buyer gets a fresh personal org instead.
 */
export async function attachCustomerToUsersOrg(env, userId, { stripeCustomerId, subStatus, seatsPurchased, name }) {
  const active = await getActiveOrg(env, userId);

  if (!active) {
    return createOrgForUser(env, userId, {
      name: name || userId,
      stripeCustomerId,
      plan: "paid",
      subStatus,
      seatsPurchased: seatsPurchased ?? 1,
    });
  }

  const existing = active.org.stripeCustomerId;
  const isSomeoneElses = existing && existing !== stripeCustomerId;
  // Only an owner's org can become their billing account; a member buying a
  // subscription is buying their own, not the team's.
  if (isSomeoneElses || active.role !== "owner") {
    return createOrgForUser(env, userId, {
      name: name || userId,
      stripeCustomerId,
      plan: "paid",
      subStatus,
      seatsPurchased: seatsPurchased ?? 1,
    });
  }

  return attachCustomerToOrg(env, active.org.orgId, { stripeCustomerId, subStatus, seatsPurchased });
}

/**
 * Attach a Stripe customer to an org after checkout, or refresh it if the same
 * customer comes through again. Idempotent: both the success_url handler and
 * the checkout.session.completed webhook can land here concurrently for the
 * same customer.
 */
export async function attachCustomerToOrg(env, orgId, { stripeCustomerId, subStatus, seatsPurchased }) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE organisations
        SET stripe_customer_id = ?,
            plan               = 'paid',
            sub_status         = ?,
            seats_purchased    = COALESCE(?, seats_purchased),
            updated_at         = ?
      WHERE org_id = ?`,
  ).bind(stripeCustomerId, subStatus, seatsPurchased ?? null, now, orgId).run();
  return getOrgById(env, orgId);
}
