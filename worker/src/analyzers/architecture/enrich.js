// The Phase-1 graph superset.
//
// buildGraph() emits what the rules engine and the renderer have always
// needed: nodes with a kind, a name and evidence; edges with a kind and
// evidence. Phases 3 and 4 need more — a place to record whether a node is a
// single point of failure, what a node's blast radius is, whether an edge
// carries classified data across a trust boundary, and whether an edge was
// merely DECLARED or actually OBSERVED.
//
// This module adds those fields. It does not compute them.
//
// That distinction is the whole design. Every field this file adds is `null`,
// and null here means NOT MEASURED — never "fine", never "none", never
// "public". The detectors that fill them in land in Phase 3; the runtime
// signals that fill in `origin` land in Phase 2. Until then a consumer asking
// "is this a SPOF?" gets null and must render "not analysed", which is the
// honest answer and the one that stops a half-built feature from quietly
// certifying an architecture nobody has checked.
//
// It runs as a separate pass rather than as edits inside graph.js so that
// buildGraph, the 16 rules that read its output, and every test written
// against them are untouched. Adding keys to an object cannot break a reader
// that ignores them; rewriting the producer can.

/**
 * A stable identity for an edge.
 *
 * buildGraph does not give edges ids — nothing needed one, because the rules
 * engine iterates rather than looks up. Drift does need one: "this edge is
 * new since last week" is a statement about identity across two captures.
 *
 * from→to→kind is the identity, and `via` joins it when present, because a
 * Worker bound to the same D1 database through two different bindings is two
 * facts about the architecture, not one recorded twice.
 */
export function edgeId(edge) {
  const via = edge && edge.via ? `|${edge.via}` : "";
  return `${edge.from}->${edge.to}:${edge.kind}${via}`;
}

/**
 * How an edge moves data, derived from what the parser already recorded.
 *
 * Only stated where the binding type settles it. A Cloudflare D1 binding IS
 * the d1 protocol; an `http` edge discovered from a fetch() call is https only
 * if the URL said so, and this does not go and check — an unconfirmed protocol
 * stays null rather than becoming a guess that a trust-boundary rule would
 * later treat as fact.
 */
const PROTOCOL_BY_VIA = Object.freeze({
  d1_databases:      "d1",
  kv_namespaces:     "kv",
  r2_buckets:        "r2",
  queues:            "queue",
  "queues.producers": "queue",
  "queues.consumers": "queue",
  services:          "service",
  durable_objects:   "do",
  ai:                "ai",
  vectorize:         "vectorize",
});

/**
 * Async edges are the ones where the producer does not wait for the consumer.
 * Queue publish/subscribe is the clear case and the only one the current
 * parsers can establish; a cron edge fires without a caller at all.
 */
function inferAsync(edge) {
  const via = edge && edge.via;
  if (via && via.indexOf("queues") === 0) return true;
  if (edge && edge.kind === "schedule") return true;
  if (edge && edge.kind === "publishes") return true;
  if (edge && edge.kind === "subscribes") return true;
  return null;   // not established — NOT "synchronous"
}

function inferProtocol(edge) {
  if (!edge) return null;
  if (edge.via && PROTOCOL_BY_VIA[edge.via]) return PROTOCOL_BY_VIA[edge.via];
  if (edge.kind === "http" || edge.kind === "calls") {
    // The parser records an http edge for a fetch() to an external host. It
    // does not record the scheme, and https-vs-http is exactly the fact a
    // trust-boundary rule will hang an encryption finding on — so it stays
    // unknown until Phase 3 reads the URL rather than being assumed here.
    return null;
  }
  return null;
}

/** Present iff the value is a real one; keeps `{}` out of every node. */
function nonEmpty(obj) {
  for (const k of Object.keys(obj)) if (obj[k] !== null && obj[k] !== undefined) return obj;
  return obj;   // returned regardless — callers want the null-filled shape
}

/**
 * The metadata block every node carries.
 *
 * All six are null today and that is deliberate rather than unfinished:
 *
 *   owner        needs CODEOWNERS parsing, which no phase has asked for yet
 *   region       Cloudflare Workers run at the edge; "region" is meaningless
 *                for them, and inventing "global" would put a value in a
 *                field a compose-based architecture uses differently
 *   replicas     compose `deploy.replicas` is parseable and is filled below
 *                where the parser saw one; everything else genuinely has no
 *                declared replica count
 *   criticality  an author's judgement, never inferrable. Phase 3 reads it
 *                from a committed file if the user writes one.
 *   lastDeployAt needs CI metadata — Phase 2
 *   health       needs a runtime signal — Phase 2
 */
