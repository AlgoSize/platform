// D1 access for compliance. Every read filters org_id first.
//
// Nothing in here decides a compliance answer — that is resolve.js's job alone.
// This module only stores and returns rows, in the camelCase shape the rest of
// the feature reads. All timestamps are UNIX SECONDS.

const nowSec = () => Math.floor(Date.now() / 1000);

function newId(prefix) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

// ---------------------------------------------------------------------------
// Attestations
// ---------------------------------------------------------------------------

function rowToAttestation(r) {
  if (!r) return null;
  return {
    id: r.id,
    orgId: r.org_id,
    frameworkId: r.framework_id,
    controlId: r.control_id,
    kind: r.kind || "attested",
    statement: r.statement || "",
    ownerEmail: r.owner_email || null,
    documentUrl: r.document_url || null,
    attestedBy: r.attested_by || null,
    attestedAt: r.attested_at || null,
    expiresAt: typeof r.expires_at === "number" ? r.expires_at : null,
    revokedAt: typeof r.revoked_at === "number" ? r.revoked_at : null,
    revokedBy: r.revoked_by || null,
    catalogVersion: r.catalog_version || null,
  };
}

/**
 * Live attestations for a framework, newest first, keyed by control id.
 *
 * Revoked rows are fetched too. resolve.js decides what a revoked attestation
 * means (nothing — it is dropped entirely), and it is the only place allowed to
 * make that call, so filtering it out here would move a compliance decision
 * into a SQL WHERE clause where no test is looking for it.
 */
export async function attestationsByControl(env, orgId, frameworkId) {
  const out = new Map();
  if (!env || !env.DB || !orgId) return out;
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM compliance_attestations
        WHERE org_id = ? AND framework_id = ?
        ORDER BY attested_at DESC`,
    ).bind(orgId, frameworkId).all();
    rows = (res && res.results) || [];
  } catch {
    // An unapplied migration must not take the coverage map down. Every
    // attested control then reads "nobody has attested it", which is what an
    // empty table honestly means.
    return out;
  }
  for (const r of rows) {
    const a = rowToAttestation(r);
    const prev = out.get(a.controlId);
    // Newest live row wins; a revoked row is only kept if nothing live exists,
    // so the page can say "this was revoked" rather than "nothing here".
    if (!prev) out.set(a.controlId, a);
    else if (prev.revokedAt && !a.revokedAt) out.set(a.controlId, a);
  }
  return out;
}

export async function listAttestations(env, orgId, frameworkId = null) {
  if (!env || !env.DB || !orgId) return [];
  const sql = frameworkId
    ? `SELECT * FROM compliance_attestations WHERE org_id = ? AND framework_id = ? ORDER BY attested_at DESC`
    : `SELECT * FROM compliance_attestations WHERE org_id = ? ORDER BY attested_at DESC`;
  const args = frameworkId ? [orgId, frameworkId] : [orgId];
  try {
    const res = await env.DB.prepare(sql).bind(...args).all();
    return ((res && res.results) || []).map(rowToAttestation);
  } catch {
    return [];
  }
}

export async function getAttestation(env, orgId, id) {
  if (!env || !env.DB || !orgId) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM compliance_attestations WHERE org_id = ? AND id = ?`,
    ).bind(orgId, id).first();
    return rowToAttestation(row);
  } catch {
    return null;
  }
}

/**
 * Sign an attestation.
 *
 * `expiresAt` is required by the caller and by the schema. There is no code
 * path that writes a perpetual claim.
 */
