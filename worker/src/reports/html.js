// The client-facing HTML audit report.
//
// This is the artefact a customer forwards to THEIR client, so it is written
// as a document rather than as a dashboard screen: light ground, one column,
// hairline rules, and a print stylesheet that turns it into a clean PDF via
// the browser's own "Save as PDF". That is the whole PDF story — no headless
// browser in the Worker. Chromium in a Worker would mean a container, a cold
// start measured in seconds, and a second rendering engine to keep in step
// with this file; the browser the reader already has does the job for free and
// produces selectable text rather than a raster.
//
// Self-contained on purpose: inline CSS, no scripts beyond one print button,
// no remote fonts or images except a white-label logo the org explicitly set.
// The file has to survive being emailed as an attachment and opened offline.
//
// EVERYTHING INTERPOLATED IS ESCAPED. Advisory summaries come from OSV, and
// package names come from the customer's lockfile — both are external text
// arriving in a document we are encouraging people to forward.

import { ALGOSIZE_BRANDING, safeLogoUrl } from "./branding.js";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "unknown"];

const SEVERITY_LABEL = {
  critical: "Critical",
  high:     "High",
  medium:   "Medium",
  low:      "Low",
  unknown:  "Unrated",
};

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** ISO instant → "17 August 2026 at 20:41 UTC". Unambiguous across locales. */
function formatTimestamp(ms) {
  const d = new Date(typeof ms === "number" ? ms : Date.now());
  const months = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} at ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// ---------------------------------------------------------------------------
