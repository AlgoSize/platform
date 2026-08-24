// Where a monitor alert actually goes.
//
// This module exists because "configured" and "delivered" had drifted apart.
// The notification settings screen let someone switch monitor alerts off, or
// on for Slack, and the sweep ignored all of it: runMonitorCheck resolved a
// single address with getOrgBillingEmail and mailed that, every time, to one
// person, regardless of what anybody had chosen.
//
// Two failures came out of that. Someone who switched monitor email off kept
// receiving it — a setting that reports saved and changes nothing. And every
// member except the billing owner received nothing however the toggle was
// set, because the org had exactly one recipient by construction.
//
// So the route is resolved here, once, from the same facts the settings
// screen shows, and the resolution is returned in a shape the UI can render
// verbatim. The Monitors screen's "where the next alert goes" card is not a
// re-statement of the settings — it is this function's answer.

import { listMembers, getOrgById } from "../handlers/_orgs.js";
import { shouldNotify } from "../notifications.js";

/** The catalog row every monitor alert is filed under (src/notifications.js). */
export const MONITOR_PREF_ID = "monitor";

/**
 * Resolve the delivery route for one organisation's monitor alerts.
 *
 * Returns
 *   {
 *     emails:  [{ userId, email, role }]   who will actually be mailed
 *     slack:   { url, configured, enabled, subscribers }
 *     muted:   true when every channel resolved to nothing
 *     reason:  a machine-readable why for `muted`
 *   }
 *
 * `url` is present only when Slack will genuinely be posted to. It is never
 * returned to the browser — see describeRoute() for the redacted shape.
 *
 * Failure posture: a preferences read that throws is treated as "no explicit
 * choice", which falls back to the catalog default (monitor:email is on by
 * default). Losing the prefs table must not silence alerts; it should leave
 * them behaving as they did before anyone touched a switch.
 */
export async function resolveMonitorRoute(env, orgId) {
  const empty = {
    emails: [],
    slack: { url: null, configured: false, enabled: false, subscribers: [] },
    muted: true,
    reason: "no_org",
  };
  if (!env || !env.DB || !orgId) return empty;

  let members = [];
  try { members = await listMembers(env, orgId); }
  catch { return { ...empty, reason: "members_unreadable" }; }
  if (!members.length) return { ...empty, reason: "no_members" };

  let org = null;
  try { org = await getOrgById(env, orgId); } catch { org = null; }
  const webhook = (org && org.slackWebhookUrl) || null;

  const emails = [];
  const slackSubscribers = [];

  for (const m of members) {
    const wantsEmail = await wants(env, m.userId, "email");
    if (wantsEmail && m.email) emails.push({ userId: m.userId, email: m.email, role: m.role });

    const wantsSlack = await wants(env, m.userId, "slack");
    if (wantsSlack) slackSubscribers.push({ userId: m.userId, role: m.role });
  }

  // Slack is delivered once per org, not once per subscriber — the webhook
  // posts into a channel, so N subscribers would produce N identical
  // messages in the same place. One subscriber is enough to enable it.
  const slackEnabled = !!webhook && slackSubscribers.length > 0;

  const muted = emails.length === 0 && !slackEnabled;

  return {
    emails,
    slack: {
      url: slackEnabled ? webhook : null,
      configured: !!webhook,
      enabled: slackEnabled,
      subscribers: slackSubscribers,
    },
    muted,
    reason: !muted ? null
      : slackSubscribers.length && !webhook ? "slack_on_but_unconfigured"
      : emailsPossible(members) ? "all_channels_off"
      : "no_addresses",
  };
}

async function wants(env, userId, channel) {
  try { return await shouldNotify(env, userId, MONITOR_PREF_ID, channel); }
  catch { return channel === "email"; }
}

function emailsPossible(members) {
  return members.some((m) => !!m.email);
}

/**
 * The same route, shaped for the browser.
 *
 * Addresses are kept — they are the organisation's own members, already
 * visible on the Team screen — but the webhook URL is not. A Slack webhook is
 * a bearer credential: anyone holding the URL can post into the channel, so
 * it is reported as configured/not and never echoed back, not even to the
 * owner who pasted it.
 */
export function describeRoute(route) {
  const channels = [];

  channels.push({
    id: "email",
    label: "Email",
    wired: route.emails.length > 0,
    detail: route.emails.length
      ? route.emails.map((r) => r.email)
      : [],
    note: route.emails.length
      ? null
      : "No member has monitor alerts switched on for email, so nothing will be mailed.",
  });

  channels.push({
    id: "slack",
    label: "Slack",
    wired: route.slack.enabled,
    detail: [],
    note: route.slack.enabled
      ? "Posts once to the organisation's webhook."
      : route.slack.configured
        ? "A webhook is configured, but no member has monitor alerts switched on for Slack."
        : "No webhook is configured for this organisation.",
  });

  return {
    channels,
    muted: route.muted,
    reason: route.reason,
    // Said plainly, because the whole point of the card is that someone can
    // read it without cross-referencing two settings screens.
    summary: route.muted
      ? "The next alert will not be delivered anywhere."
      : describeDelivery(route),
  };
}

function describeDelivery(route) {
  const parts = [];
  if (route.emails.length === 1) parts.push("1 email address");
  else if (route.emails.length > 1) parts.push(`${route.emails.length} email addresses`);
  if (route.slack.enabled) parts.push("Slack");
  return `The next alert goes to ${parts.join(" and ")}.`;
}

/**
 * The Slack body for a monitor alert.
 *
 * Deliberately short. Slack is a glance channel: the message says what
 * changed and links to the detail, and does not try to reproduce the email's
 * per-advisory tables — a 40-line unfurl in a busy channel gets muted, and a
 * muted channel is a channel that misses the next one.
 */
export function monitorSlackText({
  repoUrl, branch, newCount, counts, isBaseline, sections = [], dashboardUrl,
}) {
  const repo = String(repoUrl || "").replace(/^https?:\/\/(www\.)?github\.com\//, "");
  const where = branch ? `${repo} (${branch})` : repo;

  if (isBaseline) {
    return `Baseline recorded for ${where}. ${newCount} advisor${newCount === 1 ? "y" : "ies"} on file — future alerts report only what is new.`;
  }

  const lines = [];
  if (newCount > 0) {
    const bySeverity = Object.keys(counts || {})
      .map((k) => `${counts[k]} ${k}`)
      .join(", ");
    lines.push(`*${newCount} new advisor${newCount === 1 ? "y" : "ies"}* in ${where}${bySeverity ? ` — ${bySeverity}` : ""}`);
  }
  for (const s of sections) lines.push(s);
  if (!lines.length) lines.push(`Change detected in ${where}`);
  if (dashboardUrl) lines.push(`<${dashboardUrl}|Open the dashboard>`);
  return lines.join("\n");
}