export async function createAttestation(env, {
  orgId, frameworkId, controlId, kind = "attested", statement,
  ownerEmail = null, documentUrl = null, attestedBy = null,
  expiresAt, catalogVersion = null,
}) {
  const id = newId("catt");
  const at = nowSec();
  await env.DB.prepare(
    `INSERT INTO compliance_attestations
       (id, org_id, framework_id, control_id, kind, statement, owner_email,
        document_url, attested_by, attested_at, expires_at, catalog_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, orgId, frameworkId, controlId, kind, statement, ownerEmail,
         documentUrl, attestedBy, at, expiresAt, catalogVersion).run();
  return { id, orgId, frameworkId, controlId, kind, statement, ownerEmail,
           documentUrl, attestedBy, attestedAt: at, expiresAt,
           revokedAt: null, revokedBy: null, catalogVersion };
}

export async function revokeAttestation(env, orgId, id, revokedBy = null) {
  const at = nowSec();
  const res = await env.DB.prepare(
    `UPDATE compliance_attestations
        SET revoked_at = ?, revoked_by = ?
      WHERE org_id = ? AND id = ? AND revoked_at IS NULL`,
  ).bind(at, revokedBy, orgId, id).run();
  const changed = res && res.meta && typeof res.meta.changes === "number"
    ? res.meta.changes : 1;
  return changed > 0;
}

/** Live attestations already past their end date. Drives notification only —
 *  expiry is enforced read-side in resolve.js, which cannot be bypassed. */
export async function expiredAttestations(env, at = nowSec(), limit = 200) {
  if (!env || !env.DB) return [];
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM compliance_attestations
        WHERE revoked_at IS NULL AND expires_at <= ?
        ORDER BY expires_at ASC LIMIT ?`,
    ).bind(at, limit).all();
    return ((res && res.results) || []).map(rowToAttestation);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Audits
// ---------------------------------------------------------------------------

function rowToAudit(r) {
  if (!r) return null;
  let summary = null;
  try { summary = r.summary_json ? JSON.parse(r.summary_json) : null; } catch { summary = null; }
  // Frozen at publish because the download rebuilds the pack from this row and
  // the coverage.scans block is live data that no longer exists by then. Kept
  // in whatever shape it was stored in — it is a counts OBJECT, not a list, and
  // an earlier draft of this line coerced it to [] on the assumption that it
  // was an array, which changed the rebuilt document and broke the very hash
  // it exists to keep verifiable. null on absence: a row from before migration
  // 0030 has no scans block, and saying so beats inventing an empty one.
  let scans = null;
  try { scans = r.scans_json ? JSON.parse(r.scans_json) : null; } catch { scans = null; }
  return {
    id: r.id,
    orgId: r.org_id,
    monitorId: r.monitor_id || null,
    repoUrl: r.repo_url || null,
    frameworkId: r.framework_id,
    frameworkVersion: r.framework_version || null,
    catalogVersion: r.catalog_version,
    title: r.title || null,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    summary,
    branch: r.branch || null,
    scans,
    packSha256: r.pack_sha256 || null,
    // NULL on every row written before migration 0030. It is not "unknown" —
    // it is a definite statement that the stored hash covers a document the
    // download does not serve, which is why the read maps it rather than
    // defaulting it to the current scope.
    packHashScope: r.pack_hash_scope || null,
    packBytes: typeof r.pack_bytes === "number" ? r.pack_bytes : null,
    retainUntil: r.retain_until,
    supersededBy: r.superseded_by || null,
    createdBy: r.created_by || null,
    createdAt: r.created_at,
    publishedAt: r.published_at || null,
  };
}

/** A published audit is kept for a year past the period it describes, which is
 *  longer than any evidence behind it survives. That is the whole point. */
export const RETENTION_SECONDS = 60 * 60 * 24 * 365;

export async function listAudits(env, orgId, { frameworkId = null, limit = 20 } = {}) {
  if (!env || !env.DB || !orgId) return [];
  const sql = frameworkId
    ? `SELECT * FROM compliance_audits WHERE org_id = ? AND framework_id = ?
        ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM compliance_audits WHERE org_id = ?
        ORDER BY created_at DESC LIMIT ?`;
  const args = frameworkId ? [orgId, frameworkId, limit] : [orgId, limit];
  try {
    const res = await env.DB.prepare(sql).bind(...args).all();
    return ((res && res.results) || []).map(rowToAudit);
  } catch {
    return [];
  }
}

export async function getAudit(env, orgId, id) {
  if (!env || !env.DB || !orgId) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM compliance_audits WHERE org_id = ? AND id = ?`,
    ).bind(orgId, id).first();
    return rowToAudit(row);
  } catch {
    return null;
  }
}

export async function getAuditControls(env, orgId, auditId) {
  if (!env || !env.DB || !orgId) return [];
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM compliance_audit_controls
        WHERE org_id = ? AND audit_id = ?
        ORDER BY control_id ASC`,
    ).bind(orgId, auditId).all();
    return ((res && res.results) || []).map((r) => {
      let evidence = null;
      try { evidence = r.evidence_json ? JSON.parse(r.evidence_json) : null; } catch { evidence = null; }
      return {
        controlId: r.control_id,
        controlTitle: r.control_title,
        controlText: r.control_text || null,
        evidenceState: r.evidence_state,
        result: r.result,
        evidence,
        sourceRunId: r.source_run_id || null,
        sourceAnalyzer: r.source_analyzer || null,
        sourceCapturedAt: r.source_captured_at || null,
        attestationId: r.attestation_id || null,
        attestedOwner: r.attested_owner || null,
        attestedExpiresAt: r.attested_expires_at || null,
        documentUrl: r.document_url || null,
        rationale: r.rationale || "",
      };
    });
  } catch {
    return [];
  }
}

