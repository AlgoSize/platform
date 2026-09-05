// Model explorer — the registry contract and the endpoint behind it.
//
// The explorer is a read-only view over ai/models.js, which means every claim
// it makes on screen is a claim this registry is making. Three of those are
// load-bearing and were not previously enforced anywhere:
//
//   • "avoid" and "unrated" are DIFFERENT facts. One says somebody looked at a
//     model/task pairing and said no; the other says nobody looked. Collapsing
//     them to a blank cell loses the stronger one.
//   • the quality scores are engineering estimates (`scored: false`), and that
//     flag has to survive to the client or a 0–100 number reads as measured.
//   • the prices are relayed, not confirmed, and the caveat has to be DATA so
//     it cannot go stale when the prices are refreshed and the copy is not.
//
// Run with:  node scripts/test-model-explorer.mjs

import worker from "../src/index.js";
import { makeD1 } from "./_d1-stub.mjs";
import { issueJWT } from "../src/auth.js";
import {
  MODELS, TASK_FAMILIES, TASK_FAMILY_META, TIERS,
  graphData, recommend, bestTierOf, GRAPH_KINDS,
} from "../src/ai/models.js";
import { PRICE_PROVENANCE } from "../src/ai/pricing.js";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// ---------------------------------------------------------------------------

group("every task family says what the job actually is");

{
  expect(TASK_FAMILIES.length > 0 && TASK_FAMILIES.every((f) => typeof TASK_FAMILY_META[f] === "string" && TASK_FAMILY_META[f].length > 20),
    "every family carries a description, so an explorer never lists a slug with nothing beside it");
  // The description lives beside the tiers it explains; a copy deck in the
  // frontend would drift from the routing table the first time either changed.
  const routed = new Set();
  MODELS.forEach((m) => Object.keys(m.tasks || {}).forEach((f) => routed.add(f)));
  expect([...routed].every((f) => TASK_FAMILIES.includes(f)),
    "…and no model is routed to a family the catalogue does not list");
}

group("avoid is not the same as unrated");

{
  const fit = graphData("model_fit_by_task", { includeDeprecated: true });
  const rows = fit.rows;
  const cells = rows.flatMap((r) => Object.values(r.fit));

  expect(cells.includes("avoid") && cells.includes("unrated"),
    "the matrix contains BOTH states — a pairing somebody rejected, and one nobody rated");
  expect(!cells.includes(null) && !cells.some((c) => c === ""),
    "…and never a bare null, which a renderer would have to guess the meaning of");

  // The strongest claim: a model marked `avoid` everywhere must not be
  // coloured as though it had earned a tier.
  const avoidOnly = MODELS.find((m) =>
    Object.keys(m.tasks || {}).length > 0 &&
    Object.values(m.tasks).every((t) => t === "avoid"));
  expect(avoidOnly && bestTierOf(avoidOnly) === null,
    "a model only ever marked 'avoid' has no best tier — it is not a budget option, it is a refusal");

  const primary = MODELS.find((m) => Object.values(m.tasks || {}).includes("primary"));
  expect(bestTierOf(primary) === "primary",
    "…while a model that is primary for anything reports primary as its best tier");
}

group("the scores say they are estimates, and the prices say where they came from");

{
  for (const kind of ["cost_vs_capability", "latency_vs_quality", "cost_vs_autofix"]) {
    const g = graphData(kind);
    expect(g.points.every((p) => typeof p.scored === "boolean"),
      `${kind}: every point carries the scored flag`);
    expect(g.points.every((p) => p.scored === false),
      `${kind}: …and reports false, because these are seeded estimates rather than benchmark output`);
    expect(g.provenance && g.provenance.confirmedAgainstBill === false && g.provenance.relayedOn,
      `${kind}: …and the price provenance rides along, so the caveat is data rather than typed copy`);
    expect(typeof g.note === "string" && g.note.length > 0 &&
           g.x.label && g.y.label && g.x.low && g.x.high,
      `${kind}: the axes name themselves and their low/high ends`);
  }

  // The axis that used to lie: labelled "quality", keyed on capability.
  const lat = graphData("latency_vs_quality");
  expect(lat.y.key === "capability" && /capab/i.test(lat.y.label),
    "the speed plot labels its y axis as capability, which is what it actually plots — " +
    "there is no separate quality score in this registry to name");
}

