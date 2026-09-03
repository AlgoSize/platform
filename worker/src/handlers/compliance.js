// Compliance & release audit — the HTTP surface.
//
// Two halves:
//
//   the coverage map   computed live from stored runs and attestations, nothing
//                      persisted, safe to call as often as you like
//   the frozen record  a published audit, denormalized into D1 so it outlives
//                      the evidence behind it
//
// Deliberately NOT wrapped in enforceQuota. Quota counts analyzer runs, and an
// audit consumes runs the customer was already metered for. Charging someone
// twice for their own evidence is a poor first impression of a compliance
// product, and the reading side costs a handful of indexed SELECTs.

import { requireOrgContext } from "./monitors.js";
import { applyAcceptedRisks } from "../risk/accept.js";
import { acceptancesFor } from "../risk/store.js";
import { repoKeyFor } from "../repo-key.js";
import { getMonitor, listMonitors } from "../monitors/_store.js";
import { RUN_TTL_SECONDS } from "./runs.js";
import { AUDIT_ACTIONS, auditFromRequest } from "../audit.js";
import {
  CATALOG_VERSION, FRAMEWORKS, getFramework, controlsFor, collectorsFor,
} from "../compliance/catalog.js";
import { resolveControlResult, summarize, isoDay } from "../compliance/resolve.js";
import { gatherRuns, gatherPatches, runCollectors } from "../compliance/evidence.js";
import {
  attestationsByControl, listAttestations, getAttestation, createAttestation,
  revokeAttestation, listAudits, getAudit, getAuditControls,
  insertPublishedAudit, supersedeAudit, RETENTION_SECONDS, newId,
} from "../compliance/store.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * The sentence that travels with the evidence.
 *
 * Repeated inside every pack rather than only on the website, because a pack
 * gets forwarded and the website does not travel with it. site/terms.md carries
 * the same claim in longer form.
 */
export const PACK_DISCLAIMER =
  "This is evidence about a codebase, not a certification of conformity. " +
  "Algosize is neither an audit firm nor a notified body, and does not certify " +
  "conformity with any framework. Framework names are referenced to describe " +
  "what each artifact maps onto, not to imply endorsement or accreditation. " +
  "Sufficiency is your auditor's judgement, not this tool's.";

/**
 * The longest period this product can answer honestly.
 *
 * Runs stop being readable at 90 days (handlers/runs.js:41) — a read-time
 * filter, not a delete. An audit over a longer window would return no runs and
 * render every automated control as unevidenced, for a reason the page has no
 * way to explain. Refusing the request is the honest answer; rendering a screen
 * of false negatives is not.
 */
export const MAX_PERIOD_SECONDS = RUN_TTL_SECONDS;
export const MAX_PERIOD_DAYS = Math.floor(MAX_PERIOD_SECONDS / 86400);

// ---------------------------------------------------------------------------
// GET /api/compliance/frameworks
// ---------------------------------------------------------------------------

export async function listFrameworksHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const frameworks = FRAMEWORKS.map((f) => {
    const counts = { automated: 0, attested: 0, not_covered: 0 };
    for (const c of f.controls) {
      if (counts[c.coverage] !== undefined) counts[c.coverage]++;
    }
    return {
      id: f.id,
      name: f.name,
      version: f.version,
      short: f.short,
      note: f.note,
      groups: f.groups,
      totalControls: f.controls.length,
      coverage: counts,
    };
  });

  return jsonResponse({
    frameworks,
    catalogVersion: CATALOG_VERSION,
    maxPeriodDays: MAX_PERIOD_DAYS,
    disclaimer: PACK_DISCLAIMER,
  });
}

// ---------------------------------------------------------------------------
// GET /api/compliance/coverage
// ---------------------------------------------------------------------------

/**
 * Parse and validate `?from=&to=`, defaulting to the trailing 90 days.
 *
 * Returns `{ period }` or `{ error }`. Dates arrive as YYYY-MM-DD and are read
 * as UTC — a compliance period read in the reader's local timezone would start
 * and end on different days for different people looking at the same audit.
 */
