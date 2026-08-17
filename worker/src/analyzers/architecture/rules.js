// Scoring rules — three lenses over the graph.
//
// Every rule emits `{ target, lens, severity, why, fix, evidence }` and any
// finding without evidence is dropped before it leaves this module. That is
// enforced in `scoreGraph`, not left to each rule's discipline, because a
// finding you cannot point at a line for is indistinguishable from a guess
// and the whole product rests on the difference.
//
// Two rules are narrower than their names suggest, and say so in `why`
// rather than quietly overreaching:
//
//   - "always-on container serving trivial load" — static analysis cannot see
//     load. What is actually detectable is SHAPE: a long-running container
//     with a single inbound dependency and no published port. The finding
//     says that, and says what the reader has to check themselves.
//   - "public-facing node with no auth middleware" — proving a route is
//     unauthenticated needs to follow every path into it. What is detectable
//     is the absence of any authentication marker in a cluster whose source
//     we actually read. It fires at low severity, only for clusters we
//     opened, and the wording is about what we did not find, not about what
//     is not there.
//
// Rules from the brief that are NOT implemented, because nothing in a
// repository establishes them, are listed in `UNIMPLEMENTED_RULES` and
// surfaced on the response so the gap is visible instead of assumed covered.

export const LENSES = ["speed", "cost", "security"];

export const UNIMPLEMENTED_RULES = Object.freeze([
  {
    lens: "cost",
    rule: "egress_volume",
    why: "Egress cost depends on bytes transferred, which no file in a repository records. " +
         "The nearest detectable proxy — one external API called from several clusters — is " +
         "reported as `shared_external_dependency` instead, and is about coupling, not bytes.",
  },
  {
    lens: "speed",
    rule: "chatty_edge_by_volume",
    why: "Call volume is a runtime property. What is counted here is distinct call SITES " +
         "between one pair of services, which is a code-shape signal, not traffic.",
  },
]);

const sev = { critical: 4, high: 3, medium: 2, low: 1 };

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const DATASTORE_KINDS = new Set(["database", "kv", "bucket", "durable_object"]);

function outgoing(graph, id, kind) {
  return graph.edges.filter((e) => e.from === id && (!kind || e.kind === kind));
}
function incoming(graph, id, kind) {
  return graph.edges.filter((e) => e.to === id && (!kind || e.kind === kind));
}
const nodeById = (graph, id) => graph.nodes.find((n) => n.id === id) || null;

/**
 * Longest simple path following HTTP edges, starting anywhere.
 *
 * Depth is counted in HOPS (edges), so A→B→C→D is depth 3. Cycles are cut by
 * the visited set rather than followed — a cycle is a different problem and
 * reporting it as an infinitely deep chain would be wrong.
 */
