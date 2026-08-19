// Organisation routes — the seat-based licence surface.
//
//   GET    /api/org                     members + seat usage
//   POST   /api/org/invite              owner/admin only, emails a single-use link
//   POST   /api/org/invite/accept       redeem an invite (caller must be signed in)
//   DELETE /api/org/members/:userId     owner/admin only
//
// Seats. `organisations.seats_purchased` is the line-item quantity from the
// Stripe subscription, so it is exactly what the customer pays for. The invite
// path refuses to exceed it with a 402 that names the numbers, because the
// resolution is a purchase — the same reason quota exhaustion is a 402 and not
// a 403.
//
// Outstanding invites count against seats. An admin with three seats who sends
// ten invites has promised seven of them something we will refuse, and the
// person to tell is the admin at invite time, not the invitee at the moment
// they click.
//
// Invite tokens live in SESSIONS KV (`orgInvite:<token>`), 7-day TTL, 32 bytes
// of crypto.getRandomValues entropy. Single-use: the KV row is deleted on
// redemption, so a forwarded link works exactly once.

import {
  getActiveOrg,
  getOrgById,
  getMembership,
  listMembers,
  countSeatsUsed,
  canManageMembers,
  addMember,
  removeMember,
  updateOrgBranding,
} from "./_orgs.js";
import { getUserById } from "./_users.js";
import { auditFromRequest, AUDIT_ACTIONS } from "../audit.js";
import { recordEmailSend } from "../oplog.js";
import { resolveEntitlementForOrg } from "../entitlement.js";
import {
  mayWhiteLabel,
  tierForOrg,
  safeLogoUrl,
  safeCompanyName,
  MAX_COMPANY_NAME_LEN,
  WHITE_LABEL_TIER,
} from "../reports/branding.js";
import { sendTransactional as defaultSendTransactional } from "../email/transactional.js";
import { orgInvite } from "../email/templates.js";

const EMAIL_RE       = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN  = 254;
const INVITE_TTL_SEC = 60 * 60 * 24 * 7;   // 7 days
const TOKEN_BYTES    = 32;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function newInviteToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

const inviteKey        = (token) => `orgInvite:${token}`;
const pendingIndexKey  = (orgId) => `orgInvitePending:${orgId}`;

/**
 * Outstanding invites for an org.
 *
 * KV has no list-by-prefix we can rely on cheaply inside a request, so the
 * pending set is kept as one JSON row per org holding {token, email, sentAt}.
 * Entries past the TTL are filtered on read rather than swept — an expired
 * invite must stop consuming a seat even though nothing has run since it
 * lapsed, and a lazy filter is the only version of that with no cron behind it.
 */
async function readPendingInvites(env, orgId, now = Math.floor(Date.now() / 1000)) {
  const raw = await env.SESSIONS.get(pendingIndexKey(orgId));
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((i) => i && typeof i.sentAt === "number" && now - i.sentAt < INVITE_TTL_SEC);
}

async function writePendingInvites(env, orgId, invites) {
  if (!invites.length) {
    await env.SESSIONS.delete(pendingIndexKey(orgId));
    return;
  }
  await env.SESSIONS.put(pendingIndexKey(orgId), JSON.stringify(invites), {
    // Outlives the newest invite in the list; entries are filtered on read.
    expirationTtl: INVITE_TTL_SEC + 86_400,
  });
}

/**
 * Resolve the caller's org and role, or the response to return instead.
 * Every handler in this file starts here.
 */
async function requireOrg(request, env, { manage = false } = {}) {
  const sessionUser = request.user || {};
  if (!sessionUser.userId) {
    // requireAuth should have short-circuited — defensive only.
    return { error: jsonResponse({ error: "unauthorized" }, 401) };
  }

  const active = await getActiveOrg(env, sessionUser.userId);
  if (!active) {
    return {
      error: jsonResponse(
        { error: "no_organisation", message: "This account is not a member of any organisation." },
        404,
      ),
    };
  }

  if (manage && !canManageMembers(active.role)) {
    return {
      error: jsonResponse(
        {
          error:   "forbidden",
          message: "Only an owner or admin can manage members.",
          role:    active.role,
        },
        403,
      ),
    };
  }

  return { org: active.org, role: active.role, userId: sessionUser.userId };
}

