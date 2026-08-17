// Inline transactional-email templates (Task #56).
//
// Two templates today:
//   - welcomeFreeSignup: sent fire-and-forget after POST /api/signup.
//   - quotaWarning: stub for the "1 run from monthly limit" follow-up
//     (Task #35) so that handler can sit on top of sendTransactional
//     without re-deriving subject/body conventions.
//
// Design notes:
//   - Plain-text + lightweight HTML (no remote images, no <link>, no JS).
//     Inline styles only, single-column, ≤ 600px wide. Renders sanely in
//     Gmail web/iOS, Apple Mail, and Outlook web — the three the task
//     names. No CSS Grid / flex (Outlook still pukes on those).
//   - All copy lives here, never in the handler, so a single grep finds
//     all user-visible strings the worker sends.

const SITE_ORIGIN = "https://algosize.com";
const DASHBOARD_URL = `${SITE_ORIGIN}/dashboard/`;
const PRICING_URL   = `${SITE_ORIGIN}/#pricing`;

function shellHtml(headline, bodyHtml) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#c9d1d9;line-height:1.55">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px">
      <tr><td style="padding:28px 32px">
        <p style="margin:0 0 4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#7ee0c0">[as] Algosize</p>
        <h1 style="margin:8px 0 16px;font-size:22px;font-weight:600;color:#f0f6fc">${headline}</h1>
        ${bodyHtml}
      </td></tr>
    </table>
    <p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#6e7681;text-align:center">
      You're receiving this because you signed up at algosize.com.
      Reply to this email if anything looks off.
    </p>
  </body>
</html>`;
}

export function welcomeFreeSignup({ email }) {
  const subject = "Welcome to Algosize — your free account is ready";
  const text = [
    `Welcome to Algosize.`,
    ``,
    `Your free account (${email}) is ready. You have 5 analyses per`,
    `month across all three tools — cost analyzer, vulnerability`,
    `scanner, and algorithm optimizer.`,
    ``,
    `Open your dashboard: ${DASHBOARD_URL}`,
    ``,
    `When you're ready for unlimited use, Algosize Pro is $29/month`,
    `with a money-back guarantee on the cost analyzer alone:`,
    `${PRICING_URL}`,
    ``,
    `— The Algosize team`,
  ].join("\n");
  const html = shellHtml(
    "Your free account is ready",
    `
      <p style="margin:0 0 16px">Hi — your free account (<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#7ee0c0">${escapeHtml(email)}</code>) is ready. You have <strong>5 analyses per month</strong> across all three tools: cost analyzer, vulnerability scanner, and algorithm optimizer.</p>
      <p style="margin:0 0 24px">
        <a href="${DASHBOARD_URL}" style="display:inline-block;padding:12px 20px;background:#7ee0c0;color:#06281f;text-decoration:none;border-radius:8px;font-weight:600">Open your dashboard →</a>
      </p>
      <p style="margin:0 0 8px;font-size:14px;color:#8b949e">When you're ready for unlimited use, Algosize Pro is $29/month with a money-back guarantee on the cost analyzer alone.</p>
      <p style="margin:0;font-size:14px"><a href="${PRICING_URL}" style="color:#7ee0c0">See pricing →</a></p>
    `,
  );
  return { subject, text, html };
}

export function quotaWarning({ email, runsUsed, runsLimit, resetsOn }) {
  const subject = `Algosize — 1 free run left this month`;
  const text = [
    `Heads up — you've used ${runsUsed} of your ${runsLimit} free`,
    `analyses this month and have 1 run left.`,
    ``,
    `The counter resets on ${resetsOn}.`,
    ``,
    `If you hit the limit, Algosize Pro unlocks unlimited use:`,
    `${PRICING_URL}`,
    ``,
    `— The Algosize team`,
  ].join("\n");
  const html = shellHtml(
    "1 free run left this month",
    `
      <p style="margin:0 0 16px">Heads up — you've used <strong>${runsUsed} of ${runsLimit}</strong> free analyses this month and have <strong>1 run left</strong>.</p>
      <p style="margin:0 0 24px;font-size:14px;color:#8b949e">The counter resets on ${escapeHtml(resetsOn)}.</p>
      <p style="margin:0"><a href="${PRICING_URL}" style="color:#7ee0c0">Upgrade to Pro for unlimited use →</a></p>
    `,
  );
  return { subject, text, html };
}

