// The account-management surface: who you are, how you get in, and what we
// tell you about.
//
//   GET    /api/account                     everything the settings page opens with
//   PATCH  /api/account/profile             display name, avatar, company name
//   POST   /api/account/email               start a login-email change
//   GET    /api/account/email/confirm       finish one (clicked from email)
//   DELETE /api/account/email               abandon a pending change
//   GET    /api/account/sessions            devices signed in
//   DELETE /api/account/sessions/:sessionId revoke one
//   POST   /api/account/sessions/revoke-others
//   GET    /api/account/logins              sign-in history
//   GET    /api/account/notifications       catalog + this user's answers
//   PUT    /api/account/notifications       save them
//
// Everything here requires a SESSION, never an API key. An API key has no
// human behind it, so "which devices am I signed in on" and "change my email"
// are not questions it can meaningfully ask — and a leaked key must not be
// able to move the account's login address, which would turn a key compromise
// into an account takeover. requireAuth accepts both credential types, so the
// refusal is made explicitly below rather than assumed.
//
// The Team and API-key sections of the settings page are NOT here: they are
// served by the existing /api/org and /api/keys routes, which already do
// exactly what the screen needs. Re-implementing them behind /api/account
// would have created a second set of rules for seats and roles to drift out
// of step with.

import { getActiveOrg, listMembers, getOrgById } from "./_orgs.js";
import { getUserById } from "./_users.js";
import { resolveEntitlementForOrg } from "../entitlement.js";
import { listUserSessions, revokeUserSession, revokeAllUserSessions } from "../sessions.js";
import { listAuditEvents, auditFromRequest, AUDIT_ACTIONS } from "../audit.js";
import { readNotificationPrefs, writeNotificationPrefs, describePrefs } from "../notifications.js";
import { creditBalance, formatCents } from "../credits.js";
import { tierForOrg, safeLogoUrl } from "../reports/branding.js";
import { peekUsage, FREE_MONTHLY_LIMIT } from "../quota.js";
import { sendTransactional } from "../email/transactional.js";
import { emailChangeConfirm, emailChangeNotice } from "../email/templates.js";
import { recordEmailSend } from "../oplog.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;
const MAX_NAME_LEN = 120;
const EMAIL_CHANGE_TTL_SEC = 30 * 60;   // 30 minutes
const TOKEN_BYTES = 32;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/**
 * Resolve the signed-in human plus their org, once.
 *
 * Refuses API-key callers explicitly. requireAuth lets a key through and sets
 * `request.org` but never `request.user`, so without this check every handler
 * below would see `userId: undefined` and fail in a differently-shaped way
 * — most likely a confusing 404 rather than an honest "keys can't do this".
 */
async function requireHuman(request, env) {
  if (request.authMethod === "api_key") {
    return {
      error: jsonResponse({
        error: "forbidden",
        message: "API keys cannot manage an account. Sign in to change these settings.",
      }, 403),
    };
  }
  const sessionUser = request.user || {};
  if (!sessionUser.userId) {
    return { error: jsonResponse({ error: "unauthorized" }, 401) };
  }
  return { userId: sessionUser.userId, email: sessionUser.email || null };
}

