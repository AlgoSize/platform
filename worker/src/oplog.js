// Operational logs: what the SYSTEM did, as opposed to audit.js, which
// records what PEOPLE did.
//
// Two tables, both append-only, both read only by the admin panel:
//   webhook_deliveries (migrations/0012) — inbound Stripe events
//   email_sends        (migrations/0013) — outbound transactional email
//
// Same two rules as audit.js: a failed log write never fails the operation
// it describes, and never disappears silently either.

import { captureException } from "./observability.js";

// ---------------------------------------------------------------------------
// Webhook deliveries
// ---------------------------------------------------------------------------

/**
 * The handler's verdict on one delivery. Deliberately NOT an HTTP status:
 * three of these four return 200 to Stripe, and flattening them into the
 * response code loses the distinction that actually matters when someone is
 * asking why a customer's plan is wrong.
 */
export const WEBHOOK_OUTCOME = Object.freeze({
  PROCESSED: "processed",   // we handled it and state changed
  DUPLICATE: "duplicate",   // idempotency hit — correct, and not a problem
  IGNORED:   "ignored",     // an event type this Worker does not handle
  FAILED:    "failed",      // we tried to handle it and could not
});

const WEBHOOK_OUTCOMES = new Set(Object.values(WEBHOOK_OUTCOME));

