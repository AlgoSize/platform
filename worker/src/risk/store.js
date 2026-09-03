// D1 for accepted risks. Reads and writes only — every decision lives in
// risk/accept.js, which is pure so CI and the Worker can share it.
//
// Same posture as compliance/store.js: an unapplied migration must not take a
// scan down. Every read catches and returns empty, which means "nothing is
// accepted" — the SAFE direction, and therefore the one nothing else would
// ever notice, which is exactly why 0029 is registered in the MIGRATIONS
// manifest in handlers/admin.js.

const SELECT = `SELECT id, org_id, repo_key, rule_id, path, fingerprint, category,
                       severity, rationale, owner_email, document_url, accepted_by,
                       accepted_at, expires_at, revoked_at, analyzer_version
                  FROM accepted_risks`;

function rowToAcceptance(r) {
  return {
    id: r.id,
    orgId: r.org_id,
    repoKey: r.repo_key,
    ruleId: r.rule_id,
    path: r.path,
    fingerprint: r.fingerprint,
    category: r.category,
    severity: r.severity,
    rationale: r.rationale,
    ownerEmail: r.owner_email,
    documentUrl: r.document_url || null,
    acceptedBy: r.accepted_by || null,
    acceptedAt: r.accepted_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at || null,
    analyzerVersion: r.analyzer_version || null,
  };
}

/**
 * Live acceptances for one org and repository.
 *
 * Revoked rows are excluded here; EXPIRED ROWS ARE NOT. Expiry is decided
 * read-side in risk/accept.js against the current clock, so a lapsed
 * acceptance reverts to an open finding that still names who let it lapse.
 * Filtering expiry in SQL would throw that record away and make the lapse
 * silent, which is the failure this whole feature is built not to have.
 */
export async function acceptancesFor(env, orgId, repoKey) {
  if (!env || !env.DB || !orgId || !repoKey) return [];
  try {
    const res = await env.DB
      .prepare(`${SELECT} WHERE org_id = ? AND repo_key = ? AND revoked_at IS NULL`)
      .bind(orgId, repoKey)
      .all();
    return (res.results || []).map(rowToAcceptance);
  } catch {
    return [];
  }
}

/** The register as a list — every live acceptance for an org, newest first. */
export async function listAcceptances(env, orgId, { limit = 200 } = {}) {
  if (!env || !env.DB || !orgId) return [];
  try {
    const res = await env.DB
      .prepare(`${SELECT} WHERE org_id = ? AND revoked_at IS NULL ORDER BY accepted_at DESC LIMIT ?`)
      .bind(orgId, Math.min(Number(limit) || 200, 500))
      .all();
    return (res.results || []).map(rowToAcceptance);
  } catch {
    return [];
  }
}

/** Insert. Throws on a missing table so the handler can 503 by name. */
export async function insertAcceptance(env, row) {
  await env.DB.prepare(
    `INSERT INTO accepted_risks
       (id, org_id, repo_key, rule_id, path, fingerprint, category, severity,
        rationale, owner_email, document_url, accepted_by, accepted_at,
        expires_at, analyzer_version, run_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    row.id, row.orgId, row.repoKey, row.ruleId, row.path, row.fingerprint,
    row.category, row.severity, row.rationale, row.ownerEmail,
    row.documentUrl || null, row.acceptedBy || null, row.acceptedAt,
    row.expiresAt, row.analyzerVersion || null, row.runId || null,
  ).run();
  return row;
}

/** Revoke. Org-scoped in the statement, never after the fact. */
export async function revokeAcceptance(env, orgId, id, revokedBy, at) {
  const res = await env.DB.prepare(
    `UPDATE accepted_risks SET revoked_at = ?, revoked_by = ?
      WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
  ).bind(at, revokedBy || null, id, orgId).run();
  return Boolean(res.meta && res.meta.changes);
}

/**
 * Acceptances that have lapsed, or are about to.
 *
 * Notification only. Expiry is already enforced read-side and cannot be
 * bypassed; this exists so a lapse is a decision somebody makes rather than
 * a finding that quietly reappears in next month's report.
 */
export async function expiringAcceptances(env, { now, withinSeconds = 14 * 86400 } = {}) {
  if (!env || !env.DB) return { expired: [], expiring: [] };
  try {
    const res = await env.DB
      .prepare(`${SELECT} WHERE revoked_at IS NULL AND expires_at <= ? ORDER BY expires_at ASC LIMIT 200`)
      .bind(now + withinSeconds)
      .all();
    const rows = (res.results || []).map(rowToAcceptance);
    return {
      expired: rows.filter((r) => r.expiresAt <= now),
      expiring: rows.filter((r) => r.expiresAt > now),
    };
  } catch {
    return { expired: [], expiring: [] };
  }
}
