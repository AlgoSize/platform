// Tests for the storage layer the admin panel reads:
//
//   src/audit.js     — audit_log      (migrations/0010)
//   src/oplog.js     — webhook_deliveries + email_sends (0012, 0013)
//   src/flags.js     — feature_flags   (0014)
//   src/sessions.js  — the per-user session index in SESSIONS KV
//
// The theme running through these tests is the same one the modules are
// built around: an operational log is only worth having if it never lies.
// So the assertions concentrate on the ways a log CAN lie — a swallowed
// failure that leaves a hole reading as "nothing happened", a duplicate
// rendered as an error, a percentage rollout that answers differently on
// consecutive requests, a session index that shows a revoked session as
// live. Each of those has a test below.
//
// Run with:  node scripts/test-admin-storage.mjs

import { makeD1, makeEmptyD1 } from "./_d1-stub.mjs";
import {
  writeAudit, listAuditEvents, AUDIT_ACTIONS, SYSTEM_ACTOR, AUDIT_PAGE_MAX,
} from "../src/audit.js";
import {
  recordWebhookDelivery, listWebhookDeliveries, WEBHOOK_OUTCOME,
  recordEmailSend, listEmailSends, EMAIL_OUTCOME, outcomeFromSendResult,
} from "../src/oplog.js";
import {
  listFlags, getFlag, upsertFlag, deleteFlag, isFlagEnabled,
  listFlagOverrides, setFlagOverride,
} from "../src/flags.js";
import {
  indexSession, listUserSessions, revokeUserSession, unindexSession,
  revokeAllUserSessions, sessionIdFor,
} from "../src/sessions.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

/** KV stub with the list() surface sessions.js needs. */
function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
group("audit log — writes");
// ---------------------------------------------------------------------------
{
  const env = { DB: makeD1() };

  const id = await writeAudit(env, null, {
    actor:      "Admin@Algosize.com",
    actorUserId: "usr_1",
    action:     AUDIT_ACTIONS.API_KEY_REVOKED,
    targetType: "api_key",
    targetId:   "key_abc",
    orgId:      "org_1",
    metadata:   { prefix: "ask_live_aaaa" },
  });
  expect(typeof id === "string" && id.startsWith("aud_"), "a write returns the new audit id");

  const { events } = await listAuditEvents(env, {});
  expect(events.length === 1, "and the row is readable back");
  expect(events[0].actor === "admin@algosize.com",
    "the actor is lowercased on write, so a filter by email matches regardless of how it was typed");
  expect(events[0].metadata && events[0].metadata.prefix === "ask_live_aaaa",
    "metadata round-trips through JSON");
  expect(events[0].system === false, "a human actor is not flagged as a system action");

  await writeAudit(env, null, {
    actor: SYSTEM_ACTOR, action: AUDIT_ACTIONS.PLAN_CHANGED, orgId: "org_1",
  });
  const after = await listAuditEvents(env, {});
  expect(after.events[0].system === true,
    "the reserved `system` actor is flagged, so an unattended change is never shown as a person's doing");
  expect(after.events[0].action === AUDIT_ACTIONS.PLAN_CHANGED,
    "and it sorts ahead of the row written moments earlier — both share a created_at second, so " +
    "ordering has to come from insertion order rather than from the timestamp");
}

{
  // The failure modes. Both must be non-fatal AND non-silent.
  const captured = [];
  const env = {
    DB: makeEmptyD1(),          // tables absent → every insert throws
    SENTRY_DSN: null,
  };
  // observability captures without a DSN are no-ops, so assert on the return
  // value instead: null means "did not write", which is what a caller that
  // cares (i.e. a test) needs to be able to tell.
  const id = await writeAudit(env, null, { actor: "a@b.c", action: "x.y" });
  expect(id === null, "a write against a database with no audit_log returns null rather than throwing");

  const env2 = { DB: makeD1() };
  const bad = await writeAudit(env2, null, { action: AUDIT_ACTIONS.MEMBER_REMOVED });
  expect(bad === null, "an entry with no actor is refused rather than written as an uninterpretable row");
  const bad2 = await writeAudit(env2, null, { actor: "a@b.c" });
  expect(bad2 === null, "and so is one with no action");
  const { events } = await listAuditEvents(env2, {});
  expect(events.length === 0, "neither refusal left a partial row behind");
  void captured;
}

