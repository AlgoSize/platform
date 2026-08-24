// The admin audit log — who did what, when, to which org.
//
// Written by every privileged or destructive action in the Worker and read
// only by the admin panel. The table is migrations/0010.
//
// Two rules govern this module:
//
//  1. A failed audit write must NEVER fail the action it describes. Revoking
//     a compromised API key has to succeed even if D1 is having a bad minute.
//
//  2. A failed audit write must never be silent either. An audit log with
//     invisible holes is worse than no audit log, because a gap reads as
//     "nothing happened" rather than "we don't know". So every swallowed
//     error goes to observability, where it is visible as an error even
//     though the request itself returned 200.

import { captureException } from "./observability.js";

/**
 * The actions we log. Frozen and enumerated rather than free-form strings so
 * the admin panel can render a filter list without a SELECT DISTINCT over a
 * table that grows forever, and so a typo at a write site shows up here
 * instead of quietly creating a new action nobody filters on.
 */
export const AUDIT_ACTIONS = Object.freeze({
  API_KEY_CREATED:   "api_key.created",
  API_KEY_REVOKED:   "api_key.revoked",
  MEMBER_INVITED:    "member.invited",
  MEMBER_JOINED:     "member.joined",
  MEMBER_REMOVED:    "member.removed",
  INVITE_REVOKED:    "invite.revoked",
  BRANDING_UPDATED:  "org.branding_updated",
  MONITOR_CREATED:   "monitor.created",
  MONITOR_DELETED:   "monitor.deleted",
  MONITOR_PAUSED:    "monitor.paused",
  MONITOR_RESUMED:   "monitor.resumed",
  // Changing which analyzers a monitor runs changes what its owner is
  // relying on being watched — same reason a pause is logged.
  MONITOR_ANALYZERS_CHANGED: "monitor.analyzers_changed",
  MONITOR_SCHEDULE_CHANGED:  "monitor.schedule_changed",
  MONITOR_RUN_REQUESTED:     "monitor.run_requested",
  PLAN_CHANGED:      "billing.plan_changed",
  FLAG_UPDATED:      "flag.updated",
  SESSION_REVOKED:   "session.revoked",
  // Sign-ins. Recorded so the account area can show a login history that is
  // an actual history: the session index only knows about sessions that are
  // still live, so without this a user who was signed in from somewhere they
  // did not recognise and then signed out has no way to see it happened.
  // Written at every issueJWT call site, one row per successful sign-in.
  AUTH_LOGIN:        "auth.login",
  // Account-area writes. Each one changes something the user would want to
  // find in a history later, and the first two change how the account is
  // reached at all — an email change is an authentication change.
  EMAIL_CHANGE_REQUESTED: "account.email_change_requested",
  EMAIL_CHANGED:     "account.email_changed",
  PROFILE_UPDATED:   "account.profile_updated",
  ORG_RENAMED:       "org.renamed",
  BILLING_EMAIL_UPDATED: "org.billing_email_updated",
  DOMAIN_UPDATED:    "org.domain_updated",
  NOTIFICATIONS_UPDATED: "account.notifications_updated",
  DATA_EXPORTED:     "account.data_exported",
  ORG_DELETED:       "org.deleted",
  CREDIT_EARNED:     "credit.earned",
  CREDIT_APPLIED:    "credit.applied",
});

/**
 * The actor recorded for anything not initiated by a signed-in human — the
 * Stripe webhook, the monitor sweep, the queue consumer. Reserved: a real
 * actor is always an email address, so this can never collide with one.
 */
export const SYSTEM_ACTOR = "system";

