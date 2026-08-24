// Versioned architecture snapshots (migrations/0018).
//
// One row per capture of one repository's graph. Written from all three places
// that already build a graph — a manual upload, a CI run, the nightly monitor
// sweep — so the history accumulates from normal use rather than needing
// anyone to opt in.
//
// The load-bearing rule, and the one every function here is shaped around:
//
//   RECORDING A SNAPSHOT MUST NEVER FAIL THE THING THAT PRODUCED IT.
//
// A manual X-ray that returns a graph and then 500s because a history row
// could not be written has destroyed the result the user actually asked for,
// to protect a feature they did not. Every write path below swallows its
// errors, captures them for the operator, and returns null. The caller checks
// for null only to decide whether to mention the snapshot in its response.
//
// Same posture as recordEmailSend and recordMonitorAttempt: filing is
// diagnostic, and diagnostics do not get to break the primary path.

import { captureException } from "../observability.js";
import { reduceGraph } from "../analyzers/architecture/enrich.js";

/** Where a snapshot came from. Validated on write; see the migration header. */
export const SNAPSHOT_SOURCES = Object.freeze(["manual", "ci", "monitor"]);

/**
 * D1 caps a single value at 1,000,000 bytes. The ceiling here is deliberately
 * well under that: a row also carries its other columns, and a snapshot that
 * squeaks in at 999KB today fails on the next capture when one more service
 * appears. Reducing at 700KB leaves room for the graph to grow.
 */
export const MAX_GRAPH_BYTES = 700 * 1024;

const RETENTION_DAYS = 90;

function newSnapshotId() {
  // Same shape as newRunId: sortable prefix, random suffix. Sortable matters
  // here — the list query orders by captured_at, and ties inside one second
  // then resolve consistently rather than arbitrarily.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `arc_${ts}_${rand}`;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------
//
// gzip when the runtime has CompressionStream, plain JSON when it does not.
// The column records which, so a reader never sniffs. Architecture graphs are
// extremely repetitive — the same cluster ids, kinds and file paths over and
// over — so gzip typically gets them to well under a fifth of their size even
// after base64 adds a third back.

async function encodeGraph(graph) {
  const json = JSON.stringify(graph);

  if (typeof CompressionStream !== "function") {
    return { text: json, encoding: "json" };
  }
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = "";
    // Chunked rather than String.fromCharCode(...buf): spreading a few hundred
    // KB into an argument list blows the call-stack limit on some runtimes,
    // and it does it at exactly the sizes this feature is for.
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return { text: btoa(binary), encoding: "gzip+base64" };
  } catch {
    // Compression is an optimisation. Losing it costs space, not correctness.
    return { text: json, encoding: "json" };
  }
}

