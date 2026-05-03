// AWS Cost & Usage Report (CUR) analyzer — pure, dependency-free.
//
// Takes the text contents of a CUR CSV export and returns the same envelope
// shape as the JSON analyzer in ./cost.js, with one extra field:
//   { currentSpend, suggestions, totalSavingsPct, topItems }
//
// `topItems` is the 10 highest-cost (productCode + usageType + term) groups,
// suitable for rendering as a table. The dashboard's existing `renderCost`
// keeps working untouched when `topItems` is omitted.
//
// SCALE / STREAMING TRADE-OFF
// ---------------------------
// We deliberately use a single-pass, fully-buffered parser rather than a
// streaming TextDecoderStream pipeline. Rationale:
//   - The handler enforces a 100 MB body cap (~530k CUR rows at ~150
//     bytes/row), well within the 128 MB Worker memory limit.
//   - CUR rows are aggregated immediately into a Map keyed by (product,
//     usage, term), so the post-parse working set is O(unique-pricing-tuples)
//     — typically a few hundred entries — not O(rows).
//   - A defensive `MAX_CUR_ROWS` cap below catches pathological inputs.
// True streaming would help users with monthly CURs over 100 MB; the
// follow-up to accept gzipped uploads (Task #28) is a much higher-leverage
// path to that scale than refactoring this parser.
//
// Three recommendation heuristics:
//   1. ri_sp_coverage_gap  — on-demand EC2/RDS hours that could be on a
//                            1-yr Savings Plan / Reserved Instance (~30%).
//   2. legacy_ebs_storage  — gp2 EBS volumes recommended for gp3 migration
//                            (~20% per AWS' own guidance). NOTE: the original
//                            task plan called for "idle EBS volumes (zero IOPS
//                            for 30d)", but CUR is a billing report and does
//                            NOT carry IOPS data — true idle detection
//                            requires CloudWatch metrics. We substitute the
//                            gp2→gp3 recommendation, which IS computable from
//                            CUR alone and is a real, well-documented win.
//   3. oversized_rds       — RDS instance hours on xlarge+ usage types
//                            (~40% from right-sizing one tier down).
//
// All recommendations are conservative (we under-promise rather than over-
// promise) so the numbers stay believable. Each suggestion includes the rule
// name, an impact band, and a savingsEstimate in whole USD.

const REQUIRED_COLUMNS = [
  "lineItem/ProductCode",
  "lineItem/UsageType",
  "lineItem/UnblendedCost",
];

const HELP_URL = "https://docs.aws.amazon.com/cur/latest/userguide/cur-create.html";

// Defensive row cap. The handler's 100 MB byte cap is the primary guard;
// this is the secondary one (e.g. an attacker uploading a million tiny rows
// well under 100 MB). Exported so tests can verify the cap behavior with a
// patched limit instead of generating 500k+ rows in CI.
export const MAX_CUR_ROWS = 500_000;

// ---------------------------------------------------------------------------
// CSV parser — RFC 4180-ish state machine
// ---------------------------------------------------------------------------
//
// Handles: quoted fields, embedded commas, embedded newlines, "" escape,
// CRLF and LF line endings. Returns Array<Array<string>> — header is rows[0].
//
// Exported because the tests verify the parser independently before going
// through the analyzer.