// ---------------------------------------------------------------------------
group("audit log — reads");
// ---------------------------------------------------------------------------
{
  const env = { DB: makeD1() };
  const base = Math.floor(Date.now() / 1000);
  // Write with controlled timestamps by inserting directly — writeAudit uses
  // Date.now(), and several rows in the same second would make ordering
  // assertions depend on insertion order rather than on created_at.
  const rows = [
    ["aud_1", "a@x.com", AUDIT_ACTIONS.MEMBER_REMOVED, "org_1", base - 300],
    ["aud_2", "b@x.com", AUDIT_ACTIONS.API_KEY_REVOKED, "org_1", base - 200],
    ["aud_3", "a@x.com", AUDIT_ACTIONS.API_KEY_REVOKED, "org_2", base - 100],
  ];
  for (const [id, actor, action, orgId, at] of rows) {
    await env.DB.prepare(
      `INSERT INTO audit_log (audit_id, actor, action, org_id, created_at) VALUES (?,?,?,?,?)`,
    ).bind(id, actor, action, orgId, at).run();
  }

  const all = await listAuditEvents(env, {});
  expect(all.events.map((e) => e.auditId).join(",") === "aud_3,aud_2,aud_1",
    "the feed is newest-first");
  expect(all.hasMore === false, "hasMore is false when the page covers everything");

  const byOrg = await listAuditEvents(env, { orgId: "org_1" });
  expect(byOrg.events.length === 2, "filtering by org narrows the feed");

  const byActor = await listAuditEvents(env, { actor: "A@X.com" });
  expect(byActor.events.length === 2, "the actor filter is case-insensitive, matching how the rows are stored");

  const byAction = await listAuditEvents(env, { action: AUDIT_ACTIONS.API_KEY_REVOKED });
  expect(byAction.events.length === 2, "filtering by action works");

  const page1 = await listAuditEvents(env, { limit: 2 });
  expect(page1.events.length === 2 && page1.hasMore === true,
    "a partial page reports hasMore rather than looking like the end of the list");
  const page2 = await listAuditEvents(env, { limit: 2, before: page1.cursor });
  expect(page2.events.length === 1 && page2.events[0].auditId === "aud_1",
    "the cursor walks to the next page without an OFFSET, so rows appended mid-read cannot shift it");
  expect(page2.hasMore === false && page2.cursor !== null,
    "the last page says so, and still returns a cursor rather than a null that reads as 'start over'");
  const empty = await listAuditEvents(env, { limit: 2, before: page2.cursor });
  expect(empty.events.length === 0 && empty.cursor === null,
    "walking past the end yields nothing and a null cursor");

  const huge = await listAuditEvents(env, { limit: 100000 });
  expect(huge.events.length <= AUDIT_PAGE_MAX, "an absurd limit is capped rather than honoured");

  const none = await listAuditEvents({ DB: null }, {});
  expect(none.events.length === 0, "no database bound → an empty feed, not a thrown error");
}

{
  // The burst case. Every one of these rows carries the same created_at,
  // which is exactly what happens when a handler logs several actions in one
  // request, or when Stripe redelivers a batch.
  const env = { DB: makeD1() };
  for (let i = 0; i < 12; i++) {
    await writeAudit(env, null, {
      actor: "a@x.com", action: AUDIT_ACTIONS.MEMBER_REMOVED, targetId: `t${i}`,
    });
  }
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const res = await listAuditEvents(env, { limit: 5, before: cursor });
    seen.push(...res.events.map((e) => e.targetId));
    cursor = res.cursor;
    if (!res.hasMore) break;
  }
  expect(seen.length === 12, `paging through a same-second burst returns every row (got ${seen.length}/12)`);
  expect(new Set(seen).size === 12, "with no duplicates");
  expect(seen.join(",") === "t11,t10,t9,t8,t7,t6,t5,t4,t3,t2,t1,t0",
    "in insertion order — a created_at cursor would have skipped the whole batch at the first page boundary");
}