async function decodeGraph(text, encoding) {
  if (encoding !== "gzip+base64") return JSON.parse(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Record one capture.
 *
 * Returns `{ snapshotId, prevSnapshotId, reduced }` on success and **null** on
 * any failure — including a missing DB binding, which is the normal state in
 * a unit test and must not throw there either.
 *
 * `graph` is the enriched drawable graph (see analyzers/architecture/enrich.js).
 * `findingCount` is stored rather than derived so the list view can show it
 * without decompressing every row.
 */
export async function recordSnapshot(env, ctx, {
  orgId, repoUrl = null, branch = null, commitSha = null,
  source, graph, findingCount = 0, capturedAt = null,
} = {}) {
  if (!env || !env.DB || !orgId || !graph) return null;
  if (SNAPSHOT_SOURCES.indexOf(source) === -1) {
    await captureException(env, ctx, new Error(`recordSnapshot: unknown source ${source}`), {
      tags: { source: "arch_snapshots", reason: "invalid_source" },
    });
    return null;
  }

  const at = typeof capturedAt === "number" ? capturedAt : Math.floor(Date.now() / 1000);

  try {
    let payload = graph;
    let reduced = 0;
    let encoded = await encodeGraph(payload);

    if (encoded.text.length > MAX_GRAPH_BYTES) {
      // Too big whole. Drop the citations and keep the structure — a graph
      // that draws without its evidence is worth more than no history at all,
      // and the flag makes the loss visible instead of silent.
      payload = reduceGraph(graph);
      reduced = 1;
      encoded = await encodeGraph(payload);

      if (encoded.text.length > MAX_GRAPH_BYTES) {
        // Still too big. Refuse rather than truncate: half a graph is not a
        // smaller graph, it is a WRONG one, and a drift diff against it would
        // report every dropped node as deleted.
        await captureException(env, ctx,
          new Error("recordSnapshot: graph exceeds the row ceiling even reduced"), {
            tags: { source: "arch_snapshots", reason: "too_large" },
            extra: { bytes: encoded.text.length, nodes: (graph.nodes || []).length },
          });
        return null;
      }
    }

    // The previous capture of the same target. NULL-safe comparison, because
    // a manual upload has repo_url NULL and `= NULL` never matches — without
    // IS, every manual snapshot would look like the first one forever.
    const prev = await env.DB.prepare(
      `SELECT snapshot_id FROM arch_snapshots
        WHERE org_id = ?
          AND repo_url IS ?
          AND branch   IS ?
        ORDER BY captured_at DESC, snapshot_id DESC
        LIMIT 1`,
    ).bind(orgId, repoUrl, branch).first();

    const snapshotId = newSnapshotId();
    await env.DB.prepare(
      `INSERT INTO arch_snapshots
         (snapshot_id, org_id, repo_url, branch, commit_sha, source, captured_at,
          graph_json, encoding, reduced, node_count, edge_count, finding_count,
          prev_snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      snapshotId, orgId, repoUrl, branch, commitSha, source, at,
      encoded.text, encoded.encoding, reduced,
      (graph.nodes || []).length, (graph.edges || []).length, findingCount,
      prev ? prev.snapshot_id : null,
    ).run();

    return { snapshotId, prevSnapshotId: prev ? prev.snapshot_id : null, reduced: !!reduced };
  } catch (err) {
    await captureException(env, ctx, err, {
      tags: { source: "arch_snapshots", reason: "write_failed" },
      extra: { orgId, source },
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Row → the summary shape the list view renders. Never carries the graph. */
function rowToSummary(row) {
  return {
    snapshotId:     row.snapshot_id,
    repoUrl:        row.repo_url || null,
    branch:         row.branch || null,
    commitSha:      row.commit_sha || null,
    source:         row.source,
    capturedAt:     row.captured_at,
    nodeCount:      row.node_count,
    edgeCount:      row.edge_count,
    findingCount:   row.finding_count,
    // Surfaced, not hidden. A reduced snapshot cannot answer "which line said
    // so", and a reader that does not know that will believe it can.
    reduced:        row.reduced === 1,
    prevSnapshotId: row.prev_snapshot_id || null,
  };
}

export async function listSnapshots(env, orgId, { repoUrl = undefined, branch = undefined, limit = 50 } = {}) {
  if (!env || !env.DB || !orgId) return [];
  const where = ["org_id = ?"];
  const binds = [orgId];
  if (repoUrl !== undefined) { where.push("repo_url IS ?"); binds.push(repoUrl); }
  if (branch  !== undefined) { where.push("branch   IS ?"); binds.push(branch); }

  const { results } = await env.DB.prepare(
    `SELECT snapshot_id, org_id, repo_url, branch, commit_sha, source, captured_at,
            reduced, node_count, edge_count, finding_count, prev_snapshot_id
       FROM arch_snapshots
      WHERE ${where.join(" AND ")}
      ORDER BY captured_at DESC, snapshot_id DESC
      LIMIT ?`,
  ).bind(...binds, Math.min(Math.max(1, limit), 200)).all();

  return (results || []).map(rowToSummary);
}

/**
 * One snapshot, graph included.
 *
 * Scoped by org: a snapshot id is not a capability, and reading someone else's
 * architecture would be the whole product's worst possible bug.
 */
export async function getSnapshot(env, orgId, snapshotId) {
  if (!env || !env.DB || !orgId || !snapshotId) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM arch_snapshots WHERE snapshot_id = ? AND org_id = ?",
  ).bind(snapshotId, orgId).first();
  if (!row) return null;

  let graph = null;
  try {
    graph = await decodeGraph(row.graph_json, row.encoding);
  } catch {
    // A row we cannot decode is a row we must not pretend to have read. The
    // summary is still true and still useful; the graph reports as absent.
    return { ...rowToSummary(row), graph: null, unreadable: true };
  }
  return { ...rowToSummary(row), graph, unreadable: false };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * What changed between two graphs.
 *
 * Structural only — nodes and edges added or removed. Findings-level drift
 * already exists in monitors/analyzers.js (diffArchFindings) and answers a
 * different question: "what new problems appeared". This answers "what changed
 * shape", which is the one a reviewer asks about a pull request.
 *
 * The null-vs-empty rule applies exactly as it does everywhere else in this
 * codebase: `null` for either side means the comparison could not be made, and
 * the caller must render that differently from a diff that ran and found
 * nothing. An empty change list is a real result; a missing baseline is not.
 */
export function diffGraphs(before, after) {
  if (!before || !after) {
    return {
      comparable: false,
      reason: !before && !after ? "both_missing" : (!before ? "no_baseline" : "no_current"),
      nodesAdded: [], nodesRemoved: [], edgesAdded: [], edgesRemoved: [],
    };
  }

  const beforeNodes = new Map((before.nodes || []).map((n) => [n.id, n]));
  const afterNodes  = new Map((after.nodes  || []).map((n) => [n.id, n]));
  const beforeEdges = new Map((before.edges || []).map((e) => [e.id || fallbackEdgeId(e), e]));
  const afterEdges  = new Map((after.edges  || []).map((e) => [e.id || fallbackEdgeId(e), e]));

  const nodesAdded   = [...afterNodes.keys()].filter((k) => !beforeNodes.has(k)).map((k) => afterNodes.get(k));
  const nodesRemoved = [...beforeNodes.keys()].filter((k) => !afterNodes.has(k)).map((k) => beforeNodes.get(k));
  const edgesAdded   = [...afterEdges.keys()].filter((k) => !beforeEdges.has(k)).map((k) => afterEdges.get(k));
  const edgesRemoved = [...beforeEdges.keys()].filter((k) => !afterEdges.has(k)).map((k) => beforeEdges.get(k));

  return {
    comparable: true,
    reason: null,
    nodesAdded, nodesRemoved, edgesAdded, edgesRemoved,
    changed: nodesAdded.length + nodesRemoved.length + edgesAdded.length + edgesRemoved.length,
  };
}

/** Snapshots written before edges carried ids still diff correctly. */
function fallbackEdgeId(e) {
  return `${e.from}->${e.to}:${e.kind}${e.via ? "|" + e.via : ""}`;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Drop snapshots past the retention window.
 *
 * 90 days, matching the run history — the privacy policy commits to one
 * retention story and two different ones would make it false.
 *
 * Deliberately does NOT repair prev_snapshot_id on the survivors. A survivor
 * pointing at a deleted snapshot renders as "the comparison point is no longer
 * available", which is exactly what happened; re-pointing it at whatever is
 * left would silently compare against a much older graph and report months of
 * accumulated change as if it were last night's.
 */
export async function pruneSnapshots(env, ctx, { now = null, days = RETENTION_DAYS } = {}) {
  if (!env || !env.DB) return 0;
  const cutoff = (typeof now === "number" ? now : Math.floor(Date.now() / 1000)) - days * 86400;
  try {
    const res = await env.DB.prepare("DELETE FROM arch_snapshots WHERE captured_at < ?")
      .bind(cutoff).run();
    return (res.meta && res.meta.changes) || 0;
  } catch (err) {
    await captureException(env, ctx, err, {
      tags: { source: "arch_snapshots", reason: "prune_failed" },
    });
    return 0;
  }
}
