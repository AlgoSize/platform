// GET /api/admin/ai-usage — tenant isolation and accounting semantics.
import worker from "../src/index.js";
import { makeD1 } from "./_d1-stub.mjs";
import { issueJWT } from "../src/auth.js";

let failures = 0;
const expect = (cond, label) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
};
const approx = (a, b) => Math.abs(a - b) < 1e-9;
const ADMIN = "ai-admin@algosize.com";
const SECRET = "ai-admin-test-secret-that-is-long-enough";

function kv() {
  const values = new Map();
  return {
    async get(k) { return values.get(k) || null; },
    async put(k, v) { values.set(k, v); },
    async delete(k) { values.delete(k); },
  };
}

const env = {
  DB: makeD1(),
  SESSIONS: kv(),
  USERS: kv(),
  JWT_SECRET: SECRET,
  COOKIE_NAME: "algosize_session",
  ADMIN_EMAILS: ADMIN,
  AI_BUDGET_USD: "1",
};
const now = Date.now();
const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();

for (const [id, name] of [["org_a", "Aster"], ["org_b", "Beacon"]]) {
  await q(`INSERT INTO organisations (org_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`, id, name, Math.floor(now / 1000), Math.floor(now / 1000));
}
await q(`INSERT INTO users (user_id, email, active_org_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        "usr_admin", ADMIN, "org_a", Math.floor(now / 1000), Math.floor(now / 1000));

async function usage({ org, model, feature, raw, margin, revenue, inTok = null, outTok = null }) {
  await q(`INSERT INTO ai_usage
            (org_id, feature_name, provider, model, input_tokens, output_tokens,
             neurons_consumed, total_cost,
             platform_margin_cost, algosize_price, status, created_at)
           VALUES (?, ?, 'workers-ai', ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
          org, feature, model, inTok, outTok, raw === null ? null : raw * 1000,
          raw, margin, revenue, now - 1000);
}
await usage({ org: "org_a", model: "priced", feature: "fix", raw: 0.1, margin: 0.025, revenue: 0.125 });
await usage({ org: "org_b", model: "priced", feature: "fix", raw: 0.2, margin: 0.05, revenue: 0.25,
              inTok: 120000, outTok: 21000 });
await usage({ org: "org_b", model: "unpriced", feature: "verify", raw: null, margin: null, revenue: null });
// No organisations row: this tenant is outside the admin's enumerated scope and
// must not enter any total, even though a malformed database contains the row.
await usage({ org: "org_orphan", model: "priced", feature: "fix", raw: 99, margin: 24.75, revenue: 123.75 });

