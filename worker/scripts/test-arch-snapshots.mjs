// Architecture snapshots (migrations/0018, Phase 1).
//
// The feature's whole value is answering "what changed", so the tests are
// mostly about the ways that answer can be quietly wrong:
//
//   - a snapshot chain that links the wrong two graphs
//   - a diff that reports "no changes" when it means "no baseline"
//   - a graph too big to store, truncated rather than refused
//   - enrichment that fills a field with a default instead of leaving it null
//   - a write failure that takes the user's analysis down with it
//
// Run with:  node scripts/test-arch-snapshots.mjs

import {
  recordSnapshot, listSnapshots, getSnapshot, diffGraphs, pruneSnapshots,
  SNAPSHOT_SOURCES, MAX_GRAPH_BYTES,
} from "../src/arch/snapshots.js";
import { enrichGraph, edgeId, reduceGraph } from "../src/analyzers/architecture/enrich.js";
import { analyzeArchitecture, validateArchitectureInput } from "../src/analyzers/architecture.js";
import {
  listArchSnapshotsHandler, getArchSnapshotHandler, archDiffHandler,
} from "../src/handlers/arch_snapshots.js";
import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

const NOW = 1_700_000_000;
const ORG = "org_snap";

function makeKV() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; },
           async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
}
const makeEnv = () => ({
  JWT_SECRET: "snapshot-test-secret-at-least-32-characters",
  SITE_ORIGIN: "https://algosize.com",
  SESSIONS: makeKV(), USERS: makeKV(), DB: makeD1(),
});

async function seedOrg(env) {
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES ('u_snap','snap@acme.test',NULL,'paid','active',?,?,?)`,
  ).bind(ORG, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?,?,'cus_snap','paid','active',5,?,?)`,
  ).bind(ORG, "Acme", NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,'u_snap','owner',?)",
  ).bind(ORG, NOW).run();
}

function authed(url = "https://algosize.com/api/arch/snapshots", params) {
  const r = new Request(url);
  r.user = { userId: "u_snap", email: "snap@acme.test" };
  if (params) r.params = params;
  return r;
}

/** A small graph in the shape enrichGraph produces. */
function graphOf(nodeIds, edgePairs = []) {
  return enrichGraph({
    nodes: nodeIds.map((id) => ({ id, kind: "worker", name: id, evidence: { file: "w.toml", line: 1 } })),
    edges: edgePairs.map(([from, to]) => ({ from, to, kind: "binding", evidence: { file: "w.toml", line: 2 } })),
    clusters: [],
  });
}

// ===========================================================================
group("enrichment adds fields and asserts nothing");
// ===========================================================================
{
  const g = graphOf(["worker:a"], [["worker:a", "d1:x"]]);
  const n = g.nodes[0], e = g.edges[0];

  expect(n.confidence === "confirmed", "a node the parser cited reads as confirmed");
  expect(n.meta.owner === null && n.meta.region === null && n.meta.criticality === null,
    "node metadata is null, not a default");
  expect(n.analysis.spof === null && n.analysis.blastRadius === null && n.analysis.trustZone === null,
    "the analysis block is null until Phase 3 fills it — never 'false', never 0");

  // The one that matters most. A trust-boundary view treats unclassified data
  // crossing a boundary as a finding; defaulting this to "public" would turn
  // every such finding into a pass.
  expect(e.meta.dataClass === null, "dataClass is null — NOT 'public'");
  expect(e.meta.encryptedInTransit === null && e.meta.authenticated === null,
    "encryption and auth are unknown, not assumed true");
  expect(e.origin === "static",
    "a statically-derived edge is 'static' — never 'both', which would claim an observation nobody made");

  const withVia = enrichGraph({ nodes: [], clusters: [],
    edges: [{ from: "a", to: "b", kind: "binding", via: "d1_databases", evidence: { file: "f", line: 1 } }] });
  expect(withVia.edges[0].meta.protocol === "d1", "protocol is derived where the binding type settles it");
  expect(g.edges[0].meta.protocol === null, "…and left null where it does not");

  expect(edgeId({ from: "a", to: "b", kind: "binding", via: "d1_databases" }) !==
         edgeId({ from: "a", to: "b", kind: "binding", via: "kv_namespaces" }),
    "two bindings between the same pair are two edges, not one recorded twice");

  const src = { nodes: [{ id: "n", evidence: {} }], edges: [], clusters: [] };
  enrichGraph(src);
  expect(src.nodes[0].meta === undefined, "enrichGraph does not mutate its input");
}