function parsePeriod(url) {
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");

  // BOTH ENDS ARE DAY-ALIGNED, ALWAYS.
  //
  // This endpoint speaks in YYYY-MM-DD, and the page stores the period it
  // returns and echoes it back on every later call — a framework switch, a
  // retry, a publish. So the period a request answers with has to be one the
  // next request accepts unchanged.
  //
  // A default computed in raw seconds is not: returned as day strings and
  // re-parsed, it becomes start-of-day → end-of-day, up to 23:59:59 WIDER than
  // what was returned. With the default sitting exactly on the cap there was no
  // headroom to absorb that, so every second request was refused for exceeding
  // a limit the first request had just chosen.
  const endOn = rawTo || isoDay(nowSec());
  const end = parseDay(endOn, true);
  // Inclusive, because a period expressed in days is inclusive of both: "the
  // last 90 days" is today plus the 89 before it, not today plus 90.
  const startOn = rawFrom ||
    (end === null ? null : isoDay(end - (MAX_PERIOD_DAYS - 1) * 86400));
  const start = startOn === null ? null : parseDay(startOn, false);

  if (end === null || start === null) {
    return { error: { code: "invalid_period", message: "Dates must be YYYY-MM-DD." } };
  }
  if (start >= end) {
    return { error: { code: "invalid_period", message: "The period must start before it ends." } };
  }
  if (end - start > MAX_PERIOD_SECONDS) {
    return {
      error: {
        code: "period_too_long",
        message:
          `An evidence period cannot exceed ${MAX_PERIOD_DAYS} days. ` +
          "Scan results stop being readable after that, so a longer window would render " +
          "every automated control as unevidenced when the evidence merely aged out.",
      },
    };
  }
  return { period: { start, end } };
}

function parseDay(raw, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Build every control row for a framework over a period.
 *
 * The one place a coverage map is assembled, shared by the live endpoint and by
 * publish, so a published pack cannot disagree with the page it was cut from.
 */
/**
 * Apply the org's accepted risks to the source findings of every vuln run.
 *
 * Mutates the in-memory run objects only. The stored `result_json` is never
 * rewritten: what the scanner found is a fact about that moment, and the
 * acceptance is a fact about now. Keeping them apart is what makes revocation
 * instantaneous across all history, and what leaves nothing to bypass.
 */
async function decorateRunsWithAcceptances(env, runs, { orgId, repoUrl }) {
  const repoKey = repoKeyFor(repoUrl);
  if (!repoKey) return;
  const vuln = (runs && runs.vuln) || [];
  if (!vuln.length) return;

  const acceptances = await acceptancesFor(env, orgId, repoKey);
  if (!acceptances.length) return;

  const now = nowSec();
  for (const run of vuln) {
    const source = run && run.result && run.result.source;
    if (!source || !Array.isArray(source.findings)) continue;
    source.findings = applyAcceptedRisks(source.findings, acceptances, { repoKey, now });
  }
}

export async function buildCoverage(env, { orgId, monitor, frameworkId, period }) {
  const framework = getFramework(frameworkId);
  if (!framework) return null;

  const repoUrl = monitor ? monitor.repoUrl : null;
  const runs = await gatherRuns(env, { orgId, repoUrl, period });

  // Accepted risks are applied HERE, between gathering the runs and running the
  // collectors, so that PW.5.1 counts what is open rather than what was ever
  // found. Not inside gatherRuns, which also serves the arch collectors and
  // has no findings to decorate; and never written back to the stored run, so
  // a revocation reaches every historical run on the next read.
  await decorateRunsWithAcceptances(env, runs, { orgId, repoUrl });

  const patches = await gatherPatches(env, { orgId, period });
  const attestations = await attestationsByControl(env, orgId, frameworkId);
  const evidence = runCollectors(collectorsFor(frameworkId), {
    runs, patches, monitor, period,
  });

  const now = nowSec();
  const rows = controlsFor(frameworkId).map((control) => {
    const resolved = resolveControlResult({
      control,
      evidence: control.collector ? evidence[control.collector] : null,
      attestation: attestations.get(control.id) || null,
      period,
      now,
    });
    const att = attestations.get(control.id) || null;
    return {
      id: control.id,
      group: control.group,
      title: control.title,
      coverage: control.coverage,
      why: control.why || null,
      ...resolved,
      // Attestation detail the page renders in its own column. Kept beside the
      // resolved answer rather than folded into it: the reader is entitled to
      // see who signed, and until when, without trusting the verdict.
      attestation: att && !att.revokedAt
        ? {
            id: att.id,
            kind: att.kind,
            statement: att.statement,
            ownerEmail: att.ownerEmail,
            documentUrl: att.documentUrl,
            expiresAt: att.expiresAt,
            expiresOn: isoDay(att.expiresAt),
          }
        : null,
    };
  });

  const runCount = (runs.vuln || []).length + (runs.arch || []).length;
  return {
    framework: {
      id: framework.id, name: framework.name, version: framework.version,
      short: framework.short, note: framework.note, groups: framework.groups,
    },
    catalogVersion: CATALOG_VERSION,
    period: { start: period.start, end: period.end,
              startOn: isoDay(period.start), endOn: isoDay(period.end) },
    monitor: monitor
      ? { monitorId: monitor.monitorId, repoUrl: monitor.repoUrl,
          branch: monitor.branch || null, paused: !!monitor.pausedAt }
      : null,
    scans: { total: runCount, vuln: (runs.vuln || []).length, arch: (runs.arch || []).length },
    summary: summarize(rows),
    controls: rows,
    disclaimer: PACK_DISCLAIMER,
  };
}

export async function coverageHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const url = new URL(request.url);
  const frameworkId = url.searchParams.get("framework") || FRAMEWORKS[0].id;
  if (!getFramework(frameworkId)) {
    return jsonResponse({ error: "not_found", message: "No framework with that id." }, 404);
  }

  const parsed = parsePeriod(url);
  if (parsed.error) {
    return jsonResponse({ error: parsed.error.code, message: parsed.error.message }, 400);
  }

  // The audit is about a repository, and a repository reaches this feature
  // through a watch: runs carry no repo column, so without a monitor there is
  // nothing to scope the evidence to.
  const monitorId = url.searchParams.get("monitor");
  let monitor = null;
  if (monitorId) {
    monitor = await getMonitor(env, ctxOrg.orgId, monitorId);
    if (!monitor) {
      return jsonResponse({ error: "not_found", message: "No watch with that id on this organisation." }, 404);
    }
  } else {
    const all = await listMonitors(env, ctxOrg.orgId);
    monitor = all.length ? all[0] : null;
  }

  const coverage = await buildCoverage(env, {
    orgId: ctxOrg.orgId, monitor, frameworkId, period: parsed.period,
  });

  const audits = await listAudits(env, ctxOrg.orgId, { frameworkId, limit: 5 });
  return jsonResponse({
    ...coverage,
    monitors: (await listMonitors(env, ctxOrg.orgId)).map((m) => ({
      monitorId: m.monitorId, repoUrl: m.repoUrl, branch: m.branch || null,
    })),
    audits,
  });
}

