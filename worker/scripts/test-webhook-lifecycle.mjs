// Tests for the Stripe subscription-lifecycle webhooks.
//
// Before these events were handled, the webhook knew about exactly two moments
// — the first payment and the cancellation — so everything in between was
// invisible:
//
//   - A tier or seat-count change made in the Customer Portal never reached
//     our database. The customer's invoice and their entitlement drifted apart
//     and nothing ever reconciled them.
//   - A failed payment produced no status change and no email. A subscription
//     could die of an expired card without the customer ever being told.
//   - A trial converted to a paid charge with no warning.
//
// Each block below is one of those gaps. The last two are the properties that
// have to hold no matter which event is being handled: a redelivered event id
// is deduped, and a failed payment sends exactly one email.
//
// Run with:  node scripts/test-webhook-lifecycle.mjs

import { stripeWebhookHandler } from "../src/handlers/webhook.js";
import { buildSignatureHeader } from "../src/stripe.js";
import { getOrgByCustomerId } from "../src/handlers/_orgs.js";
import { resolveEntitlement, ENTITLEMENT_REASON } from "../src/entitlement.js";
import { makeD1 } from "./_d1-stub.mjs";

const SECRET = "whsec_lifecycle_test_secret_xxxxxxxxxxxxxx";

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

// Records every send instead of talking to Gmail, so "exactly one email" is
// an assertion on a real count rather than on a log line.
function makeMailbox() {
  const sent = [];
  const send = async (env, ctx, msg) => { sent.push(msg); return { sent: true, messageId: `m${sent.length}` }; };
  return { sent, send };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET: "lifecycle-test-jwt-secret-32-or-more-chars",
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    STRIPE_WEBHOOK_SECRET: SECRET,
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    ...overrides,
  };
}

async function deliver(env, event, mailbox) {
  const body = JSON.stringify(event);
  const sig  = await buildSignatureHeader(body, SECRET, Math.floor(Date.now() / 1000));
  const req  = new Request("http://x/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": sig, "Content-Type": "application/json" },
    body,
  });
  const res = await stripeWebhookHandler(req, env, {}, mailbox ? { sendTransactional: mailbox.send } : undefined);
  return { res, body: await res.json() };
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/**
 * Seed a paying customer the way checkout.session.completed would: a user for
 * identity, an organisation holding the Stripe customer and the subscription
 * state, and an owner membership joining them. Billing lives on the org since
 * migrations/0004, so seeding only a user row would leave every lifecycle
 * handler with no org to write to.
 */
async function seedCustomer(env, { customerId, email, subStatus = "active", periodEnd = NOW + 30 * DAY, seats = 1 }) {
  const userId = `usr_${customerId}`;
  const orgId  = `org_${customerId}`;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status,
                        active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?, ?)`,
  ).bind(userId, email, orgId, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status,
                                current_period_end, seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?)`,
  ).bind(orgId, email, customerId, subStatus, periodEnd, seats, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
  ).bind(orgId, userId, NOW).run();
  return { userId, orgId };
}

/** A Stripe subscription object with one line item. */
function subscription({ id = "sub_1", customer, status = "active", periodEnd = NOW + 30 * DAY,
                        quantity = 1, priceId = "price_pro_monthly", unitAmount = 2900, trialEnd }) {
  return {
    id, customer, status,
    current_period_end: periodEnd,
    trial_end: trialEnd,
    items: { data: [{ id: "si_1", quantity, price: { id: priceId, unit_amount: unitAmount, currency: "usd" } }] },
  };
}

// ---------------------------------------------------------------------------
console.log("\ncustomer.subscription.created / .updated — the Portal reaches the database\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  await seedCustomer(env, { customerId: "cus_SEATS", email: "seats@example.com" });

  const { res, body } = await deliver(env, {
    id: "evt_sub_updated_seats",
    type: "customer.subscription.updated",
    data: { object: subscription({ customer: "cus_SEATS", quantity: 20, priceId: "price_team_annual" }) },
  });

  expect(res.status === 200, "subscription.updated → 200");
  expect(body.handled === "customer.subscription.updated", "reported as handled");

  const org = await getOrgByCustomerId(env, "cus_SEATS");
  expect(org.seatsPurchased === 20, `seat count reached the database (got ${org.seatsPurchased})`);
  expect(org.priceId === "price_team_annual", `tier change reached the database (got ${org.priceId})`);
  expect(org.subStatus === "active", "status mirrored from the subscription");
}

