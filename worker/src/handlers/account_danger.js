// The danger zone: take your data out, or end the account.
//
//   GET    /api/account/export   everything this organisation has, as JSON
//   DELETE /api/account/org      delete the organisation and everything in it
//
// Both are owner-only, and the second is the only endpoint in this codebase
// that destroys customer data. It is written to be boring: it says exactly
// what it will do before it does it, it requires the organisation's name
// typed back, and it cancels the subscription in Stripe rather than leaving a
// customer paying for something that no longer exists.

import { getActiveOrg, listMembers } from "./_orgs.js";
import { getUserById } from "./_users.js";
import { listAuditEvents, auditFromRequest, AUDIT_ACTIONS } from "../audit.js";
import { listCreditEvents, creditBalance, formatCents } from "../credits.js";
import { listReferrals } from "../referrals.js";
import { revokeAllUserSessions } from "../sessions.js";
import { stripeFetch } from "../stripe.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

async function requireOwner(request, env) {
  if (request.authMethod === "api_key") {
    return { error: jsonResponse({
      error: "forbidden",
      message: "API keys cannot export or delete an account. Sign in to do this.",
    }, 403) };
  }
  const sessionUser = request.user || {};
  if (!sessionUser.userId) return { error: jsonResponse({ error: "unauthorized" }, 401) };

  const active = await getActiveOrg(env, sessionUser.userId);
  if (!active) {
    return { error: jsonResponse({
      error: "no_organisation",
      message: "This account is not a member of any organisation.",
    }, 404) };
  }
  if (active.role !== "owner") {
    return { error: jsonResponse({
      error: "forbidden",
      message: "Only the owner can do this.",
      role: active.role,
    }, 403) };
  }
  return { userId: sessionUser.userId, org: active.org, role: active.role };
}