// ---------------------------------------------------------------------------
group("webhook deliveries");
// ---------------------------------------------------------------------------
{
  const env = { DB: makeD1() };

  await recordWebhookDelivery(env, null, {
    eventId: "evt_1", eventType: "invoice.paid", orgId: "org_1",
    outcome: WEBHOOK_OUTCOME.PROCESSED,
  });
  await recordWebhookDelivery(env, null, {
    eventId: "evt_1", eventType: "invoice.paid", outcome: WEBHOOK_OUTCOME.DUPLICATE,
  });
  await recordWebhookDelivery(env, null, {
    eventId: "evt_2", eventType: "customer.subscription.updated",
    outcome: WEBHOOK_OUTCOME.FAILED, error: "x".repeat(2000),
  });

  const { deliveries } = await listWebhookDeliveries(env, {});
  expect(deliveries.length === 3, "all three deliveries are recorded");

  const dup = deliveries.find((d) => d.outcome === WEBHOOK_OUTCOME.DUPLICATE);
  expect(dup && dup.error === null,
    "a duplicate carries no error — it is a success that correctly did nothing, and must not read as a problem");

  const failed = deliveries.find((d) => d.outcome === WEBHOOK_OUTCOME.FAILED);
  expect(failed && failed.error.length === 500,
    "an oversized error message is truncated rather than storing a kilobyte of stack per row");

  const onlyFailed = await listWebhookDeliveries(env, { outcome: WEBHOOK_OUTCOME.FAILED });
  expect(onlyFailed.deliveries.length === 1, "the outcome filter narrows the feed");

  const bogus = await listWebhookDeliveries(env, { outcome: "nonsense" });
  expect(bogus.deliveries.length === 3,
    "an unrecognised outcome filter is ignored rather than silently returning nothing — " +
    "an empty feed would read as 'no deliveries', which is a different and wrong answer");

  const invalid = await recordWebhookDelivery(env, null, { eventType: "x", outcome: "made_up" });
  expect(invalid === null, "an outcome outside the enum is refused, so a typo cannot invent a fifth state");
}

// ---------------------------------------------------------------------------
group("email sends");
// ---------------------------------------------------------------------------
{
  expect(outcomeFromSendResult({ sent: true }) === EMAIL_OUTCOME.SENT,
    "a successful send maps to `sent`");
  expect(outcomeFromSendResult({ sent: false, reason: "not_configured" }) === EMAIL_OUTCOME.SKIPPED,
    "not_configured maps to `skipped`, not `failed` — nothing broke, the mailer simply is not set up");
  expect(outcomeFromSendResult({ sent: false, reason: "send_failed" }) === EMAIL_OUTCOME.FAILED,
    "a provider rejection maps to `failed`");
  expect(outcomeFromSendResult(undefined) === EMAIL_OUTCOME.FAILED,
    "a missing result is `failed`, not `sent` — the whole point of this log is that a silent no-op " +
    "must never be recorded as a delivered message");

  const env = { DB: makeD1() };
  await recordEmailSend(env, null, {
    recipient: "Person@Example.com", template: "magic_link",
    result: { sent: false, reason: "not_configured" },
  });
  await recordEmailSend(env, null, {
    recipient: "b@example.com", template: "payment_failed", orgId: "org_1",
    result: { sent: true },
  });

  const { sends } = await listEmailSends(env, {});
  expect(sends.length === 2, "both sends are logged");

  const skipped = sends.find((s) => s.template === "magic_link");
  expect(skipped.outcome === EMAIL_OUTCOME.SKIPPED && skipped.reason === "not_configured",
    "the reason is stored verbatim, so the panel and sendTransactional use the same vocabulary");
  expect(skipped.recipient === "person@example.com", "the recipient is normalised to lowercase");

  const delivered = sends.find((s) => s.template === "payment_failed");
  expect(delivered.reason === null, "a successful send stores no reason");

  const body = JSON.stringify(sends);
  expect(!/subject|html|body/i.test(body),
    "no message body or subject is stored — these mails carry sign-in links, and a log that " +
    "reproduces them is a second place to leak them from");
}