// ---------------------------------------------------------------------------
// GET /api/org
// ---------------------------------------------------------------------------
export async function getOrgHandler(request, env) {
  const ctxOrg = await requireOrg(request, env);
  if (ctxOrg.error) return ctxOrg.error;
  const { org, role } = ctxOrg;

  const [members, pending, entitlement] = await Promise.all([
    listMembers(env, org.orgId),
    readPendingInvites(env, org.orgId),
    resolveEntitlementForOrg(env, org.orgId, { request }),
  ]);

  return jsonResponse({
    org: {
      orgId:          org.orgId,
      name:           org.name,
      plan:           org.plan,
      subStatus:      org.subStatus,
      seatsPurchased: org.seatsPurchased,
      seatsUsed:      members.length + pending.length,
      tier:           tierForOrg(env, org),
    },
    // What the org has SET, plus whether it currently applies. The two are
    // separate on purpose: a lapsed subscription keeps the saved values but
    // stops using them, and the UI should be able to say so rather than
    // showing a logo that no longer appears on reports.
    branding: {
      companyName: org.brandCompanyName || null,
      logoUrl:     org.brandLogoUrl || null,
      available:   mayWhiteLabel(env, org, entitlement),
      appliesToNewReports: mayWhiteLabel(env, org, entitlement)
        && !!(org.brandCompanyName || org.brandLogoUrl),
    },
    role,
    members,
    pendingInvites: pending.map((i) => ({ email: i.email, sentAt: i.sentAt })),
  });
}

// ---------------------------------------------------------------------------
// PUT /api/org/branding   body {companyName?, logoUrl?}
//
// White-label report branding, top tier only. Owner/admin, like every other
// org-level setting — this changes what a document sent to the customer's
// own client says it came from.
// ---------------------------------------------------------------------------
export async function updateOrgBrandingHandler(request, env) {
  const ctxOrg = await requireOrg(request, env, { manage: true });
  if (ctxOrg.error) return ctxOrg.error;
  const { org } = ctxOrg;

  const entitlement = await resolveEntitlementForOrg(env, org.orgId, { request });
  if (!mayWhiteLabel(env, org, entitlement)) {
    // 402, not 403: the resolution is a purchase, same as seat and monitor
    // limits. A 403 would read as "you're not allowed", which is wrong — they
    // are, on a different plan.
    return jsonResponse(
      {
        error:   "white_label_not_available",
        message: `Custom report branding is included on the ${WHITE_LABEL_TIER.charAt(0).toUpperCase() + WHITE_LABEL_TIER.slice(1)} plan. ` +
                 `Upgrade to put your own name and logo on reports you send to clients.`,
        tier:        tierForOrg(env, org),
        requiredTier: WHITE_LABEL_TIER,
        upgradeUrl:  `${env.SITE_ORIGIN || ""}/#pricing`,
      },
      402,
    );
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  // `undefined` leaves a field alone; explicit null clears it. Clearing the
  // logo must not also wipe the company name.
  const patch = {};

  if (body && body.companyName !== undefined) {
    if (body.companyName === null || body.companyName === "") {
      patch.companyName = null;
    } else {
      const name = safeCompanyName(body.companyName);
      if (!name) {
        return jsonResponse(
          { error: "invalid_company_name", message: `Company name must be 1–${MAX_COMPANY_NAME_LEN} characters.` },
          400,
        );
      }
      patch.companyName = name;
    }
  }

  if (body && body.logoUrl !== undefined) {
    if (body.logoUrl === null || body.logoUrl === "") {
      patch.logoUrl = null;
    } else {
      const url = safeLogoUrl(body.logoUrl);
      if (!url) {
        // Named explicitly rather than "invalid URL": the https requirement is
        // the surprising part, and it is not negotiable — the URL ends up in an
        // <img src> in a document that gets forwarded.
        return jsonResponse(
          {
            error: "invalid_logo_url",
            message: "The logo must be an absolute https:// URL to an image. " +
                     "http, data: and javascript: URLs are refused.",
          },
          400,
        );
      }
      patch.logoUrl = url;
    }
  }

  if (patch.companyName === undefined && patch.logoUrl === undefined) {
    return jsonResponse(
      { error: "nothing_to_update", message: "Provide companyName and/or logoUrl. Send null to clear one." },
      400,
    );
  }

  const updated = await updateOrgBranding(env, org.orgId, patch);

  // Branding is logged because it changes what CLIENTS of this org see on a
  // document they were sent. That makes it the kind of change someone will
  // eventually need to attribute, even though nothing was destroyed.
  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.BRANDING_UPDATED,
    targetType: "org",
    targetId:   org.orgId,
    orgId:      org.orgId,
    metadata:   {
      companyName: (updated && updated.brandCompanyName) || null,
      logoUrl:     (updated && updated.brandLogoUrl) || null,
    },
  });

  return jsonResponse({
    ok: true,
    branding: {
      companyName: (updated && updated.brandCompanyName) || null,
      logoUrl:     (updated && updated.brandLogoUrl) || null,
    },
    // Reports already rendered into R2 keep the branding they were generated
    // with. Said out loud because it is the surprising part.
    note: "New reports use this branding. Reports already generated are unchanged.",
  });
}