async function allRows(env, sql, ...binds) {
  try {
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return (res && res.results) || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GET /api/account/export
// ---------------------------------------------------------------------------
//
// A single JSON document, streamed as a download. Deliberately not a
// background job with an emailed link: the data an org of this size holds
// fits in a response, and a job queue would add a way for the export to
// silently never arrive.
//
// What it contains is listed in the document itself under `contents`, because
// an export whose scope you have to infer from what happens to be in it is
// not much use in a compliance conversation.
//
// Report BODIES are referenced, not embedded. A run's stored result can be
// megabytes of advisory data per row, and inlining every one would turn a
// download into a timeout. The run rows carry their ids; the reports are
// fetchable individually from /api/runs/:id/report, which is stated in the
// document rather than left to be discovered.
export async function exportAccountHandler(request, env, ctx) {
  const who = await requireOwner(request, env);
  if (who.error) return who.error;
  const { org } = who;

  const [user, members, runs, monitors, keys, credit, balance, referrals, audit] = await Promise.all([
    getUserById(env, who.userId).catch(() => null),
    listMembers(env, org.orgId).catch(() => []),
    allRows(env,
      `SELECT id, analyzer, source, headline, ms, created_at
         FROM runs WHERE org_id = ? ORDER BY created_at DESC LIMIT 5000`, org.orgId),
    allRows(env,
      `SELECT monitor_id, repo_url, branch, schedule, last_run_at, created_at, paused_at
         FROM monitors WHERE org_id = ?`, org.orgId),
    allRows(env,
      `SELECT key_id, name, prefix, created_by, created_at, last_used_at, revoked_at
         FROM api_keys WHERE org_id = ?`, org.orgId),
    listCreditEvents(env, org.orgId, { limit: 200 }),
    creditBalance(env, org.orgId),
    listReferrals(env, org.orgId, { limit: 200 }),
    listAuditEvents(env, { orgId: org.orgId, limit: 200 }).catch(() => ({ events: [] })),
  ]);

  const doc = {
    exportedAt: new Date().toISOString(),
    exportedBy: (user && user.email) || null,
    contents: [
      "The organisation record and its subscription state",
      "Every member and their role",
      "Every analyser run's metadata (report bodies are referenced by id, not embedded)",
      "Scheduled monitors",
      "API key metadata — never the keys themselves, which are stored only as hashes",
      "The credit ledger and referral funnel",
      "The last 200 audit-log entries for this organisation",
    ],
    notIncluded: [
      "Report bodies — fetch each from /api/runs/<id>/report while your account is active",
      "API key secrets — they exist only as hashes and cannot be recovered by anyone, including us",
      "Card details — Algosize never receives or stores them; they live only in Stripe",
    ],
    organisation: {
      orgId: org.orgId,
      name: org.name,
      plan: org.plan,
      subStatus: org.subStatus,
      seatsPurchased: org.seatsPurchased,
      currentPeriodEnd: org.currentPeriodEnd,
      billingEmail: org.billingEmail,
      branding: {
        companyName: org.brandCompanyName,
        logoUrl: org.brandLogoUrl,
        accent: org.brandAccent,
        domain: org.brandDomain,
        domainStatus: org.brandDomainStatus,
      },
      createdAt: org.createdAt,
    },
    members: members.map((m) => ({
      email: m.email, role: m.role, joinedAt: m.joinedAt,
    })),
    runs: runs.map((r) => ({
      id: r.id, analyzer: r.analyzer, source: r.source,
      headline: r.headline, durationMs: r.ms, createdAt: r.created_at,
      reportPath: `/api/runs/${r.id}/report`,
    })),
    monitors: monitors.map((m) => ({
      monitorId: m.monitor_id, repoUrl: m.repo_url, branch: m.branch,
      schedule: m.schedule, lastRunAt: m.last_run_at,
      createdAt: m.created_at, pausedAt: m.paused_at,
    })),
    apiKeys: keys.map((k) => ({
      keyId: k.key_id, name: k.name, prefix: k.prefix,
      createdBy: k.created_by, createdAt: k.created_at,
      lastUsedAt: k.last_used_at, revokedAt: k.revoked_at,
    })),
    credit: {
      balance: formatCents(balance.balanceCents),
      balanceCents: balance.balanceCents,
      note: "Credit reduces an Algosize invoice. It is not cash, is not withdrawable, and is forfeited if the organisation is deleted.",
      events: credit.events,
    },
    referrals: referrals.referrals,
    auditLog: audit.events,
  };

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.DATA_EXPORTED,
    targetType: "org", targetId: org.orgId, orgId: org.orgId,
    metadata: { runs: runs.length, members: members.length },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="algosize-export-${org.orgId}-${stamp}.json"`,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/account/delete-preview
// ---------------------------------------------------------------------------
//
// The consequences, counted from real rows rather than written as generic
// copy. "Removes your data" is a sentence nobody reads; "18 reports and every
// shared link are deleted, 7 members lose access, $240.00 of credit is
// forfeited" is one they do.
//
// A separate endpoint from the delete itself so the confirmation dialog can
// show real numbers before anything is at stake.
export async function deletePreviewHandler(request, env) {
  const who = await requireOwner(request, env);
  if (who.error) return who.error;
  const { org } = who;

  const [members, runRow, monitorRow, keyRow, balance] = await Promise.all([
    listMembers(env, org.orgId).catch(() => []),
    env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE org_id = ?").bind(org.orgId).first().catch(() => null),
    env.DB.prepare("SELECT COUNT(*) AS n FROM monitors WHERE org_id = ?").bind(org.orgId).first().catch(() => null),
    env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND revoked_at IS NULL").bind(org.orgId).first().catch(() => null),
    creditBalance(env, org.orgId),
  ]);

  const runs     = runRow ? Number(runRow.n) || 0 : 0;
  const monitors = monitorRow ? Number(monitorRow.n) || 0 : 0;
  const keys     = keyRow ? Number(keyRow.n) || 0 : 0;

  const consequences = [
    `All ${members.length} ${members.length === 1 ? "member" : "members"} lose access immediately, including you.`,
    `${runs} ${runs === 1 ? "report is" : "reports are"} deleted, along with every share link. Anyone holding one gets a 404.`,
  ];
  if (org.stripeCustomerId) {
    consequences.push("The subscription is cancelled in Stripe. No refund is issued for the remainder of the period.");
  }
  if (balance.balanceCents > 0) {
    consequences.push(`${formatCents(balance.balanceCents)} of credit is forfeited — credit cannot be paid out or moved to another account.`);
  }
  if (keys) {
    consequences.push(`${keys} API ${keys === 1 ? "key stops" : "keys stop"} working, so any CI pipeline using them fails on the next push.`);
  }
  if (monitors) {
    consequences.push(`${monitors} scheduled ${monitors === 1 ? "monitor stops" : "monitors stop"} running.`);
  }

  return jsonResponse({
    // Typed back verbatim to enable the button. Returned rather than assumed
    // so the dialog and the server agree on the exact string, including case.
    confirmPhrase: org.name,
    consequences,
    counts: { members: members.length, runs, monitors, apiKeys: keys },
    creditForfeitedCents: Math.max(balance.balanceCents, 0),
    creditForfeited: formatCents(Math.max(balance.balanceCents, 0)),
    reversible: false,
    note: "There is no restore and no grace window. Export your data first if you may want it.",
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/account/org
// ---------------------------------------------------------------------------
//
// Order matters, and it is: cancel billing → write the audit row → delete
// data → sign everyone out.
//
// Billing goes first because it is the only step that involves a third party,
// and it is the one step whose failure must stop the whole operation. Deleting
// the org while its Stripe subscription keeps renewing would charge someone
// monthly for an account that no longer exists — a far worse outcome than a
// deletion that refuses and asks them to try again.
//
// The audit row is written BEFORE the deletion, because afterwards there is
// no org id left to attribute it to and the actor's own membership is gone.
export async function deleteOrgHandler(request, env, ctx) {
  const who = await requireOwner(request, env);
  if (who.error) return who.error;
  const { org } = who;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Body must be JSON." }, 400); }

  const typed = body && typeof body.confirm === "string" ? body.confirm.trim() : "";
  if (typed !== org.name) {
    return jsonResponse({
      error: "confirmation_mismatch",
      message: `Type the organisation name exactly — "${org.name}" — to confirm.`,
      confirmPhrase: org.name,
    }, 400);
  }

  // ---- 1. billing --------------------------------------------------------
  if (org.stripeCustomerId && env.STRIPE_SECRET_KEY) {
    try {
      const subs = await stripeFetch(
        env, `/subscriptions?customer=${encodeURIComponent(org.stripeCustomerId)}&status=active&limit=10`,
        { method: "GET" });
      for (const sub of (subs && subs.data) || []) {
        await stripeFetch(env, `/subscriptions/${encodeURIComponent(sub.id)}`, { method: "DELETE" });
      }
    } catch (err) {
      console.error("account/delete: stripe cancel failed", err);
      return jsonResponse({
        error: "billing_cancel_failed",
        message: "Could not cancel the subscription in Stripe, so nothing was deleted. " +
                 "Deleting the account while it keeps billing would be worse than not deleting it. " +
                 "Try again, or cancel in the Stripe portal first.",
      }, 502);
    }
  }

  const members = await listMembers(env, org.orgId).catch(() => []);

  // ---- 2. the audit row, while there is still something to attribute -----
  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.ORG_DELETED,
    targetType: "org", targetId: org.orgId, orgId: org.orgId,
    metadata: { name: org.name, members: members.length },
  });

  // ---- 3. the data -------------------------------------------------------
  // audit_log is NOT deleted. It is the record that this happened, it names
  // the actor, and a deletion path that erases its own evidence is not one
  // anybody should trust. Its rows carry no report content.
  const orgId = org.orgId;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM runs           WHERE org_id = ?").bind(orgId),
      env.DB.prepare("DELETE FROM monitors       WHERE org_id = ?").bind(orgId),
      env.DB.prepare("DELETE FROM api_keys       WHERE org_id = ?").bind(orgId),
      env.DB.prepare("DELETE FROM credit_events  WHERE org_id = ?").bind(orgId),
      env.DB.prepare("DELETE FROM referral_codes WHERE org_id = ?").bind(orgId),
      env.DB.prepare("DELETE FROM referrals      WHERE referrer_org_id = ?").bind(orgId),
      // A referral POINTING AT this org is cleared rather than deleted: the
      // referrer earned that credit and their history must not lose the row
      // explaining where it came from.
      env.DB.prepare("UPDATE referrals SET referred_org_id = NULL WHERE referred_org_id = ?").bind(orgId),
      env.DB.prepare("DELETE FROM memberships    WHERE org_id = ?").bind(orgId),
      env.DB.prepare("UPDATE users SET active_org_id = NULL WHERE active_org_id = ?").bind(orgId),
      env.DB.prepare("DELETE FROM organisations  WHERE org_id = ?").bind(orgId),
    ]);
  } catch (err) {
    console.error("account/delete: d1 delete failed", err);
    return jsonResponse({
      error: "delete_failed",
      message: "The subscription was cancelled but the data could not be deleted. Contact support — " +
               "your account is no longer billing, and nothing else has changed.",
    }, 500);
  }

  // ---- 4. sign everyone out ---------------------------------------------
  // Every member, not just the caller. Their session is still cryptographically
  // valid and would keep working against an org that no longer exists, which
  // surfaces as unexplained 404s rather than as "this account is gone".
  for (const m of members) {
    try { await revokeAllUserSessions(env, m.userId); } catch { /* best effort */ }
  }

  // Stored report bodies in R2 are left for a lifecycle rule rather than
  // deleted here: a per-object delete loop over a large account would run past
  // the request's CPU budget and fail halfway, and the rows that name those
  // objects are already gone, so nothing can reach them.
  return jsonResponse(
    {
      ok: true, deleted: true, orgId,
      message: "The organisation and everything in it has been deleted.",
    },
    200,
    {
      // Clear the caller's own cookie on the way out, so the browser does not
      // keep presenting a credential for an account that no longer exists.
      "Set-Cookie": [
        `${env.COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0",
      ].join("; "),
    },
  );
}
