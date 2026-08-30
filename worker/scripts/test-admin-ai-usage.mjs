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

async function usage({ org, model, feature, raw, margin, revenue }) {
  await q(`INSERT INTO ai_usage
            (org_id, feature_name, provider, model, neurons_consumed, total_cost,
             platform_margin_cost, algosize_price, status, created_at)
           VALUES (?, ?, 'workers-ai', ?, ?, ?, ?, ?, 'ok', ?)`,
          org, feature, model, raw === null ? null : raw * 1000,
          raw, margin, revenue, now - 1000);
}
await usage({ org: "org_a", model: "priced", feature: "fix", raw: 0.1, margin: 0.025, revenue: 0.125 });
await usage({ org: "org_b", model: "priced", feature: "fix", raw: 0.2, margin: 0.05, revenue: 0.25 });
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

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} admin AI usage test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all admin AI usage tests passed\x1b[0m");