export function magicLinkEmail({ email, verifyUrl, ttlMinutes }) {
  const subject = "Your Algosize sign-in link";
  const text = [
    `Hi,`,
    ``,
    `Click the link below to sign in to Algosize as ${email}.`,
    `The link is valid for ${ttlMinutes} minutes and can only be used once.`,
    ``,
    `${verifyUrl}`,
    ``,
    `If you didn't request this, you can safely ignore the email — no`,
    `account changes will be made.`,
    ``,
    `— The Algosize team`,
  ].join("\n");
  const html = shellHtml(
    "Sign in to Algosize",
    `
      <p style="margin:0 0 16px">Click the button below to sign in as <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#7ee0c0">${escapeHtml(email)}</code>. The link is valid for <strong>${ttlMinutes} minutes</strong> and can only be used once.</p>
      <p style="margin:0 0 24px">
        <a href="${verifyUrl}" style="display:inline-block;padding:12px 20px;background:#7ee0c0;color:#06281f;text-decoration:none;border-radius:8px;font-weight:600">Sign in to Algosize →</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#8b949e">Or paste this URL into your browser:</p>
      <p style="margin:0 0 16px;font-size:12px;word-break:break-all;color:#7ee0c0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(verifyUrl)}</p>
      <p style="margin:16px 0 0;font-size:13px;color:#8b949e">If you didn't request this, you can safely ignore this email — no account changes will be made.</p>
    `,
  );
  return { subject, text, html };
}

/**
 * Dunning email — sent from the invoice.payment_failed webhook.
 *
 * The three things a dunning email has to say, in this order, because a
 * customer who reads only the first line still needs to know it's about them:
 *   1. what failed (the charge, for this amount, on this account),
 *   2. what breaks and when (access continues to `accessEndsOn`, then the
 *      account drops to the free tier — 5 analyses a month),
 *   3. exactly one thing to click.
 *
 * `payUrl` is Stripe's `hosted_invoice_url` when the event carried one — it
 * settles the invoice without signing in, which is the shortest path back to
 * paid. `portalUrl` is our own billing entry point, used alone when Stripe
 * sent no hosted invoice. No guilt, no exclamation marks: the overwhelmingly
 * common cause is a card that expired.
 */
export function paymentFailed({ email, amountDue, accessEndsOn, payUrl, attemptCount }) {
  const subject = "Algosize — your payment didn't go through";
  const amount  = amountDue ? ` of ${amountDue}` : "";
  const retry   = attemptCount && attemptCount > 1
    ? `This was attempt ${attemptCount}. `
    : "";
  const deadline = accessEndsOn
    ? `Your Pro access stays on until ${accessEndsOn}. After that the account drops to the free tier (5 analyses per month) until a payment succeeds.`
    : `Your Pro access stays on for the rest of the period you've already paid for. After that the account drops to the free tier (5 analyses per month) until a payment succeeds.`;
  const link = payUrl || `${DASHBOARD_URL}#billing`;

  const text = [
    `We couldn't process the payment${amount} for your Algosize Pro`,
    `subscription (${email}).`,
    ``,
    `${retry}The usual cause is an expired or replaced card — nothing is`,
    `wrong with your account.`,
    ``,
    deadline,
    ``,
    `Update your payment method: ${link}`,
    ``,
    `— The Algosize team`,
  ].join("\n");

  const html = shellHtml(
    "Your payment didn't go through",
    `
      <p style="margin:0 0 16px">We couldn't process the payment${escapeHtml(amount)} for your Algosize Pro subscription (<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#7ee0c0">${escapeHtml(email)}</code>).</p>
      <p style="margin:0 0 16px;font-size:14px;color:#8b949e">${escapeHtml(retry)}The usual cause is an expired or replaced card — nothing is wrong with your account.</p>
      <p style="margin:0 0 24px">${escapeHtml(deadline)}</p>
      <p style="margin:0 0 8px">
        <a href="${link}" style="display:inline-block;padding:12px 20px;background:#7ee0c0;color:#06281f;text-decoration:none;border-radius:8px;font-weight:600">Update your payment method →</a>
      </p>
    `,
  );
  return { subject, text, html };
}