// ---------------------------------------------------------------------------
// Attestations
// ---------------------------------------------------------------------------

export async function listAttestationsHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;
  const url = new URL(request.url);
  const frameworkId = url.searchParams.get("framework") || null;
  return jsonResponse({
    attestations: await listAttestations(env, ctxOrg.orgId, frameworkId),
    now: nowSec(),
  });
}

const MAX_STATEMENT = 2000;

export async function createAttestationHandler(request, env, ctx) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  let body = null;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "invalid_request", message: "Expected a JSON body." }, 400);
  }

  const frameworkId = String(body.frameworkId || "");
  const controlId = String(body.controlId || "");
  const framework = getFramework(frameworkId);
  if (!framework) {
    return jsonResponse({ error: "invalid_request", message: "No framework with that id." }, 400);
  }
  const control = framework.controls.find((c) => c.id === controlId);
  if (!control) {
    return jsonResponse({ error: "invalid_request", message: "No control with that id in this framework." }, 400);
  }
  // An automated control is answered by an artifact. Letting someone sign over
  // the top of a measurement is exactly the overclaim this feature exists to
  // prevent, so it is refused rather than silently ignored downstream.
  if (control.coverage === "automated") {
    return jsonResponse({
      error: "invalid_request",
      message: "This control is answered by a scan artifact. An attestation cannot override a measurement.",
    }, 400);
  }

  const statement = typeof body.statement === "string" ? body.statement.trim() : "";
  if (!statement) {
    return jsonResponse({ error: "invalid_request", message: "An attestation needs a statement." }, 400);
  }
  if (statement.length > MAX_STATEMENT) {
    return jsonResponse({ error: "invalid_request", message: `Keep the statement under ${MAX_STATEMENT} characters.` }, 400);
  }

  const kind = body.kind === "not_applicable" ? "not_applicable" : "attested";

  // Required, and required for a reason: see 0028_compliance.sql.
  const expiresAt = parseExpiry(body.expiresAt);
  if (expiresAt === null) {
    return jsonResponse({
      error: "invalid_request",
      message: "An attestation needs an end date (YYYY-MM-DD) in the future. There are no perpetual attestations.",
    }, 400);
  }

  const ownerEmail = typeof body.ownerEmail === "string" ? body.ownerEmail.trim() : "";
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    return jsonResponse({
      error: "invalid_request",
      message: "An attestation needs an accountable owner's email address.",
    }, 400);
  }

  const documentUrl = typeof body.documentUrl === "string" && body.documentUrl.trim()
    ? body.documentUrl.trim() : null;
  if (documentUrl && !/^https:\/\//i.test(documentUrl)) {
    return jsonResponse({ error: "invalid_request", message: "A document link must be https." }, 400);
  }

  let created;
  try {
    created = await createAttestation(env, {
      orgId: ctxOrg.orgId, frameworkId, controlId, kind, statement,
      ownerEmail, documentUrl,
      attestedBy: (request.user && request.user.email) || null,
      expiresAt, catalogVersion: CATALOG_VERSION,
    });
  } catch {
    return jsonResponse({
      error: "storage_unavailable",
      message: "Attestations cannot be stored — migration 0028 has not been applied.",
    }, 503);
  }

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.COMPLIANCE_ATTESTED,
    targetType: "compliance_control",
    targetId: `${frameworkId}:${controlId}`,
    orgId: ctxOrg.orgId,
    metadata: { kind, ownerEmail, expiresAt, catalogVersion: CATALOG_VERSION },
  });

  return jsonResponse({ attestation: created }, 201);
}