// ---------------------------------------------------------------------------
group("feature flags");
// ---------------------------------------------------------------------------
{
  const env = { DB: makeD1() };

  const created = await upsertFlag(env, "new_report_viewer", { description: "d", updatedBy: "a@b.c" });
  expect(created.ok && created.created, "a flag can be created");
  expect(created.flag.enabled === false,
    "a newly created flag is OFF — a flag that springs into existence enabled is indistinguishable " +
    "from shipping the feature by accident");
  expect(created.flag.rolloutPct === 100, "and defaults to a full rollout once it IS turned on");

  const patched = await upsertFlag(env, "new_report_viewer", { enabled: true, updatedBy: "a@b.c" });
  expect(patched.ok && !patched.created, "a second upsert updates rather than duplicating");
  expect(patched.flag.description === "d",
    "a field left out of the patch keeps its value rather than being cleared");
  expect(patched.previous && patched.previous.enabled === false,
    "the previous state comes back, so the caller can log what actually changed");

  expect((await upsertFlag(env, "Not Valid", {})).error === "invalid_key",
    "a key with spaces or capitals is refused");
  expect((await upsertFlag(env, "ok_key", { rolloutPct: 101 })).error === "invalid_rollout",
    "a rollout above 100 is refused");
  expect((await upsertFlag(env, "ok_key2", { rolloutPct: 12.5 })).error === "invalid_rollout",
    "and so is a fractional one");

  expect((await listFlags(env)).length === 1, "a refused upsert created nothing");

  // Evaluation.
  expect(await isFlagEnabled(env, null, "new_report_viewer", "usr_1") === true,
    "an enabled flag at 100% is on for everyone");
  expect(await isFlagEnabled(env, null, "does_not_exist", "usr_1") === false,
    "an unknown flag is off — the system fails closed");
  expect(await isFlagEnabled({ DB: makeEmptyD1() }, null, "new_report_viewer", "usr_1") === false,
    "an unreachable database is off too, so a D1 blip cannot launch every unfinished feature at once");

  await upsertFlag(env, "new_report_viewer", { enabled: false });
  expect(await isFlagEnabled(env, null, "new_report_viewer", "usr_1") === false,
    "disabling wins regardless of the rollout percentage");

  await upsertFlag(env, "new_report_viewer", { enabled: true, rolloutPct: 50 });
  const first = await isFlagEnabled(env, null, "new_report_viewer", "usr_42");
  let stable = true;
  for (let i = 0; i < 20; i++) {
    if (await isFlagEnabled(env, null, "new_report_viewer", "usr_42") !== first) stable = false;
  }
  expect(stable,
    "a partial rollout is deterministic per subject — a coin flip per request would put a user " +
    "in the variant on one page load and out of it on the next");

  expect(await isFlagEnabled(env, null, "new_report_viewer", null) === false,
    "a partial rollout with nobody to bucket is off, rather than flipping a coin");

  // Spread across the population, and independent between flags.
  await upsertFlag(env, "second_flag", { enabled: true, rolloutPct: 50 });
  let inA = 0, inB = 0, both = 0;
  for (let i = 0; i < 400; i++) {
    const a = await isFlagEnabled(env, null, "new_report_viewer", `usr_${i}`);
    const b = await isFlagEnabled(env, null, "second_flag", `usr_${i}`);
    if (a) inA++;
    if (b) inB++;
    if (a && b) both++;
  }
  expect(inA > 140 && inA < 260, `a 50% rollout lands near half the population (got ${inA}/400)`);
  expect(Math.abs(both - inA / 2) < 60,
    `two flags at 50% pick different halves (${both} users got both, ~${Math.round(inA / 2)} expected) — ` +
    "otherwise the first cohort to get one experimental feature gets every experimental feature");

  const del = await deleteFlag(env, "second_flag");
  expect(del.deleted && del.previous.key === "second_flag", "a flag can be deleted, returning what it was");
  expect(await getFlag(env, "second_flag") === null, "and is gone afterwards");
  expect((await deleteFlag(env, "second_flag")).deleted === false, "deleting it again is a no-op, not an error");
}