{
  // .created for a customer we already know — same path, and the status is
  // taken from Stripe rather than assumed.
  const env = makeEnv();
  const seeded = await seedCustomer(env, { customerId: "cus_NEW", email: "new@example.com", subStatus: "inactive" });

  await deliver(env, {
    id: "evt_sub_created",
    type: "customer.subscription.created",
    data: { object: subscription({ customer: "cus_NEW", status: "trialing", quantity: 3, trialEnd: NOW + 14 * DAY }) },
  });

  const org = await getOrgByCustomerId(env, "cus_NEW");
  expect(org.subStatus === "trialing", "trialing status stored verbatim, not flattened to active/inactive");
  expect(org.seatsPurchased === 3, "seat count stored on .created");

  const ent = await resolveEntitlement(env, seeded.userId, { now: NOW });
  expect(ent.active === true, "a trialing subscriber is entitled");
  expect(ent.reason === ENTITLEMENT_REASON.TRIALING, `entitlement reason is trialing (got ${ent.reason})`);
}

{
  // The status that must NOT entitle: `incomplete` means the first payment
  // never succeeded, yet Stripe still stamps a period end on it. Treating that
  // period end as a grace window would hand a free month to anyone who opens
  // checkout and abandons it at the card form.
  const env = makeEnv();
  const seeded = await seedCustomer(env, { customerId: "cus_INC", email: "inc@example.com", subStatus: "inactive" });

  await deliver(env, {
    id: "evt_sub_incomplete",
    type: "customer.subscription.created",
    data: { object: subscription({ customer: "cus_INC", status: "incomplete", periodEnd: NOW + 30 * DAY }) },
  });

  const org = await getOrgByCustomerId(env, "cus_INC");
  const ent  = await resolveEntitlement(env, seeded.userId, { now: NOW });
  expect(ent.active === false, "an incomplete subscription is NOT entitled despite a future period end");
  expect(ent.reason === ENTITLEMENT_REASON.NOT_ENTITLING_STATUS,
         `entitlement reason is not_entitling_status (got ${ent.reason})`);
}

{
  // A subscription for a customer we've never seen. The email is recoverable
  // from the expanded customer object, so the row gets created rather than the
  // seat count being lost until the next update.
  const env = makeEnv();
  const { res } = await deliver(env, {
    id: "evt_sub_unknown_cust",
    type: "customer.subscription.created",
    data: { object: subscription({
      customer: { id: "cus_GHOST", email: "ghost@example.com" },
      quantity: 5, priceId: "price_team_annual",
    }) },
  });

  expect(res.status === 200, "subscription for an unknown customer → 200 (not a retry loop)");
  const org = await getOrgByCustomerId(env, "cus_GHOST");
  expect(!!org, "a user row was created from the expanded customer email");
  expect(org && org.name === "ghost@example.com", "created with the right email");
  expect(org && org.seatsPurchased === 5, "seat count was not lost on the create path");
  expect(org && org.priceId === "price_team_annual", "tier was not lost on the create path");
}

// ---------------------------------------------------------------------------
console.log("\ninvoice.paid — renewal clears past_due\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const seeded = await seedCustomer(env, { customerId: "cus_PAID", email: "paid@example.com",
                            subStatus: "past_due", periodEnd: NOW - DAY });

  const newPeriodEnd = NOW + 30 * DAY;
  const { res, body } = await deliver(env, {
    id: "evt_invoice_paid",
    type: "invoice.paid",
    data: { object: {
      id: "in_1", customer: "cus_PAID", amount_due: 2900, currency: "usd",
      lines: { data: [{ period: { start: NOW, end: newPeriodEnd } }] },
    } },
  });

  expect(res.status === 200, "invoice.paid → 200");
  expect(body.handled === "invoice.paid", "invoice.paid is handled, not swallowed by the default branch");

  const org = await getOrgByCustomerId(env, "cus_PAID");
  expect(org.subStatus === "active", `past_due cleared back to active (got ${org.subStatus})`);
  expect(org.currentPeriodEnd === newPeriodEnd, "paid-through date advanced to the new period");

  const ent = await resolveEntitlement(env, seeded.userId, { now: NOW });
  expect(ent.active === true, "the renewed subscriber is entitled again");
}