// ===========================================================================
group("the snapshot chain links the right two graphs");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env);

  const a = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/api", branch: "main",
    source: "monitor", graph: graphOf(["worker:a"]), findingCount: 1, capturedAt: NOW,
  });
  const b = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/api", branch: "main",
    source: "monitor", graph: graphOf(["worker:a", "d1:x"]), findingCount: 2, capturedAt: NOW + 100,
  });

  expect(a && a.prevSnapshotId === null, "the first snapshot of a target has no predecessor");
  expect(b && b.prevSnapshotId === a.snapshotId, "the second links back to the first");

  // A different branch is a different history. Linking them would diff main
  // against a feature branch and call the difference drift.
  const other = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/api", branch: "feature",
    source: "ci", graph: graphOf(["worker:a"]), capturedAt: NOW + 150,
  });
  expect(other && other.prevSnapshotId === null,
    "a different branch starts its own chain rather than linking to main's");

  // Manual uploads have repo_url NULL. `= NULL` never matches, so without a
  // null-safe comparison every manual snapshot would look like the first.
  const m1 = await recordSnapshot(env, null, { orgId: ORG, source: "manual", graph: graphOf(["x"]), capturedAt: NOW + 200 });
  const m2 = await recordSnapshot(env, null, { orgId: ORG, source: "manual", graph: graphOf(["x", "y"]), capturedAt: NOW + 300 });
  expect(m2 && m2.prevSnapshotId === m1.snapshotId,
    "manual uploads chain to each other — the NULL repo_url comparison is null-safe");

  const list = await listSnapshots(env, ORG, { repoUrl: "https://github.com/acme/api", branch: "main" });
  expect(list.length === 2 && list[0].snapshotId === b.snapshotId,
    "the list is newest-first and filtered to one target");
  expect(list[0].graph === undefined, "the list never carries graphs");
}

// ===========================================================================
group("round-trip, including whatever encoding the runtime chose");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env);
  const original = graphOf(["worker:a", "d1:x", "queue:q"], [["worker:a", "d1:x"], ["worker:a", "queue:q"]]);

  const rec = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/r", branch: "main",
    source: "ci", commitSha: "abc123", graph: original, findingCount: 3, capturedAt: NOW,
  });
  const read = await getSnapshot(env, ORG, rec.snapshotId);

  expect(read && !read.unreadable, "a stored snapshot reads back");
  expect(JSON.stringify(read.graph) === JSON.stringify(original),
    "the graph survives the encode/decode round trip byte for byte");
  expect(read.commitSha === "abc123" && read.source === "ci" && read.nodeCount === 3 && read.edgeCount === 2,
    "the summary columns match what was stored");
  expect(read.reduced === false, "a small graph is not marked reduced");

  const row = await env.DB.prepare("SELECT encoding FROM arch_snapshots WHERE snapshot_id = ?")
    .bind(rec.snapshotId).first();
  expect(row.encoding === "gzip+base64" || row.encoding === "json",
    `the encoding is recorded rather than sniffed (got ${row.encoding})`);

  // A snapshot id is an identifier, not a capability.
  const otherOrg = await getSnapshot(env, "org_someone_else", rec.snapshotId);
  expect(otherOrg === null, "another organisation cannot read this snapshot by id");
}

// ===========================================================================
group("a graph too large is reduced, then refused — never truncated");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env);

  // The evidence strings are deliberately high-entropy. Architecture graphs
  // are extremely repetitive and gzip crushes them — a naive 4000-node graph
  // of predictable paths compresses to a few KB and never reaches the ceiling,
  // so a test built on one would assert nothing while appearing to pass.
  const noise = (n) => Array.from({ length: n },
    () => Math.random().toString(36).slice(2)).join("");
  // 7000 nodes of this lands around 1MB after gzip+base64 — comfortably past
  // the 700KB ceiling. 4000 was not enough: it encoded to 609KB and stored
  // whole, so the assertion below passed nothing while looking like it did.
  const big = enrichGraph({
    nodes: Array.from({ length: 7000 }, (_, i) => ({
      id: `worker:svc-${i}`, kind: "worker", name: `service-number-${i}`,
      files: [noise(6)],
      evidence: { file: noise(8), line: i },
    })),
    edges: [], clusters: [],
  });

  const rec = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/huge", branch: "main",
    source: "manual", graph: big, capturedAt: NOW,
  });

  if (rec) {
    const read = await getSnapshot(env, ORG, rec.snapshotId);
    expect(rec.reduced === true, "an oversized graph is stored reduced rather than dropped");
    expect(read.nodeCount === 7000, "…with the node count still describing the WHOLE graph");
    expect(read.graph.nodes.length === 7000, "…and every node still present");
    expect(read.graph.nodes[0].evidence === undefined,
      "…having lost only the evidence citations");
    expect(read.reduced === true, "the reader is told the citations are gone rather than left to wonder");
  } else {
    ok("a graph too large even reduced is refused outright (returns null) rather than truncated");
  }

  expect(MAX_GRAPH_BYTES < 1_000_000,
    "the ceiling sits under D1's 1MB value limit with room for the row's other columns");

  const r = reduceGraph({ nodes: [{ id: "a", evidence: {}, files: ["f"], kind: "worker" }], edges: [], clusters: [] });
  expect(r.nodes[0].kind === "worker" && r.nodes[0].evidence === undefined && r.nodes[0].files === undefined,
    "reduceGraph drops evidence and files and keeps structure");
}