export function parseCsv(text) {
  // Strip UTF-8 BOM (\uFEFF) if present. Many tools (Excel, S3 console exports,
  // PowerShell `Out-File`) emit a BOM on CSV files; without this, the first
  // header would become "\uFEFFlineItem/ProductCode" and the required-column
  // check below would reject otherwise-valid CUR exports.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const c = text.charCodeAt(i);

    if (inQuotes) {
      if (c === 34 /* " */) {
        // Escaped "" inside quoted field
        if (i + 1 < len && text.charCodeAt(i + 1) === 34) {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += text[i];
      i += 1;
      continue;
    }

    // Not in quotes
    if (c === 34 /* " */ && field === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === 44 /* , */) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === 10 /* \n */) {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    if (c === 13 /* \r */) {
      // Skip CR; the LF will end the row.
      i += 1;
      continue;
    }
    field += text[i];
    i += 1;
  }

  // Trailing field / row (no terminating newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Errors — thrown by analyzeCur, caught by the handler to produce 4xx
// ---------------------------------------------------------------------------

function curError(message) {
  const e = new Error(message);
  e.curError = true;
  e.helpUrl = HELP_URL;
  return e;
}

// ---------------------------------------------------------------------------
// Pretty service names — productCode is the wire format ("AmazonEC2") but
// users want short names ("EC2") in tables.
// ---------------------------------------------------------------------------

const SERVICE_NAMES = {
  AmazonEC2: "EC2",
  AmazonRDS: "RDS",
  AmazonS3: "S3",
  AmazonCloudFront: "CloudFront",
  AmazonEBS: "EBS",
  AWSDataTransfer: "Data Transfer",
  AmazonRoute53: "Route 53",
  AWSLambda: "Lambda",
  AmazonDynamoDB: "DynamoDB",
  AmazonElastiCache: "ElastiCache",
  AmazonRedshift: "Redshift",
  AmazonECR: "ECR",
  AmazonECS: "ECS",
  AmazonEKS: "EKS",
  AmazonSNS: "SNS",
  AmazonSQS: "SQS",
};

function prettyService(productCode) {
  if (SERVICE_NAMES[productCode]) return SERVICE_NAMES[productCode];
  return productCode.replace(/^Amazon|^AWS/, "") || productCode;
}

const round = (n) => Math.round(n);
const impactOf = (savings) => (savings >= 500 ? "high" : savings >= 100 ? "medium" : "low");

// ---------------------------------------------------------------------------
// Main entry: analyzeCur(csvText) -> { currentSpend, suggestions, totalSavingsPct, topItems }
// Throws a curError on malformed CUR.
// ---------------------------------------------------------------------------

export function analyzeCur(csvText) {
  if (typeof csvText !== "string" || csvText.length === 0) {
    throw curError("CUR file is empty.");
  }
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    throw curError("CUR must have a header row and at least one data row.");
  }
  const header = rows[0].map((h) => h.trim());
  const headerIndex = new Map(header.map((h, i) => [h, i]));

  for (const col of REQUIRED_COLUMNS) {
    if (!headerIndex.has(col)) {
      throw curError(
        `This does not look like a CUR export — required column "${col}" is missing. ` +
          `Make sure you exported a Cost & Usage Report (not a Cost Explorer CSV).`,
      );
    }
  }

  const iProd = headerIndex.get("lineItem/ProductCode");
  const iUsage = headerIndex.get("lineItem/UsageType");
  const iCost = headerIndex.get("lineItem/UnblendedCost");
  const iTerm = headerIndex.has("pricing/term") ? headerIndex.get("pricing/term") : -1;
  const iType = headerIndex.has("lineItem/LineItemType") ? headerIndex.get("lineItem/LineItemType") : -1;

  // Defensive row-count cap (see file header for streaming trade-off).
  if (rows.length - 1 > MAX_CUR_ROWS) {
    throw curError(
      `CUR has ${rows.length - 1} data rows, which exceeds the ${MAX_CUR_ROWS.toLocaleString("en-US")}-row safety cap. ` +
        `Filter the export to a single AWS account or month before uploading.`,
    );
  }

  // Aggregate by (productCode, usageType, term). Skip non-Usage rows (Tax,
  // Credit, Refund, etc.) so totals reflect actual spend.
  const agg = new Map();
  let total = 0;
  let usageRowsSeen = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0] === "") continue; // blank line
    if (row.length < header.length - 2) continue; // severely truncated row, skip

    const lineType = iType >= 0 ? row[iType] : "Usage";
    if (lineType && lineType !== "Usage") continue;

    const cost = parseFloat(row[iCost]);
    if (!Number.isFinite(cost) || cost <= 0) continue;

    const product = row[iProd] || "";
    const usage = row[iUsage] || "";
    const term = iTerm >= 0 ? (row[iTerm] || "OnDemand") : "OnDemand";
    if (!product) continue;

    const key = `${product}\u0001${usage}\u0001${term}`;
    const prev = agg.get(key);
    if (prev) {
      prev.cost += cost;
    } else {
      agg.set(key, { product, usage, term, cost });
    }
    total += cost;
    usageRowsSeen += 1;
  }

  if (usageRowsSeen === 0) {
    throw curError(
      "No usable Usage rows found in the CUR — every row was filtered out. " +
        "Verify the file is not empty and that lineItem/UnblendedCost contains numbers.",
    );
  }

  const items = [...agg.values()].sort((a, b) => b.cost - a.cost);

  const topItems = items.slice(0, 10).map((it) => ({
    service: prettyService(it.product),
    productCode: it.product,
    usageType: it.usage,
    term: it.term || "OnDemand",
    monthlySpend: round(it.cost),
  }));

  // -------------------------------------------------------------------------
  // Heuristic 1 — RI/SP coverage gap on EC2/RDS
  // -------------------------------------------------------------------------
  const onDemandCompute = items.filter(
    (it) =>
      (it.product === "AmazonEC2" || it.product === "AmazonRDS") &&
      (it.term === "OnDemand" || it.term === "" || it.term == null) &&
      /(BoxUsage|InstanceUsage)/.test(it.usage),
  );
  const onDemandComputeSpend = onDemandCompute.reduce((s, it) => s + it.cost, 0);

  // -------------------------------------------------------------------------
  // Heuristic 2 — gp2 EBS migration to gp3 (substitute for IOPS-based idle
  // detection — see file header for why)
  // -------------------------------------------------------------------------
  const gp2Storage = items.filter((it) => /EBS:VolumeUsage\.gp2/i.test(it.usage));
  const gp2Spend = gp2Storage.reduce((s, it) => s + it.cost, 0);

  // -------------------------------------------------------------------------
  // Heuristic 3 — oversized RDS (xlarge or larger)
  // -------------------------------------------------------------------------
  // Match db.<family>.{2,4,8,12,16,24}xlarge AND plain "xlarge" (smallest
  // tier we'd consider downsizing). Excludes db.t3.medium etc.
  const bigRds = items.filter(
    (it) =>
      it.product === "AmazonRDS" &&
      /db\.[a-z0-9]+\.((2|4|8|12|16|24)xlarge|xlarge|metal)/i.test(it.usage),
  );
  const bigRdsSpend = bigRds.reduce((s, it) => s + it.cost, 0);

  const suggestions = [];

  if (onDemandComputeSpend >= 100) {
    const savings = round(onDemandComputeSpend * 0.30);
    suggestions.push({
      title:
        `Cover on-demand EC2/RDS with a 1-year Savings Plan ` +
        `(${onDemandCompute.length} usage type${onDemandCompute.length === 1 ? "" : "s"}, ` +
        `$${round(onDemandComputeSpend).toLocaleString("en-US")}/mo on-demand)`,
      impact: impactOf(savings),
      savingsEstimate: savings,
      service: "EC2 + RDS on-demand",
      rule: "ri_sp_coverage_gap",
    });
  }

  if (gp2Spend >= 25) {
    const savings = round(gp2Spend * 0.20);
    suggestions.push({
      title:
        `Migrate ${gp2Storage.length} gp2 EBS usage type${gp2Storage.length === 1 ? "" : "s"} to gp3 ` +
        `— same performance, ~20% cheaper ` +
        `($${round(gp2Spend).toLocaleString("en-US")}/mo current gp2 spend)`,
      impact: impactOf(savings),
      savingsEstimate: savings,
      service: "EBS gp2 volumes",
      rule: "legacy_ebs_storage",
    });
  }

  if (bigRdsSpend >= 100) {
    const savings = round(bigRdsSpend * 0.40);
    suggestions.push({
      title:
        `Right-size oversized RDS instances down one tier ` +
        `(${bigRds.length} xlarge+ usage type${bigRds.length === 1 ? "" : "s"}, ` +
        `$${round(bigRdsSpend).toLocaleString("en-US")}/mo)`,
      impact: impactOf(savings),
      savingsEstimate: savings,
      service: "RDS oversized",
      rule: "oversized_rds",
    });
  }

  suggestions.sort(
    (a, b) => b.savingsEstimate - a.savingsEstimate || a.title.localeCompare(b.title),
  );

  const currentSpend = round(total);
  const totalSavings = suggestions.reduce((s, x) => s + x.savingsEstimate, 0);
  const totalSavingsPct =
    currentSpend > 0 ? Math.round((totalSavings / currentSpend) * 1000) / 10 : 0;

  return {
    currentSpend,
    suggestions,
    totalSavingsPct,
    topItems,
  };
}

export const _CUR_HELP_URL = HELP_URL;