// Styles
//
// Palette is a document palette, not the product's. The marketing site is dark
// with a bright teal; a report printed on a client's office laser printer needs
// dark ink on white, and severity colours that stay distinguishable in
// greyscale — so the four severities differ in LIGHTNESS as well as hue, and
// every one of them is labelled in words next to its colour.
// ---------------------------------------------------------------------------
const STYLES = `
  :root {
    --ink:        #101418;
    --ink-muted:  #5b6472;
    --ink-faint:  #8a929e;
    --ground:     #ffffff;
    --panel:      #f6f8fa;
    --rule:       #dfe3e9;
    --accent:     #0f766e;

    --sev-critical: #b4232c;
    --sev-high:     #b4560f;
    --sev-medium:   #7d6400;
    --sev-low:      #4a5563;
    --sev-unknown:  #5b6472;

    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    padding: 40px 24px 72px;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.6;
    -webkit-text-size-adjust: 100%;
  }

  .sheet { max-width: 60rem; margin: 0 auto; }

  h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: -0.01em; line-height: 1.25; }
  h1 { font-size: 1.75rem; }
  h2 { font-size: 1.125rem; margin-bottom: 12px; }
  h3 { font-size: 0.95rem; }
  p  { margin: 0 0 10px; }
  a  { color: var(--accent); }

  code, .mono { font-family: var(--mono); font-size: 0.9em; }

  /* --- Masthead --- */
  .masthead {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 24px; flex-wrap: wrap;
    padding-bottom: 20px; border-bottom: 2px solid var(--ink);
  }
  .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand img { max-height: 44px; max-width: 220px; width: auto; height: auto; display: block; }
  .brand-name { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; }
  .masthead-meta { text-align: right; font-size: 0.8rem; color: var(--ink-muted); }
  .masthead-meta div + div { margin-top: 2px; }

  .doc-title { margin: 28px 0 6px; }
  .doc-sub { color: var(--ink-muted); margin-bottom: 28px; }

  /* --- Section --- */
  section { margin-bottom: 32px; }
  .eyebrow {
    font-family: var(--mono); font-size: 0.68rem; font-weight: 700;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-faint);
    margin-bottom: 6px;
  }

  /* --- Verdict --- */
  .verdict {
    display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
    padding: 20px 24px; background: var(--panel);
    border: 1px solid var(--rule); border-radius: 8px;
  }
  .grade { font-size: 3rem; font-weight: 700; line-height: 1; letter-spacing: -0.03em; }
  .grade-note { font-size: 0.8rem; color: var(--ink-muted); }
  .score { font-family: var(--mono); font-size: 1rem; color: var(--ink-muted); }

  .counts { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
  .count {
    min-width: 74px; padding: 8px 12px; border-radius: 6px;
    background: var(--ground); border: 1px solid var(--rule); text-align: center;
  }
  .count .n { font-family: var(--mono); font-size: 1.25rem; font-weight: 700; display: block; line-height: 1.2; }
  .count .l { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-muted); }
  .count-critical .n { color: var(--sev-critical); }
  .count-high     .n { color: var(--sev-high); }
  .count-medium   .n { color: var(--sev-medium); }
  .count-low      .n { color: var(--sev-low); }
  .count-unknown  .n { color: var(--sev-unknown); }

  /* --- Caveat --- */
  .caveat {
    padding: 14px 18px; border-radius: 8px;
    background: #fff8e6; border: 1px solid #e5c76b; border-left: 4px solid #b4560f;
    font-size: 0.9rem;
  }
  .caveat strong { color: #7a3c0a; }

  /* --- Definition grid (scope) --- */
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px 24px; margin: 0; }
  .fact dt {
    font-family: var(--mono); font-size: 0.68rem; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--ink-faint); margin-bottom: 2px;
  }
  .fact dd { margin: 0; font-size: 0.9rem; overflow-wrap: anywhere; }

  /* --- Remediation --- */
  ol.steps { margin: 0; padding: 0; list-style: none; counter-reset: step; }
  ol.steps li {
    counter-increment: step; position: relative;
    padding: 14px 0 14px 44px; border-top: 1px solid var(--rule);
  }
  ol.steps li:first-child { border-top: 0; }
  ol.steps li::before {
    content: counter(step); position: absolute; left: 0; top: 14px;
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--ink); color: var(--ground);
    font-family: var(--mono); font-size: 0.8rem; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .step-action { font-weight: 600; }
  .step-why { color: var(--ink-muted); font-size: 0.875rem; margin: 4px 0 0; }
  .step-cmd {
    display: inline-block; margin-top: 8px; padding: 6px 10px;
    background: var(--panel); border: 1px solid var(--rule); border-radius: 5px;
    font-family: var(--mono); font-size: 0.85rem;
  }
  .prio {
    display: inline-block; margin-right: 8px; padding: 1px 7px; border-radius: 4px;
    font-family: var(--mono); font-size: 0.66rem; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase;
    border: 1px solid currentColor;
  }
  .prio-now  { color: var(--sev-critical); }
  .prio-high { color: var(--sev-high); }
  .prio-medium { color: var(--sev-medium); }

  /* --- Findings table --- */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  caption { text-align: left; color: var(--ink-muted); font-size: 0.85rem; padding-bottom: 10px; }
  th {
    text-align: left; font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--ink-faint); font-family: var(--mono); font-weight: 700;
    padding: 0 10px 8px 0; border-bottom: 1px solid var(--ink);
    /* Column labels are two words at most; wrapping one makes the header row
       taller than the rows it labels. */
    white-space: nowrap;
  }
  td { padding: 10px 10px 10px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pkg { font-family: var(--mono); font-weight: 600; overflow-wrap: anywhere; }
  .vector { font-family: var(--mono); font-size: 0.72rem; color: var(--ink-muted); overflow-wrap: anywhere; }
  .summary-cell { color: var(--ink-muted); }
  .fixed { font-family: var(--mono); color: var(--accent); font-weight: 600; }
  .nofix { font-family: var(--mono); color: var(--sev-high); }

  /* Severity is never colour alone: the word is always present, and the swatch
     is a bordered pill so it survives greyscale printing. */
  .sev {
    display: inline-block; padding: 1px 8px; border-radius: 999px;
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em;
    border: 1.5px solid currentColor; white-space: nowrap;
  }
  .sev-critical { color: var(--sev-critical); }
  .sev-high     { color: var(--sev-high); }
  .sev-medium   { color: var(--sev-medium); }
  .sev-low      { color: var(--sev-low); }
  .sev-unknown  { color: var(--sev-unknown); }

  .clean {
    padding: 20px 24px; border: 1px solid var(--rule); border-radius: 8px;
    background: var(--panel); color: var(--ink-muted);
  }

  /* --- Footer --- */
  .colophon {
    margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--rule);
    font-size: 0.78rem; color: var(--ink-faint);
  }
  .colophon p { margin: 0 0 4px; }

  .toolbar { margin-bottom: 24px; }
  .print-btn {
    font: inherit; font-size: 0.85rem; font-weight: 600;
    padding: 8px 14px; border-radius: 6px; cursor: pointer;
    background: var(--ink); color: var(--ground); border: 1px solid var(--ink);
  }

  /* --- Print ---
     This is the PDF pipeline. The reader presses Cmd-P and gets a document
     with selectable text, real page breaks, and repeated table headers. */
  @page { margin: 16mm 14mm; }

  @media print {
    body { padding: 0; font-size: 10.5pt; }
    .sheet { max-width: none; }
    .toolbar { display: none; }

    /* Backgrounds are dropped by default in print; the ones that carry meaning
       are asked for explicitly and given a border so they still read if the
       printer or the user refuses background graphics. */
    .verdict, .caveat, .clean, .step-cmd, .count {
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }

    /* Keep a finding's row and a remediation step whole across a page break —
       half a row at the foot of a page is where a reader loses the thread. */
    tr, ol.steps li, .verdict, .caveat { break-inside: avoid; page-break-inside: avoid; }
    thead { display: table-header-group; }
    section { break-inside: auto; }
    h2 { break-after: avoid; page-break-after: avoid; }

    /* A printed link is unusable unless its target is on the page. Advisory
       URLs are the one thing a reader of a PDF genuinely needs to follow. */
    .table-wrap a[href]::after { content: " (" attr(href) ")"; font-size: 0.75em; color: #444; word-break: break-all; }

    .table-wrap { overflow-x: visible; }
  }
`;

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function mastheadHtml(branding, generatedAt) {
  const logo = safeLogoUrl(branding && branding.logoUrl);
  const name = escapeHtml((branding && branding.companyName) || ALGOSIZE_BRANDING.companyName);
  return `
    <header class="masthead">
      <div class="brand">
        ${logo ? `<img src="${escapeHtml(logo)}" alt="${name}" />` : ""}
        <span class="brand-name">${name}</span>
      </div>
      <div class="masthead-meta">
        <div>Dependency audit report</div>
        <div>${escapeHtml(formatTimestamp(generatedAt))}</div>
      </div>
    </header>`;
}

