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
      ["Severity", "Package", "Installed", "Fixed in", "CVE / Advisory"].forEach(function (h) {
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

        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }

    if (result.fixCommand) {
      wrap.appendChild(el("h4", { class: "result-section-title" }, "Fix command"));
      wrap.appendChild(el("pre", { class: "result-snippet" }, result.fixCommand));
    }

    showOutput("vuln", wrap);
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

    // LLM refactor suggestion + copy-to-clipboard rewrite block.
    if (result.suggestion) {
      var sugTitle = result.suggestion.provider === "openai"
        ? "AI refactor suggestion"
        : "Refactor suggestion (AI disabled)";
      wrap.appendChild(el("h4", { class: "result-section-title" }, sugTitle));
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
      }
    }

    showOutput("algo", wrap);
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
      .then(function (res) { renderAlgo(res); loadRuns(); })
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

  function renderRunsList(items) {
    var listEl = $("#runs-list");
    if (!listEl) return;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

    if (!items || items.length === 0) {
      listEl.appendChild(emptyState("No runs yet — pick an analyzer below to get started."));
      return;
    }

    var ul = el("ul", { class: "runs-items" });
    items.forEach(function (it) {
      var li = el("li", { class: "run-item run-item-" + it.analyzer });

      var meta = el("div", { class: "run-item-meta" });
      meta.appendChild(el("span", { class: "tag run-tag-" + it.analyzer }, it.analyzer));
      meta.appendChild(el("span", { class: "run-item-headline" }, it.headline || "—"));
      meta.appendChild(el("span", { class: "run-item-time mono" }, formatRelativeTime(it.createdAt)));
      li.appendChild(meta);

      var actions = el("div", { class: "run-item-actions" });
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
    return callApi("/api/runs?limit=20", null, "GET").then(function (page) {
      renderRunsList((page && page.items) || []);
    }).catch(function (e) {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      listEl.appendChild(errorState(e.message || "Could not load run history"));
    });
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

  function hydrateHeader() {
    var emailEl   = document.getElementById("dash-user-email");
    var statusEl  = document.getElementById("dash-status");
    var textEl    = document.getElementById("dash-status-text");
    var billingEl = document.getElementById("billing-portal-btn");
    var quotaEl   = document.getElementById("dash-quota");
    var quotaVal  = document.getElementById("dash-quota-value");
    if (!emailEl || !statusEl || !textEl) return;

    callApi("/api/me", null, "GET").then(function (me) {
      // callApi already redirects to "/" on 401, so we only get here for 2xx.
      if (me && me.email) {
        emailEl.textContent = me.email;
        emailEl.hidden = false;
      }

      // Task #19: render the quota pill BEFORE the subscription status
      // pill so free users see "X / 5" prominently and paid users see
      // "Unlimited". Falls back to hidden if the server didn't return
      // a `plan` field (e.g. an older Worker is deployed).
      if (quotaEl && quotaVal && me && me.plan) {
        if (me.plan === "free") {
          var used  = typeof me.monthlyRunsUsed  === "number" ? me.monthlyRunsUsed  : 0;
          var limit = typeof me.monthlyRunsLimit === "number" ? me.monthlyRunsLimit : 5;
          quotaVal.textContent = used + " / " + limit;
          quotaEl.classList.toggle("dash-quota--depleted", used >= limit);
          quotaEl.hidden = false;
          // If the user is already over quota when the page loads, show
          // the upgrade banner pre-emptively so they know why their next
          // run will fail.
          if (used >= limit) {
            showQuotaBanner({
              monthlyRunsUsed:  used,
              monthlyRunsLimit: limit,
            });
          }
        } else if (me.plan === "paid") {
          quotaVal.textContent = "Unlimited";
          quotaEl.classList.add("dash-quota--unlimited");
          quotaEl.hidden = false;
        }
      }

      // Subscription status pill — only meaningful for paid users (free
      // users have subStatus === null). For free users, hide the pill so
      // the header doesn't read "Subscription cancelled" — they never had
      // one to cancel.
      if (me && me.subStatus) {
        var active = me.subStatus === "active";
        textEl.textContent = active ? "Subscription active" : "Subscription cancelled";
        statusEl.classList.toggle("dash-status--inactive", !active);
        statusEl.hidden = false;
      }

      // Show "Manage billing" only for users that ever made it through
      // checkout (any non-null subStatus implies a Stripe customer record).
      // Free users hide it because they have no Stripe customer to manage.
      if (billingEl && me && me.subStatus) {
        billingEl.hidden = false;
      }
    }).catch(function () {
      // Network error or non-401 failure: leave header empty rather than show
      // misleading "active" text. The user can still use the analyzers; if
      // their session is truly dead the next analyzer call will 401 → "/".
    });
  }

  // -----------------------------------------------------------------------
  // Quota upgrade banner (Task #19) — revealed by callApi when an analyzer
  // returns 402 quota_exceeded. The "Upgrade to Pro →" button kicks off
  // the existing /api/checkout flow (Task #4), same as the marketing site.
  // -----------------------------------------------------------------------

  function showQuotaBanner(detail) {
    var banner = document.getElementById("quota-upgrade-banner");
    var title  = document.getElementById("quota-banner-title");
    var msg    = document.getElementById("quota-banner-msg");
    if (!banner) return;
    if (title && detail && typeof detail.monthlyRunsLimit === "number") {
      title.textContent = "You've used all " + detail.monthlyRunsLimit +
        " free analyses this month.";
    }
    if (msg) {
      msg.textContent = "Upgrade to Pro for unlimited cost, vulnerability, " +
        "and algorithm runs. The free counter resets on the 1st of next month.";
    }
    banner.hidden = false;
    // Scroll the banner into view so the user notices the state change
    // without having to scroll up from the analyzer panel they were using.
    if (typeof banner.scrollIntoView === "function") {
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    }
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

    hydrateHeader();
    loadRuns();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