/**
 * Trial reminder — sent from customer.subscription.trial_will_end, which
 * Stripe fires three days before the trial converts.
 *
 * Deliberately not a sales pitch: the customer already chose to trial. It says
 * when the charge lands and how much, so the card statement is never a
 * surprise, and it gives cancelling equal billing with continuing. A trial
 * reminder that hides the cancel path is what generates the chargeback.
 */
export function trialEndingSoon({ email, trialEndsOn, amount }) {
  const subject = "Algosize — your trial ends in 3 days";
  const priceLine = amount
    ? `you'll be charged ${amount} and your subscription continues`
    : `your subscription converts to paid and continues`;

  const text = [
    `Your Algosize Pro trial (${email}) ends in 3 days${trialEndsOn ? `, on ${trialEndsOn}` : ""}.`,
    ``,
    `Nothing to do if you want to keep going — ${priceLine}`,
    `automatically. Unlimited analyses carry straight on.`,
    ``,
    `If Pro isn't for you, cancel any time before then and you won't be`,
    `charged. Your account stays on the free tier with 5 analyses a month:`,
    `${DASHBOARD_URL}#billing`,
    ``,
    `— The Algosize team`,
  ].join("\n");

  const html = shellHtml(
    "Your trial ends in 3 days",
    `
      <p style="margin:0 0 16px">Your Algosize Pro trial (<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#7ee0c0">${escapeHtml(email)}</code>) ends in 3 days${trialEndsOn ? `, on ${escapeHtml(trialEndsOn)}` : ""}.</p>
      <p style="margin:0 0 16px">Nothing to do if you want to keep going — ${escapeHtml(priceLine)} automatically, and unlimited analyses carry straight on.</p>
      <p style="margin:0 0 24px;font-size:14px;color:#8b949e">If Pro isn't for you, cancel any time before then and you won't be charged. Your account stays on the free tier with 5 analyses a month.</p>
      <p style="margin:0"><a href="${DASHBOARD_URL}#billing" style="color:#7ee0c0">Manage your subscription →</a></p>
    `,
  );
  return { subject, text, html };
}

/**
 * Organisation invite — sent from POST /api/org/invite.
 *
 * Names who invited them and which organisation, because an unexplained
 * "you've been invited" from a security vendor reads as phishing. The link is
 * single-use and the copy says so, so a forwarded mail sets expectations
 * correctly rather than producing a confused second person.
 */
export function orgInvite({ email, orgName, inviterName, acceptUrl, expiresInDays }) {
  const subject = `You've been invited to ${orgName} on Algosize`;
  const text = [
    `${inviterName} invited you to join ${orgName} on Algosize.`,
    ``,
    `Algosize audits dependencies and source for known vulnerabilities.`,
    `Joining gives you a seat on their plan — your own runs, their reports.`,
    ``,
    `Accept the invite: ${acceptUrl}`,
    ``,
    `The link works once and expires in ${expiresInDays} days. It was sent to`,
    `${email}, so sign in as that address to accept it.`,
    ``,
    `If you weren't expecting this, you can ignore the email — nothing is`,
    `created until you accept.`,
    ``,
    `— The Algosize team`,
  ].join("\n");

  const html = shellHtml(
    `You've been invited to ${escapeHtml(orgName)}`,
    `
      <p style="margin:0 0 16px"><strong>${escapeHtml(inviterName)}</strong> invited you to join <strong>${escapeHtml(orgName)}</strong> on Algosize — dependency and source auditing for known vulnerabilities. Joining gives you a seat on their plan.</p>
      <p style="margin:0 0 24px">
        <a href="${acceptUrl}" style="display:inline-block;padding:12px 20px;background:#7ee0c0;color:#06281f;text-decoration:none;border-radius:8px;font-weight:600">Accept the invite →</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#8b949e">The link works once and expires in ${expiresInDays} days. It was sent to <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#7ee0c0">${escapeHtml(email)}</code> — sign in as that address to accept.</p>
      <p style="margin:16px 0 0;font-size:13px;color:#8b949e">If you weren't expecting this, ignore the email — nothing is created until you accept.</p>
    `,
  );
  return { subject, text, html };
}

