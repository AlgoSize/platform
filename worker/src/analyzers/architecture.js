// Architecture analyzer — parse a repository into a service/dependency graph,
// score it, and return JSON a dashboard can draw as a zoomable diagram.
//
// Static analysis only. No LLM calls, no requests to the infrastructure being
// analyzed, no network at all: the caller submits {path, content} pairs and
// everything below is computed from those bytes. Same posture as the vuln
// analyzer's lockfile path.
//
// The three stages live in ./architecture/:
//   graph.js      files → nodes, edges, clusters, every fact carrying file:line
//   rules.js      graph → findings under the speed / cost / security lenses
//   recommend.js  findings + graph → per-cluster changes, ordered
//
// What this deliberately does NOT do is guess. Any file it cannot parse is
// counted in `coverage.filesSkipped` and named in `coverage.skipped`; any rule
// the brief asked for that a repository cannot actually establish is listed in
// `limits.notImplemented` with the reason. An architecture diagram that
// silently omits half a system is worse than no diagram, because the reader
// has no way to know which half.

import { buildGraph } from "./architecture/graph.js";
import { scoreGraph, countByLens, countBySeverity, UNIMPLEMENTED_RULES,
         ruleCoverage } from "./architecture/rules.js";
import { recommend } from "./architecture/recommend.js";
import { enrichGraph } from "./architecture/enrich.js";

// Bounds. These mirror the lockfile analyzer's posture: cap the work, and
// SAY when the cap bit rather than returning a confidently partial answer.
export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

/**
 * Validate the submitted payload.
 *
 * Shape: `{ files: [{ path, content }, ...] }`. Everything is optional except
 * having at least one readable file — the analyzer's whole job is reading what
 * it was given.
 */
export function validateArchitectureInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_payload", message: "Request body must be a JSON object." };
  }
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      error: "invalid_payload",
      message: "Provide `files`: an array of { path, content } pairs — manifests, configs and source.",
    };
  }
  if (files.length > MAX_FILES) {
    return {
      ok: false,
      error: "too_many_files",
      message: `Submit at most ${MAX_FILES} files per analysis (received ${files.length}).`,
    };
  }

  const clean = [];
  let totalBytes = 0;
  const oversized = [];

  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    if (typeof f.path !== "string" || !f.path.trim()) continue;
    const content = typeof f.content === "string" ? f.content : "";
    if (content.length > MAX_FILE_BYTES) {
      // Skipped rather than truncated: half a manifest parses into a
      // confidently wrong graph, which is worse than a named gap.
      oversized.push(f.path);
      continue;
    }
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: "payload_too_large",
        message: `Total submitted content exceeds ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB. ` +
                 `Submit manifests, configs and source — not build output or vendored dependencies.`,
      };
    }
    clean.push({ path: f.path.trim().replace(/^\.\//, ""), content });
  }

  if (clean.length === 0) {
    return {
      ok: false,
      error: "invalid_payload",
      message: "No readable files in the payload — each entry needs a `path` and a string `content`.",
    };
  }

  return { ok: true, value: { files: clean, oversized } };
}

/**
 * Run the analysis. Pure: same input, same output, no IO.
 *
 * Returns `{ graph, findings, recommendations, summary, limits }`.
 */
export function analyzeArchitecture({ files, oversized = [] }) {
  const graph = buildGraph(files);
  const { findings, droppedForMissingEvidence } = scoreGraph(graph);
  const recommendations = recommend(graph, findings);

  const clusters = graph.clusters.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    evidence: c.evidence,
    nodes: c.nodes,
  }));

  // The graph is the drawable artefact, so it goes out in the shape the UI
  // consumes: nodes, edges, clusters, nothing else at the top level.
  const drawable = {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      cluster: n.cluster,
      files: n.files,
      evidence: n.evidence,
      ...(n.publiclyReachable ? { publiclyReachable: true } : {}),
      ...(n.shared ? { shared: true } : {}),
    })),
    edges: graph.edges,
    clusters,
  };

  // Phase 1: add the fields drift, SPOF and trust-boundary work will fill in.
  // Purely additive — every field it adds is null, and the rules engine above
  // has already run against the un-enriched graph, so nothing here can change
  // a finding. See architecture/enrich.js for why null means NOT MEASURED.
  const enriched = enrichGraph(drawable);

  const severityCounts = countBySeverity(findings);
  return {
    graph: enriched,
    findings,
    recommendations,
    summary: {
      clusters: clusters.length,
      nodes: enriched.nodes.length,
      edges: enriched.edges.length,
      findings: findings.length,
      byLens: countByLens(findings),
      // The denominator behind byLens. Without it a lens reading 0 is
      // ambiguous between "four rules looked and found nothing" and "this
      // lens is silent", which are opposite pieces of news.
      lensCoverage: ruleCoverage(),
      bySeverity: severityCounts,
      // Mirrors the dependency audit's `complete` flag: true only when every
      // submitted file was understood and no cap bit. A caller can render
      // "partial" instead of implying the whole system was seen.
      complete: graph.coverage.filesSkipped === 0 && oversized.length === 0,
    },
    limits: {
      filesAnalyzed: graph.coverage.filesAnalyzed,
      filesSkipped:  graph.coverage.filesSkipped,
      skipped:       graph.coverage.skipped,
      truncatedSkippedList: graph.coverage.truncatedSkippedList,
      oversized,
      droppedForMissingEvidence,
      notImplemented: UNIMPLEMENTED_RULES,
    },
  };
}