// ---------------------------------------------------------------------------
group("feature flag overrides — targeting an exact subject");
// ---------------------------------------------------------------------------
// The rollout percentage answers "roughly what fraction of accounts" and
// gives no say in WHICH ones. That is the right primitive for an unbiased
// rollout and the wrong one for a pilot: "turn this on for our own orgs
// before any customer sees it" is a set you choose, not a set a hash picks.
{
  const env = { DB: makeD1() };
  await upsertFlag(env, "mcp.enabled", { enabled: false, updatedBy: "a@b.c" });

  // The case the whole table exists for: a globally OFF flag, on for one
  // named org and nobody else.
  const set = await setFlagOverride(env, "mcp.enabled", "org_internal", { enabled: true, updatedBy: "a@b.c" });
  expect(set.ok && set.override.enabled === true, "an override can be set for one exact subject");
  expect(await isFlagEnabled(env, null, "mcp.enabled", "org_internal") === true,
    "an ON override beats a globally disabled flag — this is the pilot case");
  expect(await isFlagEnabled(env, null, "mcp.enabled", "org_customer") === false,
    "…and every other org stays off, which percentage bucketing could not guarantee");

  // The other direction matters just as much: excluding one account from a
  // rollout everyone else is in.
  await upsertFlag(env, "mcp.enabled", { enabled: true, rolloutPct: 100 });
  await setFlagOverride(env, "mcp.enabled", "org_optout", { enabled: false, updatedBy: "a@b.c" });
  expect(await isFlagEnabled(env, null, "mcp.enabled", "org_optout") === false,
    "an OFF override beats a fully enabled flag, so one account can be held back");
  expect(await isFlagEnabled(env, null, "mcp.enabled", "org_someone_else") === true,
    "…without affecting anyone else");

  // An override must win over the BUCKET, not merely tiebreak it — otherwise
  // a subject the hash already excluded stays excluded and the override
  // silently does nothing.
  await upsertFlag(env, "mcp.enabled", { enabled: true, rolloutPct: 1 });
  let bucketedOut = null;
  for (let i = 0; i < 200 && bucketedOut === null; i++) {
    const s = `org_probe_${i}`;
    if (await isFlagEnabled(env, null, "mcp.enabled", s) === false) bucketedOut = s;
  }
  expect(bucketedOut !== null, "found a subject the 1% bucket excludes (test setup)");
  await setFlagOverride(env, "mcp.enabled", bucketedOut, { enabled: true, updatedBy: "a@b.c" });
  expect(await isFlagEnabled(env, null, "mcp.enabled", bucketedOut) === true,
    "an override turns on a subject the rollout bucket had excluded");

  // Clearing returns the subject to the global rollout rather than pinning
  // it to a value — otherwise "undo" would silently mean "set to off".
  await upsertFlag(env, "mcp.enabled", { enabled: true, rolloutPct: 100 });
  const cleared = await setFlagOverride(env, "mcp.enabled", "org_optout", { enabled: null, updatedBy: "a@b.c" });
  expect(cleared.ok && cleared.cleared === true, "an override can be cleared");
  expect(await isFlagEnabled(env, null, "mcp.enabled", "org_optout") === true,
    "…and the subject returns to whatever the global rollout says, not to off");

  // Listing, for the admin panel.
  const list = await listFlagOverrides(env, "mcp.enabled");
  expect(list.some((o) => o.subject === "org_internal" && o.enabled === true),
    "overrides are listable for one flag");
  expect(!list.some((o) => o.subject === "org_optout"),
    "…and a cleared one is gone from the list rather than lingering as a row");

  // Overrides are per flag, not global.
  await upsertFlag(env, "other_flag", { enabled: false });
  expect(await isFlagEnabled(env, null, "other_flag", "org_internal") === false,
    "an override on one flag does not leak into another");

  // Input validation, matching upsertFlag's contract.
  expect((await setFlagOverride(env, "Not Valid", "org_x", { enabled: true })).error === "invalid_key",
    "a bad flag key is refused");
  expect((await setFlagOverride(env, "ok_key", "", { enabled: true })).error === "invalid_subject",
    "an empty subject is refused");
  expect((await setFlagOverride(env, "ok_key", "org_x", { enabled: "yes" })).error === "invalid_enabled",
    "a non-boolean enabled is refused rather than coerced — 'yes' silently meaning true is how a " +
    "flag gets turned on by a typo");

  // Fails closed, same as every other read in this module.
  expect(await isFlagEnabled({ DB: makeEmptyD1() }, null, "mcp.enabled", "org_internal") === false,
    "an unreachable database is off even for a subject with an ON override");
}