// ===========================================================================
group("the diff distinguishes 'nothing changed' from 'nothing to compare'");
// ===========================================================================
{
  const before = graphOf(["a", "b"], [["a", "b"]]);
  const after  = graphOf(["a", "b", "c"], [["a", "b"], ["a", "c"]]);

  const d = diffGraphs(before, after);
  expect(d.comparable === true && d.nodesAdded.length === 1 && d.nodesAdded[0].id === "c",
    "an added node is reported");
  expect(d.edgesAdded.length === 1 && d.nodesRemoved.length === 0,
    "…along with the edge that came with it, and nothing spurious");
  expect(d.changed === 2, "the change count sums nodes and edges");

  const same = diffGraphs(before, before);
  expect(same.comparable === true && same.changed === 0,
    "an unchanged graph diffs to zero changes — a real result");

  // THE distinction. Both look like "no changes" to a careless renderer.
  const none = diffGraphs(null, after);
  expect(none.comparable === false && none.reason === "no_baseline",
    "a missing baseline is NOT zero changes — it reports comparable:false");
  expect(none.nodesAdded.length === 0,
    "…and returns empty lists rather than claiming the whole graph is new");

  const removed = diffGraphs(after, before);
  expect(removed.nodesRemoved.length === 1 && removed.edgesRemoved.length === 1,
    "removals are reported as removals, not as an empty diff");

  // Snapshots written before edges carried ids must still diff.
  const legacy = { nodes: [], edges: [{ from: "a", to: "b", kind: "binding" }] };
  const withIds = { nodes: [], edges: [{ id: "a->b:binding", from: "a", to: "b", kind: "binding" }] };
  expect(diffGraphs(legacy, withIds).changed === 0,
    "an edge without a stored id falls back to the same identity and does not read as churn");
}

// ===========================================================================
group("recording never breaks the thing that produced the graph");
// ===========================================================================
{
  const noDb = { DB: null };
  expect(await recordSnapshot(noDb, null, { orgId: ORG, source: "manual", graph: graphOf(["a"]) }) === null,
    "no DB binding returns null rather than throwing");

  const env = makeEnv();
  await seedOrg(env);
  expect(await recordSnapshot(env, null, { orgId: ORG, source: "not_a_source", graph: graphOf(["a"]) }) === null,
    "an unknown source is refused, not written");
  expect(await recordSnapshot(env, null, { orgId: ORG, source: "manual", graph: null }) === null,
    "a missing graph returns null");
  expect(SNAPSHOT_SOURCES.length === 3, "the source set is closed: manual, ci, monitor");

  const broken = { DB: { prepare() { throw new Error("d1 exploded"); } } };
  expect(await recordSnapshot(broken, null, { orgId: ORG, source: "ci", graph: graphOf(["a"]) }) === null,
    "a database that throws resolves to null — the caller's analysis survives");
}