function nodeMeta(node) {
  return nonEmpty({
    owner:        null,
    region:       null,
    replicas:     typeof node.replicas === "number" ? node.replicas : null,
    criticality:  null,
    lastDeployAt: null,
    health:       null,
  });
}

/**
 * The analysis block. Written by Phase 3's detectors, null until then.
 *
 * Carried now, empty, so that the storage format does not change when the
 * detectors land — a snapshot taken today stays readable by tomorrow's
 * renderer, and `spof: null` renders as "not analysed" rather than as a
 * missing key the reader has to special-case.
 */
function nodeAnalysis() {
  return { spof: null, blastRadius: null, trustZone: null };
}

function edgeMeta(edge) {
  return {
    protocol:            inferProtocol(edge),
    async:               inferAsync(edge),
    // The four security fields. Every one of them null, and the trust-boundary
    // view in Phase 4 is built on the premise that null crossing a boundary is
    // a FINDING — unclassified data leaving a trust zone is exactly the thing
    // nobody checked. Defaulting any of these to a benign value would convert
    // that finding into a pass.
    dataClass:           null,
    encryptedInTransit:  null,
    authenticated:       null,
    retry:               null,
    // Runtime observations — Phase 2, and only ever from a source the customer
    // pushed us. See ARCHITECTURE-XRAY-PHASE-0.md §7.2.
    observedLatencyMs:   null,
    observedErrorRate:   null,
  };
}

/**
 * Add the Phase-1 fields to a drawable graph.
 *
 * Pure and non-mutating: returns a new graph, leaves the input alone. The
 * caller passes the object analyzeArchitecture already built, so this can be
 * dropped into that pipeline without the rules engine ever seeing it.
 *
 * `confidence` is 'confirmed' when the parser cited a file for the fact and
 * 'unconfirmed' otherwise. Today buildGraph cites everything it emits, so in
 * practice every node and edge is confirmed — the field exists because Phase 2
 * introduces edges that were observed at runtime but never declared, and those
 * genuinely are unconfirmed until someone reconciles them.
 */
export function enrichGraph(graph) {
  if (!graph || typeof graph !== "object") return graph;

  const nodes = (graph.nodes || []).map((n) => ({
    ...n,
    confidence: hasEvidence(n) ? "confirmed" : "unconfirmed",
    meta: nodeMeta(n),
    analysis: nodeAnalysis(),
  }));

  const edges = (graph.edges || []).map((e) => ({
    ...e,
    id: edgeId(e),
    confidence: hasEvidence(e) ? "confirmed" : "unconfirmed",
    // static  = declared in config or source, never observed running
    // runtime = observed running, never declared  ← a shadow dependency
    // both    = declared and observed             ← agreed
    //
    // Everything the static parsers produce is 'static' by construction. It
    // must NOT default to 'both': that would assert an observation nobody
    // made, and reconciliation would then report perfect agreement between a
    // graph and a runtime it never looked at.
    origin: "static",
    meta: edgeMeta(e),
  }));

  return { ...graph, nodes, edges };
}

function hasEvidence(x) {
  if (!x || !x.evidence) return false;
  if (Array.isArray(x.evidence)) return x.evidence.length > 0;
  return typeof x.evidence === "object" && !!x.evidence.file;
}

/**
 * Strip a graph down to what still draws when the whole thing will not fit in
 * a snapshot row.
 *
 * Drops the two heaviest fields — per-node `files` lists and every `evidence`
 * citation — and keeps structure. A reduced snapshot renders identically and
 * cannot answer "which line said so", which is why the row that holds one is
 * flagged and every reader surfaces it.
 */
export function reduceGraph(graph) {
  return {
    ...graph,
    nodes: (graph.nodes || []).map((n) => {
      const { evidence, files, ...rest } = n;      // eslint-disable-line no-unused-vars
      return rest;
    }),
    edges: (graph.edges || []).map((e) => {
      const { evidence, ...rest } = e;             // eslint-disable-line no-unused-vars
      return rest;
    }),
    clusters: (graph.clusters || []).map((c) => {
      const { evidence, ...rest } = c;             // eslint-disable-line no-unused-vars
      return rest;
    }),
  };
}
