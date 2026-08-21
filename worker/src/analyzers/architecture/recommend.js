// Per-cluster recommendations.
//
// The governing constraint here is restraint. A list of twenty plausible
// suggestions is worth less than three the reader trusts, because once one
// recommendation is obviously boilerplate the reader stops believing the
// others — and they have no way to tell which is which. So every
// recommendation is derived from findings that already carry evidence, and
// the "extract a microservice" rule stays silent unless all three of its
// legs can be shown.

const EFFORT_RANK = { S: 0, M: 1, L: 2 };
const IMPACT_RANK = { high: 0, medium: 1, low: 2 };

// What each rule implies, as a change rather than a complaint. Rules absent
// from this map produce no recommendation — the finding says enough on its
// own, and inventing an action for it would be padding.
const FROM_RULE = {
  datastore_publicly_published: {
    change: "Close the published database port and reach it over the internal network only",
    effort: "S", impact: "high", lens: "security",
  },
  committed_secret: {
    change: "Rotate the committed credential and move it to a runtime secret store",
    effort: "S", impact: "high", lens: "security",
  },
  datastore_shared_across_services: {
    change: "Give the shared datastore one owning service and route other reads through it",
    effort: "L", impact: "medium", lens: "security",
  },
  cross_cluster_bypasses_gateway: {
    change: "Route cross-boundary calls through the gateway so its controls actually apply",
    effort: "M", impact: "medium", lens: "security",
  },
  unpinned_base_image: {
    change: "Pin base images to a digest so the build is reproducible",
    effort: "S", impact: "medium", lens: "security",
  },
  sync_chain_depth: {
    change: "Break the synchronous call chain — answer the caller before the tail of the chain runs",
    effort: "M", impact: "high", lens: "speed",
  },
  chatty_edge: {
    change: "Batch the repeated calls between these two services into one request",
    effort: "M", impact: "medium", lens: "speed",
  },
  cron_fanout_should_queue: {
    change: "Move the scheduled fan-out onto a queue so one slow item cannot starve the rest",
    effort: "M", impact: "high", lens: "speed",
  },
  static_without_cache: {
    change: "Put a CDN or cache in front of the static assets",
    effort: "S", impact: "medium", lens: "speed",
  },
  always_on_single_purpose: {
    change: "Consider moving this always-on container to a request-scoped Worker or function",
    effort: "M", impact: "low", lens: "cost",
  },
  duplicate_datastores: {
    change: "Confirm the duplicate datastores hold different data, and consolidate if not",
    effort: "M", impact: "low", lens: "cost",
  },
  unbounded_log_retention: {
    change: "Bound log size and retention",
    effort: "S", impact: "low", lens: "cost",
  },
  shared_external_dependency: {
    change: "Put one shared client in front of the third-party API",
    effort: "M", impact: "low", lens: "cost",
  },
};

const DATASTORE_KINDS = new Set(["database", "kv", "bucket", "durable_object"]);

/**
 * The three legs an "extract a microservice" recommendation has to stand on.
 * Each returns evidence or null; the recommendation is only emitted when all
 * three return evidence, and it prints what each one was.
 *
 *   fan-in       reached from more than one deployable unit — otherwise the
 *                thing it would be extracted from is its only caller, and a
 *                network hop buys nothing.
 *   own data     it owns a datastore nobody else touches — a service that
 *                shares its neighbour's tables is not separable, it is a
 *                second front end on the same database.
 *   scaling      an explicit, distinct scaling signal — a replica count, a
 *                queue consumer, or a schedule. Without one there is no
 *                evidence it needs to scale differently from its host, which
 *                is the entire operational argument for splitting it out.
 */
function fanInLeg(graph, node) {
  const callers = new Set(
    graph.edges
      .filter((e) => e.to === node.id && e.kind !== "cron")
      .map((e) => {
        const from = graph.nodes.find((n) => n.id === e.from);
        return (from && from.cluster) || e.from;
      }),
  );
  callers.delete(node.cluster);
  if (callers.size < 2) return null;
  const edge = graph.edges.find((e) => e.to === node.id && e.kind !== "cron");
  return {
    leg: "fan-in",
    detail: `reached from ${callers.size} deployable units`,
    evidence: edge ? edge.evidence : null,
  };
}

