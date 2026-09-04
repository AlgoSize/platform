// Where an accepted risk actually reaches a scan.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// risk/accept.js decides; risk/store.js reads D1; this joins the two and does
// it in ONE place. Before it, `applyAcceptedRisks` had exactly one caller —
// the PW.5.1 compliance collector — so an acceptance changed a compliance
// control and nothing else. The scanner card offered "Accept this risk", told
// the reader "Signed. Re-run the scan to see it applied," and re-running
// showed a finding still open, still at full severity, with no record of who
// signed it. The API stored the acceptance; nothing read it.
//
// Every surface that shows source findings now goes through here, so there is
// one answer to "is this signed for" rather than one per renderer.
//
// ---------------------------------------------------------------------------
// THE INVARIANT THIS FILE MUST NOT BREAK
// ---------------------------------------------------------------------------
// NOTHING HERE IS EVER PERSISTED. `runs.result_json` holds what the scanner
// found at that moment; an acceptance is a fact about now. Keeping them apart
// is what makes a revocation take effect instantly across all history, and
// what leaves nothing to bypass — there is no stored `accepted: true` for a
// stale row, a restored backup, or a hand-edited database to carry.
//
// Two rules follow, and both are asserted by the suite:
//
//   1. Every function here RETURNS A NEW OBJECT and mutates nothing it is
//      given. A caller that persists its own copy cannot be affected by a
//      caller that decorates.
//   2. On the live scan paths, decoration happens strictly AFTER the run has
//      been handed to persistence, and from an independently parsed body.

import { acceptancesFor } from "./store.js";
import { applyAcceptedRisks } from "./accept.js";
import { summarizeFindings } from "../analyzers/sast/schema.js";
import { repoKeyFor } from "../repo-key.js";

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Apply acceptances to one source-scan block. Pure, synchronous, total.
 *
 * The summary is RECOMPUTED, not patched. `summarizeFindings` folds in
 * `acceptanceSummary`, so a block decorated without re-summarising would carry
 * `open.total` equal to `total` and `accepted.total` of 0 — a summary that
 * contradicts the findings beside it, which is worse than not applying the
 * acceptance at all.
 *
 * Returns a new block; the input is untouched.
 */
export function applyAcceptancesToSource(source, acceptances, { repoKey, now = nowSec() } = {}) {
  if (!source || !Array.isArray(source.findings) || !source.findings.length) return source;
  if (!repoKey || !Array.isArray(acceptances) || !acceptances.length) return source;
  const findings = applyAcceptedRisks(source.findings, acceptances, { repoKey, now });
  return { ...source, findings, summary: summarizeFindings(findings) };
}

/**
 * Apply acceptances to a whole analyzer result — the `{ ...audit, source }`
 * shape that the scan endpoint, CI ingest and the runs table all share.
 *
 * Only `result.source` is touched. Dependency advisories are deliberately left
 * alone: `NEVER_ACCEPTABLE` in risk/accept.js already refuses to store an
 * acceptance against one, and a second, quieter path that applied them anyway
 * is exactly the bypass that list exists to prevent.
 */
export function applyAcceptancesToResult(result, acceptances, opts) {
  if (!result || typeof result !== "object" || !result.source) return result;
  const source = applyAcceptancesToSource(result.source, acceptances, opts);
  return source === result.source ? result : { ...result, source };
}

/**
 * The async half: look the acceptances up, then apply them.
 *
 * Returns the result UNCHANGED when there is no repository, no org, or nothing
 * signed — and `acceptancesFor` already swallows an unapplied migration 0029
 * into an empty list, so a database that has never seen the table degrades to
 * "nothing is accepted", which is the safe direction and the only one that
 * could not hide an open finding.
 */
export async function decorateResultWithAcceptances(env, result, { orgId, repoUrl, now = nowSec() } = {}) {
  if (!result || !result.source || !orgId) return result;
  const repoKey = repoKeyFor(repoUrl || result.repoUrl);
  if (!repoKey) return result;
  const acceptances = await acceptancesFor(env, orgId, repoKey);
  if (!acceptances.length) return result;
  return applyAcceptancesToResult(result, acceptances, { repoKey, now });
}

/**
 * The same, for a bare source block with no result around it — the shape CI
 * ingest holds while it decides what to put in the build comment.
 */
export async function decorateSourceWithAcceptances(env, source, { orgId, repoUrl, now = nowSec() } = {}) {
  if (!source || !orgId) return source;
  const repoKey = repoKeyFor(repoUrl);
  if (!repoKey) return source;
  const acceptances = await acceptancesFor(env, orgId, repoKey);
  if (!acceptances.length) return source;
  return applyAcceptancesToSource(source, acceptances, { repoKey, now });
}

/**
 * Decorate a run in place of the raw one, for any READ of stored history.
 *
 * The run's own `input.repoUrl` is the repository, because that is what the
 * scan was of. Falling back to the result's `repoUrl` covers the CI shape,
 * where the repository arrives in the ingest body rather than the input.
 */
export async function decorateRunWithAcceptances(env, run, { orgId } = {}) {
  if (!run || !run.result || !run.result.source) return run;
  const owner = orgId || run.orgId;
  if (!owner) return run;
  const repoUrl = (run.input && (run.input.repoUrl || run.input.repo)) || run.result.repoUrl || null;
  const result = await decorateResultWithAcceptances(env, run.result, { orgId: owner, repoUrl });
  return result === run.result ? run : { ...run, result };
}