// ---------------------------------------------------------------------------
// POST /api/org/invite   body {email, role?}
// ---------------------------------------------------------------------------
export async function inviteMemberHandler(request, env, ctx, { sendTransactional: sendTxOverride } = {}) {
  const ctxOrg = await requireOrg(request, env, { manage: true });
  if (ctxOrg.error) return ctxOrg.error;
  const { org, role: callerRole, userId: inviterId } = ctxOrg;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  const rawEmail = body && typeof body.email === "string" ? body.email.trim() : "";
  if (!rawEmail || rawEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(rawEmail)) {
    return jsonResponse({ error: "invalid_email", message: "Please provide a valid email address." }, 400);
  }
  const email = rawEmail.toLowerCase();

  // Only an owner may mint another admin. An admin promoting someone to admin
  // is a quiet privilege escalation: it hands the invitee the power to remove
  // the people who are already there.
  let inviteRole = body && typeof body.role === "string" ? body.role : "member";
  if (inviteRole !== "member" && inviteRole !== "admin") {
    return jsonResponse({ error: "invalid_role", message: 'Role must be "member" or "admin".' }, 400);
  }
  if (inviteRole === "admin" && callerRole !== "owner") {
    return jsonResponse(
      { error: "forbidden", message: "Only the owner can invite an admin." },
      403,
    );
  }

  const now     = Math.floor(Date.now() / 1000);
  const pending = await readPendingInvites(env, org.orgId, now);

  // Re-inviting an address that already has an invite outstanding reuses its
  // seat rather than claiming a second one.
  const already = pending.find((i) => i.email === email);
  const seatsUsed = await countSeatsUsed(env, org.orgId, already ? pending.length - 1 : pending.length);

  if (seatsUsed >= org.seatsPurchased) {
    return jsonResponse(
      {
        error:   "seat_limit_reached",
        message: `All ${org.seatsPurchased} seat${org.seatsPurchased === 1 ? "" : "s"} on this plan are in use ` +
                 `(${seatsUsed} of ${org.seatsPurchased}, including invites that haven't been accepted). ` +
                 `Add seats from the billing portal to invite more people.`,
        seatsUsed,
        seatsPurchased: org.seatsPurchased,
      },
      402,
    );
  }

  const token = newInviteToken();
  await env.SESSIONS.put(
    inviteKey(token),
    JSON.stringify({ orgId: org.orgId, email, role: inviteRole, invitedBy: inviterId, sentAt: now }),
    { expirationTtl: INVITE_TTL_SEC },
  );

  await writePendingInvites(env, org.orgId, [
    ...pending.filter((i) => i.email !== email),
    { token, email, sentAt: now },
  ]);

  const origin    = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  const acceptUrl = `${origin}/dashboard/?invite=${encodeURIComponent(token)}`;
  const inviter   = await getUserById(env, inviterId);

  const send = sendTxOverride || defaultSendTransactional;
  const sendResult = await send(env, ctx, {
    to: email,
    ...orgInvite({
      email,
      orgName:     org.name,
      inviterName: (inviter && inviter.email) || "an administrator",
      acceptUrl,
      expiresInDays: INVITE_TTL_SEC / 86_400,
    }),
  });

  // The invite exists whether or not the mail went out — the seat is already
  // consumed. Logging the send result is what makes "I never got the email"
  // answerable instead of a guess.
  await recordEmailSend(env, ctx, {
    recipient: email,
    template:  "org_invite",
    orgId:     org.orgId,
    result:    sendResult,
  });

  await auditFromRequest(request, env, ctx, {
    action:     AUDIT_ACTIONS.MEMBER_INVITED,
    targetType: "invite",
    targetId:   email,
    orgId:      org.orgId,
    metadata:   { email, role: inviteRole, emailSent: Boolean(sendResult && sendResult.sent) },
  });

  return jsonResponse({
    ok: true,
    email,
    role: inviteRole,
    seatsUsed: seatsUsed + 1,
    seatsPurchased: org.seatsPurchased,
    expiresInDays: INVITE_TTL_SEC / 86_400,
  }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/org/invite/accept   body {token}
// ---------------------------------------------------------------------------
export async function acceptInviteHandler(request, env) {
  const sessionUser = request.user || {};
  if (!sessionUser.userId) return jsonResponse({ error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  const token = body && typeof body.token === "string" ? body.token : "";
  if (!token) return jsonResponse({ error: "invalid_token", message: "No invite token supplied." }, 400);

  const raw = await env.SESSIONS.get(inviteKey(token));
  if (!raw) {
    // Covers expired, already-redeemed and never-existed alike — all the same
    // answer, so a forwarded link can't be used to probe which tokens are real.
    return jsonResponse(
      { error: "invite_invalid", message: "This invite link has expired or has already been used." },
      404,
    );
  }

  let invite;
  try { invite = JSON.parse(raw); } catch {
    return jsonResponse({ error: "invite_invalid", message: "This invite link is not valid." }, 404);
  }

  // The invite is addressed to an email, so it must be redeemed by that
  // account. Otherwise anyone who intercepts the link joins the org.
  const user = await getUserById(env, sessionUser.userId);
  if (!user || user.email !== invite.email) {
    return jsonResponse(
      {
        error:   "invite_email_mismatch",
        message: `This invite was sent to ${invite.email}. Sign in as that address to accept it.`,
      },
      403,
    );
  }

  // Re-check the seat cap at redemption. Seats can have been filled, or the
  // subscription downgraded, in the days since the invite was sent.
  const now     = Math.floor(Date.now() / 1000);
  const pending = await readPendingInvites(env, invite.orgId, now);
  const org     = await getOrgById(env, invite.orgId);
  if (!org) {
    return jsonResponse({ error: "invite_invalid", message: "That organisation no longer exists." }, 404);
  }

  const alreadyMember = await getMembership(env, invite.orgId, sessionUser.userId);
  if (!alreadyMember) {
    // This invite's own pending entry is about to become a membership, so it
    // must not be counted twice.
    const others = pending.filter((i) => i.token !== token).length;
    const seatsUsed = await countSeatsUsed(env, invite.orgId, others);
    if (seatsUsed >= org.seatsPurchased) {
      return jsonResponse(
        {
          error:   "seat_limit_reached",
          message: `This organisation has no seats free (${seatsUsed} of ${org.seatsPurchased} in use). ` +
                   `Ask an administrator to add a seat, then use the link again.`,
          seatsUsed,
          seatsPurchased: org.seatsPurchased,
        },
        402,
      );
    }
  }

  await addMember(env, invite.orgId, sessionUser.userId, invite.role || "member");

  // Single-use: burn the token and drop it from the pending set. Done AFTER
  // the membership write so a failure there leaves the invite usable.
  await env.SESSIONS.delete(inviteKey(token));
  await writePendingInvites(env, invite.orgId, pending.filter((i) => i.token !== token));

  // Joining an org makes it the one you act as — otherwise the member accepts
  // a paid seat and keeps resolving to their free personal org.
  await env.DB.prepare("UPDATE users SET active_org_id = ?, updated_at = ? WHERE user_id = ?")
    .bind(invite.orgId, now, sessionUser.userId).run();

  // Actor is the invitee, not the inviter: this row records who walked
  // through the door, and the invite row above records who opened it.
  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.MEMBER_JOINED,
    targetType: "member",
    targetId:   sessionUser.userId,
    orgId:      invite.orgId,
    metadata:   { role: invite.role || "member", invitedBy: invite.invitedBy || null },
  });

  return jsonResponse({
    ok: true,
    orgId: invite.orgId,
    orgName: org.name,
    role: invite.role || "member",
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/org/members/:userId
// ---------------------------------------------------------------------------
export async function removeMemberHandler(request, env) {
  const ctxOrg = await requireOrg(request, env, { manage: true });
  if (ctxOrg.error) return ctxOrg.error;
  const { org, role: callerRole, userId: callerId } = ctxOrg;

  const targetId = request.params && request.params.userId;
  if (!targetId) {
    return jsonResponse({ error: "invalid_request", message: "No member id supplied." }, 400);
  }

  const target = await getMembership(env, org.orgId, targetId);
  if (!target) {
    return jsonResponse({ error: "not_a_member", message: "That user is not a member of this organisation." }, 404);
  }

  // An admin removing another admin is the same escalation problem as an admin
  // minting one. Owners are refused outright by removeMember.
  if (target.role === "admin" && callerRole !== "owner" && targetId !== callerId) {
    return jsonResponse(
      { error: "forbidden", message: "Only the owner can remove an admin." },
      403,
    );
  }

  const result = await removeMember(env, org.orgId, targetId);
  if (!result.removed) {
    const status = result.reason === "cannot_remove_owner" ? 409 : 404;
    const message = result.reason === "cannot_remove_owner"
      ? "The owner cannot be removed. Transfer ownership first, or cancel the subscription."
      : "That user is not a member of this organisation.";
    return jsonResponse({ error: result.reason, message }, status);
  }

  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.MEMBER_REMOVED,
    targetType: "member",
    targetId:   targetId,
    orgId:      org.orgId,
    // The removed member's role is recorded here because the membership row
    // is gone — after this write there is nowhere else to recover it from.
    metadata:   { role: target.role, selfRemoval: targetId === callerId },
  });

  const [members, pending] = await Promise.all([
    listMembers(env, org.orgId),
    readPendingInvites(env, org.orgId),
  ]);

  return jsonResponse({
    ok: true,
    removed: targetId,
    seatsUsed: members.length + pending.length,
    seatsPurchased: org.seatsPurchased,
  });
}

// ---------------------------------------------------------------------------
// POST /api/org/invite/revoke   body {email}
// ---------------------------------------------------------------------------
//
// Withdraw an invite that has not been accepted yet.
//
// An outstanding invite consumes a seat (see countSeatsUsed), so without this
// the only way to reclaim a seat from a typo'd address or a candidate who
// declined is to wait out the 7-day TTL. On a Solo or Practice plan that is a
// real block, not an inconvenience: a 3-seat org with one mistyped invite has
// lost a third of its capacity for a week.
//
// Revoking deletes BOTH the token row and the pending-index entry. Deleting
// only the index would leave a live token that still accepts, and deleting
// only the token would leave a phantom seat consumed by an invite that can no
// longer be used — the two have to move together.
//
// Keyed by email rather than token because the dashboard lists invites by
// email and never sees the token; the token is in the recipient's inbox.
export async function revokeInviteHandler(request, env) {
  const resolved = await requireOrg(request, env, { manage: true });
  if (resolved.error) return resolved.error;
  const { org } = resolved;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Body must be valid JSON." }, 400); }

  const rawEmail = body && typeof body.email === "string" ? body.email.trim() : "";
  if (!rawEmail || rawEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(rawEmail)) {
    return jsonResponse(
      { error: "invalid_email", message: "Provide the email address of the invite to revoke." },
      400,
    );
  }
  const email = rawEmail.toLowerCase();

  const now     = Math.floor(Date.now() / 1000);
  const pending = await readPendingInvites(env, org.orgId, now);
  const match   = pending.find((i) => i.email === email);

  if (!match) {
    // Already accepted, already revoked, or lapsed. 404 rather than a silent
    // 200: the caller is looking at a list that disagrees with the server, and
    // saying so is what makes them refresh it.
    return jsonResponse(
      { error: "invite_not_found", message: "No pending invite for that address." },
      404,
    );
  }

  await env.SESSIONS.delete(inviteKey(match.token));
  await writePendingInvites(env, org.orgId, pending.filter((i) => i.email !== email));

  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.INVITE_REVOKED,
    targetType: "invite",
    targetId:   email,
    orgId:      org.orgId,
    metadata:   { email, sentAt: match.sentAt || null },
  });

  const seatsUsed = await countSeatsUsed(env, org.orgId, pending.length - 1);
  return jsonResponse({ ok: true, email, seatsUsed, seatsPurchased: org.seatsPurchased }, 200);
}