function ownDataLeg(graph, node) {
  const owned = graph.edges
    .filter((e) => e.from === node.id)
    .map((e) => graph.nodes.find((n) => n.id === e.to))
    .filter((n) => n && DATASTORE_KINDS.has(n.kind));

  const exclusive = owned.filter((store) => {
    const others = new Set(
      graph.edges
        .filter((e) => e.to === store.id && e.from !== node.id)
        .map((e) => e.from),
    );
    return others.size === 0;
  });
  if (!exclusive.length) return null;

  const edge = graph.edges.find((e) => e.from === node.id && e.to === exclusive[0].id);
  return {
    leg: "own datastore",
    detail: `owns ${exclusive[0].name}, which nothing else reaches`,
    evidence: edge ? edge.evidence : exclusive[0].evidence,
  };
}

function scalingLeg(graph, node) {
  if (node.scaleEvidence) {
    return { leg: "distinct scaling profile", detail: "declares its own replica count", evidence: node.scaleEvidence };
  }
  const queueEdge = graph.edges.find((e) => e.kind === "queue" && (e.to === node.id || e.from === node.id));
  if (queueEdge) {
    return {
      leg: "distinct scaling profile",
      detail: "consumes or produces a queue, so it scales on backlog rather than on request rate",
      evidence: queueEdge.evidence,
    };
  }
  const cronEdge = graph.edges.find((e) => e.kind === "cron" && e.to === node.id);
  if (cronEdge) {
    return {
      leg: "distinct scaling profile",
      detail: "runs on a schedule, so its load is bursty and unrelated to request traffic",
      evidence: cronEdge.evidence,
    };
  }
  return null;
}

function microserviceCandidates(graph) {
  const out = [];
  for (const node of graph.nodes) {
    if (node.kind !== "service" && node.kind !== "worker") continue;
    const legs = [fanInLeg(graph, node), ownDataLeg(graph, node), scalingLeg(graph, node)];
    if (legs.some((l) => !l || !l.evidence)) continue;   // silence unless all three hold
    out.push({
      cluster: node.cluster || node.id,
      // Which node this is about, so the dashboard can scope the card to a
      // pinned node instead of only to a cluster.
      target: node.id,
      change: `Extract ${node.name} into its own service`,
      effort: "L",
      impact: "medium",
      lens: "speed",
      rationale: "All three conditions for a split hold here, each with evidence:",
      legs,
      evidence: legs[0].evidence,
    });
  }
  return out;
}

/**
 * Build the recommendation list, grouped by cluster and ordered so the
 * cheapest high-impact change is first — that is the one someone actually
 * does today.
 */
export function recommend(graph, findings) {
  const byCluster = new Map();

  const clusterFor = (target) => {
    const node = graph.nodes.find((n) => n.id === target);
    if (node) return node.cluster || node.id;
    const cluster = graph.clusters.find((c) => c.id === target);
    if (cluster) return cluster.id;
    return target;   // a file path (committed secrets) groups under itself
  };

  const push = (clusterId, rec) => {
    if (!byCluster.has(clusterId)) byCluster.set(clusterId, new Map());
    const existing = byCluster.get(clusterId);
    // One recommendation per distinct change per cluster: three unpinned
    // images in one service is one "pin your images", not three.
    if (!existing.has(rec.change)) existing.set(rec.change, rec);
    else {
      const prev = existing.get(rec.change);
      prev.occurrences = (prev.occurrences || 1) + 1;
    }
  };

  for (const finding of findings) {
    const template = FROM_RULE[finding.rule];
    if (!template) continue;
    push(clusterFor(finding.target), {
      ...template,
      evidence: finding.evidence,
      fromRule: finding.rule,
      severity: finding.severity,
      // The node (or cluster, or file) the originating finding pointed at.
      // Lets the dashboard show "recommendations for this selection" when a
      // node is pinned, rather than always widening to the whole cluster.
      // On a deduplicated card it names the FIRST occurrence, which is fine:
      // the card is one change, and one place it applies is enough to scope by.
      target: finding.target,
    });
  }

  for (const candidate of microserviceCandidates(graph)) {
    push(candidate.cluster, candidate);
  }

  const out = [];
  for (const [clusterId, recs] of byCluster) {
    const cluster = graph.clusters.find((c) => c.id === clusterId);
    out.push({
      cluster: clusterId,
      clusterName: cluster ? cluster.name : clusterId,
      recommendations: [...recs.values()].sort((a, b) =>
        (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9) ||
        (EFFORT_RANK[a.effort] ?? 9) - (EFFORT_RANK[b.effort] ?? 9) ||
        a.change.localeCompare(b.change),
      ),
    });
  }

  // Clusters with the most valuable first change come first.
  out.sort((a, b) => {
    const rank = (g) => {
      const top = g.recommendations[0];
      return top ? (IMPACT_RANK[top.impact] ?? 9) * 10 + (EFFORT_RANK[top.effort] ?? 9) : 99;
    };
    return rank(a) - rank(b);
  });

  return out;
}