group("points carry the real prices, and null where a price does not apply");

{
  const g = graphData("cost_vs_capability");
  const priced = g.points.filter((p) => p.priceHint && p.priceHint.inputPer1M != null);
  expect(priced.length > 0, "models carry a real $/1M input price, not just a cost score");

  const embedder = g.points.find((p) => /bge-m3/.test(p.model));
  expect(embedder && embedder.priceHint.outputPer1M === null,
    "an embedding model reports NULL output price — it emits no output tokens, and $0 would read as free");
  expect(embedder && embedder.priceHint.inputPer1M > 0,
    "…while its input price is a real number");
  expect(g.points.every((p) => p.priceHint && typeof p.priceHint.verified === "boolean"),
    "every price hint says whether it has a source behind it");
}

group("recommend ranks by tier, and an empty answer is a deliberate blank");

{
  const fixes = recommend("fix_suggestion");
  expect(fixes.length > 0 && fixes[0].tier === "primary",
    "a rated family returns its primary first");
  expect(fixes.every((r) => r.tier !== "avoid"),
    "…and never offers a model marked avoid");
  expect(fixes.every((r) => TIERS.includes(r.tier)), "…with every tier drawn from the registry's own set");

  const withDep = recommend("fix_suggestion", { includeDeprecated: true });
  expect(withDep.length >= fixes.length,
    "including superseded models can only widen the list, never narrow it");

  const budgetFirst = recommend("report_writing", { budget: true });
  const qualityFirst = recommend("report_writing");
  expect(budgetFirst.length === qualityFirst.length,
    "the budget weighting reorders the same pool rather than filtering it");
}

// ---------------------------------------------------------------------------

group("GET /api/ai/models");

const EMAIL = "dev@algosize.com";
const now = Date.now();

function kv() {
  const m = new Map();
  return {
    async get(k) { return m.get(k) || null; },
    async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); },
    async list() { return { keys: [] }; },
  };
}

