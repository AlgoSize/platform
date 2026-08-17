// Tests for organisations, memberships, seats and roles (migrations/0004).
//
// The four properties the feature has to hold, in the order they'd hurt:
//
//   1. The backfill leaves every existing paid user still paid. A migration
//      that silently downgrades a customer is worse than no migration.
//   2. Role enforcement — a member cannot invite, and an admin cannot mint
//      another admin or remove one. Both are quiet privilege escalations.
//   3. The seat cap holds, counting invites that have been sent and not yet
//      accepted, at BOTH the invite and the redemption end.
//   4. An invite works exactly once.
//
// Plus the thing that makes the whole model real: entitlement now comes from
// the ORG, so a member of a paid org is entitled and losing the seat ends it.
//
// Run with:  node scripts/test-orgs.mjs

import {
  getOrgHandler,
  inviteMemberHandler,
  acceptInviteHandler,
  removeMemberHandler,
} from "../src/handlers/org.js";
import { resolveEntitlement, ENTITLEMENT_REASON } from "../src/entitlement.js";
import { enforceQuota, FREE_MONTHLY_LIMIT, quotaKey } from "../src/quota.js";
import { getActiveOrg, getMembership, listMembers } from "../src/handlers/_orgs.js";
import { createFreeUser } from "../src/handlers/_users.js";
import { createCheckoutSession } from "../src/stripe.js";
import { makeD1 } from "./_d1-stub.mjs";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

function makeKV() {
  const store = new Map();
  return {
    async get(key)              { return store.has(key) ? store.get(key) : null; },
    async put(key, val, o = {}) { store.set(key, val); },
    async delete(key)           { store.delete(key); },
    _store: store,
  };
}

function makeMailbox() {
  const sent = [];
  return { sent, send: async (env, ctx, msg) => { sent.push(msg); return { sent: true }; } };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET: "orgs-test-jwt-secret-32-chars-or-more!!",
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    ...overrides,
  };
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function authed(userId, { method = "GET", url = "https://algosize.com/api/org", body, params } = {}) {
  const req = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  req.user = { userId, email: `${userId}@example.com` };
  if (params) req.params = params;
  return req;
}

/** Create a user + their personal org, then optionally make the org paid. */
async function seedOwner(env, { userId, email, plan = "free", subStatus = null,
                                periodEnd = null, seats = 1 }) {
  const now = NOW;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?)`,
  ).bind(userId, email, now, now).run();

  const orgId = `org_${userId}`;
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status,
                                current_period_end, seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(orgId, email, plan === "paid" ? `cus_${userId}` : null, plan, subStatus,
         periodEnd, seats, now, now).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
  ).bind(orgId, userId, now).run();
  await env.DB.prepare("UPDATE users SET active_org_id = ? WHERE user_id = ?").bind(orgId, userId).run();
  return orgId;
}

/** A bare user with no org of their own — the person being invited. */
async function seedLooseUser(env, userId, email) {
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?)`,
  ).bind(userId, email, NOW, NOW).run();
}

async function addMemberRow(env, orgId, userId, role) {
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
  ).bind(orgId, userId, role, NOW).run();
}

// ---------------------------------------------------------------------------
console.log("\nthe backfill — nobody loses access\n");
// ---------------------------------------------------------------------------

