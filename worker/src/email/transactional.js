// Public façade for transactional-email sends (Task #56).
//
// Every Worker handler that wants to send mail goes through
// `sendTransactional(env, ctx, {to, subject, text, html})`. The function:
//
//   - NEVER throws upward — a Workspace outage, a misconfigured secret,
//     or a network blip MUST NOT take down the user-facing handler. Any
//     caller that needs to know whether the message was actually sent
//     can read the resolved value `{sent: boolean, reason?, messageId?}`.
//   - Routes failures through `captureException` so they're visible in
//     Sentry / structured logs (same pipe as every other Worker error,
//     so the on-call doesn't need to learn a new alert source).
//   - Treats "no Workspace credentials configured" as `{sent: false,
//     reason: "not_configured"}` and records a single `captureMessage`
//     warning rather than spamming Sentry on every signup. Local dev
//     without `.dev.vars` populated should be silent at warn level.
//
// Caller pattern in handlers:
//
//     ctx.waitUntil(sendTransactional(env, ctx, {
//       to: user.email,
//       ...welcomeFreeSignup({ email: user.email }),
//     }));
//
// `ctx.waitUntil` keeps the email send alive after the HTTP response
// flushes, so the user is never made to wait on Gmail. If `ctx` is not
// available (e.g. unit tests, or a future cron path) the function still
// runs — it just won't extend the request lifetime.

import { sendViaGmail } from "./google.js";
import { captureException, captureMessage } from "../observability.js";

/**
 * @param {object} env  Worker env — reads GOOGLE_SERVICE_ACCOUNT_JSON,
 *                       EMAIL_FROM, EMAIL_DELEGATED_USER, EMAIL_REPLY_TO.
 * @param {object} ctx  ExecutionContext (for ctx.waitUntil on observability
 *                       posts). May be null/undefined.
 * @param {object} msg  {to, subject, text, html, replyTo?}
 * @returns {Promise<{sent: boolean, reason?: string, messageId?: string}>}
 */
export async function sendTransactional(env, ctx, msg) {
  if (!msg || typeof msg.to !== "string" || !msg.to.includes("@")) {
    await captureException(env, ctx, new Error("sendTransactional: invalid recipient"), {
      tags: { source: "email_transactional", reason: "invalid_recipient" },
      extra: { to: msg && msg.to },
    });
    return { sent: false, reason: "invalid_recipient" };
  }
  if (typeof msg.subject !== "string" || !msg.subject.trim()) {
    await captureException(env, ctx, new Error("sendTransactional: missing subject"), {
      tags: { source: "email_transactional", reason: "missing_subject" },
    });
    return { sent: false, reason: "missing_subject" };
  }
  if (typeof msg.text !== "string" || !msg.text.trim()) {
    // We require text for accessibility / spam-score reasons. HTML alone
    // is a deliverability red flag.
    await captureException(env, ctx, new Error("sendTransactional: missing text body"), {
      tags: { source: "email_transactional", reason: "missing_text" },
    });
    return { sent: false, reason: "missing_text" };
  }

  const from    = env && env.EMAIL_FROM;
  const replyTo = (msg.replyTo) || (env && env.EMAIL_REPLY_TO) || undefined;
  if (!from) {
    await captureMessage(env, ctx, "sendTransactional: EMAIL_FROM not configured — skipping send", {
      level: "warning",
      tags:  { source: "email_transactional", reason: "not_configured" },
      extra: { to: redact(msg.to) },
    });
    return { sent: false, reason: "not_configured" };
  }
  if (!env || !env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.EMAIL_DELEGATED_USER) {
    await captureMessage(env, ctx, "sendTransactional: Google Workspace credentials not configured — skipping send", {
      level: "warning",
      tags:  { source: "email_transactional", reason: "not_configured" },
      extra: { to: redact(msg.to) },
    });
    return { sent: false, reason: "not_configured" };
  }

  try {
    const result = await sendViaGmail(env, {
      from,
      to:      msg.to,
      subject: msg.subject,
      text:    msg.text,
      html:    msg.html,
      replyTo,
    });
    return { sent: true, messageId: result.messageId || undefined };
  } catch (err) {
    await captureException(env, ctx, err, {
      tags:  { source: "email_transactional", reason: "send_failed" },
      extra: { to: redact(msg.to), subject: msg.subject },
    });
    return { sent: false, reason: "send_failed" };
  }
}

// Redact the local-part of the recipient for log/Sentry "extra" so a
// leaked log doesn't dox the user. Keep the domain — it's useful for
// triage (deliverability problems are usually per-domain).
function redact(addr) {
  if (typeof addr !== "string" || !addr.includes("@")) return "<invalid>";
  const at  = addr.indexOf("@");
  const dom = addr.slice(at + 1);
  return `<redacted>@${dom}`;
}
