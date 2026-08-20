// Tests for the account-management API (migrations/0015).
//
// The properties that would hurt most if they broke, in that order:
//
//   1. An email change cannot lock anyone out. It is staged, not applied;
//      the confirmation goes to the NEW address; the OLD address is told; and
//      nothing moves until the token comes back. Every one of those is load-
//      bearing, because the login email IS the credential.
//   2. An API key cannot manage an account. requireAuth accepts keys, so a
//      leaked key would otherwise be able to move the login address — turning
//      a key compromise into an account takeover.
//   3. Credit is a ledger. The balance is the sum of its events, credit that
//      did not reach Stripe is reported rather than hidden, and a redelivered
//      webhook cannot credit twice.
//   4. Notification preferences store diffs, and the two locked billing rows
//      refuse to be switched off rather than pretending to save.
//   5. Deleting an organisation cancels Stripe FIRST and aborts the whole
//      operation if that fails.
//
// Run with:  node scripts/test-account.mjs

import {
  getAccountHandler,
  updateProfileHandler,
  requestEmailChangeHandler,
  confirmEmailChangeHandler,
  cancelEmailChangeHandler,
  listSessionsHandler,
  revokeSessionHandler,
  getNotificationsHandler,
  updateNotificationsHandler,
  initialsFor,
  describeDevice,
} from "../src/handlers/account.js";
import { deleteOrgHandler, deletePreviewHandler, exportAccountHandler } from "../src/handlers/account_danger.js";
import { getReferralsHandler, referralLandingHandler, readReferralCookie } from "../src/handlers/referrals.js";
import { creditBalance, listCreditEvents, earnCredit, formatCents, REFERRAL_CREDIT_CENTS } from "../src/credits.js";
import {
  getOrCreateReferralCode, attributeSignup, pendingReferralForOrg, setReferralStage,
} from "../src/referrals.js";
import {
  readNotificationPrefs, writeNotificationPrefs, defaultFor, isLocked, NOTIFICATIONS,
} from "../src/notifications.js";
import { safeDomain, verifyDomain, cnameTarget } from "../src/domains.js";
import { safeAccent, contrastWithWhite, brandingFor } from "../src/reports/branding.js";
import { issueJWT } from "../src/auth.js";
import { listAuditEvents, AUDIT_ACTIONS } from "../src/audit.js";
import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function makeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET: "account-test-jwt-secret-32-chars-or-more!!",
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS: makeKV(),
    DB: makeD1(),
    ...overrides,
  };
}