function verdictHtml(summary, counts) {
  const grade = escapeHtml(summary.grade || "—");
  const score = typeof summary.securityScore === "number" ? summary.securityScore : null;

  const cell = (key) => `
        <div class="count count-${key}">
          <span class="n">${counts[key] || 0}</span>
          <span class="l">${SEVERITY_LABEL[key]}</span>
        </div>`;

  // Unrated gets a tile ONLY when there is something in it — but then it must
  // have one. Without it the tiles sum to less than the number of rows in the
  // findings table, and a reader who adds up the summary and gets a different
  // answer from the table below stops trusting the whole document. An advisory
  // we could not score is still an advisory.
  const shown = ["critical", "high", "medium", "low"];
  if ((counts.unknown || 0) > 0) shown.push("unknown");

  // Say which cap actually bound this grade, rather than reciting the rule
  // set. On a clean report the generic version reads as a warning about
  // nothing; here it explains the number the reader is looking at.
  const note = (counts.critical || 0) > 0
    ? "A single critical finding caps the grade at&nbsp;F, whatever else is clean."
    : (counts.high || 0) > 0
    ? "A single high finding caps the grade at&nbsp;D, whatever else is clean."
    : (counts.unknown || 0) > 0
    ? "An advisory we could not score caps the grade at&nbsp;C — an unrated finding is not a low one."
    : "No severity cap applied: this grade is the deduction arithmetic alone.";

  return `
    <div class="verdict">
      <div>
        <div class="grade">${grade}</div>
        <div class="score">${score === null ? "" : `${score} / 100`}</div>
      </div>
      <div class="grade-note">${note}</div>
      <div class="counts">
        ${shown.map(cell).join("")}
      </div>
    </div>`;
}