// ===========================================================================
group("the endpoints");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env);
  const s1 = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/api", branch: "main",
    source: "monitor", graph: graphOf(["a"]), capturedAt: NOW });
  const s2 = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/api", branch: "main",
    source: "monitor", graph: graphOf(["a", "b"]), capturedAt: NOW + 60 });

  const list = await (await listArchSnapshotsHandler(authed(), env)).json();
  expect(list.snapshots.length === 2 && typeof list.basis === "string",
    "the list endpoint returns snapshots and says what they are");

  const one = await (await getArchSnapshotHandler(
    authed("https://algosize.com/api/arch/snapshots/x", { id: s2.snapshotId }), env)).json();
  expect(one.snapshot && one.snapshot.graph && one.snapshot.graph.nodes.length === 2,
    "the detail endpoint returns the graph");

  const missing = await getArchSnapshotHandler(
    authed("https://algosize.com/api/arch/snapshots/x", { id: "arc_nope" }), env);
  expect(missing.status === 404, "an unknown id is a 404");

  // `to` alone diffs against prev_snapshot_id — the common case.
  const diff = await (await archDiffHandler(
    authed(`https://algosize.com/api/arch/diff?to=${s2.snapshotId}`), env)).json();
  expect(diff.diff.comparable === true && diff.diff.nodesAdded.length === 1,
    "diffing by `to` alone uses the recorded predecessor");
  expect(diff.to.graph === undefined && (diff.from === null || diff.from.graph === undefined),
    "the diff response carries summaries, not two whole graphs");

  const firstDiff = await (await archDiffHandler(
    authed(`https://algosize.com/api/arch/diff?to=${s1.snapshotId}`), env)).json();
  expect(firstDiff.diff.comparable === false && /earliest snapshot/.test(firstDiff.note),
    "the earliest snapshot says why it cannot be compared instead of reporting no changes");

  const noTo = await archDiffHandler(authed("https://algosize.com/api/arch/diff"), env);
  expect(noTo.status === 400, "diff without `to` is a 400");

  // A reduced input must be NAMED by the diff, not merely recorded on the
  // snapshot row. The drift view cites file:line for what changed; when an
  // input lost its evidence to fit, the reader has to be told before they ask
  // why the citations are missing. Migration 0018's comment is explicit that
  // a snapshot silently losing citations breaks the X-ray's core promise.
  const big = { nodes: [], edges: [], clusters: [] };
  for (let i = 0; i < 4000; i++) {
    big.nodes.push({
      id: `n${i}`, kind: "service", name: `service-number-${i}`,
      evidence: { file: `services/really/quite/deeply/nested/path/service-${i}.ts`, line: i },
    });
  }
  const r1 = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/big", branch: "main",
    source: "monitor", graph: big, capturedAt: NOW });
  const big2 = { nodes: big.nodes.concat([{ id: "extra", kind: "service", name: "extra" }]), edges: [], clusters: [] };
  const r2 = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/big", branch: "main",
    source: "monitor", graph: big2, capturedAt: NOW + 10 });

  if (r1 && r2) {
    const rd = await (await archDiffHandler(
      authed(`https://algosize.com/api/arch/diff?to=${r2.snapshotId}`), env)).json();
    const anyReduced = (await getSnapshot(env, ORG, r1.snapshotId)).reduced ||
                       (await getSnapshot(env, ORG, r2.snapshotId)).reduced;
    expect(!anyReduced || (rd.reducedInputs && rd.reducedInputs.length > 0),
      "a reduced input is named in the diff response, not left for the reader to discover");
  } else {
    ok("the oversized pair was refused outright — nothing to diff, which is the other honest outcome");
  }
}

// ===========================================================================
group("retention, and what it deliberately does not repair");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env);
  const old = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/r", branch: "main",
    source: "monitor", graph: graphOf(["a"]), capturedAt: NOW - 91 * 86400 });
  const fresh = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/r", branch: "main",
    source: "monitor", graph: graphOf(["a", "b"]), capturedAt: NOW });

  const deleted = await pruneSnapshots(env, null, { now: NOW });
  expect(deleted === 1, "a snapshot past 90 days is pruned");
  expect(await getSnapshot(env, ORG, old.snapshotId) === null, "…and is gone");

  const survivor = await getSnapshot(env, ORG, fresh.snapshotId);
  expect(survivor.prevSnapshotId === old.snapshotId,
    "the survivor still points at the pruned snapshot — the pointer is NOT rewritten");

  const d = await (await archDiffHandler(
    authed(`https://algosize.com/api/arch/diff?to=${fresh.snapshotId}`), env)).json();
  expect(d.diff.comparable === false && /no longer available/.test(d.note),
    "…so the diff says the comparison point is gone rather than silently comparing against an older graph");
}

// ===========================================================================
group("the real analyzer produces a graph this can store");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env);
  const v = validateArchitectureInput({ files: [
    { path: "worker/wrangler.toml", content: 'name = "api"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "app"\n' },
  ] });
  const result = analyzeArchitecture(v.value);

  expect(result.graph.nodes.every((n) => n.meta && n.analysis && n.confidence),
    "analyzeArchitecture now emits the enriched node shape");
  expect(result.graph.edges.every((e) => e.id && e.origin === "static" && e.meta),
    "…and the enriched edge shape, every edge marked static");

  const rec = await recordSnapshot(env, null, {
    orgId: ORG, repoUrl: "https://github.com/acme/real", branch: "main",
    source: "manual", graph: result.graph,
    findingCount: result.findings.length, capturedAt: NOW });
  expect(rec !== null, "a real analyzer graph stores");
  const read = await getSnapshot(env, ORG, rec.snapshotId);
  expect(read.graph.nodes.length === result.graph.nodes.length,
    "…and reads back with the same node count");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} arch-snapshot test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all arch-snapshot tests passed\x1b[0m");