/** Everything a signed-in owner needs: a user, an org, a membership. */
async function seedOwner(env, {
  userId = "usr_dana", email = "dana@northgate.co.uk", orgName = "Northgate Partners",
  plan = "paid", subStatus = "active", periodEnd = NOW + 20 * DAY,
  customer = "cus_north", priceId = "price_firm_monthly", seats = 10,
} = {}) {
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?)`).bind(userId, email, NOW, NOW).run();
  const orgId = "org_" + userId;
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status,
       current_period_end, seats_purchased, price_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(orgId, orgName, customer, plan, subStatus, periodEnd, seats, priceId, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,?,'owner',?)")
    .bind(orgId, userId, NOW).run();
  await env.DB.prepare("UPDATE users SET active_org_id = ? WHERE user_id = ?").bind(orgId, userId).run();
  return { userId, email, orgId };
}

function authed(userId, email, { method = "GET", url = "https://algosize.com/api/account",
                                 body, params, authMethod = "session", token } = {}) {
  const req = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  req.user = { userId, email };
  req.authMethod = authMethod;
  if (token) req.token = token;
  if (params) req.params = params;
  return req;
}

const readJson = async (res) => { try { return await res.json(); } catch { return null; } };

// ===========================================================================
group("changing the login email cannot lock anyone out");
// ===========================================================================
{
  const env = makeEnv();
  const { userId, email } = await seedOwner(env);
  const mails = [];
  // Capture what would be sent without a Gmail credential.
  env.GOOGLE_SERVICE_ACCOUNT_JSON = undefined;

  const res = await requestEmailChangeHandler(
    authed(userId, email, { method: "POST", body: { email: "dana@northgate.legal" } }),
    env, { waitUntil: (p) => mails.push(p) });
  const body = await readJson(res);
  expect(res.status === 200 && body.ok, "a change can be requested");
  expect(body.pendingEmailChange.newEmail === "dana@northgate.legal", "…and is reported as pending");

  // The row exists; the user row does NOT.
  const still = await env.DB.prepare("SELECT email FROM users WHERE user_id = ?").bind(userId).first();
  expect(still.email === email,
    "the login email has NOT moved — a staged change that applied immediately could lock someone out");
  const staged = await env.DB.prepare("SELECT new_email, token_hash FROM email_changes WHERE user_id = ?")
    .bind(userId).first();
  expect(staged && staged.new_email === "dana@northgate.legal", "the change is staged");
  expect(staged.token_hash && staged.token_hash.length === 64 && !/[^0-9a-f]/.test(staged.token_hash),
    "only the token's SHA-256 is stored — a leaked row must not be a usable takeover token");

  // Requesting again replaces rather than accumulating.
  await requestEmailChangeHandler(
    authed(userId, email, { method: "POST", body: { email: "dana@second.example" } }),
    env, { waitUntil: () => {} });
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_changes WHERE user_id = ?")
    .bind(userId).first();
  expect(Number(rows.n) === 1, "starting a second change replaces the first, rather than leaving two live tokens");

  // An address already in use is refused BEFORE the user clicks a link.
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, plan, created_at, updated_at) VALUES (?,?,'free',?,?)`)
    .bind("usr_other", "taken@example.com", NOW, NOW).run();
  const clash = await requestEmailChangeHandler(
    authed(userId, email, { method: "POST", body: { email: "taken@example.com" } }),
    env, { waitUntil: () => {} });
  expect(clash.status === 409, "an address that already has an account is refused up front, not at confirm time");

  // Cancelling clears it.
  const cancelled = await cancelEmailChangeHandler(authed(userId, email, { method: "DELETE" }), env, null);
  expect((await readJson(cancelled)).cancelled === true, "a pending change can be abandoned");
  const gone = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_changes WHERE user_id = ?")
    .bind(userId).first();
  expect(Number(gone.n) === 0, "…and the staged row is removed");
}

{
  // The confirm half, driven with a known token.
  const env = makeEnv();
  const { userId, email } = await seedOwner(env, { userId: "usr_c", email: "c@old.example" });
  const token = "known-test-token";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(
    `INSERT INTO email_changes (user_id, new_email, token_hash, created_at, expires_at)
     VALUES (?,?,?,?,?)`).bind(userId, "c@new.example", hash, NOW, NOW + 1800).run();

  // Sessions exist before the change.
  await issueJWT(env, userId, email, "active", { authMethod: "magic_link" });
  await issueJWT(env, userId, email, "active", { authMethod: "magic_link" });

  const req = new Request(`https://algosize.com/api/account/email/confirm?token=${token}`);
  const res = await confirmEmailChangeHandler(req, env, null);
  expect(res.status === 302 && /email=changed/.test(res.headers.get("Location")),
    "a valid token applies the change and redirects with the outcome");

  const row = await env.DB.prepare("SELECT email FROM users WHERE user_id = ?").bind(userId).first();
  expect(row.email === "c@new.example", "the login email has moved");

  const left = [...env.SESSIONS._store.keys()].filter((k) => k.startsWith("sess:"));
  expect(left.length === 0,
    "every session is revoked — if the change was made by someone who took the account over, " +
    "the real owner needs their sessions gone");

  // Replay.
  const again = await confirmEmailChangeHandler(
    new Request(`https://algosize.com/api/account/email/confirm?token=${token}`), env, null);
  expect(/email=expired_or_invalid/.test(again.headers.get("Location")),
    "the token is single-use — a double-click cannot apply the change twice");

  const { events } = await listAuditEvents(env, { action: AUDIT_ACTIONS.EMAIL_CHANGED });
  expect(events.length === 1 && events[0].metadata.to === "c@new.example",
    "the change is audited with both sides");
}

{
  const env = makeEnv();
  const { userId, email } = await seedOwner(env, { userId: "usr_x", email: "x@old.example" });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("expired-token"));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(
    `INSERT INTO email_changes (user_id, new_email, token_hash, created_at, expires_at)
     VALUES (?,?,?,?,?)`).bind(userId, "x@new.example", hash, NOW - 7200, NOW - 3600).run();

  const res = await confirmEmailChangeHandler(
    new Request("https://algosize.com/api/account/email/confirm?token=expired-token"), env, null);
  expect(/email=expired_or_invalid/.test(res.headers.get("Location")), "an expired token is refused");
  const row = await env.DB.prepare("SELECT email FROM users WHERE user_id = ?").bind(userId).first();
  expect(row.email === "x@old.example", "…and the address is untouched");
}