/**
 * Freeze an audit: write the audit row and one row per control, in one batch.
 *
 * Batched so a half-written audit cannot exist. A frozen record with some of
 * its controls missing would read as a smaller framework rather than as a
 * broken write, and nothing downstream could tell the difference.
 */
export async function insertPublishedAudit(env, audit, controlRows) {
  const stmts = [
    env.DB.prepare(
      `INSERT INTO compliance_audits
         (id, org_id, monitor_id, repo_url, branch, framework_id, framework_version,
          catalog_version, title, period_start, period_end, status, summary_json,
          scans_json, pack_sha256, pack_hash_scope, pack_bytes, retain_until,
          created_by, created_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(audit.id, audit.orgId, audit.monitorId, audit.repoUrl, audit.branch || null,
           audit.frameworkId, audit.frameworkVersion, audit.catalogVersion, audit.title,
           audit.periodStart, audit.periodEnd, JSON.stringify(audit.summary || {}),
           JSON.stringify(audit.scans || []),
           audit.packSha256, audit.packHashScope || null, audit.packBytes,
           audit.retainUntil, audit.createdBy, audit.createdAt, audit.publishedAt),
  ];

  for (const c of controlRows) {
    stmts.push(env.DB.prepare(
      `INSERT INTO compliance_audit_controls
         (id, audit_id, org_id, control_id, control_title, control_text,
          evidence_state, result, evidence_json, source_run_id, source_analyzer,
          source_captured_at, attestation_id, attested_owner, attested_expires_at,
          document_url, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId("cctl"), audit.id, audit.orgId, c.controlId, c.controlTitle,
           c.controlText, c.evidenceState, c.result,
           c.evidence ? JSON.stringify(c.evidence) : null,
           c.sourceRunId, c.sourceAnalyzer, c.sourceCapturedAt,
           c.attestationId, c.attestedOwner, c.attestedExpiresAt,
           c.documentUrl, c.rationale));
  }

  await env.DB.batch(stmts);
  return audit.id;
}

/** A correction never edits the audit it corrects. */
export async function supersedeAudit(env, orgId, oldId, newId_) {
  await env.DB.prepare(
    `UPDATE compliance_audits
        SET status = 'superseded', superseded_by = ?
      WHERE org_id = ? AND id = ? AND status = 'published'`,
  ).bind(newId_, orgId, oldId).run();
}

export { newId };