function scopeHtml({ result, run, generatedAt }) {
  const scanned   = result.scanned || {};
  const manifests = scanned.manifests || [];
  const ci        = result.ci || {};
  const input     = (run && run.input) || {};

  const facts = [
    ["Report generated", formatTimestamp(generatedAt)],
    ["Run id", (run && run.id) || "—"],
    ["Source", run && run.source === "ci" ? "Continuous integration" : "Dashboard"],
  ];

  const repo = ci.repo || input.repo || (input.repoUrl ? String(input.repoUrl) : null);
  if (repo) facts.push(["Repository", repo]);
  if (ci.ref) facts.push(["Ref", ci.ref]);
  if (ci.commitSha) facts.push(["Commit", String(ci.commitSha).slice(0, 12)]);

  facts.push([
    "Manifests scanned",
    manifests.length ? manifests.map((m) => m.filename).join(", ") : "—",
  ]);
  facts.push([
    "Packages audited",
    typeof scanned.totalPackages === "number"
      ? (typeof scanned.packagesFound === "number" && scanned.packagesFound > scanned.totalPackages
          ? `${scanned.totalPackages} of ${scanned.packagesFound} found`
          : String(scanned.totalPackages))
      : "—",
  ]);
  facts.push(["Advisory source", "OSV.dev"]);

  return `
    <section>
      <p class="eyebrow">Scope</p>
      <h2>What this report covers</h2>
      <dl class="facts">
        ${facts.map(([k, v]) => `
        <div class="fact">
          <dt>${escapeHtml(k)}</dt>
          <dd>${escapeHtml(v)}</dd>
        </div>`).join("")}
      </dl>
    </section>`;
}

function caveatHtml(summary) {
  if (summary.complete !== false) return "";
  return `
    <section>
      <div class="caveat">
        <strong>This audit did not cover everything.</strong>
        ${escapeHtml(summary.partialReason ||
          "The audit hit an internal cap, so the counts below are a lower bound rather than a total.")}
      </div>
    </section>`;
}

function remediationHtml(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return "";
  const prioClass = (p) => (p === "now" ? "prio-now" : p === "high" ? "prio-high" : "prio-medium");
  return `
    <section>
      <p class="eyebrow">Remediation</p>
      <h2>What to do, in order</h2>
      <ol class="steps">
        ${steps.map((s) => `
        <li>
          <p class="step-action"><span class="prio ${prioClass(s.priority)}">${escapeHtml(s.priority || "next")}</span>${escapeHtml(s.action || "")}</p>
          ${s.why ? `<p class="step-why">${escapeHtml(s.why)}</p>` : ""}
          ${s.command ? `<code class="step-cmd">${escapeHtml(s.command)}</code>` : ""}
        </li>`).join("")}
      </ol>
    </section>`;
}

