// Posting to an organisation's Slack incoming webhook.
//
// Same posture as email/transactional.js and for the same reason: a delivery
// channel must never be able to take down the thing it is reporting on. A
// revoked webhook, a Slack outage, or a URL someone pasted with a trailing
// newline all resolve to {sent:false, reason}, never a throw. The monitor
// sweep that called it goes on to record its run and mail whoever is on the
// email leg.
//
// Slack's incoming-webhook endpoint answers `ok` in the body with a 200, and
// uses 4xx for a URL that is dead for good (`no_service`, `invalid_token`) —
// so a 4xx is worth surfacing to the org as "reconnect Slack", while a 5xx is
// just today's outage. Both are recorded; only the first is actionable.

import { captureException } from "./observability.js";

const SLACK_TIMEOUT_MS = 8000;

/**
 * @param {object} env
 * @param {object} ctx  ExecutionContext, may be null
 * @param {string} url  the org's stored webhook URL
 * @param {object} msg  { text, blocks? } — `text` is required and is what
 *                      Slack shows in notifications and on unfurl-less
 *                      clients, so it must stand alone even when blocks are
 *                      present.
 * @returns {Promise<{sent:boolean, reason?:string, status?:number}>}
 */
export async function postToSlack(env, ctx, url, msg, fetchImpl = fetch) {
  if (typeof url !== "string" || !/^https:\/\/hooks\.slack\.com\//.test(url)) {
    // Not captured to Sentry: a bad URL is the org's configuration, and it is
    // already reported to them on the notifications screen.
    return { sent: false, reason: "invalid_webhook" };
  }
  if (!msg || typeof msg.text !== "string" || !msg.text.trim()) {
    return { sent: false, reason: "missing_text" };
  }

  const body = { text: msg.text };
  if (Array.isArray(msg.blocks) && msg.blocks.length) body.blocks = msg.blocks;

  let res;
  try {
    res = await withTimeout(fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), SLACK_TIMEOUT_MS);
  } catch (err) {
    await captureException(env, ctx, err, {
      tags: { source: "slack", reason: "network" },
    });
    return { sent: false, reason: "network" };
  }

  if (res.status >= 200 && res.status < 300) return { sent: true, status: res.status };

  // Slack puts the machine-readable cause in the body, not the status line.
  let detail = "";
  try { detail = (await res.text()).slice(0, 120); } catch { /* body already consumed */ }

  const reason = res.status >= 500 ? "slack_unavailable" : "webhook_rejected";
  await captureException(env, ctx,
    new Error(`slack webhook ${res.status}: ${detail || "(no body)"}`),
    { tags: { source: "slack", reason }, extra: { status: res.status } });

  return { sent: false, reason, status: res.status };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`slack webhook timed out after ${ms}ms`)), ms)),
  ]);
}