function newId(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export async function recordWebhookDelivery(env, ctx, { eventId = null, eventType, orgId = null, outcome, error = null } = {}) {
  if (!env || !env.DB) return null;
  if (!eventType || !WEBHOOK_OUTCOMES.has(outcome)) {
    await captureException(env, ctx, new Error("recordWebhookDelivery: invalid entry"), {
      tags:  { source: "oplog", reason: "invalid_entry" },
      extra: { eventType: eventType || null, outcome: outcome || null },
    });
    return null;
  }

  const deliveryId = newId("whd_");
  try {
    await env.DB
      .prepare(
        `INSERT INTO webhook_deliveries
           (delivery_id, event_id, event_type, org_id, outcome, error_message, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deliveryId,
        eventId,
        eventType,
        orgId,
        outcome,
        // Truncated: a stack trace from a nested fetch failure can be
        // kilobytes, and the panel shows a one-line reason.
        error ? String(error).slice(0, 500) : null,
        Math.floor(Date.now() / 1000),
      )
      .run();
    return deliveryId;
  } catch (err) {
    await captureException(env, ctx, err, {
      tags:  { source: "oplog", reason: "webhook_write_failed" },
      extra: { eventType, outcome },
    });
    return null;
  }
}

/**
 * Newest first, keyed on rowid for the same reason audit.js is: Stripe
 * redelivers in bursts, so several rows share a second, and a `received_at`
 * cursor would silently skip every row on the boundary.
 */
export async function listWebhookDeliveries(env, { limit = 50, before = null, outcome = null } = {}) {
  if (!env || !env.DB) return { deliveries: [], hasMore: false, cursor: null };
  const capped = Math.max(1, Math.min(200, Number(limit) || 50));
  const where = [];
  const binds = [];
  if (outcome && WEBHOOK_OUTCOMES.has(outcome)) { where.push("outcome = ?"); binds.push(outcome); }
  if (before)                                   { where.push("rowid < ?");   binds.push(Number(before)); }

  const res = await env.DB
    .prepare(
      `SELECT rowid AS cursor, delivery_id, event_id, event_type, org_id, outcome, error_message, received_at
         FROM webhook_deliveries
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY rowid DESC
        LIMIT ?`,
    )
    .bind(...binds, capped + 1)
    .all();
  const rows = (res && res.results) || [];
  const hasMore = rows.length > capped;
  const page = rows.slice(0, capped);
  return {
    deliveries: page.map((r) => ({
      deliveryId: r.delivery_id,
      eventId:    r.event_id || null,
      eventType:  r.event_type,
      orgId:      r.org_id || null,
      outcome:    r.outcome,
      error:      r.error_message || null,
      receivedAt: r.received_at,
    })),
    hasMore,
    cursor: page.length ? page[page.length - 1].cursor : null,
  };
}

// ---------------------------------------------------------------------------
// Email sends
// ---------------------------------------------------------------------------

export const EMAIL_OUTCOME = Object.freeze({
  SENT:    "sent",
  SKIPPED: "skipped",   // sendTransactional declined before trying — e.g. not_configured
  FAILED:  "failed",    // it tried and the provider rejected it
});

/**
 * Map a sendTransactional() return value onto an outcome.
 *
 * `not_configured` is deliberately SKIPPED rather than FAILED. Nothing broke;
 * the mailer simply isn't set up. Reporting it as a failure trains whoever
 * reads this page to ignore red rows, and reporting it as `sent` is how the
 * magic-link outage earlier in this project stayed invisible for so long —
 * every send "succeeded" by doing nothing at all.
 */
export function outcomeFromSendResult(result) {
  if (result && result.sent) return EMAIL_OUTCOME.SENT;
  const reason = (result && result.reason) || "unknown";
  return reason === "not_configured" ? EMAIL_OUTCOME.SKIPPED : EMAIL_OUTCOME.FAILED;
}

/**
 * Log one outbound message.
 *
 * The recipient IS stored — support cannot answer "did the invite reach
 * them" without it — but the body is not. These messages carry sign-in links
 * and billing details, and a log that reproduces them is a second place to
 * leak them from.
 */
export async function recordEmailSend(env, ctx, { recipient, template, orgId = null, result } = {}) {
  if (!env || !env.DB) return null;
  if (!recipient || !template) {
    await captureException(env, ctx, new Error("recordEmailSend: invalid entry"), {
      tags:  { source: "oplog", reason: "invalid_entry" },
      extra: { template: template || null, hasRecipient: Boolean(recipient) },
    });
    return null;
  }

  const sendId = newId("eml_");
  try {
    await env.DB
      .prepare(
        `INSERT INTO email_sends (send_id, recipient, template, org_id, outcome, reason, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sendId,
        String(recipient).toLowerCase(),
        template,
        orgId,
        outcomeFromSendResult(result),
        // Stored verbatim from sendTransactional so the panel and the code
        // speak the same vocabulary. On success there is no reason to store.
        (result && result.sent) ? null : ((result && result.reason) || "unknown"),
        Math.floor(Date.now() / 1000),
      )
      .run();
    return sendId;
  } catch (err) {
    await captureException(env, ctx, err, {
      tags:  { source: "oplog", reason: "email_write_failed" },
      extra: { template },
    });
    return null;
  }
}

export async function listEmailSends(env, { limit = 50, before = null, outcome = null } = {}) {
  if (!env || !env.DB) return { sends: [], hasMore: false, cursor: null };
  const capped = Math.max(1, Math.min(200, Number(limit) || 50));
  const valid = new Set(Object.values(EMAIL_OUTCOME));
  const where = [];
  const binds = [];
  if (outcome && valid.has(outcome)) { where.push("outcome = ?"); binds.push(outcome); }
  if (before)                        { where.push("rowid < ?");   binds.push(Number(before)); }

  const res = await env.DB
    .prepare(
      `SELECT rowid AS cursor, send_id, recipient, template, org_id, outcome, reason, sent_at
         FROM email_sends
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY rowid DESC
        LIMIT ?`,
    )
    .bind(...binds, capped + 1)
    .all();
  const rows = (res && res.results) || [];
  const hasMore = rows.length > capped;
  const page = rows.slice(0, capped);
  return {
    sends: page.map((r) => ({
      sendId:    r.send_id,
      recipient: r.recipient,
      template:  r.template,
      orgId:     r.org_id || null,
      outcome:   r.outcome,
      reason:    r.reason || null,
      sentAt:    r.sent_at,
    })),
    hasMore,
    cursor: page.length ? page[page.length - 1].cursor : null,
  };
}