// ---------------------------------------------------------------------------
console.log("\ninvoice.payment_failed — past_due plus one dunning email\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const mailbox = makeMailbox();
  const periodEnd = NOW + 10 * DAY;
  const seeded = await seedCustomer(env, { customerId: "cus_FAIL", email: "fail@example.com", periodEnd });

  const failedInvoice = {
    id: "evt_invoice_failed",
    type: "invoice.payment_failed",
    data: { object: {
      id: "in_fail", customer: "cus_FAIL", amount_due: 2900, currency: "usd",
      attempt_count: 1, hosted_invoice_url: "https://invoice.stripe.com/i/test_abc",
    } },
  };

  const { res } = await deliver(env, failedInvoice, mailbox);
  expect(res.status === 200, "invoice.payment_failed → 200");

  const org = await getOrgByCustomerId(env, "cus_FAIL");
  expect(org.subStatus === "past_due", `status set to past_due (got ${org.subStatus})`);

  expect(mailbox.sent.length === 1, `exactly one dunning email sent (got ${mailbox.sent.length})`);
  const mail = mailbox.sent[0];
  expect(mail.to === "fail@example.com", "dunning email addressed to the customer");
  expect(/didn't go through/i.test(mail.subject), "subject says the payment failed");
  expect(mail.text.includes("$29.00"), "email states the amount that failed");
  expect(mail.text.includes("https://invoice.stripe.com/i/test_abc"),
         "email links to the hosted invoice so they can pay without signing in");
  expect(/free tier/i.test(mail.text), "email says what breaks: the account drops to the free tier");

  // Dunning must not cut access off on the first failure — that is what the
  // two weeks of Stripe retries are for.
  const ent = await resolveEntitlement(env, seeded.userId, { now: NOW });
  expect(ent.active === true, "past_due keeps access until the period ends (dunning, not a cliff)");
  expect(ent.reason === ENTITLEMENT_REASON.GRACE_PERIOD, `reason is grace_period (got ${ent.reason})`);

  // ...but it does end when the period does.
  const later = await resolveEntitlement(env, seeded.userId, { now: periodEnd + 1 });
  expect(later.active === false, "past_due past the period end finally drops to free");

  // A redelivery of the SAME event must not send a second email.
  const { body: replayBody } = await deliver(env, failedInvoice, mailbox);
  expect(replayBody.deduped === true, "redelivered payment_failed is deduped");
  expect(mailbox.sent.length === 1,
         `redelivery sent no second email (still ${mailbox.sent.length})`);
}

// ---------------------------------------------------------------------------
console.log("\ncustomer.subscription.trial_will_end — the 3-day reminder\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const mailbox = makeMailbox();
  const trialEnd = NOW + 3 * DAY;
  await seedCustomer(env, { customerId: "cus_TRIAL", email: "trial@example.com", subStatus: "trialing" });

  const event = {
    id: "evt_trial_will_end",
    type: "customer.subscription.trial_will_end",
    data: { object: subscription({ customer: "cus_TRIAL", status: "trialing", trialEnd }) },
  };

  const { res, body } = await deliver(env, event, mailbox);
  expect(res.status === 200, "trial_will_end → 200");
  expect(body.handled === "customer.subscription.trial_will_end", "reported as handled");

  expect(mailbox.sent.length === 1, `exactly one trial reminder sent (got ${mailbox.sent.length})`);
  const mail = mailbox.sent[0];
  expect(/trial ends in 3 days/i.test(mail.subject), "subject names the 3-day window");
  expect(mail.text.includes("$29.00"), "reminder states what they'll be charged");
  expect(/cancel/i.test(mail.text), "reminder tells them how to not be charged");

  // The subscription itself is unchanged — nothing has happened yet.
  const org = await getOrgByCustomerId(env, "cus_TRIAL");
  expect(org.subStatus === "trialing", "trial_will_end does not change the stored status");

  const { body: replayBody } = await deliver(env, event, mailbox);
  expect(replayBody.deduped === true, "redelivered trial_will_end is deduped");
  expect(mailbox.sent.length === 1, "redelivery sent no second reminder");
}

// ---------------------------------------------------------------------------
console.log("\nthe switch stays exhaustive\n");
// ---------------------------------------------------------------------------

{
  // Adding five handled types must not change what happens to the hundreds of
  // event types Stripe sends that we have no opinion about.
  const env = makeEnv();
  const mailbox = makeMailbox();

  for (const type of ["customer.discount.created", "payment_intent.succeeded", "charge.refunded"]) {
    const { res, body } = await deliver(env, { id: `evt_unhandled_${type}`, type, data: { object: {} } }, mailbox);
    expect(res.status === 200 && body.received === true && body.handled === false,
           `${type} → { received: true, handled: false }`);
  }
  expect(mailbox.sent.length === 0, "unhandled event types send no email");
}

{
  // An event whose object is missing the customer id is a malformed delivery,
  // not a transient failure: ack it rather than 500ing into a retry loop that
  // can never succeed.
  const env = makeEnv();
  const mailbox = makeMailbox();
  const { res } = await deliver(env, {
    id: "evt_no_customer",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_orphan", status: "active" } },
  }, mailbox);
  expect(res.status === 200, "subscription event with no customer id is acked, not retried forever");
  expect(mailbox.sent.length === 0, "and sends no email");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all webhook-lifecycle tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} webhook-lifecycle test(s) failed\x1b[0m\n`);
  process.exit(1);
}