/** `YYYY-MM-DD` -> unix seconds at end of that UTC day, or null when it is not
 *  a date or is not in the future. Exported because the accepted-risk register
 *  makes exactly the same promise ("there are no perpetual ones") and two
 *  implementations of a rule like that drift. */
export function parseExpiry(raw) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T23:59:59Z`);
  if (!Number.isFinite(ms)) return null;
  const sec = Math.floor(ms / 1000);
  return sec > nowSec() ? sec : null;
}

export async function revokeAttestationHandler(request, env, ctx) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const id = request.params && request.params.id;
  if (!id) return jsonResponse({ error: "invalid_request", message: "No attestation id supplied." }, 400);

  const existing = await getAttestation(env, ctxOrg.orgId, id);
  if (!existing) {
    return jsonResponse({ error: "not_found", message: "No attestation with that id on this organisation." }, 404);
  }
  if (existing.revokedAt) return jsonResponse({ attestation: existing });

  await revokeAttestation(env, ctxOrg.orgId, id, (request.user && request.user.email) || null);

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.COMPLIANCE_ATTESTATION_REVOKED,
    targetType: "compliance_attestation",
    targetId: id,
    orgId: ctxOrg.orgId,
    metadata: { controlId: existing.controlId, frameworkId: existing.frameworkId },
  });

  return jsonResponse({ attestation: await getAttestation(env, ctxOrg.orgId, id) });
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Strip anything that would put source code into a document meant to be
 * forwarded. Rule ids, CWE and OWASP mappings, confidence, language, file and
 * line survive; the matched snippet never does.
 *
 * This preserves the standing rule stated in 0027_scan_patches.sql, and it is
 * what makes a pack safe to hand a third party.
 */
export function redactEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return evidence;
  const clean = {};
  for (const [k, v] of Object.entries(evidence)) {
    if (k === "snippet" || k === "evidence" || k === "content" || k === "source") continue;
    clean[k] = Array.isArray(v) ? v.map(redactEvidence) : (v && typeof v === "object" ? redactEvidence(v) : v);
  }
  return clean;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function publishAuditHandler(request, env, ctx) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  let body = null;
  try { body = await request.json(); } catch { body = null; }
  body = body || {};

  const frameworkId = String(body.frameworkId || FRAMEWORKS[0].id);
  const framework = getFramework(frameworkId);
  if (!framework) {
    return jsonResponse({ error: "invalid_request", message: "No framework with that id." }, 400);
  }

  const url = new URL(request.url);
  if (body.from) url.searchParams.set("from", String(body.from));
  if (body.to) url.searchParams.set("to", String(body.to));
  const parsed = parsePeriod(url);
  if (parsed.error) {
    return jsonResponse({ error: parsed.error.code, message: parsed.error.message }, 400);
  }

  const monitorId = body.monitorId ? String(body.monitorId) : null;
  let monitor = null;
  if (monitorId) {
    monitor = await getMonitor(env, ctxOrg.orgId, monitorId);
    if (!monitor) {
      return jsonResponse({ error: "not_found", message: "No watch with that id on this organisation." }, 404);
    }
  } else {
    const all = await listMonitors(env, ctxOrg.orgId);
    monitor = all.length ? all[0] : null;
  }
  if (!monitor) {
    return jsonResponse({
      error: "invalid_request",
      message: "An audit is about a repository. Put one under watch first — scan runs carry no repository of their own to scope this to.",
    }, 400);
  }

  const coverage = await buildCoverage(env, {
    orgId: ctxOrg.orgId, monitor, frameworkId, period: parsed.period,
  });

  const at = nowSec();
  const auditId = newId("caud");
  const controlRows = coverage.controls.map((c) => ({
    controlId: c.id,
    controlTitle: c.title,
    // The framework's own words, frozen. A later CATALOG_VERSION bump cannot
    // rewrite what this pack said.
    controlText: c.why || c.title,
    evidenceState: c.evidenceState,
    result: c.result,
    evidence: redactEvidence({
      asserted: c.asserted, provenance: c.provenance, qualifiers: c.qualifiers,
      capturedOn: c.capturedAt ? isoDay(c.capturedAt) : null,
    }),
    sourceRunId: c.sourceRunId,
    sourceAnalyzer: c.sourceAnalyzer,
    sourceCapturedAt: c.capturedAt,
    attestationId: c.attestation ? c.attestation.id : null,
    attestedOwner: c.attestation ? c.attestation.ownerEmail : null,
    attestedExpiresAt: c.attestation ? c.attestation.expiresAt : null,
    documentUrl: c.attestation ? c.attestation.documentUrl : null,
    rationale: c.rationale,
  }));

  const packBody = canonicalPack({
    auditId, coverage, controlRows, monitor, framework, at,
  });
  const packJson = JSON.stringify(packBody);
  const packSha256 = await sha256Hex(packJson);

  const audit = {
    id: auditId,
    orgId: ctxOrg.orgId,
    monitorId: monitor.monitorId,
    repoUrl: monitor.repoUrl,
    frameworkId,
    frameworkVersion: framework.version,
    catalogVersion: CATALOG_VERSION,
    title: typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 200)
      : `${framework.short} · ${coverage.period.startOn} → ${coverage.period.endOn}`,
    periodStart: parsed.period.start,
    periodEnd: parsed.period.end,
    summary: coverage.summary,
    packSha256,
    packBytes: new TextEncoder().encode(packJson).length,
    retainUntil: parsed.period.end + RETENTION_SECONDS,
    createdBy: (request.user && request.user.email) || null,
    createdAt: at,
    publishedAt: at,
  };

  try {
    await insertPublishedAudit(env, audit, controlRows);
  } catch {
    return jsonResponse({
      error: "storage_unavailable",
      message: "The audit cannot be frozen — migration 0028 has not been applied.",
    }, 503);
  }

  // A correction supersedes; it never edits.
  const supersedes = body.supersedes ? String(body.supersedes) : null;
  if (supersedes) {
    await supersedeAudit(env, ctxOrg.orgId, supersedes, auditId);
    await auditFromRequest(request, env, ctx, {
      action: AUDIT_ACTIONS.COMPLIANCE_AUDIT_SUPERSEDED,
      targetType: "compliance_audit", targetId: supersedes,
      orgId: ctxOrg.orgId, metadata: { supersededBy: auditId },
    });
  }

  await auditFromRequest(request, env, ctx, {
    action: AUDIT_ACTIONS.COMPLIANCE_AUDIT_PUBLISHED,
    targetType: "compliance_audit",
    targetId: auditId,
    orgId: ctxOrg.orgId,
    metadata: {
      frameworkId, catalogVersion: CATALOG_VERSION, packSha256,
      periodStart: parsed.period.start, periodEnd: parsed.period.end,
      controls: controlRows.length,
    },
  });

  return jsonResponse({ audit }, 201);
}

/**
 * The frozen document, in a stable key order so its SHA-256 is reproducible.
 *
 * Self-describing on purpose: it carries the framework text, the numbers
 * asserted and the disclaimer, so it still reads as a complete record after
 * every run behind it has aged out of the platform.
 */
function canonicalPack({ auditId, coverage, controlRows, monitor, framework, at }) {
  return {
    schema: "algosize.compliance.pack/1",
    auditId,
    generatedAt: isoDay(at),
    disclaimer: PACK_DISCLAIMER,
    framework: {
      id: framework.id, name: framework.name, version: framework.version,
      catalogVersion: CATALOG_VERSION,
    },
    subject: { repoUrl: monitor.repoUrl, branch: monitor.branch || null },
    period: { start: coverage.period.startOn, end: coverage.period.endOn },
    scans: coverage.scans,
    summary: coverage.summary,
    controls: controlRows.map((c) => ({
      id: c.controlId,
      title: c.controlTitle,
      evidenceState: c.evidenceState,
      result: c.result,
      rationale: c.rationale,
      asserted: c.evidence ? c.evidence.asserted : null,
      provenance: c.evidence ? c.evidence.provenance : null,
      capturedOn: c.evidence ? c.evidence.capturedOn : null,
      attestedOwner: c.attestedOwner,
      attestedUntil: c.attestedExpiresAt ? isoDay(c.attestedExpiresAt) : null,
      documentUrl: c.documentUrl,
    })),
  };
}

export async function listAuditsHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;
  const url = new URL(request.url);
  return jsonResponse({
    audits: await listAudits(env, ctxOrg.orgId, {
      frameworkId: url.searchParams.get("framework") || null,
    }),
  });
}

export async function getAuditHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const id = request.params && request.params.id;
  if (!id) return jsonResponse({ error: "invalid_request", message: "No audit id supplied." }, 400);

  const audit = await getAudit(env, ctxOrg.orgId, id);
  if (!audit) {
    return jsonResponse({ error: "not_found", message: "No audit with that id on this organisation." }, 404);
  }
  const framework = getFramework(audit.frameworkId);
  return jsonResponse({
    audit,
    framework: framework
      ? { id: framework.id, name: framework.name, version: framework.version,
          short: framework.short, groups: framework.groups }
      : null,
    controls: await getAuditControls(env, ctxOrg.orgId, id),
    disclaimer: PACK_DISCLAIMER,
  });
}

/**
 * The downloadable pack, rebuilt from the frozen rows.
 *
 * Rebuilt rather than stored: the rows ARE the record, and generating from them
 * means the file a recipient gets and the page the customer reads cannot drift
 * apart. The bulk bundle — full SBOM, SARIF, per-scan artifacts — is not here
 * yet; it needs an object store whose lifecycle rule is scoped so a one-year
 * pack is not swept away by a rule written for 90-day reports.
 */
export async function downloadPackHandler(request, env) {
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const id = request.params && request.params.id;
  const audit = id ? await getAudit(env, ctxOrg.orgId, id) : null;
  if (!audit) {
    return jsonResponse({ error: "not_found", message: "No audit with that id on this organisation." }, 404);
  }
  if (audit.status === "draft") {
    return jsonResponse({
      error: "not_published",
      message: "A draft has nothing frozen to download. Publish it first.",
    }, 409);
  }

  const controls = await getAuditControls(env, ctxOrg.orgId, id);
  const framework = getFramework(audit.frameworkId);
  const body = {
    schema: "algosize.compliance.pack/1",
    auditId: audit.id,
    generatedAt: isoDay(audit.publishedAt || audit.createdAt),
    disclaimer: PACK_DISCLAIMER,
    framework: {
      id: audit.frameworkId,
      name: framework ? framework.name : audit.frameworkId,
      version: audit.frameworkVersion,
      catalogVersion: audit.catalogVersion,
    },
    subject: { repoUrl: audit.repoUrl },
    period: { start: isoDay(audit.periodStart), end: isoDay(audit.periodEnd) },
    summary: audit.summary,
    packSha256: audit.packSha256,
    retainedUntil: isoDay(audit.retainUntil),
    controls: controls.map((c) => ({
      id: c.controlId, title: c.controlTitle,
      evidenceState: c.evidenceState, result: c.result,
      rationale: c.rationale,
      asserted: c.evidence ? c.evidence.asserted : null,
      provenance: c.evidence ? c.evidence.provenance : null,
      attestedOwner: c.attestedOwner,
      attestedUntil: c.attestedExpiresAt ? isoDay(c.attestedExpiresAt) : null,
      documentUrl: c.documentUrl,
    })),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${audit.id}.json"`,
    },
  });
}