{
  // Build a database at the PRE-0004 schema, populate it the way production
  // looks today, then apply 0004 and check every user came through intact.
  // Applying the real migration file is the point: a hand-written equivalent
  // would test the test, not the migration.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const before = files.filter((f) => f < "0004");
  const migration0004 = files.find((f) => f.startsWith("0004"));

  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  for (const f of before) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

  const insert = db.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status,
                        current_period_end, quantity, price_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("usr_paid_active",  "active@example.com",  "cus_A", "paid", "active",   NOW + 30 * DAY, 1, "price_pro", NOW, NOW);
  insert.run("usr_paid_grace",   "grace@example.com",   "cus_B", "paid", "canceled", NOW + 5 * DAY,  1, "price_pro", NOW, NOW);
  insert.run("usr_paid_trial",   "trial@example.com",   "cus_C", "paid", "trialing", NOW + 10 * DAY, 1, "price_pro", NOW, NOW);
  insert.run("usr_free",         "free@example.com",    null,    "free", null,       null,           null, null,     NOW, NOW);

  db.exec(readFileSync(join(MIGRATIONS_DIR, migration0004), "utf8"));

  const orgCount = db.prepare("SELECT COUNT(*) AS n FROM organisations").get().n;
  const memCount = db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE role = 'owner'").get().n;
  expect(orgCount === 4, `every user got an org (got ${orgCount} of 4)`);
  expect(memCount === 4, `every user owns their org (got ${memCount} of 4)`);

  const paid = db.prepare(
    `SELECT o.plan, o.sub_status, o.current_period_end, o.stripe_customer_id, o.seats_purchased
       FROM organisations o WHERE o.org_id = 'org_usr_paid_active'`,
  ).get();
  expect(paid.plan === "paid",                  "a paid user's org is paid");
  expect(paid.sub_status === "active",          "subscription status carried over");
  expect(paid.current_period_end === NOW + 30 * DAY, "paid-through date carried over");
  expect(paid.stripe_customer_id === "cus_A",   "Stripe customer carried over to the org");
  expect(paid.seats_purchased === 1,            "backfilled orgs get exactly the one seat they have");

  const grace = db.prepare("SELECT * FROM organisations WHERE org_id = 'org_usr_paid_grace'").get();
  expect(grace.plan === "paid" && grace.sub_status === "canceled" && grace.current_period_end === NOW + 5 * DAY,
    "a cancelled-but-in-grace user keeps their grace window");

  const free = db.prepare("SELECT * FROM organisations WHERE org_id = 'org_usr_free'").get();
  expect(free.plan === "free" && free.stripe_customer_id === null,
    "a free user's org is free, and gains nothing");

  const orphans = db.prepare(
    "SELECT COUNT(*) AS n FROM users u LEFT JOIN memberships m ON m.user_id = u.user_id WHERE m.user_id IS NULL",
  ).get().n;
  expect(orphans === 0, "no user is left without a membership");

  const activePtr = db.prepare("SELECT COUNT(*) AS n FROM users WHERE active_org_id IS NULL").get().n;
  expect(activePtr === 0, "every user has an active org set");
  db.close();
}

// ---------------------------------------------------------------------------
console.log("\nentitlement comes from the org, not the user\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const orgId = await seedOwner(env, {
    userId: "usr_boss", email: "boss@example.com",
    plan: "paid", subStatus: "active", seats: 5,
  });
  await seedLooseUser(env, "usr_seat", "seat@example.com");
  await addMemberRow(env, orgId, "usr_seat", "member");
  await env.DB.prepare("UPDATE users SET active_org_id = ? WHERE user_id = 'usr_seat'").bind(orgId).run();

  const ownerEnt  = await resolveEntitlement(env, "usr_boss", { now: NOW });
  const memberEnt = await resolveEntitlement(env, "usr_seat", { now: NOW });

  expect(ownerEnt.active === true,  "the owner of a paid org is entitled");
  expect(memberEnt.active === true, "a MEMBER of a paid org is entitled — the seat is what grants access");
  expect(memberEnt.org.orgId === orgId, "entitlement reports the org it decided against");
  expect(memberEnt.role === "member",   "and the caller's role in it");

  // The user row itself says plan 'free' — proving the decision came from the org.
  expect(memberEnt.user.plan === "free",
    "the users.plan column is not what granted it (it still reads free)");

  // Take the seat away: access ends with it.
  await removeMemberHandler(
    authed("usr_boss", { method: "DELETE", params: { userId: "usr_seat" } }), env,
  );
  const afterRemoval = await resolveEntitlement(env, "usr_seat", { now: NOW });
  expect(afterRemoval.active === false, "removing the seat ends the member's access");
  expect(afterRemoval.reason === ENTITLEMENT_REASON.NO_ORG,
    `and they resolve to no_org, not to a stale paid row (got ${afterRemoval.reason})`);
}

{
  // A member of a paid org bypasses the free quota exactly like the owner:
  // otherwise seats are sold but not delivered.
  const env = makeEnv();
  const orgId = await seedOwner(env, {
    userId: "usr_q_owner", email: "qowner@example.com", plan: "paid", subStatus: "active", seats: 3,
  });
  await seedLooseUser(env, "usr_q_member", "qmember@example.com");
  await addMemberRow(env, orgId, "usr_q_member", "member");

  await env.USERS.put(quotaKey("usr_q_member", new Date(NOW * 1000)), String(FREE_MONTHLY_LIMIT));
  const wrapped = enforceQuota(async () => new Response("{}", { status: 200 }),
                               { now: () => new Date(NOW * 1000) });
  const res = await wrapped(
    authed("usr_q_member", { method: "POST", url: "https://algosize.com/api/analyze/vuln", body: { code: "x" } }),
    env, {},
  );
  expect(res.status === 200,
    `a seated member at the free limit still runs analyses (got ${res.status})`);
}