// ---------------------------------------------------------------------------
group("session index");
// ---------------------------------------------------------------------------
{
  const env = { SESSIONS: makeKV() };
  const put = async (token, userId) => {
    await env.SESSIONS.put(`sess:${token}`, JSON.stringify({ userId }));
    return indexSession(env, userId, token, new Request("http://x", {
      headers: { "User-Agent": "TestBrowser/1.0", "CF-Connecting-IP": "203.0.113.9", "CF-IPCountry": "CA" },
    }));
  };

  const sidA = await put("tok_a", "usr_1");
  await put("tok_b", "usr_1");
  await put("tok_c", "usr_2");

  const listed = await listUserSessions(env, "usr_1", { currentToken: "tok_a" });
  expect(listed.sessions.length === 2, "only the user's own sessions are listed");
  expect(listed.complete === true, "and the list reports itself complete when KV did not paginate");
  expect(listed.sessions.some((s) => s.current === true),
    "the caller's own session is marked, so the UI can warn before revoking the one they are using");
  expect(listed.sessions.every((s) => !("token" in s)),
    "no session token is returned to the caller — the handle is a hash, so a live credential " +
    "never travels through a URL or a browser history entry");
  expect(listed.sessions[0].userAgent === "TestBrowser/1.0" && listed.sessions[0].country === "CA",
    "display metadata is captured at issue time");

  // The lie this list must never tell.
  await env.SESSIONS.delete("sess:tok_b");
  const afterRevoke = await listUserSessions(env, "usr_1");
  expect(afterRevoke.sessions.length === 1,
    "a session revoked out from under the index is NOT listed — showing a dead session as live " +
    "is the one error this list must not make");
  expect(env.SESSIONS._store.has(`usess:usr_1:${await sessionIdFor("tok_b")}`) === false,
    "and the orphaned index entry is pruned as a side effect of the read");

  const rev = await revokeUserSession(env, "usr_1", sidA);
  expect(rev.revoked === true, "a session can be revoked by its handle");
  expect(env.SESSIONS._store.has("sess:tok_a") === false, "which deletes the session itself, not just the index row");
  expect((await revokeUserSession(env, "usr_1", sidA)).reason === "not_found",
    "revoking it again reports not_found rather than a false success");
  expect((await revokeUserSession(env, "usr_2", await sessionIdFor("tok_c"))).revoked === true,
    "another user's own session is revocable by that user");

  // Cross-user isolation: usr_1 must not be able to name usr_2's handle.
  await put("tok_d", "usr_2");
  const stolen = await revokeUserSession(env, "usr_1", await sessionIdFor("tok_d"));
  expect(stolen.revoked === false,
    "a handle belonging to another user does not resolve under this user's prefix — " +
    "the index key is scoped by user id, so knowing a handle is not enough to kill someone else's session");
  expect(env.SESSIONS._store.has("sess:tok_d") === true, "and that session is untouched");
}

{
  const env = { SESSIONS: makeKV() };
  for (const t of ["t1", "t2", "t3"]) {
    await env.SESSIONS.put(`sess:${t}`, JSON.stringify({ userId: "usr_9" }));
    await indexSession(env, "usr_9", t, null);
  }
  const result = await revokeAllUserSessions(env, "usr_9", { exceptToken: "t2" });
  expect(result.revoked === 2, "sign-out-everywhere revokes every session but the one held back");
  expect(env.SESSIONS._store.has("sess:t2"), "the excepted session survives");
  expect(!env.SESSIONS._store.has("sess:t1") && !env.SESSIONS._store.has("sess:t3"), "the others are gone");

  await unindexSession(env, "usr_9", "t2");
  const left = await listUserSessions(env, "usr_9");
  expect(left.sessions.length === 0, "unindexing removes the entry a logout leaves behind");
  expect(env.SESSIONS._store.has("sess:t2"),
    "unindex alone does NOT revoke — revokeJWT owns that, and conflating the two would make a " +
    "bookkeeping call silently sign someone out");

  const noKv = await listUserSessions({ SESSIONS: null }, "usr_9");
  expect(noKv.sessions.length === 0 && noKv.complete === false,
    "with no KV bound the list is empty AND flagged incomplete — 'we cannot tell' must never " +
    "render as 'this user has no other sessions'");
}

console.log("");
if (failures > 0) {
  console.log(`\x1b[31m  ${failures} admin-storage test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all admin-storage tests passed\x1b[0m");
