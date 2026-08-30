// Algosize dashboard — vanilla JS only.
//
// Wires the three analyzer panels (cost / vuln / algo) and the logout button
// to the Cloudflare Worker. All requests send the session cookie via
// `credentials: "include"`. A 401 from any endpoint means the session is
// gone (subscription expired, server-side revoked, or never logged in) — we
// bounce the user back to the marketing page.
//
// API base comes from window.ALGOSIZE_API_BASE (set by the Jekyll layout
// from site/_config.yml). Empty string means same-origin; in dev it points
// at the wrangler dev server (e.g. http://127.0.0.1:8787).

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Tiny helpers
  // -----------------------------------------------------------------------

  function apiUrl(path) {
    var base = (window.ALGOSIZE_API_BASE || "").replace(/\/$/, "");
    return base + path;
  }

  function $(sel) { return document.querySelector(sel); }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === "class") n.className = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
    }
    if (text != null) n.textContent = text;
    return n;
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
      button.textContent = busyText || "Running…";
      button.disabled = true;
    } else {
      if (button.dataset.originalText) button.textContent = button.dataset.originalText;
      button.disabled = false;
    }
  }

  function showOutput(target, node) {
    var out = $("#output-" + target);
    if (!out) return;
    // Defensive clear: never use innerHTML so we can't accidentally introduce
    // an XSS sink if a future caller passes a string instead of a DOM node.
    while (out.firstChild) out.removeChild(out.firstChild);
    out.appendChild(node);
  }

  function emptyState(msg) {
    return el("div", { class: "panel-empty" }, msg || "No results.");
  }

  function errorState(msg, helpUrl, helpLabel) {
    var div = el("div", { class: "panel-error" });
    div.appendChild(el("strong", null, "Error"));
    div.appendChild(el("p", null, msg));
    if (helpUrl) {
      var p = el("p", null);
      p.appendChild(el("a", { href: helpUrl, target: "_blank", rel: "noopener" },
        helpLabel || "Read the docs →"));
      div.appendChild(p);
    }
    return div;
  }

  function formatUsd(n) {
    if (typeof n !== "number" || !isFinite(n)) return String(n);
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  // -----------------------------------------------------------------------
  // Sample inputs
  // -----------------------------------------------------------------------
  //
  // The cost sample is now a small synthetic CUR — the dashboard shipped
  // with a JSON sample before Task #14. CUR-shaped sample exercises all
  // three heuristics (RI/SP gap, gp2→gp3, oversized RDS) so users see a
  // realistic result on click-Sample.

  var SAMPLE_CUR = [
    "identity/LineItemId,bill/PayerAccountId,lineItem/UsageStartDate,lineItem/ProductCode,lineItem/UsageType,lineItem/LineItemType,lineItem/UnblendedCost,pricing/term",
    "1,123456789012,2024-01-01T00:00:00Z,AmazonEC2,USE1-BoxUsage:m5.xlarge,Usage,1450.00,OnDemand",
    "2,123456789012,2024-01-01T00:00:00Z,AmazonEC2,USE1-BoxUsage:m5.large,Usage,640.00,OnDemand",
    "3,123456789012,2024-01-01T00:00:00Z,AmazonEC2,USE1-BoxUsage:c6i.2xlarge,Usage,820.00,Reserved",
    "4,123456789012,2024-01-01T00:00:00Z,AmazonRDS,USE1-InstanceUsage:db.r5.4xlarge,Usage,1180.00,OnDemand",
    "5,123456789012,2024-01-01T00:00:00Z,AmazonRDS,USE1-InstanceUsage:db.t3.medium,Usage,42.00,OnDemand",
    "6,123456789012,2024-01-01T00:00:00Z,AmazonEBS,USE1-EBS:VolumeUsage.gp2,Usage,310.00,OnDemand",
    "7,123456789012,2024-01-01T00:00:00Z,AmazonEBS,USE1-EBS:VolumeUsage.gp3,Usage,90.00,OnDemand",
    "8,123456789012,2024-01-01T00:00:00Z,AmazonS3,USE1-TimedStorage-ByteHrs,Usage,210.00,",
    "9,123456789012,2024-01-01T00:00:00Z,AWSDataTransfer,USE1-EUC1-AWS-Out-Bytes,Usage,470.00,",
    "10,123456789012,2024-01-01T00:00:00Z,AmazonEC2,Tax,Tax,180.00,",
    ""
  ].join("\n");

  var SAMPLES = {
    // Sample repo URL for the vuln panel. juice-shop is OWASP's intentionally
    // vulnerable Node.js demo app — its lockfile is large and consistently
    // turns up advisories, so the demo never feels empty.
    vuln: "https://github.com/juice-shop/juice-shop",

    algo: [
      "function findDuplicates(items) {",
      "  const dupes = [];",
      "  for (let i = 0; i < items.length; i++) {",
      "    for (let j = i + 1; j < items.length; j++) {",
      "      if (items[i] === items[j]) dupes.push(items[i]);",
      "    }",
      "  }",
      "  return dupes;",
      "}",
      ""
    ].join("\n"),

    // Sample input passed to the algo function — array of integers with a
    // duplicate so findDuplicates() returns a non-empty result.
    algoSample: "[3, 1, 4, 1, 5, 9, 2, 6, 5, 3]"
  };

  // Cost panel state: a real File from the picker, OR a Blob synthesized
  // from the built-in sample CUR. `pendingCostBlob` is whichever the user
  // most recently selected.
  var pendingCostBlob = null;
  var pendingCostName = null;

  function setCostFile(blob, displayName) {
    pendingCostBlob = blob;
    pendingCostName = displayName;
    var label = $("#input-cost-name");
    if (label) label.textContent = displayName || "No file selected.";
  }

  // -----------------------------------------------------------------------
  // Fetch wrapper: always send cookies; redirect to / on 401
  // -----------------------------------------------------------------------

  function callApi(path, body, method) {
    var init = {
      method: method || "POST",
      headers: { "Accept": "application/json" },
      credentials: "include"
    };
    if (body !== undefined && body !== null) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(apiUrl(path), init).then(function (res) {
      if (res.status === 401) {
        // Session is gone (or never existed). Bounce home and never resolve so
        // callers don't try to render anything in the meantime.
        window.location.assign("/");
        return new Promise(function () { /* never resolves */ });
      }
      return res.json().then(function (json) {
        if (!res.ok) {
          // Task #19: surface the quota_exceeded banner immediately so even
          // if the caller's .catch() handler does nothing, the user sees a
          // clear upgrade CTA. We still throw so analyzer renderers don't
          // accidentally render "0 findings".
          if (res.status === 402 && json && json.error === "quota_exceeded") {
            showQuotaBanner(json);
          }
          var msg = (json && (json.message || json.error)) || ("HTTP " + res.status);
          var err = new Error(msg);
          if (json && json.helpUrl) err.helpUrl = json.helpUrl;
          if (json && json.error)   err.code    = json.error;
          // Keep structured server feedback available to feature modules.
          // Validation endpoints use an errors[] array so callers can place
          // each message beside the control that needs attention.
          if (json && Array.isArray(json.errors)) err.errors = json.errors;
          if (json && json.schema) err.schema = json.schema;
          throw err;
        }
        return json;
      }, function () {
        throw new Error("HTTP " + res.status + " (non-JSON response)");
      });
    });
  }

  // Multipart variant for the CUR upload — bypasses callApi because we don't
  // want fetch to set application/json on a FormData body.
  function callApiMultipart(path, formData) {
    return fetch(apiUrl(path), {
      method: "POST",
      credentials: "include",
      headers: { "Accept": "application/json" },
      body: formData
    }).then(function (res) {
      if (res.status === 401) {
        window.location.assign("/");
        return new Promise(function () {});
      }
      return res.json().then(function (json) {
        if (!res.ok) {
          // Mirror callApi's 402 handling for the multipart CUR path.
          if (res.status === 402 && json && json.error === "quota_exceeded") {
            showQuotaBanner(json);
          }
          var msg = (json && (json.message || json.error)) || ("HTTP " + res.status);
          var err = new Error(msg);
          if (json && json.helpUrl) err.helpUrl = json.helpUrl;
          if (json && json.error)   err.code    = json.error;
          throw err;
        }
        return json;
      }, function () {
        throw new Error("HTTP " + res.status + " (non-JSON response)");
      });
    });
  }

  // -----------------------------------------------------------------------
  // Renderers — one per panel
  // -----------------------------------------------------------------------

  function statCard(label, value, extraValueClass) {
    var card = el("div", { class: "stat-card" });
    card.appendChild(el("div", { class: "stat-label" }, label));
    card.appendChild(el("div", { class: "stat-value" + (extraValueClass ? " " + extraValueClass : "") }, value));
    return card;
  }

  function renderCost(result) {
    var wrap = el("div", { class: "result-wrap" });

    var stats = el("div", { class: "result-stats" });
    stats.appendChild(statCard("Current spend / mo", formatUsd(result.currentSpend)));
    stats.appendChild(statCard("Projected savings", result.totalSavingsPct + "%", "accent"));
    stats.appendChild(statCard("Suggestions", String(result.suggestions.length)));
    wrap.appendChild(stats);

    if (!result.suggestions.length) {
      wrap.appendChild(emptyState("No savings opportunities detected."));
    } else {
      var ul = el("ul", { class: "result-list" });
      result.suggestions.forEach(function (s) {
        var li = el("li", { class: "result-item impact-" + s.impact });
        var top = el("div", { class: "result-item-top" });
        top.appendChild(el("span", { class: "tag tag-impact tag-" + s.impact }, s.impact));
        top.appendChild(el("span", { class: "result-item-title" }, s.title));
        top.appendChild(el("span", { class: "result-item-savings mono" }, formatUsd(s.savingsEstimate) + " / mo"));
        li.appendChild(top);
        li.appendChild(el("p", { class: "result-item-meta mono" }, s.service + " · " + s.rule));
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }

    if (result.topItems && result.topItems.length) {
      wrap.appendChild(el("h4", { class: "result-section-title" }, "Top line items"));
      var table = el("table", { class: "result-table" });
      var thead = el("thead", null);
      var thr = el("tr", null);
      ["Service", "Usage type", "Term", "$/mo"].forEach(function (h) {
        thr.appendChild(el("th", null, h));
      });
      thead.appendChild(thr);
      table.appendChild(thead);
      var tbody = el("tbody", null);
      result.topItems.forEach(function (it) {
        var tr = el("tr", null);
        tr.appendChild(el("td", null, it.service));
        tr.appendChild(el("td", { class: "mono" }, it.usageType));
        tr.appendChild(el("td", null, it.term));
        tr.appendChild(el("td", { class: "mono result-table-num" }, formatUsd(it.monthlySpend)));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }

    showOutput("cost", wrap);
    renderCostChart(result.suggestions);
  }

  var costChart = null;

  function renderCostChart(suggestions) {
    var wrap   = $("#chart-cost-wrap");
    var canvas = $("#chart-cost");
    if (!wrap || !canvas) return;

    if (!suggestions || !suggestions.length || typeof window.Chart === "undefined") {
      wrap.hidden = true;
      if (costChart) { costChart.destroy(); costChart = null; }
      return;
    }

    wrap.hidden = false;
    var top    = suggestions.slice(0, 6);
    var labels = top.map(function (s) { return s.title; });
    var data   = top.map(function (s) { return s.savingsEstimate; });

    if (costChart) costChart.destroy();
    costChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Savings (USD / mo)",
          data: data,
          backgroundColor: "rgba(94, 234, 212, 0.55)",
          borderColor:     "#5eead4",
          borderWidth:     1,
          borderRadius:    6,
          maxBarThickness: 56
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend:  { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) { return formatUsd(ctx.parsed.y) + " / mo"; }
            }
          }
        },
        scales: {
          x: { ticks: { color: "#8a93a3", maxRotation: 30, minRotation: 0 }, grid: { display: false } },
          y: { ticks: { color: "#8a93a3", callback: function (v) { return formatUsd(v); } },
               grid:  { color: "#1e2532" }, beginAtZero: true }
        }
      }
    });
  }

  function countBySeverity(findings) {
    var c = { critical: 0, high: 0, medium: 0, low: 0 };
    findings.forEach(function (f) {
      if (c[f.severity] === undefined) c[f.severity] = 0;
      c[f.severity] += 1;
    });
    return c;
  }

  // Build a "Generate fix" button for one finding. `mount(node)` decides
  // where the returned fix renders (table detail row, card footer, ...).
  // POST /api/fix is authenticated + rate-limited; 503 means no AI provider
  // is configured and the button says so instead of pretending to retry.
  function makeFixButton(payload, mount) {
    var btn = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Generate fix");
    btn.addEventListener("click", function () {
      setBusy(btn, true, "Generating…");
      callApi("/api/fix", payload)
        .then(function (res) {
          var box = el("div", { class: "fix-result" });
          if (res.fix && res.fix.text) {
            box.appendChild(el("p", { class: "result-reason" }, res.fix.text));
          }
          if (res.fix && res.fix.code) {
            box.appendChild(el("pre", { class: "result-snippet" }, res.fix.code));
          }
          if (!res.fix || (!res.fix.text && !res.fix.code)) {
            box.appendChild(el("p", { class: "result-reason" }, "The AI returned an empty fix. Try again."));
          }
          mount(box);
          btn.remove();
        })
        .catch(function (err) {
          setBusy(btn, false);
          mount(el("p", { class: "result-reason" },
            err && err.code === "fix_generation_unavailable"
              ? "AI fix generation is not configured on this deployment."
              : "Fix generation failed: " + (err && err.message || "unknown error")));
        });
    });
    return btn;
  }

  function renderVuln(result) {
    // Task #15 lockfile-audit shape:
    //   { repoUrl, scanned, counts, advisories, topAdvisories, fixCommand }
    var wrap = el("div", { class: "result-wrap" });

    var counts = result.counts || { critical: 0, high: 0, medium: 0, low: 0 };
    var stats  = el("div", { class: "result-stats result-stats-4" });
    ["critical", "high", "medium", "low"].forEach(function (sev) {
      stats.appendChild(statCard(sev, String(counts[sev] || 0), "sev-" + sev));
    });
    wrap.appendChild(stats);

    if (result.scanned && result.scanned.manifests && result.scanned.manifests.length) {
      var meta = el("p", { class: "result-item-meta mono" },
        "Scanned " + result.scanned.totalPackages + " packages from " +
        result.scanned.manifests.map(function (m) { return m.filename; }).join(", "));
      wrap.appendChild(meta);
    }

    var advisories = result.topAdvisories || result.advisories || [];
    if (!advisories.length) {
      wrap.appendChild(emptyState("No known advisories. Nice."));
    } else {
      wrap.appendChild(el("h4", { class: "result-section-title" }, "Top advisories"));
      var table = el("table", { class: "result-table" });
      var thead = el("thead", null);
      var thr   = el("tr", null);
      ["Severity", "Package", "Installed", "Fixed in", "CVE / Advisory", ""].forEach(function (h) {
        thr.appendChild(el("th", null, h));
      });
      thead.appendChild(thr);
      table.appendChild(thead);

      var tbody = el("tbody", null);
      advisories.forEach(function (a) {
        var tr = el("tr", null);

        var sevCell = el("td", null);
        sevCell.appendChild(el("span", { class: "tag sev-tag-" + a.severity }, a.severity));
        tr.appendChild(sevCell);

        tr.appendChild(el("td", { class: "mono" }, a.package + (a.ecosystem ? "  (" + a.ecosystem + ")" : "")));
        tr.appendChild(el("td", { class: "mono" }, a.installedVersion || "—"));
        tr.appendChild(el("td", { class: "mono" }, a.fixedIn || "no fix yet"));

        var linkCell = el("td", null);
        var link = el("a", { href: a.advisoryUrl, target: "_blank", rel: "noopener", class: "mono" }, a.id);
        linkCell.appendChild(link);
        tr.appendChild(linkCell);

        // "Generate fix" (Copilot-style): one advisory in, one concrete
        // remediation out, rendered in a full-width row directly under the
        // advisory that asked for it. Nothing is persisted — see /api/fix.
        var fixCell = el("td", null);
        fixCell.appendChild(makeFixButton({ kind: "vuln", finding: {
          id: a.id, package: a.package, ecosystem: a.ecosystem,
          installedVersion: a.installedVersion, fixedIn: a.fixedIn,
          severity: a.severity, cvssScore: a.cvssScore,
        }}, function (node) {
          var dr = el("tr", { class: "fix-detail-row" });
          var td = el("td", { colspan: "6" });
          td.appendChild(node);
          dr.appendChild(td);
          tr.parentNode.insertBefore(dr, tr.nextSibling);
        }));
        tr.appendChild(fixCell);

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }

    if (result.fixCommand) {
      wrap.appendChild(el("h4", { class: "result-section-title" }, "Fix command"));
      wrap.appendChild(el("pre", { class: "result-snippet" }, result.fixCommand));
    }

    renderSourceFindings(wrap, result);
    showOutput("vuln", wrap);
  }

  // -------------------------------------------------------------------------
  // Source-code findings (SAST)
  // -------------------------------------------------------------------------
  //
  // Rendered as its own labelled section, deliberately never merged into the
  // advisory table above. "A package you install has a published CVE" and "a
  // line you wrote builds SQL from a request parameter" are different work,
  // owned by different people, on different timescales — one is an upgrade,
  // the other is a code change. Interleaving them produces a list nobody can
  // triage.

  var SEV_ORDER = ["critical", "high", "medium", "low", "info"];

  // The repository profile: what the scanner found, how deeply each language
  // can be analysed, and — the part that stops a clean report being
  // over-read — what it will not cover.
  function renderCoverageProfile(wrap, src) {
    var profile = src.profile;
    if (!profile || !profile.languages || !profile.languages.length) return;

    var box = el("div", { class: "scan-profile" });
    if (src.profileSummary) {
      box.appendChild(el("p", { class: "scan-profile-summary" }, src.profileSummary));
    }

    var chips = el("div", { class: "scan-profile-langs" });
    profile.languages.slice(0, 12).forEach(function (l) {
      var chip = el("span", { class: "scan-profile-lang scan-profile-tier-" + l.supportTier });
      chip.appendChild(el("span", { class: "scan-profile-lang-name mono" }, l.name));
      chip.appendChild(el("span", { class: "scan-profile-lang-meta mono" },
        l.fileCount + (l.fileCount === 1 ? " file" : " files")));
      // The tier is the claim a reader is most likely to over-read, so it is
      // spelled out on hover rather than left as a bare number.
      chip.setAttribute("title", l.name + " — " + l.supportTierLabel +
        " · analyzers: " + l.analyzers.join(", "));
      chips.appendChild(chip);
    });
    box.appendChild(chips);

    var fws = profile.frameworks || [];
    var confident = fws.filter(function (f) { return f.confidence !== "low"; });
    if (confident.length) {
      var fwLine = el("p", { class: "scan-profile-fw mono" },
        "Frameworks: " + confident.map(function (f) { return f.name; }).join(", "));
      fwLine.setAttribute("title", confident.map(function (f) {
        return f.name + " (" + f.confidence + "): " + (f.evidence || []).join("; ");
      }).join("\n"));
      box.appendChild(fwLine);
    }

    var gaps = (profile.scanPlan && profile.scanPlan.gaps) || [];
    gaps.forEach(function (g) {
      box.appendChild(el("p", { class: "scan-profile-gap" }, g.detail));
    });

    wrap.appendChild(box);
  }

  function renderSourceFindings(wrap, result) {
    var src = result.source;
    // The key is absent on a stored run from before source scanning existed.
    // That is not "no findings" — it is "this run never looked" — so nothing
    // is rendered rather than an empty, reassuring section.
    if (!src) return;

    wrap.appendChild(el("h4", { class: "result-section-title" }, "Source code"));

    // Coverage before findings, always — including on the paths where the scan
    // produced nothing. A reader deciding whether a clean result means
    // anything needs to know which languages were read and how deeply, and
    // that question is most urgent exactly when there is nothing to show.
    renderCoverageProfile(wrap, src);

    if (src.status !== "ok") {
      wrap.appendChild(el("p", { class: "result-reason" },
        src.message || "The source scan did not run."));
      return;
    }

    var findings = src.findings || [];
    var cov = src.coverage || {};

    var meta = "Scanned " + (cov.filesScanned || 0) + " file" +
      ((cov.filesScanned === 1) ? "" : "s") +
      (cov.astParsed ? " · " + cov.astParsed + " with full AST + taint analysis" : "");
    // Said out loud, because a file the parser could not read was covered by
    // the pattern engine alone. Silence here would let partial coverage read
    // as full coverage, which is the one claim a security tool must not make.
    if (cov.astUnparseable && cov.astUnparseable.length) {
      meta += " · " + cov.astUnparseable.length + " pattern-only (unparseable)";
    }
    if (cov.truncated) {
      meta += " · capped at " + (cov.filesScanned || 0) + " of " + cov.filesEligible;
    }
    wrap.appendChild(el("p", { class: "result-item-meta mono" }, meta));

    if (!findings.length) {
      wrap.appendChild(emptyState("No source-code findings in the files scanned."));
      return;
    }

    var counts = (src.summary && src.summary.bySeverity) || {};
    var stats = el("div", { class: "result-stats result-stats-4" });
    SEV_ORDER.forEach(function (sev) {
      if (sev === "info" && !counts.info) return;
      stats.appendChild(statCard(sev, String(counts[sev] || 0), "sev-" + sev));
    });
    wrap.appendChild(stats);

    // Filters. Built from what is actually present rather than from a fixed
    // list, so a filter never offers a category with nothing behind it.
    var state = { severity: "all", category: "all", confidence: "all" };
    var listBox = el("div", { class: "sast-list" });

    var fixCtx = { repoUrl: result.repoUrl || null };
    wrap.appendChild(buildSastFilters(findings, state, function () {
      drawSastList(listBox, findings, state, fixCtx);
    }));
    wrap.appendChild(listBox);
    drawSastList(listBox, findings, state, fixCtx);
  }

  function distinct(findings, key) {
    var seen = [];
    findings.forEach(function (f) {
      if (f[key] && seen.indexOf(f[key]) === -1) seen.push(f[key]);
    });
    return seen;
  }

  function buildSastFilters(findings, state, onChange) {
    var bar = el("div", { class: "sast-filters" });

    function group(label, key, values) {
      if (values.length < 2) return;      // a filter with one option is furniture
      var g = el("div", { class: "sast-filter-group" });
      g.appendChild(el("span", { class: "sast-filter-label mono" }, label));
      ["all"].concat(values).forEach(function (v) {
        var b = el("button", {
          type: "button",
          class: "seg-btn" + (state[key] === v ? " is-active" : ""),
        }, v === "all" ? "All" : v);
        b.addEventListener("click", function () {
          state[key] = v;
          [].forEach.call(g.querySelectorAll(".seg-btn"), function (x) {
            x.classList.remove("is-active");
          });
          b.classList.add("is-active");
          onChange();
        });
        g.appendChild(b);
      });
      bar.appendChild(g);
    }

    group("Severity", "severity",
      SEV_ORDER.filter(function (s) { return distinct(findings, "severity").indexOf(s) !== -1; }));
    group("Category", "category", distinct(findings, "category").sort());
    group("Confidence", "confidence",
      ["high", "medium", "low"].filter(function (c) {
        return distinct(findings, "confidence").indexOf(c) !== -1;
      }));
    return bar;
  }

  function drawSastList(box, findings, state, fixCtx) {
    box.textContent = "";
    var shown = findings.filter(function (f) {
      return (state.severity === "all"   || f.severity === state.severity) &&
             (state.category === "all"   || f.category === state.category) &&
             (state.confidence === "all" || f.confidence === state.confidence);
    });

    if (!shown.length) {
      box.appendChild(el("p", { class: "result-reason" },
        "No findings match these filters."));
      return;
    }

    // Grouped by file: a reviewer opens one file and fixes everything in it,
    // rather than paging between files per finding.
    var byFile = {};
    var order = [];
    shown.forEach(function (f) {
      if (!byFile[f.path]) { byFile[f.path] = []; order.push(f.path); }
      byFile[f.path].push(f);
    });

    order.forEach(function (path) {
      var fileBox = el("div", { class: "sast-file" });
      fileBox.appendChild(el("div", { class: "sast-file-head mono" },
        path + "  ·  " + byFile[path].length + " finding" +
        (byFile[path].length === 1 ? "" : "s")));
      byFile[path].forEach(function (f) {
        fileBox.appendChild(sastCard(f, fixCtx));
      });
      box.appendChild(fileBox);
    });
  }

  function sastCard(f, fixCtx) {
    var card = el("div", { class: "sast-card sast-card-" + f.severity });

    var head = el("div", { class: "sast-card-head" });
    head.appendChild(el("span", { class: "tag sev-tag-" + f.severity }, f.severity));
    head.appendChild(el("span", { class: "sast-conf mono" }, f.confidence + " confidence"));
    head.appendChild(el("span", { class: "sast-title" }, f.title || f.type));
    head.appendChild(el("span", { class: "sast-loc mono" },
      "line " + f.line + (f.column ? ":" + f.column : "")));
    card.appendChild(head);

    if (f.snippet) {
      card.appendChild(el("pre", { class: "result-snippet sast-snippet" }, f.snippet));
    }

    // The taint path, when the AST engine proved one. This is the field that
    // makes a finding checkable in seconds instead of minutes — it names the
    // request property the value came from, not just the line it ended at.
    if (f.evidence && f.evidence.source && f.evidence.sink) {
      var flow = el("div", { class: "sast-flow mono" });
      flow.appendChild(el("span", { class: "sast-flow-src" }, f.evidence.source));
      flow.appendChild(el("span", { class: "sast-flow-arrow" }, " → "));
      flow.appendChild(el("span", { class: "sast-flow-sink" }, f.evidence.sink));
      card.appendChild(flow);
    }

    card.appendChild(el("p", { class: "sast-remediation" }, f.recommendation));

    var tags = el("div", { class: "sast-tags" });
    tags.appendChild(el("span", { class: "sast-tag mono" }, f.ruleId));
    (f.cwe || []).forEach(function (c) {
      tags.appendChild(el("a", {
        class: "sast-tag sast-tag-cwe mono",
        href: "https://cwe.mitre.org/data/definitions/" + String(c).replace("CWE-", "") + ".html",
        target: "_blank", rel: "noopener",
      }, c));
    });
    (f.owasp || []).forEach(function (o) {
      tags.appendChild(el("span", { class: "sast-tag sast-tag-owasp mono" }, o));
    });
    tags.appendChild(el("span", { class: "sast-tag sast-tag-module mono" }, f.module));
    card.appendChild(tags);

    // The fix pipeline. Repo-mode only: the Worker refetches the one file the
    // finding names and runs propose → validate; a pasted-content scan has no
    // repository for it to refetch from (the API and CLI cover that path by
    // sending the content directly). Imported findings have no registered
    // rule to validate against, so they are read-only here too.
    if (fixCtx && fixCtx.repoUrl && f.fingerprint && f.module !== "sarif-import") {
      card.appendChild(sastFixZone(f, fixCtx.repoUrl));
    }
    return card;
  }

  /**
   * "Generate validated fix" and everything it reveals: explanation, the
   * validation checklist, the diff, and the patch download. The checklist is
   * the part that must never be skimmable into a lie — it always renders the
   * checks that did NOT run, because "passed" here means passed the static
   * tier, and the reader is the one who has to run the tests.
   */
  function sastFixZone(f, repoUrl) {
    var zone = el("div", { class: "sast-fix" });
    var btn = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Generate validated fix");
    zone.appendChild(btn);

    btn.addEventListener("click", function () {
      setBusy(btn, true, "Proposing + validating…");
      callApi("/api/fix/propose", {
        repoUrl: repoUrl,
        finding: {
          ruleId: f.ruleId, fingerprint: f.fingerprint, path: f.path, line: f.line,
          severity: f.severity, confidence: f.confidence, category: f.category,
          title: f.title, snippet: f.snippet, recommendation: f.recommendation,
          cwe: f.cwe, owasp: f.owasp, evidence: f.evidence,
        },
      })
        .then(function (res) { btn.remove(); zone.appendChild(sastFixResult(res, f)); })
        .catch(function (err) {
          setBusy(btn, false);
          zone.appendChild(el("p", { class: "result-reason" },
            err && err.code === "no_provider_configured"
              ? "No AI provider is configured on this deployment."
              : "Fix generation failed: " + ((err && err.message) || "unknown error")));
        });
    });
    return zone;
  }

  function sastFixResult(res, f) {
    var box = el("div", { class: "sast-fix-result" });
    var v = res.validation;

    var badge = el("div", { class: "sast-fix-verdict sast-fix-" + (res.applyable ? "ok" : "bad") });
    badge.appendChild(el("strong", null, res.applyable ? "Passed static validation" : "Failed validation"));
    badge.appendChild(el("span", { class: "mono" },
      " · " + (res.proposal ? res.proposal.provider : "") +
      (res.retried ? " · retried once" : "")));
    box.appendChild(badge);

    if (res.proposal && res.proposal.explanation) {
      box.appendChild(el("p", { class: "result-reason" }, res.proposal.explanation));
    }

    var checks = el("ul", { class: "sast-fix-checks" });
    (v.checks || []).forEach(function (c) {
      checks.appendChild(el("li", { class: "mono " + (c.ok ? "sast-check-ok" : "sast-check-bad") },
        (c.ok ? "✓ " : "✗ ") + c.check + " — " + c.detail));
    });
    box.appendChild(checks);

    // The honesty line. Not a footnote: it is the difference between what
    // this badge claims and what a green CI run claims.
    box.appendChild(el("p", { class: "sast-fix-notrun" },
      "Not checked here: " + (v.checksNotRun || []).map(function (c) { return c.check; }).join(", ") +
      ". Run them where the code runs before merging."));

    if (res.patch) {
      box.appendChild(el("pre", { class: "result-snippet sast-fix-diff" }, res.patch));
      var dl = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Download .patch");
      dl.addEventListener("click", function () {
        var blob = new Blob([res.patch], { type: "text/x-patch" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = (f.ruleId || "fix").replace(/[^a-z0-9.-]+/gi, "-") + ".patch";
        a.click();
        URL.revokeObjectURL(a.href);
      });
      box.appendChild(dl);
    }

    if (res.proposal && res.proposal.riskNotes) {
      box.appendChild(el("p", { class: "sast-fix-risk" }, "Reviewer notes: " + res.proposal.riskNotes));
    }
    return box;
  }

  function renderAlgo(result) {
    var wrap  = el("div", { class: "result-wrap" });

    // Headline stats: Big-O badge, measured wall-clock, result-size proxy.
    var stats = el("div", { class: "result-stats" });
    var bigOLabel = (result.bigO && result.bigO.label) || "unknown";
    stats.appendChild(statCard("Big-O", bigOLabel, "mono accent"));
    stats.appendChild(statCard("Wall time", formatMs(result.wallTimeMs)));
    stats.appendChild(statCard("Result size", formatBytes(result.heapBytes)));
    wrap.appendChild(stats);

    if (result.bigO && result.bigO.reason) {
      wrap.appendChild(el("p", { class: "result-reason" }, result.bigO.reason));
    }

    // Big-O probe chart — inline SVG, no chart library.
    if (result.bigO && Array.isArray(result.bigO.points) && result.bigO.points.length >= 2) {
      wrap.appendChild(el("h4", { class: "result-section-title" }, "Timing at 3 input sizes"));
      wrap.appendChild(renderBigOChart(result.bigO.points));
    }

    // Sample-run result preview.
    if (result.sampleResult !== undefined) {
      wrap.appendChild(el("h4", { class: "result-section-title" }, "Sample run output"));
      var preview;
      try { preview = JSON.stringify(result.sampleResult, null, 2); }
      catch (e) { preview = String(result.sampleResult); }
      if (preview && preview.length > 4000) preview = preview.slice(0, 4000) + "\n…(truncated)";
      wrap.appendChild(el("pre", { class: "result-snippet" }, preview));
    }
    if (result.truncated) {
      wrap.appendChild(el("p", { class: "result-reason" },
        "Result was larger than 100 KB — preview truncated."));
    }

    // Handoff to the watchlist (D-6). Rendered only when the optimizer page
    // module is present AND a top-level function name is parseable from the
    // pasted source — a button that can't fill a row is not rendered.
    var opt = window.DashOptimizer;
    var bench = opt && opt.lastBench && opt.lastBench();
    var fnName = bench ? opt.parseFunctionName(bench.code) : null;
    if (opt && fnName) {
      var ceiling = opt.ceilingAbove(bigOLabel);
      var hand = el("div", { class: "opt-handoff" });
      var handText = el("div", { class: "opt-handoff-text" });
      handText.appendChild(el("strong", null, "Keep this grade honest"));
      handText.appendChild(el("p", null,
        "Ceiling pre-filled one bucket above the measured grade, so run-to-run noise can't turn a green build red."));
      hand.appendChild(handText);
      var watchBtn = el("button", { type: "button", class: "btn btn-primary btn-sm" },
        "Watch " + fnName + " · ceiling " + opt.prettyGrade(ceiling));
      watchBtn.addEventListener("click", function () { opt.addFromBench(); });
      hand.appendChild(watchBtn);
      wrap.appendChild(hand);
    }

    // LLM refactor suggestion + copy-to-clipboard rewrite block.
    if (result.suggestion) {
      var aiProvider = result.suggestion.provider === "openai" || result.suggestion.provider === "workers-ai";
      var sugTitle = aiProvider
        ? "AI refactor suggestion"
        : "Refactor suggestion (AI disabled)";
      wrap.appendChild(el("h4", { class: "result-section-title" }, sugTitle));
      if (aiProvider) {
        // EU AI Act Art. 50 transparency: AI-generated content is labeled as
        // such at the moment it is shown, not in a policy page footnote. The
        // grades and timings above are measured, not generated — this label
        // marks exactly the part that isn't.
        wrap.appendChild(el("p", { class: "result-reason ai-disclosure" },
          "AI-generated — a suggestion for your review, never applied automatically. " +
          "The grade and curve above are measured; this text is not."));
      }
      if (result.suggestion.text) {
        wrap.appendChild(el("p", { class: "result-reason" }, result.suggestion.text));
      }
      if (result.suggestion.code) {
        var head = el("div", { class: "result-item-top" });
        head.appendChild(el("span", { class: "tag" }, "rewritten function"));
        var copyBtn = el("button", {
          class: "btn btn-ghost btn-sm",
          type: "button",
          "data-copy-target": "suggestion-code"
        }, "Copy");
        head.appendChild(copyBtn);
        wrap.appendChild(head);
        var pre = el("pre", { class: "result-snippet", id: "suggestion-code" },
          result.suggestion.code);
        wrap.appendChild(pre);

        // "Measure the rewrite" (D-6): advice is a guess until the sandbox
        // grades it. Runs the suggestion through the same endpoint with the
        // same sample input, so the comparison is like for like.
        if (window.DashOptimizer && window.DashOptimizer.lastBench()) {
          wrap.appendChild(rewriteMeasureBox(result));
        }
      }
    }

    showOutput("algo", wrap);
  }

  function lastProbeMs(res) {
    var pts = res && res.bigO && res.bigO.points;
    if (!Array.isArray(pts) || !pts.length) return null;
    var last = pts[pts.length - 1];
    return typeof last.ms === "number" ? last.ms : null;
  }

  function rewriteMeasureBox(beforeResult) {
    var box = el("div", { class: "rewrite-measure" });
    var pitch = el("div", { class: "opt-handoff opt-handoff-dashed" });
    var t = el("div", { class: "opt-handoff-text" });
    t.appendChild(el("strong", null, "This rewrite has not been measured"));
    t.appendChild(el("p", null, "Advice is a guess until the sandbox grades it."));
    pitch.appendChild(t);
    var btn = el("button", { type: "button", class: "btn btn-primary btn-sm" }, "Measure the rewrite →");
    pitch.appendChild(btn);
    box.appendChild(pitch);

    btn.addEventListener("click", function () {
      var bench = window.DashOptimizer.lastBench();
      var body = bench.sampleInput === undefined
        ? { code: beforeResult.suggestion.code }
        : { code: beforeResult.suggestion.code, sampleInput: bench.sampleInput };
      setBusy(btn, true, "Measuring…");
      callApi("/api/analyze/algo", body)
        .then(function (after) { renderRewriteCompare(box, beforeResult, after); })
        .catch(function (e) {
          t.appendChild(el("p", { class: "result-reason" },
            "Could not measure the rewrite: " + (e.message || "request failed") + ". The advice above stands unproven."));
          setBusy(btn, false);
        });
    });
    return box;
  }

  /**
   * Before / after, both measured through the same three probes on the same
   * sandbox. The three outcomes get equal prominence — "the suggestion was
   * wrong and the measurement says so" is a result, not a failure state.
   */
  function renderRewriteCompare(box, before, after) {
    while (box.firstChild) box.removeChild(box.firstChild);
    var opt = window.DashOptimizer;
    var bLabel = (before.bigO && before.bigO.label) || "unknown";
    var aLabel = (after.bigO && after.bigO.label) || "unknown";
    var bRank = opt.gradeRank(bLabel), aRank = opt.gradeRank(aLabel);
    var bMs = lastProbeMs(before), aMs = lastProbeMs(after);
    var ratio = (bMs !== null && aMs !== null && aMs > 0) ? bMs / aMs : null;

    var tone, headline, note;
    if (aRank < bRank) {
      tone = "rewrite-better";
      headline = "↓ " + bLabel + " → " + aLabel +
        (ratio && ratio > 1 ? ", " + (Math.round(ratio * 10) / 10) + "× faster at n = 10,000" : "");
      note = "Both curves measured through the same three probes on the same sandbox, so the comparison is like for like.";
    } else if (aRank > bRank) {
      tone = "rewrite-worse";
      headline = "↑ " + bLabel + " → " + aLabel + " — the rewrite made it worse";
      note = "Keep what you have; the suggestion was wrong and the measurement says so.";
    } else {
      var slower = ratio !== null && ratio < 1;
      tone = slower ? "rewrite-worse" : "rewrite-same";
      headline = bLabel + " → " + aLabel + " — same complexity class" +
        (ratio !== null ? (slower
          ? ", " + (Math.round((1 / ratio) * 100) / 100) + "× slower at n = 10,000"
          : ", " + (Math.round(ratio * 100) / 100) + "× the speed at n = 10,000") : "");
      note = slower
        ? "The rewrite did not help — same class, more constant overhead. Keep what you have."
        : "No class change — the difference is constant factors. Take whichever version reads better.";
    }

    box.appendChild(el("h4", { class: "result-section-title" }, "Measured — before vs after"));
    box.appendChild(el("p", { class: "rewrite-delta mono " + tone }, headline));
    var stats = el("div", { class: "result-stats" });
    stats.appendChild(statCard("Before · yours", bLabel, "mono"));
    stats.appendChild(statCard("After · rewrite", aLabel, "mono"));
    if (bMs !== null && aMs !== null) {
      stats.appendChild(statCard("At n = 10,000", formatMs(bMs) + " → " + formatMs(aMs), "mono"));
    }
    box.appendChild(stats);
    box.appendChild(el("p", { class: "result-reason" }, note));
  }

  // Inline SVG chart for the Big-O probe — renders 3 (n, ms) points with a
  // log-x axis. No external chart lib so the dashboard stays a single static
  // page with zero build step.
  function renderBigOChart(points) {
    var W = 480, H = 140, PAD = 28;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "bigo-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Run time at three input sizes");

    var xs = points.map(function (p) { return Math.log10(p.n); });
    var ys = points.map(function (p) { return p.ms; });
    var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
    var yMax = Math.max.apply(null, ys) || 1;
    if (xMax === xMin) xMax = xMin + 1;

    function px(x) { return PAD + (x - xMin) / (xMax - xMin) * (W - 2 * PAD); }
    function py(y) { return H - PAD - (y / yMax) * (H - 2 * PAD); }

    // Axes
    var ax = document.createElementNS("http://www.w3.org/2000/svg", "path");
    ax.setAttribute("d", "M" + PAD + " " + (H - PAD) + " L" + (W - PAD) + " " + (H - PAD));
    ax.setAttribute("stroke", "#9ca3af"); ax.setAttribute("fill", "none");
    svg.appendChild(ax);

    // Polyline through the points
    var d = points.map(function (p, i) {
      return (i === 0 ? "M" : "L") + px(Math.log10(p.n)) + " " + py(p.ms);
    }).join(" ");
    var line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", d);
    line.setAttribute("stroke", "#2563eb"); line.setAttribute("fill", "none");
    line.setAttribute("stroke-width", "2");
    svg.appendChild(line);

    // Points + labels
    points.forEach(function (p) {
      var cx = px(Math.log10(p.n));
      var cy = py(p.ms);
      var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
      dot.setAttribute("r", 4); dot.setAttribute("fill", "#2563eb");
      svg.appendChild(dot);
      var lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      lbl.setAttribute("x", cx); lbl.setAttribute("y", H - PAD + 16);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("font-size", "11"); lbl.setAttribute("fill", "#6b7280");
      lbl.textContent = "n=" + p.n + " · " + formatMs(p.ms);
      svg.appendChild(lbl);
    });

    return svg;
  }

  function formatMs(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "—";
    if (ms < 1) return ms.toFixed(3) + " ms";
    if (ms < 100) return ms.toFixed(2) + " ms";
    return Math.round(ms) + " ms";
  }
  function formatBytes(b) {
    if (typeof b !== "number" || !isFinite(b)) return "—";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / 1024 / 1024).toFixed(2) + " MB";
  }

  // -----------------------------------------------------------------------
  // Run handlers — one per analyzer
  // -----------------------------------------------------------------------

  function runCost(button) {
    if (!pendingCostBlob) {
      showOutput("cost", errorState("Choose a CUR CSV file first (or click Load sample)."));
      return;
    }
    var form = new FormData();
    // Append as a real File so the Worker's formData() parser sees a name.
    var name = pendingCostName || "cur.csv";
    if (typeof File !== "undefined" && !(pendingCostBlob instanceof File)) {
      form.append("file", new File([pendingCostBlob], name, { type: "text/csv" }));
    } else {
      form.append("file", pendingCostBlob, name);
    }
    setBusy(button, true, "Analyzing…");
    callApiMultipart("/api/analyze/cost", form)
      .then(function (res) { renderCost(res); loadRuns(); })
      .catch(function (e)  {
        showOutput("cost", errorState(e.message || "Request failed", e.helpUrl,
          "Read AWS docs on enabling CUR exports →"));
      })
      .then(function ()    { setBusy(button, false); });
  }

  function runVuln(button) {
    var url = $("#input-vuln").value;
    if (!url || !url.trim()) {
      showOutput("vuln", errorState("Paste a public GitHub repo URL first."));
      return;
    }
    setBusy(button, true, "Scanning…");
    callApi("/api/analyze/vuln", { repoUrl: url.trim() })
      .then(function (res) { renderVuln(res); loadRuns(); })
      .catch(function (e)  {
        showOutput("vuln", errorState(e.message || "Request failed", e.helpUrl,
          "Open OSV.dev →"));
      })
      .then(function ()    { setBusy(button, false); });
  }

  function runAlgo(button) {
    var src = $("#input-algo").value;
    if (!src.trim()) { showOutput("algo", errorState("Paste a function first.")); return; }
    var sampleRaw = ($("#input-algo-sample") && $("#input-algo-sample").value || "").trim();
    var sampleInput;
    if (sampleRaw === "") {
      // Empty sample = let the Worker pick its default (length-100 int array).
      sampleInput = undefined;
    } else {
      try { sampleInput = JSON.parse(sampleRaw); }
      catch (e) {
        showOutput("algo", errorState("Sample input must be valid JSON: " + e.message));
        return;
      }
    }
    var body = sampleInput === undefined
      ? { code: src }
      : { code: src, sampleInput: sampleInput };
    setBusy(button, true, "Running…");
    callApi("/api/analyze/algo", body)
      .then(function (res) {
        // Hand the run to the optimizer page module BEFORE rendering, so the
        // verdict can offer "Watch this function" with the right context.
        if (window.DashOptimizer) {
          window.DashOptimizer.onBenchResult({ code: src, sampleInput: sampleInput, result: res });
        }
        renderAlgo(res);
        loadRuns();
      })
      .catch(function (e)  { showOutput("algo", errorState(e.message || "Request failed")); })
      .then(function ()    { setBusy(button, false); });
  }

  // -----------------------------------------------------------------------
  // Recent runs (Task #17) — list, re-run, CSV export
  // -----------------------------------------------------------------------
  //
  // The list endpoint returns 6-field summaries (id, analyzer, headline, ms,
  // createdAt, hasInput). For re-run/CSV we lazy-fetch the full record from
  // GET /api/runs/:id when the user clicks. This keeps the list response
  // small even with the maximum 20 items × 3 analyzers.

  function formatRelativeTime(ts) {
    if (typeof ts !== "number") return "—";
    var diff = Date.now() - ts;
    if (diff < 0) diff = 0;
    var sec = Math.floor(diff / 1000);
    if (sec < 60)        return sec + "s ago";
    var min = Math.floor(sec / 60);
    if (min < 60)        return min + "m ago";
    var hr  = Math.floor(min / 60);
    if (hr  < 24)        return hr + "h ago";
    var d   = Math.floor(hr / 24);
    if (d   < 7)         return d + "d ago";
    return new Date(ts).toISOString().slice(0, 10);
  }

  // Current feed filter (D-3): "all" | "ci" | "monitor" | "manual". Filtering
  // is server-side (?source=) so a busy pipeline can't push every manual run
  // off the twenty-item first page. "monitor" arrived when scheduled sweeps
  // started filing their audits as runs: a nightly monitor produces the most
  // rows of anyone and would otherwise be the thing burying the other two.
  var runsFilter = "all";

  function renderRunsList(items) {
    var listEl = $("#runs-list");
    if (!listEl) return;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

    if (!items || items.length === 0) {
      listEl.appendChild(emptyState(
        runsFilter === "ci"
          ? "No CI runs yet — wire the workflow from the Monitors & CI tab and the first build will land here."
          : runsFilter === "monitor"
          ? "No scheduled sweeps yet — a monitor files a run each time it checks, from the Monitors & CI tab."
          : "No runs yet — pick an analyzer below to get started."));
      return;
    }

    var ul = el("ul", { class: "runs-items" });
    items.forEach(function (it) {
      var isCi = it.source === "ci";
      var isMonitor = it.source === "monitor";
      // Both origins read a repository and stored paths rather than content.
      // Grouping them is what the row actually needs: neither can be re-run,
      // and both have a repository worth naming.
      var isAutomated = isCi || isMonitor;
      var li = el("li", { class: "run-item run-item-" + it.analyzer });

      var meta = el("div", { class: "run-item-meta" });
      meta.appendChild(el("span", { class: "tag run-tag-" + it.analyzer }, it.analyzer));
      // Provenance badge (D-3): CI runs say so, and name the commit that
      // produced them. Dashboard entries keep exactly the shape they had.
      if (isCi) {
        meta.appendChild(el("span", { class: "tag tag-ci" }, "CI"));
      } else if (isMonitor) {
        // Its own badge rather than sharing CI's. "A schedule did this while
        // you were asleep" and "a pull request was gated on this" are
        // different facts, and the second one has a person waiting on it.
        meta.appendChild(el("span", { class: "tag tag-monitor" }, "Monitor"));
      }
      meta.appendChild(el("span", { class: "run-item-headline" }, it.headline || "—"));
      var origin = isAutomated
        ? (it.repo || (isCi ? "pipeline" : "scheduled")) +
          (it.commitSha ? " · " + String(it.commitSha).slice(0, 7) : "")
        : null;
      if (origin) meta.appendChild(el("span", { class: "run-item-origin mono" }, origin));
      meta.appendChild(el("span", { class: "run-item-time mono" }, formatRelativeTime(it.createdAt)));
      li.appendChild(meta);

      var actions = el("div", { class: "run-item-actions" });

      // Dependency audits open as the client-ready report (D-4);
      // architecture runs re-open as the explorer (D-5).
      if (it.analyzer === "vuln") {
        actions.appendChild(el("a", {
          class: "btn btn-ghost btn-sm",
          href: "#/report/" + encodeURIComponent(it.id),
        }, "View report"));
      }
      if (it.analyzer === "arch") {
        actions.appendChild(el("button", {
          type: "button",
          class: "btn btn-ghost btn-sm",
          "data-run-action": "viewmap",
          "data-run-id": it.id,
        }, "View map"));
      }

      // A CI run's stored input is lockfile PATHS, not content, and a swept
      // run's is the monitor's own configuration — neither has anything to
      // re-run against, so the button isn't rendered at all. (Re-running a
      // monitor is a different action, and it lives on the monitor.)
      if (!isAutomated) {
        var rerun = el("button", {
          type: "button",
          class: "btn btn-ghost btn-sm",
          "data-run-action": "rerun",
          "data-run-id": it.id,
          "data-run-analyzer": it.analyzer,
        }, "Re-run");
        if (!it.hasInput) {
          rerun.disabled = true;
          rerun.title = "Re-run not available — input was too large to keep (e.g. CUR upload).";
        }
        actions.appendChild(rerun);
      }

      var csv = el("button", {
        type: "button",
        class: "btn btn-ghost btn-sm",
        "data-run-action": "csv",
        "data-run-id": it.id,
        "data-run-analyzer": it.analyzer,
      }, "Download CSV");
      actions.appendChild(csv);

      li.appendChild(actions);
      ul.appendChild(li);
    });
    listEl.appendChild(ul);
  }

  function loadRuns() {
    var listEl = $("#runs-list");
    if (!listEl) return Promise.resolve();
    var qs = "/api/runs?limit=20" + (runsFilter === "all" ? "" : "&source=" + runsFilter);
    return callApi(qs, null, "GET").then(function (page) {
      renderRunsList((page && page.items) || []);
    }).catch(function (e) {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      listEl.appendChild(errorState(e.message || "Could not load run history"));
    });
  }

  function setRunsFilter(next) {
    runsFilter = next;
    var group = $("#runs-filter");
    if (group) {
      group.querySelectorAll("[data-runs-filter]").forEach(function (b) {
        b.setAttribute("aria-pressed", b.dataset.runsFilter === next ? "true" : "false");
      });
    }
    loadRuns();
  }

  // CSV builders — tabular when the result is naturally tabular, key/value
  // when it isn't. Quoting follows RFC 4180: wrap any cell containing comma,
  // quote, or newline in double-quotes; double up internal quotes.
  function csvEscape(v) {
    var s = (v === null || v === undefined) ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function rowsToCsv(rows) {
    return rows.map(function (r) { return r.map(csvEscape).join(","); }).join("\n") + "\n";
  }
  function csvForRun(run) {
    var r = (run && run.result) || {};
    if (run.analyzer === "cost") {
      var rows = [["impact", "title", "service", "rule", "savings_per_month_usd"]];
      (r.suggestions || []).forEach(function (s) {
        rows.push([s.impact, s.title, s.service, s.rule, s.savingsEstimate]);
      });
      return rowsToCsv(rows);
    }
    if (run.analyzer === "vuln") {
      var rows2 = [["severity", "package", "ecosystem", "installed_version", "fixed_in", "id", "advisory_url"]];
      (r.advisories || []).forEach(function (a) {
        rows2.push([a.severity, a.package, a.ecosystem, a.installedVersion, a.fixedIn, a.id, a.advisoryUrl]);
      });
      return rowsToCsv(rows2);
    }
    if (run.analyzer === "algo") {
      var rows3 = [["metric", "value"]];
      rows3.push(["big_o", (r.bigO && r.bigO.label) || "unknown"]);
      rows3.push(["wall_time_ms", r.wallTimeMs]);
      rows3.push(["heap_bytes", r.heapBytes]);
      ((r.bigO && r.bigO.points) || []).forEach(function (p) {
        rows3.push(["probe_n_" + p.n + "_ms", p.ms]);
      });
      return rowsToCsv(rows3);
    }
    if (run.analyzer === "arch") {
      var rows4 = [["severity", "lens", "rule", "target", "evidence", "why", "fix"]];
      (r.findings || []).forEach(function (f) {
        rows4.push([f.severity, f.lens, f.rule, f.target, f.evidence, f.why, f.fix]);
      });
      return rowsToCsv(rows4);
    }
    if (run.analyzer === "estimate") {
      var rows5 = [["provider_id", "provider_name", "estimated_total_usd", "lower_bound_usd", "upper_bound_usd", "confidence"]];
      var micro = function (v) { return typeof v === "number" ? (v / 1e6).toFixed(2) : ""; };
      (r.providers || []).forEach(function (p) {
        rows5.push([p.providerId, p.providerName, micro(p.estimatedTotalMicroUsd),
                    micro(p.lowerBoundMicroUsd), micro(p.upperBoundMicroUsd), p.confidence]);
      });
      return rowsToCsv(rows5);
    }
    return "";
  }
  function downloadCsv(filename, csv) {
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url  = URL.createObjectURL(blob);
    var a    = el("a", { href: url, download: filename, style: "display:none" });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  // Re-run a persisted run by re-POSTing the same input. We render directly
  // into the analyzer's output panel so the user sees the result without
  // having to scroll through manual input fields. (For algo we ALSO mirror
  // the input back into the textareas so it's editable for a follow-up run.)
  function rerunFromHistory(run, button) {
    if (!run || !run.input || run.input._omitted) {
      showOutput(run.analyzer, errorState("Re-run not available for this run."));
      return;
    }
    setBusy(button, true, "Re-running…");
    var done = function () { setBusy(button, false); loadRuns(); };

    if (run.analyzer === "cost") {
      callApi("/api/analyze/cost", run.input)
        .then(renderCost)
        .catch(function (e) { showOutput("cost", errorState(e.message || "Re-run failed")); })
        .then(done);
    } else if (run.analyzer === "vuln") {
      var input = $("#input-vuln");
      if (input && typeof run.input.repoUrl === "string") input.value = run.input.repoUrl;
      callApi("/api/analyze/vuln", run.input)
        .then(renderVuln)
        .catch(function (e) { showOutput("vuln", errorState(e.message || "Re-run failed")); })
        .then(done);
    } else if (run.analyzer === "algo") {
      var algoInput  = $("#input-algo");
      var algoSample = $("#input-algo-sample");
      if (algoInput  && typeof run.input.code === "string") algoInput.value = run.input.code;
      if (algoSample && "sampleInput" in run.input) {
        try { algoSample.value = JSON.stringify(run.input.sampleInput); }
        catch (e) { /* unprintable input — leave the textarea alone */ }
      }
      callApi("/api/analyze/algo", run.input)
        .then(renderAlgo)
        .catch(function (e) { showOutput("algo", errorState(e.message || "Re-run failed")); })
        .then(done);
    } else {
      done();
    }
  }

  // -----------------------------------------------------------------------
  // Header hydration — GET /api/me on load to show real email + sub status
  // -----------------------------------------------------------------------

  // Billing states (D-1). One renderer, keyed off the ENTITLEMENT_REASON the
  // resolver actually took — /api/me returns `reason`, `active` and
  // `currentPeriodEnd` precisely so the UI never re-derives state from
  // plan + subStatus and drifts from the analyzer gate.

  function longDate(unixSec) {
    if (typeof unixSec !== "number") return "";
    return new Date(unixSec * 1000).toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  }
  function shortDate(unixSec) {
    if (typeof unixSec !== "number") return "";
    return new Date(unixSec * 1000).toLocaleDateString("en-US", {
      month: "short", day: "numeric", timeZone: "UTC",
    });
  }
  function daysUntil(unixSec) {
    if (typeof unixSec !== "number") return 0;
    return Math.max(0, Math.ceil((unixSec * 1000 - Date.now()) / 86400000));
  }

  // Pill definitions per state. Every state is distinguishable without
  // colour: the glyph and the words carry it; the class only tints.
  function pillFor(me) {
    var reason = me.reason || "";
    var end = me.currentPeriodEnd;
    if (reason === "active_subscription") {
      return { cls: "dash-status--pro", glyph: "●", text: "Pro · subscription active" };
    }
    if (reason === "trialing") {
      var d = daysUntil(end);
      return { cls: "dash-status--trial", glyph: "◌",
               text: "Pro trial · " + d + (d === 1 ? " day left" : " days left") };
    }
    if (reason === "grace_period") {
      if (me.subStatus === "past_due") {
        return { cls: "dash-status--pastdue", glyph: "▲", text: "Past due · Pro until " + shortDate(end) };
      }
      return { cls: "dash-status--grace", glyph: "◦", text: "Ending · Pro until " + shortDate(end) };
    }
    if (reason === "period_expired") {
      return { cls: "dash-status--inactive", glyph: "○", text: "Pro ended " + shortDate(end) };
    }
    if (reason === "missing_period_end") {
      return { cls: "dash-status--pastdue", glyph: "▲", text: "Unconfirmed — contact support" };
    }
    if (reason === "not_entitling_status") {
      return { cls: "dash-status--inactive", glyph: "○", text: "Not active — payment incomplete" };
    }
    return null;   // free_plan → no status pill, the meter is the signal
  }

  // Build the one billing banner the current state calls for, or null. The
  // copy mirrors the transactional emails word for word (templates.js), so
  // the inbox and the dashboard can never disagree about a date.
  function bannerFor(me) {
    var reason = me.reason || "";
    var until = longDate(me.currentPeriodEnd);

    function banner(kind, role, title, body, actionLabel, actionFn) {
      var box = el("div", { class: "banner banner-" + kind, role: role });
      var textWrap = el("div", { class: "banner-text" });
      var strong = el("strong", null);
      strong.appendChild(el("span", { class: "banner-glyph", "aria-hidden": "true" },
        kind === "amber" ? "▲" : kind === "teal" ? "✓" : "◦"));
      strong.appendChild(document.createTextNode(title));
      textWrap.appendChild(strong);
      textWrap.appendChild(el("p", null, body));
      box.appendChild(textWrap);
      if (actionLabel) {
        var btn = el("button", { type: "button", class: "btn btn-sm " + (kind === "amber" ? "btn-amber" : "btn-primary") }, actionLabel);
        btn.addEventListener("click", function () { actionFn(btn); });
        box.appendChild(btn);
      }
      return box;
    }

    if (reason === "grace_period" && me.subStatus === "past_due") {
      // Not dismissable while the status persists — there is a task here.
      return banner("amber", "alert",
        "Your payment didn't go through — Pro until " + until,
        "The usual cause is an expired or replaced card — nothing is wrong with your account. " +
        "Your Pro access stays on until " + until + ". After that the account drops to the free tier " +
        "(5 analyses per month) until a payment succeeds.",
        "Update payment method →", openBillingPortal);
    }
    if (reason === "grace_period") {
      return banner("grey", "status",
        "Subscription cancelled — Pro until " + until,
        "Pro access stays on until " + until + ". After that the account drops to the free tier " +
        "(5 analyses per month).",
        "Resubscribe", openBillingPortal);
    }
    if (reason === "period_expired") {
      return banner("grey", "status",
        "Your Pro access ended on " + until,
        "The account is back on the free tier — 5 analyses per month. Resubscribing restores " +
        "unlimited runs immediately.",
        "Resubscribe →", startUpgradeCheckout);
    }
    if (reason === "missing_period_end") {
      return banner("amber", "alert",
        "We can't confirm your billing period",
        "Your subscription is paid but carries no period end for us to measure against, so paid " +
        "features are paused rather than guessed at. Email hello@algosize.com and we'll fix the " +
        "record — or open the billing portal to check the subscription.",
        "Open billing portal", openBillingPortal);
    }
    if (reason === "not_entitling_status") {
      return banner("amber", "alert",
        "Your subscription isn't active yet",
        "The first payment never completed, so the subscription exists but doesn't grant access. " +
        "Finish the payment to activate it.",
        "Complete payment →", openBillingPortal);
    }
    if (reason === "trialing") {
      var d = daysUntil(me.currentPeriodEnd);
      return banner("teal", "status",
        "Your Algosize Pro trial ends in " + d + (d === 1 ? " day" : " days") + ", on " + until,
        "Nothing to do if you want to keep going — your subscription continues automatically. " +
        "If Pro isn't for you, cancel any time before then in the billing portal and you won't be charged.",
        "Manage subscription", openBillingPortal);
    }
    return null;
  }

  function renderQuotaMeter(meterEl, used, limit) {
    if (!meterEl) return;
    while (meterEl.firstChild) meterEl.removeChild(meterEl.firstChild);
    var depleted = used >= limit;
    for (var i = 0; i < limit; i++) {
      meterEl.appendChild(el("span", {
        class: "dash-quota-seg" + (i < used ? (depleted ? " seg-on seg-out" : " seg-on") : ""),
      }));
    }
  }

  // Kept so other modules (report white-label note, team screen) can read the
  // most recent /api/me answer without a second request.
  var lastMe = null;

  /**
   * The Account control in the header: avatar, then the word.
   *
   * The avatar is an <img> when the account has one stored and the initials
   * otherwise. Never a generic silhouette — the whole job of this element is
   * to say WHICH account is signed in, and a silhouette says nothing. A URL
   * that fails to load falls back to the initials rather than leaving a
   * broken-image box, because the failure is invisible to the person who set
   * it and they would have no idea anything was wrong.
   *
   * The accessible name carries the display name or email; the visible word
   * is hidden by CSS on narrow screens, so it cannot be the only label.
   */
  function hydrateAccountControl(me) {
    var link   = document.getElementById("account-link");
    var avatar = document.getElementById("dash-avatar");
    if (!link || !avatar || !me) return;

    var who = me.displayName || me.email || null;
    link.setAttribute("aria-label", who ? "Account settings for " + who : "Account settings");

    avatar.textContent = "";
    if (me.avatarUrl) {
      var img = el("img", {
        src: me.avatarUrl,
        alt: "",
        class: "dash-avatar-img",
        loading: "lazy",
        referrerpolicy: "no-referrer",
      });
      img.addEventListener("error", function () {
        avatar.textContent = me.initials || "··";
        avatar.classList.remove("has-image");
      });
      avatar.classList.add("has-image");
      avatar.appendChild(img);
      return;
    }
    avatar.classList.remove("has-image");
    avatar.textContent = me.initials || "··";
  }

  function hydrateHeader() {
    var statusEl  = document.getElementById("dash-status");
    var textEl    = document.getElementById("dash-status-text");
    var billingEl = document.getElementById("billing-portal-btn");
    var quotaEl   = document.getElementById("dash-quota");
    var quotaVal  = document.getElementById("dash-quota-value");
    var quotaMeter = document.getElementById("dash-quota-meter");
    var bannerSlot = document.getElementById("billing-banner");
    var adminEl   = document.getElementById("admin-link");
    if (!statusEl || !textEl) return Promise.resolve();

    return callApi("/api/me", null, "GET").then(function (me) {
      lastMe = me;
      // callApi already redirects to "/" on 401, so we only get here for 2xx.
      // The signed-in address is no longer printed in the bar: the avatar and
      // the Account link's accessible name already identify the account, and
      // a full email is a long, variable-width string that pushed every other
      // control around to answer a question nobody asks twice.
      hydrateAccountControl(me);

      // Quota pill + segment meter: shown whenever entitlement is NOT
      // active. Never keyed off plan — plan stays "paid" through
      // period_expired and missing_period_end, and those accounts are
      // metered like anyone else's.
      var active = me && (me.active === true || (me.active === undefined && me.plan === "paid"));
      if (quotaEl && quotaVal) {
        if (!active && typeof me.monthlyRunsUsed === "number") {
          var used  = me.monthlyRunsUsed;
          var limit = typeof me.monthlyRunsLimit === "number" ? me.monthlyRunsLimit : 5;
          var depleted = used >= limit;
          quotaVal.textContent = depleted ? used + " / " + limit + " · none left" : used + " / " + limit;
          quotaEl.classList.toggle("dash-quota--depleted", depleted);
          renderQuotaMeter(quotaMeter, used, limit);
          quotaEl.hidden = false;
          if (depleted) {
            showQuotaBanner({ monthlyRunsUsed: used, monthlyRunsLimit: limit }, { modal: false });
          }
        } else if (active) {
          quotaVal.textContent = "Unlimited";
          quotaEl.classList.add("dash-quota--unlimited");
          if (quotaMeter) quotaMeter.hidden = true;
          quotaEl.hidden = false;
        }
      }

      // Plan pill, one state at a time. The e2e suite and any muscle memory
      // keyed on "Subscription active" keep working — the pro state includes
      // the phrase.
      var pill = me ? pillFor(me) : null;
      statusEl.className = "dash-status" + (pill && pill.cls ? " " + pill.cls : "");
      if (pill) {
        textEl.textContent = pill.text;
        var dot = statusEl.querySelector(".dash-status-dot");
        if (dot) dot.textContent = pill.glyph;
        statusEl.hidden = false;
      } else if (me && me.subStatus) {
        // Fallback for an older Worker without `reason`.
        var isActive = me.subStatus === "active";
        textEl.textContent = isActive ? "Subscription active" : "Subscription cancelled";
        statusEl.classList.toggle("dash-status--inactive", !isActive);
        statusEl.hidden = false;
      }

      // The one billing banner this state calls for.
      if (bannerSlot) {
        while (bannerSlot.firstChild) bannerSlot.removeChild(bannerSlot.firstChild);
        var b = me ? bannerFor(me) : null;
        if (b) { bannerSlot.appendChild(b); bannerSlot.hidden = false; }
        else bannerSlot.hidden = true;
      }

      // "Manage billing" for anyone with a Stripe subscription record.
      if (billingEl && me && me.subStatus) {
        billingEl.hidden = false;
      }

      // Admin link: visibility only, not the access control. /admin and
      // every /api/admin/* route re-check the ADMIN_EMAILS allowlist
      // server-side regardless of what this flag says.
      if (adminEl) {
        adminEl.hidden = !(me && me.isAdmin === true);
      }
      return me;
    }).catch(function () {
      // Network error or non-401 failure: leave header empty rather than show
      // misleading "active" text. The user can still use the analyzers; if
      // their session is truly dead the next analyzer call will 401 → "/".
      return null;
    });
  }

  // -----------------------------------------------------------------------
  // Quota upgrade banner (Task #19) — revealed by callApi when an analyzer
  // returns 402 quota_exceeded. The "Upgrade to Pro →" button kicks off
  // the existing /api/checkout flow (Task #4), same as the marketing site.
  // -----------------------------------------------------------------------

  // Date the free counter resets: first of next month, UTC — matches how
  // quota.js buckets the KV counter by YYYY-MM.
  function quotaResetDate() {
    var d = new Date();
    var next = new Date(Date.UTC(
      d.getUTCMonth() === 11 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(),
      (d.getUTCMonth() + 1) % 12, 1));
    return next.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  function showQuotaBanner(detail, opts) {
    opts = opts || {};
    var banner = document.getElementById("quota-upgrade-banner");
    var title  = document.getElementById("quota-banner-title");
    var msg    = document.getElementById("quota-banner-msg");
    if (banner) {
      if (title && detail && typeof detail.monthlyRunsLimit === "number") {
        title.textContent = "You've used all " + detail.monthlyRunsLimit +
          " free analyses this month.";
      }
      if (msg) {
        msg.textContent = "Upgrade to Pro for unlimited cost, vulnerability, " +
          "and algorithm runs. The free counter resets on " + quotaResetDate() + ".";
      }
      banner.hidden = false;
    }

    // The 402 modal (D-1): raised on the run attempt, not on load. Renders
    // the API's own message verbatim — paraphrasing the refusal is how the
    // banner and the response drift apart.
    if (opts.modal !== false) {
      var modalMsg   = document.getElementById("modal-quota-msg");
      var modalReset = document.getElementById("modal-quota-reset");
      if (modalMsg) {
        modalMsg.textContent = (detail && detail.message) ||
          ("You've used all " + ((detail && detail.monthlyRunsLimit) || 5) +
           " free analyses this month. Upgrade to Pro for unlimited runs.");
      }
      if (modalReset) {
        var used  = detail && typeof detail.monthlyRunsUsed  === "number" ? detail.monthlyRunsUsed  : null;
        var limit = detail && typeof detail.monthlyRunsLimit === "number" ? detail.monthlyRunsLimit : null;
        modalReset.textContent =
          (used !== null && limit !== null ? used + " of " + limit + " used · " : "") +
          "counter resets on " + quotaResetDate();
      }
      openModal("modal-quota");
    } else if (banner && typeof banner.scrollIntoView === "function") {
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // -----------------------------------------------------------------------
  // Modal plumbing — shared by every dialog on the page. One scrim pattern:
  // open sets [hidden]=false and focuses the first control; Esc and scrim
  // clicks close, EXCEPT dialogs marked data-modal-sticky (the key-reveal —
  // dismissing that by accident loses the secret).
  // -----------------------------------------------------------------------

  var openModalId = null;

  function openModal(id) {
    var scrim = document.getElementById(id);
    if (!scrim) return;
    if (openModalId && openModalId !== id) closeModal(openModalId);
    scrim.hidden = false;
    openModalId = id;
    var first = scrim.querySelector("input:not([readonly]), button:not([data-modal-close]):not(.modal-x), a[href]");
    if (!first) first = scrim.querySelector("button");
    if (first && typeof first.focus === "function") first.focus();
  }

  function closeModal(id) {
    var scrim = document.getElementById(id || openModalId);
    if (!scrim) return;
    scrim.hidden = true;
    if (openModalId === (id || openModalId)) openModalId = null;
  }

  function startUpgradeCheckout(button) {
    setBusy(button, true, "Opening Stripe…");
    callApi("/api/checkout", {}).then(function (res) {
      if (res && res.url) {
        window.location.assign(res.url);
        return;
      }
      setBusy(button, false);
    }).catch(function (err) {
      setBusy(button, false);
      window.alert((err && err.message) || "Could not start checkout");
    });
  }

  // -----------------------------------------------------------------------
  // "Manage billing" — POST /api/billing/portal then redirect to Stripe's
  // hosted Customer Portal. State changes (cancel, card swap) come back as
  // webhooks and are reflected on the dashboard's next load via /api/me.
  // -----------------------------------------------------------------------

  function openBillingPortal(button) {
    setBusy(button, true, "Opening…");
    callApi("/api/billing/portal", {}).then(function (res) {
      if (res && res.url) {
        window.location.assign(res.url);
        // Don't restore the button — we're leaving the page.
        return;
      }
      setBusy(button, false);
    }).catch(function (err) {
      setBusy(button, false);
      // Surface the failure so the user isn't left wondering. We deliberately
      // use alert here (rather than the analyzer error pane) because the
      // billing button lives in the header, away from any output region.
      var msg = (err && err.message) || "Could not open billing portal";
      window.alert(msg);
    });
  }

  // -----------------------------------------------------------------------
  // Logout — POST /api/logout, then go home regardless of network outcome
  // -----------------------------------------------------------------------

  function doLogout(button) {
    setBusy(button, true, "Signing out…");
    fetch(apiUrl("/api/logout"), {
      method: "POST",
      credentials: "include",
      headers: { "Accept": "application/json" }
    })
      .catch(function () { /* network error → still bounce home below */ })
      .then(function () { window.location.assign("/"); });
  }

  // -----------------------------------------------------------------------
  // Wire up
  // -----------------------------------------------------------------------

  function attach() {
    // Copy-to-clipboard for the AI refactor's rewritten function. Lives in
    // its own delegated handler because the button is rendered dynamically
    // by renderAlgo() and we want a single global listener instead of one
    // per render.
    document.addEventListener("click", function (event) {
      var c = event.target.closest && event.target.closest("button[data-copy-target]");
      if (!c) return;
      var src = document.getElementById(c.dataset.copyTarget);
      if (!src || !navigator.clipboard) return;
      navigator.clipboard.writeText(src.textContent || "").then(function () {
        var orig = c.textContent;
        c.textContent = "Copied!";
        setTimeout(function () { c.textContent = orig; }, 1200);
      }).catch(function () { /* ignored — clipboard may be denied */ });
    });

    document.addEventListener("click", function (event) {
      var t = event.target.closest && event.target.closest("button[data-action]");
      if (!t) return;
      var action = t.dataset.action;
      var target = t.dataset.target;
      if (action === "sample") {
        if (target === "cost") {
          var blob = new Blob([SAMPLE_CUR], { type: "text/csv" });
          setCostFile(blob, "sample-cur.csv (built-in)");
        } else if (target === "algo") {
          var algoInput = document.getElementById("input-algo");
          var algoSample = document.getElementById("input-algo-sample");
          if (algoInput)  algoInput.value  = SAMPLES.algo;
          if (algoSample) algoSample.value = SAMPLES.algoSample;
        } else {
          // SAMPLES[target] is a string for input/textarea fields. Works for
          // the URL input on the vuln panel.
          var input = document.getElementById("input-" + target);
          if (input && SAMPLES[target] !== undefined) input.value = SAMPLES[target];
        }
      } else if (action === "run") {
        if      (target === "cost") runCost(t);
        else if (target === "vuln") runVuln(t);
        else if (target === "algo") runAlgo(t);
      }
    });

    // Recent-runs panel: re-run + CSV download. Lazy-fetches the full record
    // from /api/runs/:id only when the user actually clicks (the list view
    // intentionally omits input/result to stay small).
    document.addEventListener("click", function (event) {
      var btn = event.target.closest && event.target.closest("button[data-run-action]");
      if (!btn) return;
      var action = btn.dataset.runAction;
      var id     = btn.dataset.runId;
      if (!id) return;

      if (action === "rerun") {
        setBusy(btn, true, "Loading…");
        callApi("/api/runs/" + encodeURIComponent(id), null, "GET").then(function (run) {
          setBusy(btn, false);
          rerunFromHistory(run, btn);
        }).catch(function (e) {
          setBusy(btn, false);
          showOutput(btn.dataset.runAnalyzer || "algo",
            errorState(e.message || "Could not load run"));
        });
      } else if (action === "csv") {
        setBusy(btn, true, "Exporting…");
        callApi("/api/runs/" + encodeURIComponent(id), null, "GET").then(function (run) {
          var csv = csvForRun(run);
          // Never hand back an empty file. The button is rendered for every
          // run, and csvForRun had no branch for arch or estimate — so those
          // downloaded a 0-byte .csv and said nothing about why. A silent
          // empty export is indistinguishable from "this run found nothing",
          // which is the one thing it must not be mistaken for.
          if (!csv || !csv.trim()) {
            showOutput(btn.dataset.runAnalyzer || run.analyzer || "algo",
              errorState("There is no CSV export for a \"" + run.analyzer + "\" run, " +
                         "so nothing was downloaded."));
            return;
          }
          var stamp = new Date(run.createdAt || Date.now()).toISOString().replace(/[:.]/g, "-");
          downloadCsv("algosize-" + run.analyzer + "-" + stamp + ".csv", csv);
        }).catch(function (e) {
          showOutput(btn.dataset.runAnalyzer || "algo",
            errorState(e.message || "Could not export CSV"));
        }).then(function () { setBusy(btn, false); });
      }
    });

    var refreshBtn = $("#runs-refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        setBusy(refreshBtn, true, "Refreshing…");
        loadRuns().then(function () { setBusy(refreshBtn, false); });
      });
    }

    // Cost panel file picker — the visible "Choose CUR file…" button proxies
    // the click into the hidden <input type=file>; the change event then
    // updates the displayed filename and stores the File for the run handler.
    var costFileInput = $("#input-cost-file");
    var costFileBtn   = $("#input-cost-btn");
    if (costFileBtn && costFileInput) {
      costFileBtn.addEventListener("click", function () { costFileInput.click(); });
      costFileInput.addEventListener("change", function () {
        var f = costFileInput.files && costFileInput.files[0];
        if (!f) { setCostFile(null, null); return; }
        setCostFile(f, f.name);
      });
    }

    var logoutBtn = $("#logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () { doLogout(logoutBtn); });
    }

    var billingBtn = $("#billing-portal-btn");
    if (billingBtn) {
      billingBtn.addEventListener("click", function () { openBillingPortal(billingBtn); });
    }

    var upgradeBtn = $("#quota-upgrade-btn");
    if (upgradeBtn) {
      upgradeBtn.addEventListener("click", function () { startUpgradeCheckout(upgradeBtn); });
    }
    var modalUpgradeBtn = $("#modal-quota-upgrade");
    if (modalUpgradeBtn) {
      modalUpgradeBtn.addEventListener("click", function () { startUpgradeCheckout(modalUpgradeBtn); });
    }

    // Modal close plumbing: any [data-modal-close], a click on the scrim
    // itself, or Escape — except dialogs marked data-modal-sticky.
    document.addEventListener("click", function (event) {
      var closer = event.target.closest && event.target.closest("[data-modal-close]");
      if (closer) {
        var scrim = closer.closest(".modal-scrim");
        if (scrim) closeModal(scrim.id);
        return;
      }
      if (event.target.classList && event.target.classList.contains("modal-scrim") &&
          !event.target.hasAttribute("data-modal-sticky")) {
        closeModal(event.target.id);
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !openModalId) return;
      var scrim = document.getElementById(openModalId);
      if (scrim && !scrim.hasAttribute("data-modal-sticky")) closeModal(openModalId);
    });

    // Runs feed filter (D-3).
    var filterGroup = $("#runs-filter");
    if (filterGroup) {
      filterGroup.addEventListener("click", function (event) {
        var b = event.target.closest && event.target.closest("[data-runs-filter]");
        if (b) setRunsFilter(b.dataset.runsFilter);
      });
    }

    hydrateHeader();
    loadRuns();
  }

  // -----------------------------------------------------------------------
  // Shared core for the other dashboard modules (dash-team.js,
  // dash-monitors.js, dash-report.js, dash-arch.js, dash-router.js). Script
  // order in dashboard.html guarantees this exists before they run.
  // -----------------------------------------------------------------------

  window.DashCore = {
    apiUrl: apiUrl,
    callApi: callApi,
    el: el,
    setBusy: setBusy,
    emptyState: emptyState,
    errorState: errorState,
    formatRelativeTime: formatRelativeTime,
    openModal: openModal,
    closeModal: closeModal,
    openBillingPortal: openBillingPortal,
    startUpgradeCheckout: startUpgradeCheckout,
    showQuotaBanner: showQuotaBanner,
    loadRuns: loadRuns,
    me: function () { return lastMe; },
    refreshMe: hydrateHeader,
    // The three manual renderers, exposed so a result fetched from somewhere
    // OTHER than this file's own run buttons can be drawn by the same code.
    // The monitored half of each tool page uses these: a nightly result and
    // a hand-run result are the same kind of thing and must never render
    // through two implementations that can disagree about what a finding
    // looks like. (rerunFromHistory already does exactly this internally —
    // this just makes the same path reachable from another module.)
    //
    // These call the renderer and STOP. Each internal renderer already ends in
    // its own showOutput(...) and therefore returns undefined, so wrapping one
    // in another showOutput cleared the output that had just been drawn and
    // then threw on appendChild(undefined) — "Argument 1 ('node') to
    // Node.appendChild must be an instance of Node". That is what every
    // monitored "Show the advisories →" did, on all three tool pages.
    renderVuln: function (result) { renderVuln(result); },
    renderCost: function (result) {
      renderCost(result);
      renderCostChart(result && result.suggestions);
    },
    renderAlgo: function (result) { renderAlgo(result); },
    // Exported so the export itself is testable. The Download CSV button is
    // offered on every run, so "does this analyzer actually produce rows"
    // has to be checkable — it silently produced a 0-byte file for arch and
    // estimate, and source-reading cannot catch that.
    csvForRun: csvForRun,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