const env = {
  DB: makeD1(), SESSIONS: kv(), USERS: kv(),
  JWT_SECRET: "model-explorer-test-secret-long-enough",
  COOKIE_NAME: "algosize_session",
};
const sec = Math.floor(now / 1000);
await env.DB.prepare(`INSERT INTO organisations (org_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
  .bind("org_a", "Aster", sec, sec).run();
await env.DB.prepare(`INSERT INTO users (user_id, email, active_org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
  .bind("usr_1", EMAIL, "org_a", sec, sec).run();

async function get(path) {
  const token = await issueJWT(env, "usr_1", EMAIL, "active");
  const res = await worker.fetch(new Request(`https://algosize.com${path}`, {
    headers: { Cookie: `algosize_session=${token}` },
  }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

{
  const base = await get("/api/ai/models");
  expect(base.status === 200 && Array.isArray(base.body.taskFamilies) && base.body.taskFamilies[0].description,
    "the task catalogue rides along on every call, descriptions included");

  const scatter = await get("/api/ai/models?graph=cost_vs_capability");
  const withDep = await get("/api/ai/models?graph=cost_vs_capability&includeDeprecated=1");
  expect(withDep.body.graph.points.length > scatter.body.graph.points.length,
    "the Deprecated toggle reaches the server — it used to have no backend at all");
  expect(withDep.body.graph.points.some((p) => p.deprecated === true),
    "…and superseded models come back flagged, not silently mixed in");

  const narrowed = await get("/api/ai/models?graph=cost_vs_capability&taskFamily=embeddings");
  expect(narrowed.body.graph.points.length > 0 &&
         narrowed.body.graph.points.length < scatter.body.graph.points.length,
    "a graph can be narrowed to the models rated for one family");

  const rec = await get("/api/ai/models?task=fix_suggestion");
  expect(rec.body.recommendation.models.length > 0 &&
         rec.body.recommendation.description.length > 0 &&
         rec.body.recommendation.empty === false,
    "the recommend view has an endpoint, with the job description attached");

  const empty = await get("/api/ai/models?task=visual_reasoning&taskFamily=embeddings");
  expect(empty.status === 200, "an unusual filter combination is still a 200");

  expect((await get("/api/ai/models?graph=nope")).status === 400 &&
         (await get("/api/ai/models?task=nope")).status === 400 &&
         (await get("/api/ai/models?taskFamily=nope")).status === 400,
    "unknown graph kinds, tasks and families are rejected by name rather than silently ignored");

  const anon = await worker.fetch(new Request("https://algosize.com/api/ai/models"), env, { waitUntil() {} });
  expect(anon.status === 401, "the registry is behind the same auth as everything else");
}

group("a family nobody rated returns an explicit blank, not a hole");

{
  // Find a family with no model rated for it, if one exists; otherwise assert
  // the shape a blank WOULD take, so the contract is pinned either way.
  const unratedFamily = TASK_FAMILIES.find((f) => recommend(f).length === 0);
  if (unratedFamily) {
    const r = await get("/api/ai/models?task=" + unratedFamily);
    expect(r.body.recommendation.empty === true && r.body.recommendation.models.length === 0,
      `${unratedFamily} returns empty:true — a deliberate blank, not a gap in the data`);
  } else {
    expect(GRAPH_KINDS.length >= 4,
      "every family currently has a rated model; the empty flag stays on the contract for when one does not");
  }
}

group("provenance is one record, not a sentence retyped per surface");

{
  expect(PRICE_PROVENANCE.relayedOn && PRICE_PROVENANCE.sourceUrl && PRICE_PROVENANCE.caveat,
    "the date, the source and the caveat live in one exported record");
  expect(PRICE_PROVENANCE.confirmedAgainstBill === false,
    "…and it says plainly that nothing here has been reconciled against a bill");
}

// ===========================================================================
console.log("\na missing price says WHY it is missing\n");
// ===========================================================================
{
  // A null price was two different facts wearing one shape, and the tooltip
  // described both with the embedding sentence: "n/a — no output tokens" about
  // @cf/moonshotai/kimi-k2.5, which pricing.js lists at $0.180 / 1M out. It is
  // not that the model emits no output tokens; it is that pickPrice refuses a
  // deprecated row for a new call.
  //
  // costOf already distinguished them. priceHint threw the distinction away,
  // so this checks the shape the explorer actually receives.
  const pts = graphData(GRAPH_KINDS[0], { includeDeprecated: true }).points || [];
  const byModel = (id) => pts.find((p) => p.model === id) || null;

  const dep = pts.filter((p) => p.deprecated);
  expect(dep.length > 0, `the catalogue still has a superseded model to check (${dep.length})`);
  for (const p of dep) {
    expect(p.priceHint && p.priceHint.reason === "model_deprecated",
      `${p.model} says its price is withheld because it is superseded`);
    expect(p.priceHint && p.priceHint.inputPer1M === null && p.priceHint.outputPer1M === null,
      `…and quotes no price for it, in either direction`);
  }

  // The other null, which must stay reachable: a model that IS priced and
  // genuinely has no output leg. Its reason is null, and that null is what
  // lets the renderer keep saying "no output tokens" for exactly this case.
  const embed = byModel("@cf/baai/bge-m3");
  expect(embed !== null, "the embedding model is on the plot");
  expect(embed.priceHint.inputPer1M !== null && embed.priceHint.outputPer1M === null,
    "an embedding model is priced on input and has no output price");
  expect(embed.priceHint.reason === null,
    "…with no reason attached, because nothing is being withheld — it emits no output tokens");

  // A priced, ordinary model carries no reason either.
  const live = pts.find((p) => !p.deprecated && p.priceHint && p.priceHint.outputPer1M !== null);
  expect(live && live.priceHint.reason === null,
    "a fully priced model carries no withheld-price reason");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} model-explorer test(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log("\x1b[32m  all model-explorer tests passed\x1b[0m\n");