function findingsHtml(advisories) {
  if (!advisories.length) {
    return `
    <section>
      <p class="eyebrow">Findings</p>
      <h2>Advisories</h2>
      <div class="clean">
        No known advisories affect the audited packages. This is a statement
        about what was published at the time of the scan, not a guarantee about
        code that has not been looked at since.
      </div>
    </section>`;
  }

  const sorted = [...advisories].sort((a, b) => {
    const d = SEVERITY_ORDER.indexOf(a.severity || "unknown") - SEVERITY_ORDER.indexOf(b.severity || "unknown");
    if (d !== 0) return d;
    return (b.cvssScore || 0) - (a.cvssScore || 0);
  });

  const row = (a) => {
    const sev = SEVERITY_ORDER.includes(a.severity) ? a.severity : "unknown";
    return `
        <tr>
          <td>
            <div class="pkg">${escapeHtml(a.package)}</div>
            <div class="vector">${escapeHtml(a.ecosystem || "")}</div>
          </td>
          <td class="num">${escapeHtml(a.installedVersion)}</td>
          <td class="num">${a.fixedIn
            ? `<span class="fixed">${escapeHtml(a.fixedIn)}</span>`
            : `<span class="nofix">none</span>`}</td>
          <td><span class="sev sev-${sev}">${SEVERITY_LABEL[sev]}</span></td>
          <td class="num">${a.cvssScore == null ? "—" : escapeHtml(a.cvssScore)}${
            a.severityApproximate ? ` <abbr title="CVSS v4.0 base scores are approximated, not computed">≈</abbr>` : ""}</td>
          <td>
            <div><a href="${escapeHtml(a.advisoryUrl || `https://osv.dev/vulnerability/${encodeURIComponent(a.id || "")}`)}">${escapeHtml(a.id)}</a></div>
            ${a.summary ? `<div class="summary-cell">${escapeHtml(a.summary)}</div>` : ""}
            ${a.cvssVector ? `<div class="vector">${escapeHtml(a.cvssVector)}</div>` : ""}
          </td>
        </tr>`;
  };

  return `
    <section>
      <p class="eyebrow">Findings</p>
      <h2>Advisories</h2>
      <div class="table-wrap">
        <table>
          <caption>
            Sorted worst first. Every score is the CVSS base score computed from
            the vector printed beneath the advisory id — not a text rating copied
            from the advisory. A “≈” marks a v4.0 vector, which we approximate.
          </caption>
          <thead>
            <tr>
              <th>Package</th><th>Installed</th><th>Fixed in</th>
              <th>Severity</th><th>CVSS</th><th>Advisory</th>
            </tr>
          </thead>
          <tbody>${sorted.map(row).join("")}</tbody>
        </table>
      </div>
    </section>`;
}

function colophonHtml(branding, run) {
  const attribution = branding.whiteLabel
    ? `Prepared by ${escapeHtml(branding.companyName)}.`
    : `Generated by Algosize.`;
  return `
    <footer class="colophon">
      <p>${attribution} Advisory data from OSV.dev. CVSS base scores computed from published vectors per the FIRST CVSS specification.</p>
      <p>Run ${escapeHtml((run && run.id) || "—")}. This report describes the state of the audited manifests at the time of the scan.</p>
    </footer>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render the full standalone HTML report for a stored vuln run.
 *
 * `run`      the record from getRun(): id, source, input, result, createdAt.
 * `branding` from brandingFor() — already entitlement-checked. Defaults to
 *            Algosize branding when omitted, so a caller that forgets to
 *            resolve entitlement cannot accidentally produce an unbranded
 *            report; the failure mode points the safe way.
 */
export function renderReportHtml(run, { branding = ALGOSIZE_BRANDING, generatedAt = null } = {}) {
  const result   = (run && run.result) || {};
  const summary  = result.summary || {};
  const counts   = summary.counts || result.counts || {};
  const advisories = Array.isArray(result.advisories) ? result.advisories : [];
  const when = typeof generatedAt === "number" ? generatedAt : Date.now();

  const title = branding.whiteLabel
    ? `Dependency audit — ${branding.companyName}`
    : "Dependency audit — Algosize";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="sheet">
  <div class="toolbar">
    <button type="button" class="print-btn" onclick="window.print()">Print or save as PDF</button>
  </div>

  ${mastheadHtml(branding, when)}

  <h1 class="doc-title">Dependency audit report</h1>
  <p class="doc-sub">
    Known vulnerabilities in the declared dependencies of the manifests listed
    below, scored from their published CVSS vectors.
  </p>

  <section>
    <p class="eyebrow">Verdict</p>
    <h2>Summary</h2>
    ${verdictHtml(summary, counts)}
  </section>

  ${caveatHtml(summary)}
  ${scopeHtml({ result, run, generatedAt: when })}
  ${remediationHtml(summary.remediation)}
  ${findingsHtml(advisories)}
  ${colophonHtml(branding, run)}
</div>
</body>
</html>`;
}