// ---------------------------------------------------------------------------
console.log("\nrole enforcement\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const mailbox = makeMailbox();
  const orgId = await seedOwner(env, {
    userId: "usr_owner", email: "owner@example.com", plan: "paid", subStatus: "active", seats: 10,
  });
  await seedLooseUser(env, "usr_member", "member@example.com");
  await addMemberRow(env, orgId, "usr_member", "member");
  await seedLooseUser(env, "usr_admin", "admin@example.com");
  await addMemberRow(env, orgId, "usr_admin", "admin");

  // A member cannot invite.
  const memberInvite = await inviteMemberHandler(
    authed("usr_member", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "x@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  const memberBody = await memberInvite.json();
  expect(memberInvite.status === 403, `a member cannot invite (got ${memberInvite.status})`);
  expect(memberBody.error === "forbidden", "refusal is a forbidden, naming the role");
  expect(mailbox.sent.length === 0, "and no invite email was sent");

  // A member cannot remove anyone.
  const memberRemove = await removeMemberHandler(
    authed("usr_member", { method: "DELETE", params: { userId: "usr_admin" } }), env,
  );
  expect(memberRemove.status === 403, `a member cannot remove members (got ${memberRemove.status})`);

  // An admin CAN invite a member.
  const adminInvite = await inviteMemberHandler(
    authed("usr_admin", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "newbie@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  expect(adminInvite.status === 201, `an admin can invite a member (got ${adminInvite.status})`);
  expect(mailbox.sent.length === 1, "exactly one invite email sent");
  expect(mailbox.sent[0].to === "newbie@example.com", "addressed to the invitee");
  expect(/invited you to join/i.test(mailbox.sent[0].text), "email names who invited them");

  // ...but an admin cannot mint another admin. That would hand the invitee
  // power over the people already in the org.
  const escalate = await inviteMemberHandler(
    authed("usr_admin", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "evil@example.com", role: "admin" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  expect(escalate.status === 403, `an admin cannot invite another admin (got ${escalate.status})`);
  expect(mailbox.sent.length === 1, "no email sent for the refused escalation");

  // ...nor remove an existing admin.
  await seedLooseUser(env, "usr_admin2", "admin2@example.com");
  await addMemberRow(env, orgId, "usr_admin2", "admin");
  const adminRemovesAdmin = await removeMemberHandler(
    authed("usr_admin", { method: "DELETE", params: { userId: "usr_admin2" } }), env,
  );
  expect(adminRemovesAdmin.status === 403, `an admin cannot remove another admin (got ${adminRemovesAdmin.status})`);

  // The owner can do both.
  const ownerInvitesAdmin = await inviteMemberHandler(
    authed("usr_owner", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "trusted@example.com", role: "admin" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  expect(ownerInvitesAdmin.status === 201, "the owner can invite an admin");

  const ownerRemovesAdmin = await removeMemberHandler(
    authed("usr_owner", { method: "DELETE", params: { userId: "usr_admin2" } }), env,
  );
  expect(ownerRemovesAdmin.status === 200, "the owner can remove an admin");

  // Nobody can remove the owner — an org with no owner has nobody who can pay
  // for it or add anyone back.
  const removeOwner = await removeMemberHandler(
    authed("usr_owner", { method: "DELETE", params: { userId: "usr_owner" } }), env,
  );
  expect(removeOwner.status === 409, `the owner cannot be removed (got ${removeOwner.status})`);
}

// ---------------------------------------------------------------------------
console.log("\nthe seat cap\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const mailbox = makeMailbox();
  // Two seats, one already used by the owner. Exactly one invite may go out.
  await seedOwner(env, {
    userId: "usr_cap", email: "cap@example.com", plan: "paid", subStatus: "active", seats: 2,
  });

  const first = await inviteMemberHandler(
    authed("usr_cap", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "one@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  expect(first.status === 201, "the second seat can be invited into");

  const second = await inviteMemberHandler(
    authed("usr_cap", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "two@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  const body = await second.json();
  expect(second.status === 402, `exceeding the seat count is a 402 (got ${second.status})`);
  expect(body.error === "seat_limit_reached", "error is seat_limit_reached");
  expect(body.seatsUsed === 2 && body.seatsPurchased === 2,
    `the response names the numbers (${body.seatsUsed} of ${body.seatsPurchased})`);
  expect(/2 of 2/.test(body.message), "and so does the message");
  expect(mailbox.sent.length === 1, "no email is sent for the refused invite");

  // The seat that blocked it is an UNACCEPTED invite. Counting only accepted
  // members would let an admin issue twenty invites against two seats and
  // discover the problem at the far end, one confused invitee at a time.
  expect(/haven't been accepted/.test(body.message),
    "the message explains that outstanding invites hold seats");

  // Re-inviting the same address reuses its seat rather than claiming another.
  const reinvite = await inviteMemberHandler(
    authed("usr_cap", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "one@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  expect(reinvite.status === 201, "re-inviting a pending address is allowed (same seat)");
}

// ---------------------------------------------------------------------------
console.log("\ninvites are single-use\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const mailbox = makeMailbox();
  const orgId = await seedOwner(env, {
    userId: "usr_inv", email: "inv@example.com", plan: "paid", subStatus: "active", seats: 4,
  });
  await seedLooseUser(env, "usr_joiner", "joiner@example.com");

  await inviteMemberHandler(
    authed("usr_inv", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "joiner@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  const link  = mailbox.sent[0].text.match(/invite=([A-Za-z0-9_-]+)/);
  const token = link && decodeURIComponent(link[1]);
  expect(!!token, "the invite email carries a token");

  const accept = await acceptInviteHandler(
    authed("usr_joiner", { method: "POST", url: "https://algosize.com/api/org/invite/accept", body: { token } }), env,
  );
  const acceptBody = await accept.json();
  expect(accept.status === 200, `the invite is accepted (got ${accept.status})`);
  expect(acceptBody.orgId === orgId, "and joins the right org");

  const membership = await getMembership(env, orgId, "usr_joiner");
  expect(membership && membership.role === "member", "membership row created with the invited role");

  const active = await getActiveOrg(env, "usr_joiner");
  expect(active && active.org.orgId === orgId,
    "the joined org becomes the one they act as (otherwise they keep resolving to a free personal org)");

  const ent = await resolveEntitlement(env, "usr_joiner", { now: NOW });
  expect(ent.active === true, "and the seat delivers paid access immediately");

  // Second use of the same token must fail.
  await seedLooseUser(env, "usr_thief", "joiner@example.com2");
  const replay = await acceptInviteHandler(
    authed("usr_joiner", { method: "POST", url: "https://algosize.com/api/org/invite/accept", body: { token } }), env,
  );
  const replayBody = await replay.json();
  expect(replay.status === 404, `re-using the invite token fails (got ${replay.status})`);
  expect(replayBody.error === "invite_invalid", "with invite_invalid — single use means single use");

  // An invite addressed to one email cannot be redeemed by another account.
  await inviteMemberHandler(
    authed("usr_inv", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "intended@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  const t2 = decodeURIComponent(mailbox.sent[mailbox.sent.length - 1].text.match(/invite=([A-Za-z0-9_-]+)/)[1]);
  await seedLooseUser(env, "usr_wrong", "wrong@example.com");
  const mismatched = await acceptInviteHandler(
    authed("usr_wrong", { method: "POST", url: "https://algosize.com/api/org/invite/accept", body: { token: t2 } }), env,
  );
  expect(mismatched.status === 403,
    `an invite cannot be redeemed by a different account (got ${mismatched.status})`);
}

{
  // The cap is re-checked at redemption, not only at invite time: seats can
  // fill, or the subscription downgrade, in the days a link sits in an inbox.
  const env = makeEnv();
  const mailbox = makeMailbox();
  const orgId = await seedOwner(env, {
    userId: "usr_late", email: "late@example.com", plan: "paid", subStatus: "active", seats: 2,
  });
  await seedLooseUser(env, "usr_slow", "slow@example.com");

  await inviteMemberHandler(
    authed("usr_late", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "slow@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );
  const token = decodeURIComponent(mailbox.sent[0].text.match(/invite=([A-Za-z0-9_-]+)/)[1]);

  // Meanwhile the seat gets taken by someone else joining directly.
  await seedLooseUser(env, "usr_fast", "fast@example.com");
  await addMemberRow(env, orgId, "usr_fast", "member");

  const late = await acceptInviteHandler(
    authed("usr_slow", { method: "POST", url: "https://algosize.com/api/org/invite/accept", body: { token } }), env,
  );
  const lateBody = await late.json();
  expect(late.status === 402, `redeeming into a full org is refused (got ${late.status})`);
  expect(lateBody.error === "seat_limit_reached", "with seat_limit_reached at the redemption end too");
}

// ---------------------------------------------------------------------------
console.log("\nGET /api/org, signup, and checkout quantity\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const mailbox = makeMailbox();
  const orgId = await seedOwner(env, {
    userId: "usr_view", email: "view@example.com", plan: "paid", subStatus: "active", seats: 5,
  });
  await seedLooseUser(env, "usr_v2", "v2@example.com");
  await addMemberRow(env, orgId, "usr_v2", "member");
  await inviteMemberHandler(
    authed("usr_view", { method: "POST", url: "https://algosize.com/api/org/invite", body: { email: "pending@example.com" } }),
    env, {}, { sendTransactional: mailbox.send },
  );

  const res = await getOrgHandler(authed("usr_view"), env);
  const body = await res.json();
  expect(res.status === 200, "GET /api/org returns 200");
  expect(body.members.length === 2, `members are listed (got ${body.members.length})`);
  expect(body.members[0].role === "owner", "owner sorts first");
  expect(body.members[0].email === "view@example.com", "members carry their email");
  expect(body.org.seatsPurchased === 5, "seats purchased reported");
  expect(body.org.seatsUsed === 3, `seats used counts members + pending invites (got ${body.org.seatsUsed})`);
  expect(body.pendingInvites.length === 1, "pending invites are listed");
  expect(body.role === "owner", "the caller's own role is reported so the UI can hide actions");

  // A member sees the org but is not granted management by seeing it.
  const memberView = await getOrgHandler(authed("usr_v2"), env);
  const memberBody = await memberView.json();
  expect(memberView.status === 200 && memberBody.role === "member",
    "a member can read the org, reported as role member");
}

{
  // Signup must create an org, or the new user resolves to no_org and is
  // refused everything.
  const env = makeEnv();
  const { user } = await createFreeUser(env, { email: "fresh@example.com" });
  const active = await getActiveOrg(env, user.userId);
  expect(!!active, "a fresh signup owns an organisation");
  expect(active && active.role === "owner", "as its owner");
  expect(active && active.org.plan === "free", "which starts on the free plan");

  const ent = await resolveEntitlement(env, user.userId, { now: NOW });
  expect(ent.reason === ENTITLEMENT_REASON.FREE_PLAN,
    `and resolves as a free plan, not no_org (got ${ent.reason})`);
}

{
  // createCheckoutSession must send the seat count instead of a hardcoded "1".
  const calls = [];
  const fakeEnv = {
    STRIPE_SECRET_KEY: "sk_test_FAKE",
    STRIPE_PRICE_ID:   "price_test_monthly",
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(new URLSearchParams(init.body));
    return new Response(JSON.stringify({ id: "cs_1", url: "https://stripe.test/x" }),
                        { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await createCheckoutSession(fakeEnv, { successUrl: "https://x/s", cancelUrl: "https://x/c", quantity: 7, orgId: "org_abc" });
    await createCheckoutSession(fakeEnv, { successUrl: "https://x/s", cancelUrl: "https://x/c" });
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(calls[0].get("line_items[0][quantity]") === "7",
    `seat quantity reaches Stripe (got ${calls[0].get("line_items[0][quantity]")})`);
  expect(calls[0].get("client_reference_id") === "org_abc",
    "org id is sent as client_reference_id");
  expect(calls[0].get("subscription_data[metadata][org_id]") === "org_abc",
    "and on the subscription metadata, so later subscription events resolve without guessing");
  expect(calls[1].get("line_items[0][quantity]") === "1",
    "omitting quantity still means one seat — existing callers are unchanged");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all org tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} org test(s) failed\x1b[0m\n`);
  process.exit(1);
}
