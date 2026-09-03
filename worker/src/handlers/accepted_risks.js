// POST /api/accepted-risks         — sign for a finding that will not be fixed
// GET  /api/accepted-risks         — the register
// POST /api/accepted-risks/:id/revoke
//
// Modelled on the attestation routes in handlers/compliance.js, because the
// two are the same shape of object: a named human claim with an expiry. The
// differences are deliberate and are documented at each refusal below.

import { AUDIT_ACTIONS, auditFromRequest } from "../audit.js";
import { requireOrgContext } from "./monitors.js";
import { parseExpiry } from "./compliance.js";
import { rulesForTypes } from "../analyzers/sast/registry.js";
import { repoKeyFor } from "../repo-key.js";
import { analyzerVersion } from "../analyzer-version.js";
import {
  acceptancesFor, listAcceptances, insertAcceptance, revokeAcceptance,
} from "../risk/store.js";
import { isAcceptableCategory, MAX_ACCEPTANCE_SECONDS, isoDay } from "../risk/accept.js";

const MAX_RATIONALE = 2000;
const nowSec = () => Math.floor(Date.now() / 1000);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

/** Rules indexed by their registry id, not by raw detector `type`. */
function ruleById() {
  const byId = new Map();
  for (const rule of rulesForTypes().values()) byId.set(rule.id, rule);
  return byId;
}

export async function listAcceptedRisksHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const url = new URL(request.url);
  const repoKey = repoKeyFor(url.searchParams.get("repoUrl") || "");
  const rows = repoKey
    ? await acceptancesFor(env, ctxOrg.orgId, repoKey)
    : await listAcceptances(env, ctxOrg.orgId);

  const now = nowSec();
  return json({
    acceptedRisks: rows.map((r) => ({
      ...r,
      expiresOn: isoDay(r.expiresAt),
      // Computed here, never stored. The same value the scanner's read path
      // derives, so the register and the findings cannot disagree about
      // whether something has lapsed.
      expired: r.expiresAt <= now,
    })),
    now,
  });
}

export async function createAcceptedRiskHandler(request, env, ctx) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  let body = null;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== "object") {
    return json({ error: "invalid_request", message: "Expected a JSON body." }, 400);
  }

  // 1. A repository. Without one there is nothing to scope the acceptance to,
  //    and a scan of pasted content can never match it anyway.
  const repoKey = repoKeyFor(body.repoUrl);
  if (!repoKey) {
    return json({
      error: "invalid_request",
      message: "An accepted risk is scoped to one repository. Supply `repoUrl` as a GitHub repository.",
    }, 400);
  }

  // 2. A rule that exists. You cannot accept a scanner bug.
  const rule = ruleById().get(String(body.ruleId || ""));
  if (!rule || rule.id === "sast.unregistered") {
    return json({
      error: "invalid_request",
      message: "`ruleId` must be a rule this scanner defines. An unregistered finding is a bug to report, not a risk to accept.",
    }, 400);
  }

  // 3. The ban list. Refused here AND re-checked when findings are read, so a
  //    row written by any other path still cannot take effect.
  if (!isAcceptableCategory(rule.category)) {
    return json({
      error: "invalid_request",
      message: rule.category === "secrets"
        ? "A committed credential is not a risk you accept — it is a credential you rotate. Accepting it would record that you did not."
        : "A dependency advisory is a fact about a version, and it is answered by upgrading. Accepting one would make the SBOM and the component-health control claim something untrue about a third party.",
    }, 400);
  }

  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!path) {
    return json({ error: "invalid_request", message: "An accepted risk names the file it applies to." }, 400);
  }

  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  if (!/^[0-9a-f]{16}$/.test(fingerprint)) {
    return json({
      error: "invalid_request",
      message: "`fingerprint` must be the 16-character identifier the scanner reported for this finding.",
    }, 400);
  }

  const severity = String(body.severity || "");
  if (!["critical", "high", "medium", "low", "info"].includes(severity)) {
    return json({ error: "invalid_request", message: "`severity` must be the severity the finding was reported at." }, 400);
  }

  const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
  if (!rationale) {
    return json({
      error: "invalid_request",
      message: "An accepted risk needs a written reason. A signature with no reason is an unexplained silence.",
    }, 400);
  }
  if (rationale.length > MAX_RATIONALE) {
    return json({ error: "invalid_request", message: `Keep the reason under ${MAX_RATIONALE} characters.` }, 400);
  }

  const ownerEmail = typeof body.ownerEmail === "string" ? body.ownerEmail.trim() : "";
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    return json({
      error: "invalid_request",
      message: "An accepted risk needs an accountable owner's email address. Anonymous acceptance is the thing this prevents.",
    }, 400);
  }

  const documentUrl = typeof body.documentUrl === "string" && body.documentUrl.trim()
    ? body.documentUrl.trim() : null;
  if (documentUrl && !/^https:\/\//i.test(documentUrl)) {
    return json({ error: "invalid_request", message: "A document link must be https." }, 400);
  }

  const expiresAt = parseExpiry(body.expiresAt);
  if (!expiresAt) {
    return json({
      error: "invalid_request",
      message: "An accepted risk needs an end date (YYYY-MM-DD) in the future. There are no perpetual acceptances.",
    }, 400);
  }
  const at = nowSec();
  if (expiresAt - at > MAX_ACCEPTANCE_SECONDS) {
    return json({
      error: "invalid_request",
      message: "An acceptance may run for at most a year. A longer one is a perpetual acceptance wearing a date, and nobody re-reads it.",
    }, 400);
  }

  const row = {
    id: `ar_${at}_${Math.random().toString(16).slice(2, 10)}`,
    orgId: ctxOrg.orgId,
    repoKey, ruleId: rule.id, path, fingerprint,
    category: rule.category, severity,
    rationale, ownerEmail, documentUrl,
    acceptedBy: (request.user && request.user.email) || null,
    acceptedAt: at,
    expiresAt,
    analyzerVersion: analyzerVersion(env),
    runId: typeof body.runId === "string" ? body.runId : null,
  };

  try {
    await insertAcceptance(env, row);
  } catch {
    return json({
      error: "storage_unavailable",
      message: "Accepted risks cannot be stored — migration 0029 has not been applied.",
    }, 503);
  }

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.RISK_ACCEPTED,
    targetType: "finding",
    targetId: `${repoKey}:${rule.id}:${fingerprint}`,
    orgId: ctxOrg.orgId,
    metadata: { ruleId: rule.id, path, severity, ownerEmail, expiresAt },
  });

  return json({ acceptedRisk: { ...row, expiresOn: isoDay(expiresAt) } }, 201);
}

export async function revokeAcceptedRiskHandler(request, env, ctx) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const id = request.params && request.params.id;
  if (!id) return json({ error: "invalid_request", message: "No acceptance id supplied." }, 400);

  let revoked = false;
  try {
    revoked = await revokeAcceptance(
      env, ctxOrg.orgId, id, (request.user && request.user.email) || null, nowSec());
  } catch {
    return json({
      error: "storage_unavailable",
      message: "Accepted risks cannot be stored — migration 0029 has not been applied.",
    }, 503);
  }
  if (!revoked) {
    return json({ error: "not_found", message: "No live acceptance with that id on this organisation." }, 404);
  }

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.RISK_ACCEPTANCE_REVOKED,
    targetType: "finding",
    targetId: id,
    orgId: ctxOrg.orgId,
  });

  // Revocation takes effect on the next READ of every run, past and present,
  // because no acceptance was ever written into a stored result.
  return json({ revoked: true, id });
}