const token = await issueJWT(env, "usr_admin", ADMIN, "active");
async function call(path) {
  const res = await worker.fetch(new Request(`https://algosize.com${path}`, {
    headers: { Cookie: `algosize_session=${token}` },
  }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

console.log("\nadmin AI usage\n");
const orgReport = await call("/api/admin/ai-usage?window=7d&groupBy=org");
expect(orgReport.status === 200, "admin route responds 200");
expect(orgReport.body.groups.length === 2 &&
       !orgReport.body.groups.some((g) => g.key === "org_orphan"),
  "usage is read only through known, explicitly-filtered tenant ids");
expect(approx(orgReport.body.summary.totalCostUsd, 0.3) &&
       approx(orgReport.body.summary.platformMarginUsd, 0.075) &&
       approx(orgReport.body.summary.algosizePriceUsd, 0.375),
  "summary keeps raw cost, platform margin, and customer revenue separate");

const modelReport = await call("/api/admin/ai-usage?window=30d&groupBy=model");
const priced = modelReport.body.groups.find((g) => g.key === "priced");
const unpriced = modelReport.body.groups.find((g) => g.key === "unpriced");
expect(priced.requests === 2 && approx(priced.totalCostUsd, 0.3) &&
       approx(priced.platformMarginUsd, 0.075) && approx(priced.algosizePriceUsd, 0.375),
  "group rollup uses the stored raw/margin/revenue values");
expect(unpriced.totalCostUsd === null && unpriced.platformMarginUsd === null &&
       unpriced.algosizePriceUsd === null && unpriced.partial === true,
  "an all-unmeasured group returns null totals plus partial:true, never zero");
expect(unpriced.budget.state === "unmeasured",
  "unmeasured revenue is not classified as safely under budget");
expect(modelReport.body.trend.length === 1 &&
       approx(modelReport.body.trend[0].algosizePriceUsd, 0.375) &&
       modelReport.body.trend[0].partial === true,
  "daily trend preserves revenue and partial coverage");
expect(modelReport.body.topExpensive[0].orgId === "org_b" &&
       modelReport.body.topExpensive.every((r) => !("requestMetadata" in r)),
  "top-expensive is scoped and exposes no request metadata");

const bad = await call("/api/admin/ai-usage?groupBy=repository");
expect(bad.status === 400, "unknown grouping is rejected rather than guessed");

const anon = await worker.fetch(
  new Request("https://algosize.com/api/admin/ai-usage"), env, { waitUntil() {} });
expect(anon.status === 401, "the route uses the same admin authentication chain");

// ---------------------------------------------------------------------------
// Coverage: the denominator under every money figure on the page.
// ---------------------------------------------------------------------------
const cov = modelReport.body.coverage;
expect(cov.requests === 3 && cov.measuredRequests === 2 && cov.unmeasuredRequests === 1,
  "coverage names how many calls could be priced and how many could not");
expect(Math.abs(cov.measuredPct - (200 / 3)) < 1e-9 && cov.state === "partial",
  "…as a share, so a total summed over measured rows only can be read as the lower bound it is");
expect(approx(modelReport.body.summary.marginPct, 20),
  "margin is reported as a share of customer revenue (a 25% markup is 20% of revenue)");
expect(priced.measured === "full" && unpriced.measured === "none" &&
       priced.measuredRequests === 2 && unpriced.measuredRequests === 0,
  "each group carries the tri-state coverage that `partial` flattens");

// ---------------------------------------------------------------------------
// Sorting: unmeasured has no rank on a money scale, in EITHER direction.
// ---------------------------------------------------------------------------
const asc = await call("/api/admin/ai-usage?window=30d&groupBy=model&sort=cost&dir=asc");
expect(asc.body.groups.map((g) => g.key).join(",") === "priced,unpriced",
  "sorting cost ascending does not float the unpriced group to the top as if it were the cheapest");
const desc = await call("/api/admin/ai-usage?window=30d&groupBy=model&sort=cost&dir=desc");
expect(desc.body.groups.map((g) => g.key).join(",") === "priced,unpriced",
  "…and sorting descending does not float it there as if it were the biggest spender either");
const byName = await call("/api/admin/ai-usage?window=30d&groupBy=model&sort=name&dir=asc");
expect(byName.body.groups.map((g) => g.key).join(",") === "priced,unpriced",
  "on a scale every group is on (name) nothing is parked — there is no missing value to hide");
const byReq = await call("/api/admin/ai-usage?window=30d&groupBy=model&sort=requests&dir=asc");
expect(byReq.body.groups.map((g) => g.key).join(",") === "unpriced,priced",
  "…and request count ranks the unpriced group normally, because its request count is measured");
expect((await call("/api/admin/ai-usage?sort=vibes")).status === 400 &&
       (await call("/api/admin/ai-usage?dir=sideways")).status === 400,
  "an unknown sort column or direction is rejected rather than silently ignored");

// ---------------------------------------------------------------------------
// Top expensive: a row is explainable, not just a number.
// ---------------------------------------------------------------------------
const top = modelReport.body.topExpensive[0];
expect(top.inputTokens === 120000 && top.outputTokens === 21000 && top.totalTokens === 141000,
  "the most expensive request carries the token counts that explain the cost");
const noTokens = modelReport.body.topExpensive.find((r) => r.orgId === "org_a");
expect(noTokens.totalTokens === null,
  "a request whose provider returned no usage block reports null tokens, never 0");

// ---------------------------------------------------------------------------
// Empty is not $0 — and an empty table is not an empty window.
// ---------------------------------------------------------------------------
async function callWith(otherEnv, path) {
  const t = await issueJWT(otherEnv, "usr_admin", ADMIN, "active");
  const res = await worker.fetch(new Request(`https://algosize.com${path}`, {
    headers: { Cookie: `algosize_session=${t}` },
  }), otherEnv, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

function freshEnv() {
  const e = { ...env, DB: makeD1(), SESSIONS: kv(), USERS: kv() };
  return e;
}

const bare = freshEnv();
const bq = (sql, ...args) => bare.DB.prepare(sql).bind(...args).run();
await bq(`INSERT INTO organisations (org_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
         "org_a", "Aster", Math.floor(now / 1000), Math.floor(now / 1000));
await bq(`INSERT INTO users (user_id, email, active_org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
         "usr_admin", ADMIN, "org_a", Math.floor(now / 1000), Math.floor(now / 1000));

const never = await callWith(bare, "/api/admin/ai-usage?window=7d");
expect(never.body.summary.requests === 0 && never.body.summary.totalCostUsd === null,
  "a window with no rows reports null cost, not $0 of spend");
expect(never.body.emptyState.reason === "no_rows_ever" && never.body.lastRowAt === null,
  "…and says nothing has EVER been recorded, which is a plumbing failure, not a quiet week");
expect(never.body.coverage.state === "empty",
  "coverage over zero rows is 'empty', not 100% measured");

// Same database, one row well outside the 7-day window.
const oldAt = now - 400 * 24 * 60 * 60 * 1000;
await bq(`INSERT INTO ai_usage
           (org_id, feature_name, provider, model, neurons_consumed, total_cost,
            platform_margin_cost, algosize_price, status, created_at)
          VALUES (?, 'fix', 'workers-ai', 'priced', ?, ?, ?, ?, 'ok', ?)`,
         "org_a", 100, 0.1, 0.025, 0.125, oldAt);
const quiet = await callWith(bare, "/api/admin/ai-usage?window=7d");
expect(quiet.body.emptyState.reason === "no_rows_in_window" && quiet.body.lastRowAt === oldAt,
  "rows outside the window read as a quiet period, with the last recorded call named");

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} admin AI usage test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all admin AI usage tests passed\x1b[0m");