async function requireHumanWithOrg(request, env) {
  const who = await requireHuman(request, env);
  if (who.error) return who;
  const active = await getActiveOrg(env, who.userId);
  if (!active) {
    return {
      error: jsonResponse({
        error: "no_organisation",
        message: "This account is not a member of any organisation.",
      }, 404),
    };
  }
  return { ...who, org: active.org, role: active.role };
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Derive initials the way the UI shows them.
 *
 * Done server-side so the avatar in an email, the dashboard header and the
 * account page cannot disagree. Falls back through display name → email local
 * part → "?", and never returns an empty string, because a blank avatar
 * circle reads as a rendering bug rather than as missing data.
 */
export function initialsFor({ displayName, email }) {
  const source = (displayName || "").trim() || String(email || "").split("@")[0] || "";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

async function readPendingEmailChange(env, userId) {
  if (!env || !env.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT new_email, created_at, expires_at FROM email_changes WHERE user_id = ?")
      .bind(userId).first();
    if (!row) return null;
    const now = Math.floor(Date.now() / 1000);
    // An expired row is not a pending change. Left in place rather than swept
    // here: a read path that deletes is a read path that can fail a GET.
    if (Number(row.expires_at) <= now) return null;
    return {
      newEmail:  row.new_email,
      requestedAt: Number(row.created_at) || null,
      expiresAt: Number(row.expires_at) || null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/account — one request, everything the page opens with
// ---------------------------------------------------------------------------
//
// Deliberately one endpoint rather than ten. The summary pane at the top of
// the settings area shows plan, renewal, credit and seats together, and
// fetching those from four places would make the pane assemble itself in
// front of the user, one number at a time.
//
// Sections that need a lot of data (invoices, referral history, sessions) are
// NOT here — they load when their section opens.
export async function getAccountHandler(request, env, ctx) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  const [user, active] = await Promise.all([
    getUserById(env, who.userId).catch(() => null),
    getActiveOrg(env, who.userId).catch(() => null),
  ]);

  const org  = active && active.org;
  const role = active && active.role;

  const [entitlement, credit, members, pendingEmail, usage] = await Promise.all([
    org ? resolveEntitlementForOrg(env, org.orgId, { request, ctx }).catch(() => null) : null,
    org ? creditBalance(env, org.orgId) : null,
    org ? listMembers(env, org.orgId).catch(() => []) : [],
    readPendingEmailChange(env, who.userId),
    peekUsage(env, who.userId).catch(() => null),
  ]);

  const active_ = !!(entitlement && entitlement.active);
  const tier = org ? tierForOrg(env, org) : null;

  return jsonResponse({
    profile: {
      userId:      who.userId,
      email:       (user && user.email) || who.email,
      displayName: (user && user.displayName) || null,
      avatarUrl:   (user && user.avatarUrl) || null,
      initials:    initialsFor({
        displayName: user && user.displayName,
        email: (user && user.email) || who.email,
      }),
      // How this person actually signs in. Rendered as connected methods
      // rather than as a password field, because there is no password.
      authMethod:  (user && user.authMethod) || null,
      // Distinguishes "signs in with magic link" from "we have no record",
      // which for pre-0011 rows is genuinely unknown rather than magic_link.
      authMethodKnown: !!(user && user.authMethod),
      createdAt:   (user && user.createdAt) || null,
      pendingEmailChange: pendingEmail,
    },
    org: org ? {
      orgId:          org.orgId,
      name:           org.name,
      role,
      tier,
      plan:           org.plan,
      subStatus:      org.subStatus,
      seatsPurchased: org.seatsPurchased,
      seatsUsed:      members.length,
      billingEmail:   org.billingEmail || null,
      hasStripeCustomer: !!org.stripeCustomerId,
    } : null,
    entitlement: entitlement ? {
      active:           entitlement.active,
      reason:           entitlement.reason,
      currentPeriodEnd: entitlement.currentPeriodEnd,
    } : null,
    usage: active_ ? null : {
      monthlyRunsUsed:  usage,
      monthlyRunsLimit: FREE_MONTHLY_LIMIT,
    },
    credit: credit ? {
      balanceCents: credit.balanceCents,
      balance:      formatCents(credit.balanceCents),
      // Our ledger says this much credit exists that Stripe has not been told
      // about. Surfaced rather than hidden — see src/credits.js.
      unsyncedCents: credit.unsyncedCents,
      expiringCents: credit.expiringCents,
      expiringAt:    credit.expiringAt,
      // false means we could not read the ledger at all. The UI must render
      // that as unknown, never as $0.00.
      known:         credit.complete,
    } : null,
    // Which sections have anything to show. The nav renders every section
    // regardless — a locked Branding panel that explains what Firm buys is
    // more use to someone comparing plans than a section that is not there —
    // but the page needs to know which ones are live.
    capabilities: {
      branding:   { unlocked: active_ && tier === "firm", requiredTier: "firm" },
      team:       { canManage: role === "owner" || role === "admin" },
      apiKeys:    { canManage: role === "owner" || role === "admin" },
      dangerZone: { canDeleteOrg: role === "owner" },
      billing:    { canManage: role === "owner" },
    },
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/account/profile
// ---------------------------------------------------------------------------
//
// Three fields, two subjects: displayName/avatarUrl belong to the USER,
// companyName is the ORGANISATION's name. They are edited on one form because
// that is how someone thinks about "my profile", and split correctly on write
// because renaming the org affects everyone in it.
//
// Editing the org name therefore needs owner/admin; editing your own name
// does not. A member who submits both gets their own fields saved and an
// explicit refusal for the org one, rather than a blanket 403 that loses the
// change they were entitled to make.
export async function updateProfileHandler(request, env, ctx) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Body must be JSON." }, 400); }
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "invalid_json", message: "Body must be a JSON object." }, 400);
  }

  const sets = [];
  const binds = [];
  const changed = {};

  // undefined = leave alone. null or "" = clear. Same convention as
  // /api/org/branding, so the two forms behave identically.
  if (body.displayName !== undefined) {
    if (body.displayName === null || body.displayName === "") {
      sets.push("display_name = NULL"); changed.displayName = null;
    } else if (typeof body.displayName !== "string" || body.displayName.trim().length > MAX_NAME_LEN) {
      return jsonResponse({
        error: "invalid_display_name",
        message: `Name must be 1–${MAX_NAME_LEN} characters.`,
      }, 400);
    } else {
      const v = body.displayName.trim();
      if (!v) { sets.push("display_name = NULL"); changed.displayName = null; }
      else { sets.push("display_name = ?"); binds.push(v); changed.displayName = v; }
    }
  }

  if (body.avatarUrl !== undefined) {
    if (body.avatarUrl === null || body.avatarUrl === "") {
      sets.push("avatar_url = NULL"); changed.avatarUrl = null;
    } else {
      // Same validator the report logo uses, for the same reason: this ends
      // up in an <img src>, and https-only is checked on write AND on render.
      const url = safeLogoUrl(body.avatarUrl);
      if (!url) {
        return jsonResponse({
          error: "invalid_avatar_url",
          message: "The avatar must be an absolute https:// URL to an image. http, data: and javascript: URLs are refused.",
        }, 400);
      }
      sets.push("avatar_url = ?"); binds.push(url); changed.avatarUrl = url;
    }
  }

  // ---- the org half ------------------------------------------------------
  let orgRefusal = null;
  if (body.companyName !== undefined) {
    const active = await getActiveOrg(env, who.userId);
    if (!active) {
      orgRefusal = { error: "no_organisation", message: "This account is not a member of any organisation." };
    } else if (active.role !== "owner" && active.role !== "admin") {
      orgRefusal = {
        error: "forbidden",
        message: "Only an owner or admin can rename the organisation. Your own name and avatar were saved.",
        role: active.role,
      };
    } else {
      const name = typeof body.companyName === "string" ? body.companyName.trim() : "";
      if (!name || name.length > MAX_NAME_LEN) {
        return jsonResponse({
          error: "invalid_company_name",
          message: `Company name must be 1–${MAX_NAME_LEN} characters.`,
        }, 400);
      }
      if (name !== active.org.name) {
        await env.DB.prepare("UPDATE organisations SET name = ?, updated_at = ? WHERE org_id = ?")
          .bind(name, Math.floor(Date.now() / 1000), active.org.orgId).run();
        changed.companyName = name;
        await auditFromRequest(request, env, ctx, {
          action: AUDIT_ACTIONS.ORG_RENAMED,
          targetType: "org", targetId: active.org.orgId, orgId: active.org.orgId,
          metadata: { from: active.org.name, to: name },
        });
      }
    }
  }

  if (!sets.length && !("companyName" in changed) && !orgRefusal) {
    return jsonResponse({
      error: "nothing_to_update",
      message: "Provide displayName, avatarUrl and/or companyName. Send null to clear one.",
    }, 400);
  }

  if (sets.length) {
    sets.push("updated_at = ?"); binds.push(Math.floor(Date.now() / 1000));
    binds.push(who.userId);
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE user_id = ?`).bind(...binds).run();
    await auditFromRequest(request, env, ctx, {
      action: AUDIT_ACTIONS.PROFILE_UPDATED,
      targetType: "user", targetId: who.userId,
      metadata: { fields: Object.keys(changed) },
    });
  }

  const fresh = await getUserById(env, who.userId).catch(() => null);
  return jsonResponse({
    ok: true,
    profile: {
      displayName: (fresh && fresh.displayName) || null,
      avatarUrl:   (fresh && fresh.avatarUrl) || null,
      initials:    initialsFor({
        displayName: fresh && fresh.displayName,
        email: (fresh && fresh.email) || who.email,
      }),
    },
    changed,
    // Present only when part of the request was refused. The UI shows it as a
    // warning beside the saved fields, not as a failure of the whole save.
    refused: orgRefusal,
  }, orgRefusal ? 200 : 200);
}

// ---------------------------------------------------------------------------
// POST /api/account/email — start a login-email change
// ---------------------------------------------------------------------------
//
// The login email IS the credential: magic links go to it. So the change is
// STAGED, not applied. Two emails go out:
//
//   to the NEW address  a confirmation link — proves control of it
//   to the OLD address  a notice that this was requested — the only warning
//                       the real owner gets if a hijacked session is being
//                       used to lock them out
//
// Until confirmed, sign-in links keep going to the old address, so an
// unfinished or malicious change cannot lock anyone out of anything.
export async function requestEmailChangeHandler(request, env, ctx) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Body must be JSON." }, 400); }

  const raw = body && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!raw || raw.length > MAX_EMAIL_LEN || !EMAIL_RE.test(raw)) {
    return jsonResponse({ error: "invalid_email", message: "Enter a valid email address." }, 400);
  }

  const user = await getUserById(env, who.userId);
  if (!user) return jsonResponse({ error: "not_found", message: "Account not found." }, 404);
  if (raw === String(user.email || "").toLowerCase()) {
    return jsonResponse({
      error: "same_email",
      message: "That is already your login email.",
    }, 400);
  }

  // Refuse an address already in use. `users.email` is UNIQUE, so letting
  // this reach the confirm step would produce a constraint failure at the
  // worst possible moment — after the user has clicked a link and been told
  // it was about to work.
  const taken = await env.DB.prepare("SELECT user_id FROM users WHERE email = ?").bind(raw).first();
  if (taken) {
    return jsonResponse({
      error: "email_in_use",
      message: "That address already has an Algosize account. Sign in with it instead, or use a different address.",
    }, 409);
  }

  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + EMAIL_CHANGE_TTL_SEC;

  await env.DB.prepare(
    `INSERT INTO email_changes (user_id, new_email, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       new_email = excluded.new_email, token_hash = excluded.token_hash,
       created_at = excluded.created_at, expires_at = excluded.expires_at`)
    .bind(who.userId, raw, await sha256Hex(token), now, expiresAt).run();

  const origin = (env.SITE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
  const confirmUrl = `${origin}/api/account/email/confirm?token=${encodeURIComponent(token)}`;
  const ttlMinutes = EMAIL_CHANGE_TTL_SEC / 60;

  const confirmTmpl = emailChangeConfirm({
    oldEmail: user.email, newEmail: raw, confirmUrl, ttlMinutes,
  });
  const noticeTmpl = emailChangeNotice({ oldEmail: user.email, newEmail: raw, ttlMinutes });

  const sends = Promise.all([
    sendTransactional(env, ctx, {
      to: raw, subject: confirmTmpl.subject, text: confirmTmpl.text, html: confirmTmpl.html,
    }).then((result) => recordEmailSend(env, ctx, {
      recipient: raw, template: "email_change_confirm", result,
    })),
    sendTransactional(env, ctx, {
      to: user.email, subject: noticeTmpl.subject, text: noticeTmpl.text, html: noticeTmpl.html,
    }).then((result) => recordEmailSend(env, ctx, {
      recipient: user.email, template: "email_change_notice", result,
    })),
  ]);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(sends);
  else void sends.catch(() => {});

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.EMAIL_CHANGE_REQUESTED,
    targetType: "user", targetId: who.userId,
    metadata: { to: raw },
  });

  return jsonResponse({
    ok: true,
    pendingEmailChange: { newEmail: raw, requestedAt: now, expiresAt },
    message: `Check ${raw} for a confirmation link. Until you confirm it, sign-in links keep going to ${user.email}.`,
  });
}

// ---------------------------------------------------------------------------
// GET /api/account/email/confirm?token=… — clicked from the new address
// ---------------------------------------------------------------------------
//
// A browser GET, so it redirects rather than returning JSON. No session is
// required: the person clicking is proving control of the NEW mailbox, and
// they may well be reading it on a device that has never signed in. The token
// is the authorisation, exactly as it is for a magic link.
export async function confirmEmailChangeHandler(request, env, ctx) {
  const origin = (env.SITE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
  const back = (status) => Response.redirect(`${origin}/dashboard/#/account?email=${status}`, 302);

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return back("missing_token");

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT user_id, new_email, expires_at FROM email_changes WHERE token_hash = ?`)
      .bind(await sha256Hex(token)).first();
  } catch {
    return back("server_error");
  }
  if (!row) return back("expired_or_invalid");

  // Delete first, so a double-click cannot apply the change twice and a
  // failure below leaves no reusable token behind.
  await env.DB.prepare("DELETE FROM email_changes WHERE user_id = ?").bind(row.user_id).run();

  if (Number(row.expires_at) <= Math.floor(Date.now() / 1000)) return back("expired_or_invalid");

  const before = await getUserById(env, row.user_id).catch(() => null);

  try {
    await env.DB.prepare("UPDATE users SET email = ?, updated_at = ? WHERE user_id = ?")
      .bind(row.new_email, Math.floor(Date.now() / 1000), row.user_id).run();
  } catch {
    // Almost certainly the UNIQUE(email) constraint: the address was claimed
    // by someone else between request and confirmation.
    return back("email_in_use");
  }

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.EMAIL_CHANGED,
    targetType: "user", targetId: row.user_id,
    metadata: { from: before && before.email, to: row.new_email },
  });

  // Every existing session was issued against the old identity, and the JWT
  // carries the email in its payload. Leaving them alive would mean sessions
  // whose token says one address while the row says another — and, more to
  // the point, if this change was made by someone who had taken the account
  // over, the real owner needs their sessions gone. Signing everyone out is
  // the only version of this that is safe in both directions.
  try { await revokeAllUserSessions(env, row.user_id); } catch { /* best effort */ }

  return back("changed");
}

// ---------------------------------------------------------------------------
// DELETE /api/account/email — abandon a pending change
// ---------------------------------------------------------------------------
export async function cancelEmailChangeHandler(request, env, ctx) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  const res = await env.DB.prepare("DELETE FROM email_changes WHERE user_id = ?")
    .bind(who.userId).run();
  const removed = !!(res && res.meta && res.meta.changes);
  return jsonResponse({ ok: true, cancelled: removed });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Turn a stored user-agent into something a person recognises.
 *
 * Coarse on purpose. The question this list answers is "is one of these not
 * me", and "Chrome on macOS" answers it; a version string does not, and
 * parsing one out of a UA reliably is a losing game. An unparseable UA
 * returns null rather than a guess — "Unknown device" beside a real IP is
 * honest, "Chrome on Windows" that is actually a script is not.
 */
export function describeDevice(userAgent) {
  if (typeof userAgent !== "string" || !userAgent) return null;
  const ua = userAgent;
  const browser =
    /\bEdg\//.test(ua)     ? "Edge" :
    /\bOPR\//.test(ua)     ? "Opera" :
    /\bFirefox\//.test(ua) ? "Firefox" :
    /\bChrome\//.test(ua)  ? "Chrome" :
    /\bSafari\//.test(ua) && /\bVersion\//.test(ua) ? "Safari" :
    /\bcurl\//.test(ua)    ? "curl" :
    null;
  const os =
    /\biPhone\b/.test(ua)          ? "iPhone" :
    /\biPad\b/.test(ua)            ? "iPad" :
    /\bAndroid\b/.test(ua)         ? "Android" :
    /\bMac OS X\b|\bMacintosh\b/.test(ua) ? "macOS" :
    /\bWindows\b/.test(ua)         ? "Windows" :
    /\bCrOS\b/.test(ua)            ? "ChromeOS" :
    /\bLinux\b/.test(ua)           ? "Linux" :
    null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || null;
}

export async function listSessionsHandler(request, env) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  const { sessions, complete } = await listUserSessions(env, who.userId, {
    currentToken: request.token || null,
  });

  return jsonResponse({
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      device:    describeDevice(s.userAgent),
      userAgent: s.userAgent,
      ip:        s.ip,
      country:   s.country,
      issuedAt:  s.issuedAt,
      current:   s.current,
    })),
    // Two separate truths, and the UI says both. `complete: false` means KV
    // paginated. `indexedOnly` is the permanent caveat from src/sessions.js:
    // sessions issued before the index shipped are not listed at all, so this
    // is a floor on how many devices are signed in, never a count.
    complete,
    indexedOnly: true,
    note: "Sessions issued before device tracking shipped are not listed. Sessions expire after 30 days.",
  });
}

export async function revokeSessionHandler(request, env, ctx) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  const sessionId = request.params && request.params.sessionId;
  if (!sessionId) {
    return jsonResponse({ error: "invalid_request", message: "No session id supplied." }, 400);
  }

  // Refuse to revoke the session making the request. It would work — and the
  // user would be signed out by their own click with no explanation, which
  // reads as the app crashing. Signing out is a different button.
  const { sessions } = await listUserSessions(env, who.userId, { currentToken: request.token || null });
  const target = sessions.find((s) => s.sessionId === sessionId);
  if (target && target.current) {
    return jsonResponse({
      error: "cannot_revoke_current",
      message: "That is the session you are using. Use Sign out instead.",
    }, 400);
  }

  const result = await revokeUserSession(env, who.userId, sessionId);
  if (!result.revoked) {
    return jsonResponse({
      error: result.reason === "not_found" ? "not_found" : "invalid_request",
      message: result.reason === "not_found"
        ? "That session has already ended."
        : "Could not revoke that session.",
    }, result.reason === "not_found" ? 404 : 400);
  }

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.SESSION_REVOKED,
    targetType: "session", targetId: sessionId,
    metadata: { self: true, device: target ? describeDevice(target.userAgent) : null },
  });

  return jsonResponse({ ok: true, sessionId, revoked: true });
}

export async function revokeOtherSessionsHandler(request, env, ctx) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  const { revoked, complete } = await revokeAllUserSessions(env, who.userId, {
    exceptToken: request.token || null,
  });

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.SESSION_REVOKED,
    targetType: "user", targetId: who.userId,
    metadata: { self: true, bulk: true, count: revoked },
  });

  return jsonResponse({
    ok: true,
    revoked,
    // A partial sweep is reported as one. Saying "signed out everywhere" when
    // KV paginated and some sessions survived is the one lie this endpoint
    // must not tell — the whole reason someone clicks it is a lost device.
    complete,
    message: complete
      ? `Signed out of ${revoked} other ${revoked === 1 ? "device" : "devices"}.`
      : `Signed out of ${revoked} devices. There may be more — run this again to be sure.`,
  });
}

// ---------------------------------------------------------------------------
// GET /api/account/logins — sign-in history
// ---------------------------------------------------------------------------
//
// Read from the audit log rather than from the session index, because the
// index only knows about sessions that are still alive. Someone who was
// signed in from a place they did not recognise and has since been signed out
// would see nothing at all — which is exactly the case this list exists for.
export async function listLoginsHandler(request, env) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  const user = await getUserById(env, who.userId).catch(() => null);
  const actor = (user && user.email) || who.email;
  if (!actor) return jsonResponse({ logins: [], complete: false });

  const { events } = await listAuditEvents(env, {
    actor, action: AUDIT_ACTIONS.AUTH_LOGIN, limit: 30,
  });

  return jsonResponse({
    logins: events.map((e) => ({
      at:      e.createdAt,
      method:  (e.metadata && e.metadata.method) || null,
      ip:      (e.metadata && e.metadata.ip) || null,
      country: (e.metadata && e.metadata.country) || null,
      device:  describeDevice(e.metadata && e.metadata.userAgent),
    })),
    // Logins before this shipped were never recorded. An empty list means
    // "nothing recorded since we started recording", not "you have never
    // signed in", and the UI has to be able to say which.
    since: "Recorded from the release that added sign-in history. Earlier sign-ins were not logged.",
  });
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

export async function getNotificationsHandler(request, env) {
  const who = await requireHumanWithOrg(request, env);
  if (who.error) return who.error;

  const { prefs, stored } = await readNotificationPrefs(env, who.userId);
  const org = await getOrgById(env, who.org.orgId).catch(() => null);

  return jsonResponse({
    groups: describePrefs(prefs),
    // A Slack toggle that is on with no webhook configured delivers nothing.
    // Reported as its own fact so the UI can say so beside the switch rather
    // than letting someone believe alerts are going somewhere.
    slack: {
      configured: !!(org && org.slackWebhookUrl),
      note: org && org.slackWebhookUrl
        ? null
        : "No Slack webhook is configured for this organisation, so Slack toggles have nowhere to deliver.",
    },
    // false = we are showing defaults because nothing has been saved (or the
    // preferences table could not be read). Either way these are not
    // necessarily this user's choices.
    stored,
  });
}

export async function updateNotificationsHandler(request, env, ctx) {
  const who = await requireHuman(request, env);
  if (who.error) return who.error;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Body must be JSON." }, 400); }

  const changes = body && typeof body.prefs === "object" && body.prefs ? body.prefs : null;
  if (!changes) {
    return jsonResponse({
      error: "invalid_request",
      message: 'Send { "prefs": { "<id>:<channel>": true|false } }.',
    }, 400);
  }

  const result = await writeNotificationPrefs(env, who.userId, changes);

  if (result.refused.length) {
    // A refusal is a 400, not a silent success. A switch that reports saved
    // and did not move is worse than one that says no — see the header of
    // src/notifications.js for why these two rows are locked at all.
    return jsonResponse({
      error: "channel_locked",
      message: "Payment failures and plan changes always send an email. Every other notification is yours to silence.",
      refused: result.refused,
    }, 400);
  }

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.NOTIFICATIONS_UPDATED,
    targetType: "user", targetId: who.userId,
    metadata: { written: result.written, cleared: result.cleared },
  });

  const { prefs } = await readNotificationPrefs(env, who.userId);
  return jsonResponse({ ok: true, groups: describePrefs(prefs) });
}