function newAuditId() {
  return "aud_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/**
 * Append one row to the audit log.
 *
 * Returns the audit id on success and null when the write did not happen
 * (no DB bound, or the insert failed). Callers ignore the return value —
 * it exists for tests, which need to distinguish "wrote" from "swallowed".
 *
 * `metadata` is serialised as-is. Do not put secrets in it: this table is
 * read by the admin panel and exported, so an API key or a session token
 * placed here becomes a second copy to leak. Key PREFIXES are fine, which
 * is why the revoke site passes `prefix` and not `key`.
 */
export async function writeAudit(env, ctx, entry) {
  if (!env || !env.DB) return null;
  const {
    actor,
    actorUserId = null,
    action,
    targetType  = null,
    targetId    = null,
    orgId       = null,
    metadata    = null,
  } = entry || {};

  if (!actor || !action) {
    // A row with no actor or no action is unreadable noise; refusing to write
    // it is better than filling the log with rows nobody can interpret.
    await captureException(env, ctx, new Error("writeAudit: entry missing actor or action"), {
      tags:  { source: "audit", reason: "invalid_entry" },
      extra: { action: action || null, hasActor: Boolean(actor) },
    });
    return null;
  }

  const auditId = newAuditId();
  try {
    await env.DB
      .prepare(
        `INSERT INTO audit_log
           (audit_id, actor, actor_user_id, action, target_type, target_id, org_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        auditId,
        String(actor).toLowerCase(),
        actorUserId,
        action,
        targetType,
        targetId,
        orgId,
        metadata === null || metadata === undefined ? null : JSON.stringify(metadata),
        Math.floor(Date.now() / 1000),
      )
      .run();
    return auditId;
  } catch (err) {
    await captureException(env, ctx, err, {
      tags:  { source: "audit", reason: "write_failed" },
      extra: { action, targetType, targetId, orgId },
    });
    return null;
  }
}

/**
 * Convenience wrapper for the common case: an action taken by the signed-in
 * user on a request that has already been through requireAuth.
 */
export async function auditFromRequest(request, env, ctx, entry) {
  const user = (request && request.user) || {};
  return writeAudit(env, ctx, {
    actor:       user.email || SYSTEM_ACTOR,
    actorUserId: user.userId || null,
    ...entry,
  });
}

function parseMetadata(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function rowToEvent(row) {
  return {
    auditId:     row.audit_id,
    actor:       row.actor,
    actorUserId: row.actor_user_id || null,
    action:      row.action,
    targetType:  row.target_type || null,
    targetId:    row.target_id || null,
    orgId:       row.org_id || null,
    metadata:    parseMetadata(row.metadata_json),
    createdAt:   row.created_at,
    // A row whose actor is the reserved SYSTEM_ACTOR was not a human action.
    // Surfaced as a flag so the panel can label it rather than having every
    // renderer re-derive the comparison and one of them get it wrong.
    system:      row.actor === SYSTEM_ACTOR,
  };
}

export const AUDIT_PAGE_MAX = 200;

/**
 * Read the log, newest first.
 *
 * Ordering and pagination both run on SQLite's implicit rowid, not on
 * created_at. Two reasons, and the first is not theoretical — the write sites
 * fire in bursts, so several rows routinely land in the same second:
 *
 *   - created_at has one-second resolution, so ordering by it alone leaves
 *     ties in whatever order the query planner feels like. A feed that
 *     reshuffles the last three entries between two refreshes is a feed
 *     nobody trusts.
 *   - `WHERE created_at < ?` as a cursor SKIPS every row that shares the
 *     boundary second. The reader never sees them and never learns they
 *     existed, which is the specific failure an audit log cannot have.
 *
 * rowid is monotonic for an append-only table and has no ties, so it gives a
 * total order and a cursor that cannot drop rows. created_at stays in the
 * response as the timestamp to DISPLAY; it is not what anything is keyed on.
 */
export async function listAuditEvents(env, { orgId = null, actor = null, action = null, before = null, limit = 50 } = {}) {
  if (!env || !env.DB) return { events: [], hasMore: false, cursor: null };

  const capped = Math.max(1, Math.min(AUDIT_PAGE_MAX, Number(limit) || 50));
  const where  = [];
  const binds  = [];
  if (orgId)  { where.push("org_id = ?"); binds.push(orgId); }
  if (actor)  { where.push("actor = ?");  binds.push(String(actor).toLowerCase()); }
  if (action) { where.push("action = ?"); binds.push(action); }
  if (before) { where.push("rowid < ?");  binds.push(Number(before)); }

  const sql =
    `SELECT rowid AS cursor, audit_id, actor, actor_user_id, action, target_type, target_id, org_id, metadata_json, created_at
       FROM audit_log
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY rowid DESC
      LIMIT ?`;

  // One extra row, then dropped — that is how hasMore is known without a
  // second COUNT(*) over a table with no upper bound on its size.
  const res  = await env.DB.prepare(sql).bind(...binds, capped + 1).all();
  const rows = (res && res.results) || [];
  const hasMore = rows.length > capped;
  const page = rows.slice(0, capped);
  return {
    events:  page.map(rowToEvent),
    hasMore,
    // The value to pass back as `before`. Null on an empty page so a caller
    // cannot accidentally re-request from position zero forever.
    cursor:  page.length ? page[page.length - 1].cursor : null,
  };
}
