// Custom report domains.
//
//   PUT    /api/org/domain          set or replace the hostname
//   POST   /api/org/domain/verify   check DNS now
//   DELETE /api/org/domain          remove it
//
// Firm-tier, owner/admin, same gate as the rest of white-labelling.
//
// ---------------------------------------------------------------------------
// What "verified" means here, precisely
// ---------------------------------------------------------------------------
// It means the customer's CNAME resolves to our target. It does NOT mean the
// hostname serves anything yet — terminating TLS for a domain somebody else
// owns requires Cloudflare for SaaS custom hostnames, which needs zone-level
// credentials this Worker does not carry.
//
// So every response includes `servingReady`, and it is false until an
// operator has provisioned the hostname. Reporting a bare "verified" would be
// the expensive kind of wrong: a consultancy puts the domain in front of a
// client, the client gets a TLS error, and the consultancy's report — the
// thing they are paying us for — is what looks broken.
//
// Existing algosize.com/r/… links keep working throughout, in every state.
// A domain that is pending, failed, or removed never takes a report offline.

import { getActiveOrg, canManageMembers, getOrgById } from "./_orgs.js";
import { resolveEntitlementForOrg } from "../entitlement.js";
import { mayWhiteLabel, tierForOrg, WHITE_LABEL_TIER } from "../reports/branding.js";
import { auditFromRequest, AUDIT_ACTIONS } from "../audit.js";
import { safeDomain, dnsRecordFor, verifyDomain, cnameTarget, MAX_VERIFY_ATTEMPTS } from "../domains.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Owner/admin of an entitled Firm org, or the response to send instead. */
async function requireBrandingManager(request, env) {
  if (request.authMethod === "api_key") {
    return { error: jsonResponse({
      error: "forbidden",
      message: "API keys cannot change branding. Sign in to do this.",
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
  if (!canManageMembers(active.role)) {
    return { error: jsonResponse({
      error: "forbidden",
      message: "Only an owner or admin can change branding.",
      role: active.role,
    }, 403) };
  }

  const entitlement = await resolveEntitlementForOrg(env, active.org.orgId, { request });
  if (!mayWhiteLabel(env, active.org, entitlement)) {
    // 402 rather than 403, matching PUT /api/org/branding: they are allowed,
    // on a different plan. The resolution is a purchase.
    return { error: jsonResponse({
      error: "white_label_not_available",
      message: `A custom report domain is included on the ${WHITE_LABEL_TIER.charAt(0).toUpperCase() + WHITE_LABEL_TIER.slice(1)} plan.`,
      tier: tierForOrg(env, active.org),
      requiredTier: WHITE_LABEL_TIER,
      upgradeUrl: `${env.SITE_ORIGIN || ""}/#pricing`,
    }, 402) };
  }

  return { org: active.org, role: active.role, userId: sessionUser.userId };
}

/** The shape every endpoint in this file returns for the domain block. */
function describeDomain(env, org) {
  const hostname = org.brandDomain || null;
  const status   = org.brandDomainStatus || null;
  return {
    hostname,
    status,
    detail:    org.brandDomainDetail || null,
    checkedAt: org.brandDomainCheckedAt || null,
    attempts:  org.brandDomainAttempts || 0,
    maxAttempts: MAX_VERIFY_ATTEMPTS,
    record: hostname ? dnsRecordFor(env, hostname) : { type: "CNAME", name: "", value: cnameTarget(env) },
    // DNS is correct AND the hostname has been provisioned to serve. The
    // second half is an operator step; see the header.
    servingReady: status === "verified" && !!env.CUSTOM_HOSTNAMES_ENABLED,
    servingNote: status === "verified" && !env.CUSTOM_HOSTNAMES_ENABLED
      ? "DNS is correct. Serving from this hostname is being provisioned — until it is live, shared links keep using algosize.com and nothing is interrupted."
      : null,
  };
}

async function writeDomain(env, orgId, fields) {
  const sets = [];
  const vals = [];
  for (const [col, val] of Object.entries(fields)) { sets.push(`${col} = ?`); vals.push(val); }
  sets.push("updated_at = ?"); vals.push(Math.floor(Date.now() / 1000));
  await env.DB.prepare(`UPDATE organisations SET ${sets.join(", ")} WHERE org_id = ?`)
    .bind(...vals, orgId).run();
  return getOrgById(env, orgId);
}

// ---------------------------------------------------------------------------
// PUT /api/org/domain   body {domain}
// ---------------------------------------------------------------------------
//
// Setting a domain resets the verification state, including the attempt
// counter. Someone who fixes a typo after twelve failed checks is starting a
// new attempt at a different name, and carrying the old budget over would
// mark their corrected domain as failed before it was ever checked.
//
// One verification runs immediately, so a customer who already had the CNAME
// in place sees "verified" without clicking anything.
export async function setOrgDomainHandler(request, env, ctx) {
  const gate = await requireBrandingManager(request, env);
  if (gate.error) return gate.error;
  const { org } = gate;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Body must be JSON." }, 400); }

  const raw = body && body.domain;
  const domain = safeDomain(raw);
  if (!domain) {
    const looksLikeOurs = typeof raw === "string" && /(^|\.)algosize\.com$/i.test(raw.trim().toLowerCase());
    return jsonResponse({
      error: "invalid_domain",
      message: looksLikeOurs
        ? "That is an Algosize domain. Enter a hostname you own, like reports.yourfirm.com."
        : "Enter a hostname you own, like reports.yourfirm.com. No protocol, no path, no port.",
    }, 400);
  }

  // One org per hostname. Two orgs claiming the same name would both be told
  // it verified, and whichever was provisioned last would silently serve the
  // other's reports.
  const clash = await env.DB
    .prepare("SELECT org_id FROM organisations WHERE brand_domain = ? AND org_id != ?")
    .bind(domain, org.orgId).first().catch(() => null);
  if (clash) {
    return jsonResponse({
      error: "domain_in_use",
      message: "That hostname is already registered to another Algosize account. Contact support if it belongs to you.",
    }, 409);
  }

  const check = await verifyDomain(env, domain, { attempts: 0 });
  const updated = await writeDomain(env, org.orgId, {
    brand_domain: domain,
    brand_domain_status: check.status,
    brand_domain_detail: check.detail,
    brand_domain_checked_at: check.checkedAt,
    brand_domain_attempts: check.attempts,
  });

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.DOMAIN_UPDATED,
    targetType: "org", targetId: org.orgId, orgId: org.orgId,
    metadata: { from: org.brandDomain || null, to: domain, status: check.status },
  });

  return jsonResponse({ ok: true, domain: describeDomain(env, updated) });
}

// ---------------------------------------------------------------------------
// POST /api/org/domain/verify — "Check now"
// ---------------------------------------------------------------------------
//
// Runs against whatever is currently stored. Works from the 'failed' state
// too: a customer who fixed their DNS after we gave up must be able to
// recover without deleting and re-entering the same hostname. Retrying from
// failed resets the attempt budget, because the situation being retested is a
// different one from the twelve that failed.
export async function verifyOrgDomainHandler(request, env, ctx) {
  const gate = await requireBrandingManager(request, env);
  if (gate.error) return gate.error;
  const { org } = gate;

  if (!org.brandDomain) {
    return jsonResponse({
      error: "no_domain",
      message: "No custom domain is set for this organisation.",
    }, 400);
  }

  const retryingAfterFailure = org.brandDomainStatus === "failed";
  const check = await verifyDomain(env, org.brandDomain, {
    attempts: retryingAfterFailure ? 0 : (org.brandDomainAttempts || 0),
  });

  const updated = await writeDomain(env, org.orgId, {
    brand_domain_status: check.status,
    brand_domain_detail: check.detail,
    brand_domain_checked_at: check.checkedAt,
    brand_domain_attempts: check.attempts,
  });

  return jsonResponse({
    ok: true,
    domain: describeDomain(env, updated),
    // Distinguishes "checked, still not there" from "checked, and it is now
    // live" so the UI can decide whether to celebrate or just re-render.
    changed: check.status !== org.brandDomainStatus,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/org/domain
// ---------------------------------------------------------------------------
export async function removeOrgDomainHandler(request, env, ctx) {
  const gate = await requireBrandingManager(request, env);
  if (gate.error) return gate.error;
  const { org } = gate;

  const updated = await writeDomain(env, org.orgId, {
    brand_domain: null,
    brand_domain_status: null,
    brand_domain_detail: null,
    brand_domain_checked_at: null,
    brand_domain_attempts: 0,
  });

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.DOMAIN_UPDATED,
    targetType: "org", targetId: org.orgId, orgId: org.orgId,
    metadata: { from: org.brandDomain || null, to: null },
  });

  return jsonResponse({
    ok: true,
    domain: describeDomain(env, updated),
    note: "Removed. Shared reports serve from algosize.com — links already sent keep working.",
  });
}