// ===========================================================================
group("an API key cannot manage an account");
// ===========================================================================
{
  const env = makeEnv();
  const { userId, email } = await seedOwner(env, { userId: "usr_k", email: "k@example.com" });

  // requireAuth sets request.org for a key and never request.user, so these
  // handlers must refuse on authMethod rather than on the absence of a user.
  const cases = [
    ["GET /api/account", getAccountHandler, { method: "GET" }],
    ["PATCH profile", updateProfileHandler, { method: "PATCH", body: { displayName: "Mallory" } }],
    ["POST email", requestEmailChangeHandler, { method: "POST", body: { email: "attacker@evil.example" } }],
    ["GET sessions", listSessionsHandler, { method: "GET" }],
    ["DELETE org", deleteOrgHandler, { method: "DELETE", body: { confirm: "Northgate Partners" } }],
  ];
  for (const [label, handler, opts] of cases) {
    const res = await handler(
      authed(userId, email, { ...opts, authMethod: "api_key" }), env, null);
    const body = await readJson(res);
    expect(res.status === 403 && body.error === "forbidden",
      `${label} refuses an API-key caller (got ${res.status})`);
  }

  // And the login email really is untouched after that attempt.
  const row = await env.DB.prepare("SELECT email FROM users WHERE user_id = ?").bind(userId).first();
  expect(row.email === "k@example.com",
    "a leaked key cannot move the login address — that would turn a key compromise into an account takeover");
}