function longestHttpPath(graph) {
  const httpEdges = graph.edges.filter((e) => e.kind === "http");
  const adjacency = new Map();
  for (const e of httpEdges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from).push(e);
  }

  let best = { path: [], edges: [] };
  const walk = (nodeId, visited, path, edges) => {
    if (edges.length > best.edges.length) best = { path: [...path], edges: [...edges] };
    for (const edge of adjacency.get(nodeId) || []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      path.push(edge.to);
      edges.push(edge);
      walk(edge.to, visited, path, edges);
      edges.pop();
      path.pop();
      visited.delete(edge.to);
    }
  };

  for (const start of adjacency.keys()) {
    walk(start, new Set([start]), [start], []);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

function speedRules(graph, findings) {
  // Synchronous call chains ≥3 services deep.
  const longest = longestHttpPath(graph);
  if (longest.edges.length >= 3) {
    const names = longest.path.map((id) => (nodeById(graph, id) || { name: id }).name);
    findings.push({
      target: longest.path[0],
      lens: "speed",
      rule: "sync_chain_depth",
      severity: longest.edges.length >= 4 ? "high" : "medium",
      why: `A request entering here traverses ${longest.edges.length} synchronous hops before it is answered: ` +
           `${names.join(" → ")}. Every hop adds its own latency and its own failure mode, and the ` +
           `slowest link sets the floor for the whole chain.`,
      fix: "Collapse the middle hops, or make the tail of the chain asynchronous — publish an event and " +
           "answer the caller immediately, rather than waiting for the last service in line.",
      evidence: longest.edges[0].evidence,
      relatedEvidence: longest.edges.map((e) => e.evidence),
    });
  }

  // Chatty pairs: many distinct call sites between the same two services.
  const pairs = new Map();
  for (const e of graph.edges) {
    if (e.kind !== "http") continue;
    const key = `${e.from}|${e.to}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(e);
  }
  for (const [key, edges] of pairs) {
    if (edges.length < 4) continue;
    const [from, to] = key.split("|");
    findings.push({
      target: from,
      lens: "speed",
      rule: "chatty_edge",
      severity: "medium",
      why: `${edges.length} separate call sites go from ${(nodeById(graph, from) || {}).name} to ` +
           `${(nodeById(graph, to) || {}).name}. Many small round trips between one pair of services usually ` +
           `means one coarse call is being simulated by several fine-grained ones — each paying full network cost.`,
      fix: "Batch the reads into one request, or move the data the caller keeps asking for to where it is needed.",
      evidence: edges[0].evidence,
      relatedEvidence: edges.slice(0, 6).map((e) => e.evidence),
    });
  }

  // Static assets served with no cache or CDN in front.
  const hasGateway = graph.nodes.some((n) => n.isGateway);
  for (const node of graph.nodes) {
    if (!node.servesStatic || !node.publiclyReachable) continue;
    if (node.kind === "static_site") continue;   // already on a CDN by construction
    if (hasGateway) continue;
    if (!node.publicEvidence) continue;
    findings.push({
      target: node.id,
      lens: "speed",
      rule: "static_without_cache",
      severity: "low",
      why: `${node.name} serves static assets straight to the internet with no cache or CDN node anywhere in ` +
           `this graph. Every asset request travels to the origin and is paid for twice — in latency and in egress.`,
      fix: "Put a CDN or reverse-proxy cache in front of it. Static assets are the cheapest thing to cache and " +
           "the most expensive thing to keep re-serving.",
      evidence: node.publicEvidence,
    });
  }

  // Cron work that should be a queue.
  const queueNodes = graph.nodes.filter((n) => n.kind === "queue");
  for (const edge of graph.edges) {
    if (edge.kind !== "cron") continue;
    const target = nodeById(graph, edge.to);
    if (!target) continue;
    const fanOut = outgoing(graph, target.id).filter((e) => e.kind !== "cron");
    if (fanOut.length < 3 || queueNodes.length > 0) continue;
    findings.push({
      target: target.id,
      lens: "speed",
      rule: "cron_fanout_should_queue",
      severity: "medium",
      why: `A scheduled trigger runs ${target.name}, which then fans out to ${fanOut.length} other components ` +
           `inside that one invocation, and there is no queue in this architecture. Everything the cron touches ` +
           `shares a single time and CPU budget, so the slowest item delays or starves the rest, and a failure ` +
           `part-way through loses the remainder of the run with no retry.`,
      fix: "Have the scheduled handler enqueue one message per unit of work and let a consumer process them " +
           "independently. Slow items then delay only themselves, and failures retry individually.",
      evidence: edge.evidence,
    });
  }
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

function costRules(graph, findings) {
  // Long-running containers with a single-purpose shape.
  for (const node of graph.nodes) {
    if (node.kind !== "service" || node.isGateway) continue;
    if (!node.image) continue;                 // only containers, not Workers
    const edges = [...outgoing(graph, node.id), ...incoming(graph, node.id)];
    if (edges.length > 1 || node.publiclyReachable) continue;
    if (!node.evidence) continue;
    findings.push({
      target: node.id,
      lens: "cost",
      rule: "always_on_single_purpose",
      severity: "low",
      why: `${node.name} is a container that runs continuously but has only ${edges.length} connection(s) in this ` +
           `architecture and publishes no port. That shape — always paid for, rarely reached — is what a ` +
           `request-scoped Worker or function bills far better. Note that static analysis cannot see traffic: ` +
           `this is about the container's SHAPE, and you should confirm its actual utilisation before moving it.`,
      fix: "If its utilisation is as low as its shape suggests, move it to a Worker or serverless function so it " +
           "costs nothing while idle.",
      evidence: node.evidence,
    });
  }

  // Two RELATIONAL databases attached to one deployable unit, in the same
  // environment.
  //
  // Scoped tightly on purpose. Key-value stores are excluded: two KV
  // namespaces on one Worker (sessions and counters, say) is ordinary design,
  // not duplication, and flagging it trains the reader to skip this lens.
  // Environments are compared separately because a production and a staging
  // database are two databases by intent, and calling that a duplicate would
  // be flatly wrong.
  const byCluster = new Map();
  for (const node of graph.nodes) {
    if (node.kind !== "database" || !node.cluster) continue;
    const key = `${node.cluster}|${node.env || "default"}`;
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(node);
  }
  for (const [key, nodes] of byCluster) {
    if (nodes.length < 2) continue;
    const clusterId = key.split("|")[0];
    findings.push({
      target: clusterId,
      lens: "cost",
      rule: "duplicate_datastores",
      severity: "low",
      why: `${nodes.length} separate databases are attached to one deployable unit in the same environment ` +
           `(${nodes.map((n) => n.name).join(", ")}). Sometimes that is a deliberate split; often it is one ` +
           `dataset that ended up in two places, paying twice and drifting apart.`,
      fix: "Confirm each store holds a genuinely different dataset. If two hold the same one, consolidate before " +
           "they disagree.",
      evidence: nodes[0].evidence,
      relatedEvidence: nodes.map((n) => n.evidence).filter(Boolean),
    });
  }

  // Logging configured with no size bound.
  for (const node of graph.nodes) {
    if (!node.logging || !node.logging.configured || node.logging.bounded) continue;
    if (!node.evidence) continue;
    findings.push({
      target: node.id,
      lens: "cost",
      rule: "unbounded_log_retention",
      severity: "low",
      why: `${node.name} configures logging without a size or retention limit. Container logs with no cap grow ` +
           `until the disk does something about it, and the bill arrives before the incident does.`,
      fix: "Set a max size and rotation count on the logging driver, or ship logs somewhere with a retention policy.",
      evidence: node.evidence,
    });
  }

  // One third party depended on from several clusters.
  for (const node of graph.nodes) {
    if (node.kind !== "external_api") continue;
    const callers = new Set(incoming(graph, node.id).map((e) => e.from));
    if (callers.size < 2) continue;
    const first = incoming(graph, node.id)[0];
    findings.push({
      target: node.id,
      lens: "cost",
      rule: "shared_external_dependency",
      severity: "low",
      why: `${callers.size} deployable units call ${node.name} directly. Each one pays its own egress and holds ` +
           `its own credentials, retry policy and failure behaviour for the same third party — so an outage or a ` +
           `price change lands in several places at once, and they will not respond to it the same way.`,
      fix: "Put one client in front of it that the others use, so caching, retries and the blast radius of an " +
           "outage are decided once.",
      evidence: first.evidence,
    });
  }
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function securityRules(graph, findings) {
  // A datastore published beyond its host.
  for (const node of graph.nodes) {
    if (!DATASTORE_KINDS.has(node.kind)) continue;
    if (!node.publiclyReachable || !node.publicEvidence) continue;
    findings.push({
      target: node.id,
      lens: "security",
      rule: "datastore_publicly_published",
      severity: "critical",
      why: `${node.name} is a datastore whose port is published outside the container network` +
           `${node.publishedPorts ? ` (${node.publishedPorts.join(", ")})` : ""}. Anything that can route to this ` +
           `host can attempt to connect to the database directly, with only its own credentials in the way — no ` +
           `application, no authorisation, no audit trail.`,
      fix: "Remove the port mapping and reach it over the internal network only. If a human needs access, bind it " +
           "to 127.0.0.1 and tunnel, so it is never listening on a routable interface.",
      evidence: node.publicEvidence,
    });
  }

  // A datastore reachable from more than one service.
  for (const node of graph.nodes) {
    if (!DATASTORE_KINDS.has(node.kind)) continue;
    const clusters = node.inboundClusters || [];
    if (clusters.length < 2) continue;
    const first = incoming(graph, node.id)[0];
    if (!first) continue;
    findings.push({
      target: node.id,
      lens: "security",
      rule: "datastore_shared_across_services",
      severity: "medium",
      why: `${node.name} is reached directly by ${clusters.length} deployable units. Shared database access means ` +
           `every one of them can read and write every table, so the blast radius of a compromise in the least ` +
           `careful service is the whole dataset — and no schema change is safe to make in one place.`,
      fix: "Give the data one owner and let the others go through it. If they genuinely need shared reads, expose " +
           "a read-only path rather than the raw store.",
      evidence: first.evidence,
      relatedEvidence: incoming(graph, node.id).map((e) => e.evidence).slice(0, 6),
    });
  }

  // Secrets committed in env files or manifests.
  for (const hit of graph.secrets || []) {
    findings.push({
      target: hit.file,
      lens: "security",
      rule: "committed_secret",
      severity: "critical",
      why: `\`${hit.key}\` is assigned a literal value in a file that lives in the repository. Anyone with read ` +
           `access has it, and so does every fork, clone and CI log — rotating the value is the only fix, because ` +
           `deleting the line leaves it in the history.`,
      fix: "Rotate the credential now, then move it to a secret store the deploy reads at runtime and keep only a " +
           "placeholder in the file.",
      evidence: `${hit.file}:${hit.line}`,
    });
  }

  // Unpinned base images.
  for (const df of graph.dockerfiles || []) {
    for (const img of df.images) {
      const unpinned = !img.image.includes("@sha256:") &&
                       (!img.image.includes(":") || /:latest$/.test(img.image));
      if (!unpinned) continue;
      findings.push({
        target: df.path,
        lens: "security",
        rule: "unpinned_base_image",
        severity: "medium",
        why: `\`FROM ${img.image}\` does not pin a version. The image this builds from can change under you between ` +
             `two builds of the same commit, which means a build that passed review is not the build that ships, ` +
             `and a compromised upstream tag arrives silently.`,
        fix: "Pin to a digest (`image@sha256:…`) — or at minimum an explicit version tag — and update it deliberately.",
        evidence: `${df.path}:${img.line}`,
      });
    }
  }
  for (const node of graph.nodes) {
    if (!node.image || !node.imageEvidence) continue;
    const unpinned = !node.image.includes("@sha256:") &&
                     (!node.image.includes(":") || /:latest$/.test(node.image));
    if (!unpinned) continue;
    findings.push({
      target: node.id,
      lens: "security",
      rule: "unpinned_base_image",
      severity: "medium",
      why: `${node.name} runs \`${node.image}\`, which is not pinned to a version. What runs in production can ` +
           `change without any change to this repository.`,
      fix: "Pin the image to a digest or an explicit version tag.",
      evidence: node.imageEvidence,
    });
  }

  // Cross-cluster traffic that goes around the gateway.
  const gateways = graph.nodes.filter((n) => n.isGateway);
  if (gateways.length) {
    const gatewayIds = new Set(gateways.map((g) => g.id));
    for (const edge of graph.edges) {
      if (edge.kind !== "http") continue;
      const from = nodeById(graph, edge.from);
      const to   = nodeById(graph, edge.to);
      if (!from || !to || to.kind === "external_api") continue;
      if (gatewayIds.has(from.id) || gatewayIds.has(to.id)) continue;
      if (!from.cluster || !to.cluster || from.cluster === to.cluster) continue;
      findings.push({
        target: to.id,
        lens: "security",
        rule: "cross_cluster_bypasses_gateway",
        severity: "medium",
        why: `${from.name} calls ${to.name} directly, across a deployment boundary, while this architecture has a ` +
             `gateway (${gateways[0].name}) that other traffic goes through. Whatever the gateway enforces — ` +
             `authentication, rate limiting, logging — is not enforced on this path.`,
        fix: "Route it through the gateway, or state explicitly why this path is exempt and what enforces those " +
             "controls instead.",
        evidence: edge.evidence,
      });
    }
  }

  // Publicly reachable clusters with no sign of authentication anywhere in
  // the source we actually read. Deliberately low severity — see the module
  // header for why this is worded as "we found none" and not "there is none".
  for (const node of graph.nodes) {
    if (!node.publiclyReachable || !node.publicEvidence) continue;
    if (DATASTORE_KINDS.has(node.kind)) continue;   // covered, far more sharply, above
    if (node.kind === "static_site") continue;      // public by intent
    const cluster = (graph.clusters || []).find((c) => c.id === node.cluster);
    if (!cluster || !cluster.sourceFilesRead) continue;   // never opened its code — say nothing
    if (cluster.authMarkers) continue;
    findings.push({
      target: node.id,
      lens: "security",
      rule: "public_without_auth_marker",
      severity: "low",
      why: `${node.name} is reachable from outside, and across the ${cluster.sourceFilesRead} source file(s) read ` +
           `for it nothing resembling an authentication or authorisation check appeared. This is an absence of ` +
           `evidence, not proof of absence — auth may live in a proxy, a framework default, or a file not ` +
           `submitted — so treat it as a prompt to confirm, not as a confirmed hole.`,
      fix: "Confirm what authenticates requests on this path. If the answer is a component outside this repository, " +
           "it is worth writing that down where the next reader will find it.",
      evidence: node.publicEvidence,
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run every lens. Findings without evidence are dropped here rather than
 * trusted to each rule — one rule forgetting is all it takes to put an
 * unfalsifiable claim in front of a customer.
 */
export function scoreGraph(graph) {
  const raw = [];
  speedRules(graph, raw);
  costRules(graph, raw);
  securityRules(graph, raw);

  const dropped = raw.filter((f) => !f.evidence).length;
  const findings = raw
    .filter((f) => typeof f.evidence === "string" && f.evidence.includes(":"))
    .sort((a, b) => (sev[b.severity] || 0) - (sev[a.severity] || 0) ||
                    a.lens.localeCompare(b.lens) ||
                    a.rule.localeCompare(b.rule));

  return { findings, droppedForMissingEvidence: dropped };
}

export function countByLens(findings) {
  const counts = { speed: 0, cost: 0, security: 0 };
  for (const f of findings) if (counts[f.lens] !== undefined) counts[f.lens]++;
  return counts;
}

export function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) if (counts[f.severity] !== undefined) counts[f.severity]++;
  return counts;
}
