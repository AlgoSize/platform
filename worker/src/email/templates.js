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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