// ===========================================================================
group("profile — one form, two subjects");
// ===========================================================================
{
  const env = makeEnv();
  const { userId, email, orgId } = await seedOwner(env);

  const res = await updateProfileHandler(authed(userId, email, {
    method: "PATCH", body: { displayName: "Dana Kessler", companyName: "Northgate LLP" },
  }), env, null);
  const body = await readJson(res);
  expect(res.status === 200 && body.ok, "an owner can save both halves");
  expect(body.profile.initials === "DK", "initials come from the server so every surface agrees");

  const org = await env.DB.prepare("SELECT name FROM organisations WHERE org_id = ?").bind(orgId).first();
  expect(org.name === "Northgate LLP", "the org rename applied");

  // A member gets their own fields saved and an explicit refusal for the org.
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, plan, active_org_id, created_at, updated_at)
     VALUES (?,?,'free',?,?,?)`).bind("usr_mem", "mem@example.com", orgId, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,?,'member',?)")
    .bind(orgId, "usr_mem", NOW).run();

  const partial = await updateProfileHandler(authed("usr_mem", "mem@example.com", {
    method: "PATCH", body: { displayName: "Sam", companyName: "Hostile Rename Ltd" },
  }), env, null);
  const pb = await readJson(partial);
  expect(partial.status === 200 && pb.refused && pb.refused.error === "forbidden",
    "a member's org rename is refused explicitly rather than with a blanket 403");
  expect(pb.profile.displayName === "Sam",
    "…while the change they WERE entitled to make is still saved");
  const unchanged = await env.DB.prepare("SELECT name FROM organisations WHERE org_id = ?").bind(orgId).first();
  expect(unchanged.name === "Northgate LLP", "the org name did not move");

  // An avatar is an <img src> in a page — https only, checked on write.
  const bad = await updateProfileHandler(authed(userId, email, {
    method: "PATCH", body: { avatarUrl: "javascript:alert(1)" },
  }), env, null);
  expect(bad.status === 400 && (await readJson(bad)).error === "invalid_avatar_url",
    "a javascript: avatar URL is refused");
  const httpAvatar = await updateProfileHandler(authed(userId, email, {
    method: "PATCH", body: { avatarUrl: "http://example.com/a.png" },
  }), env, null);
  expect(httpAvatar.status === 400, "…and so is a plain-http one");
}

{
  expect(initialsFor({ displayName: "Dana Kessler" }) === "DK", "initials from a full name");
  expect(initialsFor({ email: "finance@northgate.co.uk" }) === "FI", "…from an email when there is no name");
  expect(initialsFor({}) === "?",
    "…and never an empty string — a blank avatar circle reads as a rendering bug");
  expect(describeDevice("Mozilla/5.0 (Macintosh) AppleWebKit Chrome/120 Safari/537") === "Chrome on macOS",
    "a user agent becomes something a person recognises");
  expect(describeDevice("some-unparseable-agent") === null,
    "…and an unparseable one is null rather than a guess");
}

// ===========================================================================
group("credit is a ledger, not a column");
// ===========================================================================
{
  const env = makeEnv();
  const { orgId } = await seedOwner(env);

  const empty = await creditBalance(env, orgId);
  expect(empty.balanceCents === 0 && empty.complete === true,
    "an org with no events has a zero balance, and we know it is zero");

  // No Stripe key configured: the ledger row is still written, and the
  // absence of a Stripe transaction is reported rather than treated as failure.
  const grant = await earnCredit(env, {
    orgId, stripeCustomerId: "cus_north", amountCents: REFERRAL_CREDIT_CENTS,
    description: "Earned — Meridian Legal first invoice paid",
  });
  expect(grant.ok && grant.eventId, "credit is recorded even with no Stripe configured");
  expect(grant.stripeTxnId === null && grant.reason === "no_stripe_customer",
    "…and reports that it has not reached Stripe rather than claiming success");

  const after = await creditBalance(env, orgId);
  expect(after.balanceCents === REFERRAL_CREDIT_CENTS, "the balance is the sum of the events");
  expect(after.unsyncedCents === REFERRAL_CREDIT_CENTS,
    "credit our ledger has and Stripe does not is surfaced, not hidden — a discount that " +
    "silently fails to apply is a billing dispute after the invoice");

  // Applying it is a negative event; the balance follows the sum.
  const { recordCreditEvent } = await import("../src/credits.js");
  await recordCreditEvent(env, {
    orgId, kind: "applied", amountCents: -5000, description: "Applied to invoice NGP-1",
  });
  const applied = await creditBalance(env, orgId);
  expect(applied.balanceCents === REFERRAL_CREDIT_CENTS - 5000,
    "applying credit moves the balance by summing, with no balance column to drift");

  const { events } = await listCreditEvents(env, orgId);
  expect(events.length === 2 && events[0].kind === "applied",
    "the history reads newest first and keeps both events");
  expect(events[1].syncedToStripe === false,
    "each row says individually whether Stripe knows about it");

  expect(formatCents(12000) === "$120.00", "money formats once, on the server");
  expect(formatCents(-5000) === "-$50.00", "…including negatives");
  expect(formatCents(5) === "$0.05", "…and sub-dollar amounts");
}

// ===========================================================================
group("referrals — the funnel only moves forward, and only on payment");
// ===========================================================================
{
  const env = makeEnv();
  const a = await seedOwner(env, { userId: "usr_ref", email: "ref@example.com", orgName: "Referrer Ltd" });
  const b = await seedOwner(env, {
    userId: "usr_new", email: "new@example.com", orgName: "Newco",
    customer: "cus_new", plan: "free", subStatus: null, periodEnd: null,
  });

  const code = await getOrCreateReferralCode(env, a.orgId, "Referrer Ltd");
  expect(code && /^referrer-ltd-[a-z0-9]{8}$/.test(code.code),
    `the code is slug + 8 random chars, not something guessable (${code && code.code})`);

  const same = await getOrCreateReferralCode(env, a.orgId, "Referrer Ltd");
  expect(same.code === code.code, "…and is stable once issued");

  const self = await attributeSignup(env, code.code, { referredOrgId: a.orgId, label: "Referrer Ltd" });
  expect(!self.attributed && self.reason === "self_referral", "an org cannot refer itself");

  const unknown = await attributeSignup(env, "nobody-12345678", { referredOrgId: b.orgId, label: "Newco" });
  expect(!unknown.attributed && unknown.reason === "unknown_code", "an unknown code is refused by name");

  const good = await attributeSignup(env, code.code, { referredOrgId: b.orgId, label: "Newco" });
  expect(good.attributed, "a real signup is attributed");

  const dupe = await attributeSignup(env, code.code, { referredOrgId: b.orgId, label: "Newco" });
  expect(!dupe.attributed,
    "an org is referred by exactly one referrer — the first link they came through is the one that counts");

  const spent = await env.DB.prepare("SELECT signups_used FROM referral_codes WHERE org_id = ?")
    .bind(a.orgId).first();
  expect(Number(spent.signups_used) === 1, "one attribution, one signup off the allowance");

  // Signing up is not converting.
  const pending = await pendingReferralForOrg(env, b.orgId);
  expect(pending && pending.stage === "signed_up",
    "the referral sits at signed_up — credit is earned on payment, not on signup");

  await setReferralStage(env, pending.referralId, "credited", { creditCents: REFERRAL_CREDIT_CENTS });
  const settled = await pendingReferralForOrg(env, b.orgId);
  expect(settled === null,
    "once credited it is no longer pending, so a redelivered invoice.paid finds nothing to do");
}

{
  // The allowance pauses the link rather than silently dropping attributions.
  const env = makeEnv();
  const a = await seedOwner(env, { userId: "usr_cap", email: "cap@example.com", orgName: "Capped" });
  await getOrCreateReferralCode(env, a.orgId, "Capped");
  await env.DB.prepare("UPDATE referral_codes SET signups_used = signups_limit WHERE org_id = ?")
    .bind(a.orgId).run();

  const res = await getReferralsHandler(authed("usr_cap", "cap@example.com"), env, null);
  const body = await readJson(res);
  expect(body.usage.limitReached === true, "the API reports the link as paused");
  expect(/not withdrawable as cash/i.test(body.terms.cashPolicy),
    "the not-cash policy ships with the data, so every surface that renders a balance carries it");
  expect(body.terms.creditPerReferral === formatCents(REFERRAL_CREDIT_CENTS),
    "the advertised amount comes from the same constant that is actually credited");
}

{
  // The public link: unknown codes still land somewhere sensible.
  const env = makeEnv();
  const a = await seedOwner(env, { userId: "usr_link", email: "l@example.com", orgName: "Linkco" });
  const code = await getOrCreateReferralCode(env, a.orgId, "Linkco");

  const good = await referralLandingHandler(
    Object.assign(new Request("https://algosize.com/api/r/" + code.code), { params: { code: code.code } }),
    env);
  expect(good.status === 302, "the link redirects");
  const cookie = good.headers.get("Set-Cookie") || "";
  expect(cookie.includes("algosize_ref=" + code.code) && /HttpOnly/.test(cookie),
    "…dropping a first-party attribution cookie");
  expect(/SameSite=Lax/.test(cookie), "…scoped SameSite=Lax");

  const bad = await referralLandingHandler(
    Object.assign(new Request("https://algosize.com/api/r/nope"), { params: { code: "nope" } }), env);
  expect(bad.status === 302 && !bad.headers.get("Set-Cookie"),
    "an unknown code still reaches the site — a stranger who was recommended the product " +
    "should not meet a 404");

  const read = readReferralCookie(new Request("https://x/", {
    headers: { Cookie: "a=1; algosize_ref=abc-123; b=2" },
  }));
  expect(read === "abc-123", "the cookie reads back off a request");
}

// ===========================================================================
group("notification preferences store diffs, and locked rows refuse");
// ===========================================================================
{
  const env = makeEnv();
  const { userId, email } = await seedOwner(env, { userId: "usr_n", email: "n@example.com" });

  const first = await readNotificationPrefs(env, userId);
  expect(first.stored === true && Object.keys(first.prefs).length === NOTIFICATIONS.length * 3,
    "every notification × channel has an effective answer");
  expect(first.prefs["scan_done:inapp"] === defaultFor("scan_done", "inapp"),
    "…and with nothing saved they are the defaults");

  // Saving a value equal to the default writes NOTHING, so a later change to
  // that default still reaches everyone who never disagreed with it.
  const same = await writeNotificationPrefs(env, userId, { "scan_done:inapp": true });
  expect(same.cleared === 1 && same.written === 0,
    "agreeing with the default stores no row — the table is a diff, not a snapshot");

  const diff = await writeNotificationPrefs(env, userId, { "scan_done:inapp": false });
  expect(diff.written === 1, "disagreeing with the default stores one");
  const after = await readNotificationPrefs(env, userId);
  expect(after.prefs["scan_done:inapp"] === false, "…and reads back");

  // The locked rows.
  expect(isLocked("pay_failed", "email") && isLocked("plan_changed", "email"),
    "payment-failed and plan-changed are locked on email");
  expect(!isLocked("pay_failed", "slack"), "…only on email");

  const refused = await writeNotificationPrefs(env, userId, { "pay_failed:email": false });
  expect(refused.refused.length === 1 && refused.refused[0] === "pay_failed:email",
    "turning a locked channel off is refused, not silently ignored");
  const stillOn = await readNotificationPrefs(env, userId);
  expect(stillOn.prefs["pay_failed:email"] === true, "…and it stays on");

  const resave = await writeNotificationPrefs(env, userId, { "pay_failed:email": true });
  expect(resave.refused.length === 0,
    "re-sending a locked row as ON is not a refusal — that is what every save does");

  // The HTTP surface says so too.
  const res = await updateNotificationsHandler(authed(userId, email, {
    method: "PUT", body: { prefs: { "pay_failed:email": false } },
  }), env, null);
  const body = await readJson(res);
  expect(res.status === 400 && body.error === "channel_locked",
    "the endpoint 400s rather than reporting a save that did not happen");

  const view = await getNotificationsHandler(authed(userId, email), env, null);
  const vb = await readJson(view);
  const billing = vb.groups.find((g) => g.id === "billing");
  const payRow = billing.rows.find((r) => r.id === "pay_failed");
  expect(payRow.channels.email.locked === true && payRow.channels.email.on === true,
    "the UI is told the channel is locked, so it cannot paint a switch the API would reject");
  expect(vb.slack.configured === false && /nowhere to deliver/.test(vb.slack.note),
    "a Slack toggle with no webhook reports that it has nowhere to deliver");
}

// ===========================================================================
group("branding — accent contrast, and domain verification states");
// ===========================================================================
{
  expect(safeAccent("#1c5f4a") === "#1c5f4a", "a dark accent is accepted");
  expect(safeAccent("#FFEB3B") === null,
    "a pale accent is refused — report buttons draw white text on it, and it would be unreadable");
  expect(safeAccent("red") === null, "a colour name is refused");
  expect(safeAccent("#fff") === null, "…and so is shorthand hex");
  expect(contrastWithWhite("#000000") > 20 && contrastWithWhite("#ffffff") < 1.05,
    "the contrast helper is the right way round");

  // The accent is re-validated at render, like the logo URL.
  const entitled = { active: true };
  const env = { STRIPE_PRICE_FIRM_MONTHLY: "price_firm_monthly" };
  const org = { priceId: "price_firm_monthly", name: "N", brandAccent: "#FFEB3B", brandCompanyName: "N" };
  const branding = brandingFor(env, org, entitled);
  expect(branding.accent === null,
    "an accent that would fail validation today is dropped at render, even though it was stored");
}

{
  expect(safeDomain("Reports.YourFirm.com ") === "reports.yourfirm.com", "a domain is normalised");
  expect(safeDomain("https://reports.yourfirm.com/x") === "reports.yourfirm.com",
    "…out of a pasted URL, because that is what people paste");
  expect(safeDomain("reports.algosize.com") === null,
    "our own domain is refused — it would 'verify' and then collide with the real site");
  expect(safeDomain("localhost") === null, "a single label is refused");
  expect(safeDomain("reports.yourfirm.com:8080") === null, "a port is refused");
}

{
  const env = { REPORT_CNAME_TARGET: "cname.algosize.com" };
  const dnsJson = (answer) => ({
    ok: true, status: 200,
    json: async () => answer,
  });

  const verified = await verifyDomain(env, "reports.x.com", {
    attempts: 0,
    fetchImpl: async () => dnsJson({ Status: 0, Answer: [{ type: 5, data: "cname.algosize.com." }] }),
  });
  expect(verified.status === "verified", "a correct CNAME verifies");

  const missing = await verifyDomain(env, "reports.x.com", {
    attempts: 0,
    fetchImpl: async () => dnsJson({ Status: 3 }),
  });
  expect(missing.status === "pending" && /No CNAME record found/.test(missing.detail),
    "NXDOMAIN is a definite 'not yet', and says so");
  expect(missing.attempts === 1, "…and consumes an attempt");

  const wrong = await verifyDomain(env, "reports.x.com", {
    attempts: 0,
    fetchImpl: async () => dnsJson({ Status: 0, Answer: [{ type: 5, data: "elsewhere.netlify.app." }] }),
  });
  expect(/Found elsewhere\.netlify\.app, expected cname\.algosize\.com/.test(wrong.detail),
    "a wrong record reports what was actually found — a missing record and a wrong one are different fixes");

  const exhausted = await verifyDomain(env, "reports.x.com", {
    attempts: 11,
    fetchImpl: async () => dnsJson({ Status: 3 }),
  });
  expect(exhausted.status === "failed", "the attempt budget eventually gives up");

  const resolverDown = await verifyDomain(env, "reports.x.com", {
    attempts: 5,
    fetchImpl: async () => { throw new Error("network"); },
  });
  expect(resolverDown.status === "pending" && resolverDown.attempts === 5,
    "a lookup that could not be PERFORMED never consumes an attempt — a resolver outage " +
    "must not mark every customer domain as failed");
  expect(/Not counted as an attempt/.test(resolverDown.detail), "…and says so");

  expect(cnameTarget({}) === "cname.algosize.com", "the CNAME target has a default");
}

// ===========================================================================
group("the danger zone states what it will do, then does exactly that");
// ===========================================================================
{
  const env = makeEnv();
  const { userId, email, orgId } = await seedOwner(env, { orgName: "Northgate Partners" });
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind("run_1", userId, orgId, "dashboard", "vuln", "{}", "{}", 12, "1 critical", Date.now()).run();
  await earnCredit(env, { orgId, stripeCustomerId: null, amountCents: 24000, description: "Earned — test" });

  const preview = await readJson(await deletePreviewHandler(authed(userId, email), env, null));
  expect(preview.confirmPhrase === "Northgate Partners",
    "the phrase to type back is returned, so dialog and server cannot disagree about it");
  expect(preview.counts.runs === 1 && preview.counts.members === 1, "the counts are real reads");
  expect(preview.consequences.some((c) => /1 report is deleted/.test(c)),
    "the consequences are counted, not generic copy");
  expect(preview.consequences.some((c) => /\$240\.00 of credit is forfeited/.test(c)),
    "…including the credit that is about to be lost");

  const wrong = await deleteOrgHandler(authed(userId, email, {
    method: "DELETE", body: { confirm: "northgate partners" },
  }), env, null);
  expect(wrong.status === 400 && (await readJson(wrong)).error === "confirmation_mismatch",
    "the confirmation is case-sensitive");

  const org = await env.DB.prepare("SELECT org_id FROM organisations WHERE org_id = ?").bind(orgId).first();
  expect(!!org, "…and nothing was deleted on a mismatch");
}

{
  // Stripe cancellation fails → the whole operation aborts.
  const env = makeEnv({ STRIPE_SECRET_KEY: "sk_test_x" });
  const { userId, email, orgId } = await seedOwner(env, { orgName: "Doomed Ltd" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 500 });

  const res = await deleteOrgHandler(authed(userId, email, {
    method: "DELETE", body: { confirm: "Doomed Ltd" },
  }), env, null);
  globalThis.fetch = realFetch;

  expect(res.status === 502 && (await readJson(res)).error === "billing_cancel_failed",
    "a failed Stripe cancellation aborts the deletion");
  const survived = await env.DB.prepare("SELECT org_id FROM organisations WHERE org_id = ?").bind(orgId).first();
  expect(!!survived,
    "…and the org still exists — billing for an account that no longer exists is worse " +
    "than a deletion that asks you to retry");
}

{
  // The happy path, with no Stripe customer so no third party is involved.
  const env = makeEnv();
  const { userId, email, orgId } = await seedOwner(env, {
    orgName: "Gone Ltd", customer: null, plan: "free", subStatus: null, periodEnd: null,
  });
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind("run_g", userId, orgId, "dashboard", "vuln", "{}", "{}", 1, "x", Date.now()).run();
  await issueJWT(env, userId, email, null, { authMethod: "magic_link" });

  const res = await deleteOrgHandler(authed(userId, email, {
    method: "DELETE", body: { confirm: "Gone Ltd" },
  }), env, null);
  expect(res.status === 200 && (await readJson(res)).deleted === true, "the org is deleted");
  expect(/Max-Age=0/.test(res.headers.get("Set-Cookie") || ""),
    "…and the caller's cookie is cleared, so the browser stops presenting a dead credential");

  const gone = await env.DB.prepare("SELECT COUNT(*) AS n FROM organisations WHERE org_id = ?")
    .bind(orgId).first();
  expect(Number(gone.n) === 0, "the organisation row is gone");
  const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE org_id = ?").bind(orgId).first();
  expect(Number(runs.n) === 0, "its runs are gone");
  const sessions = [...env.SESSIONS._store.keys()].filter((k) => k.startsWith("sess:"));
  expect(sessions.length === 0, "every member is signed out");

  const { events } = await listAuditEvents(env, { action: AUDIT_ACTIONS.ORG_DELETED });
  expect(events.length === 1 && events[0].metadata.name === "Gone Ltd",
    "the audit row survives the deletion — a delete path that erases its own evidence " +
    "is not one anybody should trust");
}

// ===========================================================================
group("export says what it contains, and what it does not");
// ===========================================================================
{
  const env = makeEnv();
  const { userId, email, orgId } = await seedOwner(env);
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind("run_e", userId, orgId, "ci", "vuln", "{}", "{}", 5, "clean", Date.now()).run();

  const res = await exportAccountHandler(authed(userId, email), env, null);
  expect(/attachment; filename="algosize-export-/.test(res.headers.get("content-disposition")),
    "the export downloads rather than rendering");
  const doc = await readJson(res);
  expect(Array.isArray(doc.contents) && doc.contents.length > 0,
    "the document lists its own scope — an export whose contents you have to infer is not much use");
  expect(doc.notIncluded.some((s) => /API key secrets/.test(s)),
    "…and says what is NOT in it, including the key hashes nobody can recover");
  expect(doc.runs.length === 1 && doc.runs[0].reportPath === "/api/runs/run_e/report",
    "report bodies are referenced by id rather than inlined");
  expect(/not cash/i.test(doc.credit.note), "the credit note travels with the export");
}

// ===========================================================================
group("GET /api/account — the summary the page opens with");
// ===========================================================================
{
  const env = makeEnv({ STRIPE_PRICE_FIRM_MONTHLY: "price_firm_monthly" });
  const { userId, email } = await seedOwner(env);
  const token = await issueJWT(env, userId, email, "active", { authMethod: "google" });

  const res = await getAccountHandler(authed(userId, email, { token }), env, null);
  const body = await readJson(res);
  expect(res.status === 200, "it answers");
  expect(body.profile.email === email && body.profile.initials, "the profile is there");
  expect(body.org.tier === "firm", "the tier is derived from the price, not stored");
  expect(body.capabilities.branding.unlocked === true,
    "a Firm org on a live subscription has branding unlocked");
  expect(body.capabilities.dangerZone.canDeleteOrg === true, "an owner can delete");
  expect(body.credit.known === true && body.credit.balance === "$0.00",
    "a real zero balance is reported as known — this is the case that must NOT read as unknown");
  expect(body.entitlement.active === true, "entitlement comes from the shared resolver");

  const sessions = await readJson(await listSessionsHandler(authed(userId, email, { token }), env, null));
  expect(sessions.sessions.length === 1 && sessions.sessions[0].current === true,
    "the caller's own session is marked current");
  expect(sessions.indexedOnly === true && /not listed/.test(sessions.note),
    "the list says it is a floor rather than a count");

  const self = await revokeSessionHandler(authed(userId, email, {
    method: "DELETE", token, params: { sessionId: sessions.sessions[0].sessionId },
  }), env, null);
  expect(self.status === 400 && (await readJson(self)).error === "cannot_revoke_current",
    "you cannot revoke the session you are using — it would work, and read as the app crashing");
}

{
  // A free org: branding locked, usage reported, no Stripe customer.
  const env = makeEnv();
  const { userId, email } = await seedOwner(env, {
    userId: "usr_free", email: "free@example.com", plan: "free",
    subStatus: null, periodEnd: null, customer: null, priceId: null, seats: 1,
  });
  const body = await readJson(await getAccountHandler(authed(userId, email), env, null));
  expect(body.capabilities.branding.unlocked === false, "a free org has branding locked");
  expect(body.org.hasStripeCustomer === false, "…and no Stripe customer");
  expect(body.usage && body.usage.monthlyRunsLimit > 0,
    "…and its free-tier usage is reported, because that is the number it needs");
  expect(body.entitlement.active === false, "…and it is not entitled");
}

// ===========================================================================
console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} account test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all account tests passed\x1b[0m");