/**
 * Scheduled-monitor alert — sent when a nightly re-scan finds advisories that
 * were NOT present the previous run.
 *
 * The whole design constraint is that this arrives unprompted, at 3am, on a
 * schedule the reader set up once and forgot. So:
 *   - the subject leads with the worst new severity and the repo, because
 *     that is the entire triage decision most recipients will make;
 *   - only NEW advisories appear — the diff has already removed everything
 *     they saw last time, which is what keeps this out of the spam filter;
 *   - each finding carries its fixed version and the fix command, so the
 *     remediation doesn't require opening the dashboard first.
 *
 * `isBaseline` marks a monitor's first completed run, where "new since last
 * time" has no meaning yet. Saying so is more honest than presenting an
 * entire existing backlog as if it appeared overnight.
 */
export function monitorNewFindings({
  repoUrl, branch, newAdvisories, groups, counts, fixCommand, isBaseline, dashboardUrl,
}) {
  const total = newAdvisories.length;
  const worst = ["critical", "high", "medium", "low"].find((s) => counts[s] > 0) || "unknown";
  const repoLabel = `${repoUrl}${branch ? ` (${branch})` : ""}`;

  const subject = isBaseline
    ? `Algosize — baseline scan of ${repoUrl}: ${total} advisor${total === 1 ? "y" : "ies"}`
    : `Algosize — ${total} new ${worst} advisor${total === 1 ? "y" : "ies"} in ${repoUrl}`;

  const lead = isBaseline
    ? `First scheduled scan of ${repoLabel}. This is the current state — future emails will only list what's new since the previous scan.`
    : `New advisories in ${repoLabel} since the last scan. Everything you'd already seen has been left out.`;

  const textLines = [lead, ""];
  for (const group of groups) {
    textLines.push(`${group.severity.toUpperCase()} (${group.items.length})`);
    for (const a of group.items) {
      textLines.push(`  ${a.package}@${a.installedVersion} — ${a.id}`);
      if (a.fixedIn) textLines.push(`    fixed in ${a.fixedIn}`);
      if (a.summary) textLines.push(`    ${a.summary}`);
    }
    textLines.push("");
  }
  if (fixCommand) textLines.push(`Fix: ${fixCommand}`, "");
  textLines.push(`Full report: ${dashboardUrl}`, "", "— The Algosize team");

  const groupsHtml = groups.map((group) => `
      <p style="margin:18px 0 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8b949e">${escapeHtml(group.severity)} (${group.items.length})</p>
      ${group.items.map((a) => `
      <div style="margin:0 0 10px;padding:10px 12px;background:#0d1117;border-left:3px solid #7ee0c0;border-radius:0 4px 4px 0">
        <p style="margin:0 0 3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#f0f6fc">${escapeHtml(a.package)}@${escapeHtml(String(a.installedVersion))}</p>
        <p style="margin:0 0 3px;font-size:12px;color:#8b949e">${escapeHtml(a.id)}${a.fixedIn ? ` · fixed in <span style="color:#7ee0c0">${escapeHtml(String(a.fixedIn))}</span>` : ""}</p>
        ${a.summary ? `<p style="margin:0;font-size:13px;color:#c9d1d9">${escapeHtml(a.summary)}</p>` : ""}
      </div>`).join("")}
  `).join("");

  const html = shellHtml(
    isBaseline ? "Baseline scan complete" : `${total} new advisor${total === 1 ? "y" : "ies"}`,
    `
      <p style="margin:0 0 6px">${escapeHtml(lead)}</p>
      ${groupsHtml}
      ${fixCommand ? `
      <p style="margin:18px 0 6px;font-size:13px;color:#8b949e">Start here:</p>
      <p style="margin:0 0 20px;padding:10px 12px;background:#0d1117;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#7ee0c0">${escapeHtml(fixCommand)}</p>` : ""}
      <p style="margin:0 0 16px">
        <a href="${dashboardUrl}" style="display:inline-block;padding:12px 20px;background:#7ee0c0;color:#06281f;text-decoration:none;border-radius:8px;font-weight:600">View the full report →</a>
      </p>
      <p style="margin:16px 0 0;font-size:12px;color:#6e7681">You're getting this because a scheduled monitor is watching this repository. Pause or remove it from your dashboard.</p>
    `,
  );

  return { subject, text: textLines.join("\n"), html };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
