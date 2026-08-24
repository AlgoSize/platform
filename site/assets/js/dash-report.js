// Report viewer (D-4) — the in-dashboard surface for one dependency audit.
//
// Mirrors the R2 HTML artefact section for section (severity band, findings
// with CVSS evidence, remediation order, coverage caveats, scope footer) and
// renders from the same stored result, so the two can only disagree if the
// data does — which it can't, it's the same row.
//
//   GET    /api/runs/:id                     the stored run (result + input)
//   GET    /api/runs/:id/report?format=…     html | sarif | cyclonedx
//   POST   /api/runs/:id/share               mint a read-only link
//   GET    /api/runs/:id/shares              the links already minted
//   DELETE /api/runs/:id/share/:token        revoke one
//
// The share list now has a backing endpoint (src/reports/share.js keeps a
// per-run index), so the modal opens on what is already live rather than
// only on the create form. A view counter is still absent: nothing records
// share reads, and a "0 views" that means "not measured" would be a lie.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  var SEV_ORDER = ["critical", "high", "medium", "low", "unknown"];
  var SEV_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low", unknown: "Unrated" };
  var SEV_MARK  = { critical: "▲▲", high: "▲", medium: "●", low: "·", unknown: "?" };

  var state = {
    runId: null,
    run: null,
    shareDays: 7,
    share: null,        // { token, url } of the link minted this session
  };

  function fmtStamp(ms) {
    if (typeof ms !== "number") return "—";
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }

  function sevChip(sev) {
    var s = SEV_ORDER.indexOf(sev) >= 0 ? sev : "unknown";
    var chip = el("span", { class: "chip chip-sev chip-sev-" + s });
    chip.appendChild(el("span", { "aria-hidden": "true", class: "chip-mark" }, SEV_MARK[s]));
    chip.appendChild(el("span", { class: "chip-text" }, SEV_LABEL[s]));
    return chip;
  }

  function copyButton(text, label) {
    var btn = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, label || "Copy");
    btn.addEventListener("click", function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function () {
        var orig = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = orig; }, 1200);
      }).catch(function () {});
    });
    return btn;
  }

  // ---------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------

  function verdictBand(summary, counts) {
    var band = el("div", { class: "report-verdict" });

    var gradeWrap = el("div", { class: "report-grade-wrap" });
    var grade = summary.grade || "—";
    var gradeBox = el("span", {
      class: "report-grade report-grade-" + String(grade).toLowerCase(),
      "aria-label": "Grade " + grade +
        (typeof summary.securityScore === "number" ? ", security score " + summary.securityScore + " of 100" : ""),
    }, grade);
    gradeWrap.appendChild(gradeBox);
    if (typeof summary.securityScore === "number") {
      gradeWrap.appendChild(el("span", { class: "mono report-score" }, summary.securityScore + " / 100"));
    }
    band.appendChild(gradeWrap);

    var note = counts.critical > 0
      ? "A single critical finding caps the grade at F, whatever else is clean."
      : counts.high > 0
      ? "A single high finding caps the grade at D, whatever else is clean."
      : (counts.unknown || 0) > 0
      ? "An advisory we could not score caps the grade at C — unrated is not low."
      : "No severity cap applied — this grade is the deduction arithmetic alone.";
    band.appendChild(el("p", { class: "report-grade-note" }, note));

    var tiles = el("div", { class: "report-counts" });
    var shown = ["critical", "high", "medium", "low"];
    if ((counts.unknown || 0) > 0) shown.push("unknown");
    shown.forEach(function (sev) {
      var tile = el("span", { class: "report-count report-count-" + sev + ((counts[sev] || 0) > 0 ? " has" : "") });
      tile.appendChild(el("span", { class: "report-count-n mono" }, String(counts[sev] || 0)));
      tile.appendChild(el("span", { class: "report-count-l mono" }, SEV_LABEL[sev]));
      tiles.appendChild(tile);
    });
    band.appendChild(tiles);
    return band;
  }

  function partialCaveat(summary) {
    if (summary.complete !== false) return null;
    var box = el("div", { class: "banner banner-amber", role: "note" });
    var wrap = el("div", { class: "banner-text" });
    var strong = el("strong", null);
    strong.appendChild(el("span", { class: "banner-glyph", "aria-hidden": "true" }, "▲"));
    strong.appendChild(document.createTextNode("Coverage is incomplete — these counts are a lower bound"));
    wrap.appendChild(strong);
    // The Worker's own partialReason, verbatim — never paraphrased softer.
    wrap.appendChild(el("p", null, summary.partialReason ||
      "This audit hit an internal cap and did not cover everything."));
    box.appendChild(wrap);
    return box;
  }

  function cleanBand(result) {
    var scanned = result.scanned || {};
    var box = el("div", { class: "report-clean" });
    var head = el("h3", null);
    head.appendChild(el("span", { class: "report-clean-check", "aria-hidden": "true" }, "✓ "));
    head.appendChild(document.createTextNode(
      "0 known advisories across " + (scanned.totalPackages || 0) + " packages"));
    box.appendChild(head);
    box.appendChild(el("p", null,
      "Every resolved dependency was checked against OSV. This is a statement about what was " +
      "published at the time of the scan, not a guarantee about code that hasn't been looked at since."));
    return box;
  }

  function findingsSection(advisories, fixEcosystemCmd) {
    var section = el("section", { class: "report-section" });
    var head = el("div", { class: "report-section-head" });
    head.appendChild(el("h3", null, "Findings"));
    head.appendChild(el("span", { class: "mono report-section-note" },
      advisories.length + " advisor" + (advisories.length === 1 ? "y" : "ies") +
      " · ordered worst first"));
    section.appendChild(head);

    var sorted = advisories.slice().sort(function (a, b) {
      var d = SEV_ORDER.indexOf(a.severity || "unknown") - SEV_ORDER.indexOf(b.severity || "unknown");
      if (d !== 0) return d;
      return (b.cvssScore || 0) - (a.cvssScore || 0);
    });

    var ul = el("ul", { class: "finding-list" });
    sorted.forEach(function (a, i) {
      var li = el("li", { class: "finding-item finding-sev-" + (a.severity || "unknown") });

      var detailId = "finding-detail-" + i;
      var btn = el("button", {
        type: "button", class: "finding-toggle",
        "aria-expanded": "false", "aria-controls": detailId,
      });
      btn.appendChild(sevChip(a.severity || "unknown"));
      btn.appendChild(el("span", { class: "mono finding-pkg" },
        a.package + (a.ecosystem ? " (" + a.ecosystem + ")" : "")));
      btn.appendChild(el("span", { class: "mono finding-versions" + (a.fixedIn ? "" : " finding-nofix") },
        a.fixedIn ? a.installedVersion + " → " + a.fixedIn : a.installedVersion + " → no fix yet"));
      btn.appendChild(el("span", { class: "mono finding-id" }, a.id));
      btn.appendChild(el("span", { class: "finding-chevron", "aria-hidden": "true" }, "▾"));
      li.appendChild(btn);

      var detail = el("div", { class: "finding-detail", id: detailId });
      detail.hidden = true;

      var cvssRow = el("div", { class: "finding-cvss" });
      var scoreCol = el("div", { class: "finding-cvss-col" });
      scoreCol.appendChild(el("span", { class: "mono finding-label" },
        "CVSS " + (a.cvssVersion || "—")));
      var scoreLine = el("span", { class: "finding-score-line" });
      scoreLine.appendChild(el("span", { class: "mono finding-score" },
        a.cvssScore == null ? "—" : Number(a.cvssScore).toFixed(1)));
      scoreLine.appendChild(el("span", { class: "mono finding-score-note" },
        a.cvssScore == null ? "no published score"
          : (a.severityApproximate ? "approximate" : "computed from the vector")));
      scoreCol.appendChild(scoreLine);
      cvssRow.appendChild(scoreCol);
      var vecCol = el("div", { class: "finding-cvss-col finding-cvss-vec" });
      vecCol.appendChild(el("span", { class: "mono finding-label" }, "Vector"));
      vecCol.appendChild(el("span", { class: "mono finding-vector" },
        a.cvssVector || "No vector published — severity taken from the advisory's own rating."));
      cvssRow.appendChild(vecCol);
      detail.appendChild(cvssRow);

      if (a.summary) detail.appendChild(el("p", { class: "finding-summary" }, a.summary));

      var cmd = a.fixedIn && fixEcosystemCmd
        ? fixEcosystemCmd(a)
        : null;
      if (cmd) {
        var cmdRow = el("div", { class: "snippet-row" });
        cmdRow.appendChild(el("pre", { class: "result-snippet result-snippet-inline" }, cmd));
        cmdRow.appendChild(copyButton(cmd));
        detail.appendChild(cmdRow);
      }

      detail.appendChild(el("a", {
        class: "mono finding-osv-link",
        href: a.advisoryUrl || ("https://osv.dev/vulnerability/" + encodeURIComponent(a.id || "")),
        target: "_blank", rel: "noopener",
      }, (a.id || "advisory") + " on OSV →"));

      li.appendChild(detail);

      btn.addEventListener("click", function () {
        var open = detail.hidden;
        detail.hidden = !open;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        li.classList.toggle("finding-open", open);
      });

      ul.appendChild(li);
    });
    section.appendChild(ul);
    return section;
  }

  function remediationSection(steps) {
    if (!Array.isArray(steps) || !steps.length) return null;
    var section = el("section", { class: "report-section" });
    var head = el("div", { class: "report-section-head" });
    head.appendChild(el("h3", null, "Remediation order"));
    head.appendChild(el("span", { class: "mono report-section-note" },
      "first item first — not a list to triage"));
    section.appendChild(head);

    var ol = el("ol", { class: "remediation-list" });
    steps.forEach(function (r, i) {
      var li = el("li", { class: "remediation-item" });
      li.appendChild(el("span", { class: "remediation-n mono", "aria-hidden": "true" }, String(i + 1)));
      var body = el("div", { class: "remediation-body" });
      var top = el("div", { class: "remediation-top" });
      top.appendChild(el("span", { class: "chip chip-prio chip-prio-" + (r.priority || "next") },
        r.priority || "next"));
      top.appendChild(el("span", { class: "remediation-action" }, r.action || ""));
      body.appendChild(top);
      if (r.why) body.appendChild(el("p", { class: "remediation-why" }, r.why));
      if (r.command) {
        var row = el("div", { class: "snippet-row" });
        row.appendChild(el("pre", { class: "result-snippet result-snippet-inline" }, r.command));
        row.appendChild(copyButton(r.command));
        body.appendChild(row);
      }
      li.appendChild(body);
      ol.appendChild(li);
    });
    section.appendChild(ol);
    return section;
  }

  function scopeFooter(run) {
    var result = run.result || {};
    var scanned = result.scanned || {};
    var ci = result.ci || {};
    var input = run.input || {};

    var footer = el("footer", { class: "report-scope mono" });
    var bits = [];
    var repo = ci.repo || input.repo || input.repoUrl || null;
    if (repo) bits.push(String(repo).replace(/^https?:\/\/(www\.)?github\.com\//, ""));
    if (ci.ref) bits.push(String(ci.ref).replace("refs/heads/", ""));
    if (ci.commitSha) bits.push(String(ci.commitSha).slice(0, 7));
    if (scanned.manifests && scanned.manifests.length) {
      bits.push(scanned.manifests.map(function (m) { return m.filename; }).join(", "));
    }
    if (typeof scanned.totalPackages === "number") {
      var pkgLine = scanned.totalPackages + " packages";
      if (typeof scanned.packagesFound === "number" && scanned.packagesFound > scanned.totalPackages) {
        pkgLine = scanned.totalPackages + " of " + scanned.packagesFound + " packages";
      }
      bits.push(pkgLine);
    }
    footer.appendChild(el("span", null, bits.join(" · ") || "—"));
    footer.appendChild(el("span", null,
      "Run " + run.id + (run.source === "ci" ? " · CI" : "") + " · generated " + fmtStamp(run.createdAt)));
    return footer;
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  /**
   * The report, for whichever analyzer produced the run.
   *
   * This used to refuse anything that was not a dependency audit — "Reports
   * are produced for dependency audits; this is an 'arch' run" — which meant
   * View report on four of the five tools led to a dead end. The runs were
   * real and the results were stored; only the renderer was missing.
   *
   * Every analyzer shares the chrome (masthead, scope footer) and brings its
   * own body, because the analyzers genuinely do not have a common shape: a
   * grade band makes sense for a security audit and is meaningless for a cost
   * estimate. Forcing all four through one layout would either flatten them
   * into a list of numbers or invent a severity for things that have none.
   */
  function render(run) {
    var body = document.getElementById("report-body");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    var builder = BODIES[run.analyzer];
    if (!builder) {
      body.appendChild(core.errorState(
        "No report layout exists for a \"" + run.analyzer + "\" run yet."));
      return;
    }

    var wrap = el("div", { class: "report-wrap" });
    wrap.appendChild(masthead(run));
    builder(run, wrap);
    wrap.appendChild(scopeFooter(run));
    body.appendChild(wrap);
  }

  /** Eyebrow + subject line, identical for every analyzer. */
  function masthead(run) {
    var box = el("div", { class: "report-masthead" });
    var title = el("div", { class: "report-masthead-title" });
    title.appendChild(el("span", { class: "eyebrow" }, EYEBROW[run.analyzer] || "Report"));
    var result = run.result || {};
    var subject = (result.ci && result.ci.repo) ||
      (run.input && (run.input.repo || run.input.repoUrl || run.input.name)) ||
      SUBJECT_FALLBACK[run.analyzer] || "Report";
    title.appendChild(el("h2", null,
      String(subject).replace(/^https?:\/\/(www\.)?github\.com\//, "")));
    box.appendChild(title);
    return box;
  }

  var EYEBROW = {
    vuln: "Dependency audit", arch: "Architecture X-ray",
    algo: "Algorithm complexity", estimate: "Infrastructure cost",
    cost: "Cloud cost analysis",
  };
  var SUBJECT_FALLBACK = {
    vuln: "Audit report", arch: "System map", algo: "Measured function",
    estimate: "Estimated stack", cost: "Cost and usage report",
  };

  function renderVulnBody(run, wrap) {
    var result = run.result || {};
    var summary = result.summary || {};
    var counts = summary.counts || result.counts || {};
    var advisories = Array.isArray(result.advisories) ? result.advisories : [];

    wrap.appendChild(verdictBand(summary, counts));

    var caveat = partialCaveat(summary);
    if (caveat) wrap.appendChild(caveat);

    if (!advisories.length) {
      wrap.appendChild(cleanBand(result));
    } else {
      wrap.appendChild(findingsSection(advisories, function (a) {
        var eco = a.ecosystem;
        if (eco === "npm")      return "npm install " + a.package + "@" + a.fixedIn;
        if (eco === "PyPI")     return "pip install -U " + a.package + "==" + a.fixedIn;
        if (eco === "RubyGems") return "bundle update " + a.package;
        if (eco === "Go")       return "go get " + a.package + "@v" + String(a.fixedIn).replace(/^v/, "");
        return null;
      }));
      var rem = remediationSection(summary.remediation);
      if (rem) wrap.appendChild(rem);
    }
  }

  // ---------------------------------------------------------------------
  // Architecture X-ray
  // ---------------------------------------------------------------------
  //
  // Reuses the audit's severity chrome because architecture findings ARE
  // graded by severity — a circular dependency between two services is a
  // different order of problem from an inconsistent naming convention, and
  // the analyzer already says which is which. What it does not have is a
  // letter grade, so the verdict band is a shape count instead of an
  // invented score.

  function renderArchBody(run, wrap) {
    var result = run.result || {};
    var summary = result.summary || {};
    var bySev = summary.bySeverity || {};
    var findings = Array.isArray(result.findings) ? result.findings : [];

    wrap.appendChild(shapeBand([
      { n: summary.clusters || 0, label: "clusters" },
      { n: summary.nodes || (result.nodes && result.nodes.length) || 0, label: "modules" },
      { n: summary.edges || (result.edges && result.edges.length) || 0, label: "dependencies" },
      { n: typeof summary.findings === "number" ? summary.findings : findings.length,
        label: "findings", tone: (bySev.critical || bySev.high) ? "bad" : "ok" },
    ]));

    wrap.appendChild(severityTiles(bySev));

    if (!findings.length) {
      wrap.appendChild(emptyBand("No structural findings",
        "The graph was built and every rule ran. This says the shape is sound at the time of the " +
        "scan — not that the code inside each module is."));
      return;
    }
    wrap.appendChild(genericFindings(findings, {
      title: "Findings",
      note: findings.length + " finding" + (findings.length === 1 ? "" : "s") + " · ordered worst first",
      titleOf: function (f) { return f.title || f.rule || "Finding"; },
      whereOf: function (f) { return f.target || f.module || null; },
      bodyOf:  function (f) { return f.detail || f.why || f.message || ""; },
      fixOf:   function (f) { return f.recommendation || f.fix || null; },
    }));
  }

  // ---------------------------------------------------------------------
  // Algorithm complexity
  // ---------------------------------------------------------------------

  function renderAlgoBody(run, wrap) {
    var result = run.result || {};
    var bigO = (result.bigO && result.bigO.label) || "unmeasured";
    var ceiling = (run.input && run.input.ceiling) || (result.ceiling || null);

    var band = el("div", { class: "report-verdict" });
    var gradeWrap = el("div", { class: "report-grade-wrap" });
    gradeWrap.appendChild(el("span", { class: "report-bigo mono" }, bigO));
    if (typeof result.wallTimeMs === "number") {
      gradeWrap.appendChild(el("span", { class: "mono report-score" },
        result.wallTimeMs.toFixed(2) + " ms"));
    }
    band.appendChild(gradeWrap);
    // Said plainly, because a Big-O label read without this caveat gets
    // quoted as a proof. It is a curve fitted to timings on one machine.
    band.appendChild(el("p", { class: "report-grade-note" },
      ceiling
        ? "Measured against a declared ceiling of " + ceiling + ". A grade is a curve fitted to " +
          "observed timings, not a proof — treat a one-bucket move as noise."
        : "A grade is a curve fitted to observed timings on this machine, not a proof. " +
          "No ceiling was declared for this function, so nothing here can fail a build."));
    wrap.appendChild(band);

    var points = Array.isArray(result.samples) ? result.samples
               : Array.isArray(result.points) ? result.points : [];
    if (points.length) {
      var sec = el("section", { class: "report-section" });
      var head = el("div", { class: "report-section-head" });
      head.appendChild(el("h3", null, "Measurements"));
      head.appendChild(el("span", { class: "mono report-section-note" },
        points.length + " sample" + (points.length === 1 ? "" : "s")));
      sec.appendChild(head);

      var scroll = el("div", { class: "report-table-scroll" });
      var table = el("div", { class: "report-table" });
      var hr = el("div", { class: "report-table-row report-table-head" });
      hr.appendChild(el("span", { class: "mono" }, "Input size"));
      hr.appendChild(el("span", { class: "mono" }, "Wall time"));
      table.appendChild(hr);
      points.forEach(function (pt) {
        var row = el("div", { class: "report-table-row" });
        row.appendChild(el("span", { class: "mono" }, String(pt.n != null ? pt.n : pt.size || "—")));
        var ms = pt.ms != null ? pt.ms : pt.wallTimeMs;
        row.appendChild(el("span", { class: "mono" },
          typeof ms === "number" ? ms.toFixed(3) + " ms" : "—"));
        table.appendChild(row);
      });
      scroll.appendChild(table);
      sec.appendChild(scroll);
      wrap.appendChild(sec);
    }

    if (result.notes || result.warning) {
      wrap.appendChild(noteBand(result.notes || result.warning));
    }
  }

  // ---------------------------------------------------------------------
  // Infrastructure cost estimate
  // ---------------------------------------------------------------------

  function renderEstimateBody(run, wrap) {
    var result = run.result || {};
    var providers = Array.isArray(result.providers) ? result.providers : [];
    var priced = providers.filter(function (p) {
      return typeof p.estimatedTotalMicroUsd === "number";
    }).sort(function (a, b) { return a.estimatedTotalMicroUsd - b.estimatedTotalMicroUsd; });

    var spec = result.normalizedSpec || {};
    var resources = Array.isArray(spec.resources) ? spec.resources : [];

    if (priced.length) {
      var best = priced[0];
      var band = el("div", { class: "report-verdict" });
      var gw = el("div", { class: "report-grade-wrap" });
      gw.appendChild(el("span", { class: "report-price mono" }, money(best.estimatedTotalMicroUsd)));
      gw.appendChild(el("span", { class: "mono report-score" },
        "on " + (best.providerName || best.providerId)));
      band.appendChild(gw);
      band.appendChild(el("p", { class: "report-grade-note" },
        "Cheapest of " + priced.length + " provider" + (priced.length === 1 ? "" : "s") +
        " for " + resources.length + " resource" + (resources.length === 1 ? "" : "s") +
        (result.duration ? " over " + result.duration : "") + "."));
      wrap.appendChild(band);
    }

    // The disclaimer is not decoration and is never paraphrased: these are
    // list prices against a declared spec, not anybody's invoice.
    wrap.appendChild(noteBand(result.disclaimer ||
      "List prices against the submitted specification. Not a quote, and not your bill."));

    if (priced.length) {
      var sec = el("section", { class: "report-section" });
      var head = el("div", { class: "report-section-head" });
      head.appendChild(el("h3", null, "By provider"));
      head.appendChild(el("span", { class: "mono report-section-note" },
        "cheapest first" + (result.pricingCatalogVersion
          ? " · catalog " + result.pricingCatalogVersion : "")));
      sec.appendChild(head);

      var scroll = el("div", { class: "report-table-scroll" });
      var table = el("div", { class: "report-table" });
      var hr = el("div", { class: "report-table-row report-table-head" });
      ["Provider", "Monthly total", "Range", "Confidence"].forEach(function (h) {
        hr.appendChild(el("span", { class: "mono" }, h));
      });
      table.appendChild(hr);
      priced.forEach(function (p) {
        var row = el("div", { class: "report-table-row" });
        row.appendChild(el("span", { class: "mono" }, p.providerName || p.providerId));
        row.appendChild(el("span", { class: "mono" }, money(p.estimatedTotalMicroUsd)));
        // A single number where a range exists would overstate what the
        // engine actually knows, so the absence of one is shown as a dash
        // rather than by repeating the point estimate twice.
        row.appendChild(el("span", { class: "mono" },
          typeof p.lowerBoundMicroUsd === "number" && typeof p.upperBoundMicroUsd === "number"
            ? money(p.lowerBoundMicroUsd) + " – " + money(p.upperBoundMicroUsd)
            : "—"));
        row.appendChild(el("span", { class: "mono" }, p.confidence || "—"));
        table.appendChild(row);
      });
      scroll.appendChild(table);
      sec.appendChild(scroll);
      wrap.appendChild(sec);
    } else {
      wrap.appendChild(emptyBand("Nothing could be priced",
        "The specification parsed but no provider in the catalog could price it. That is a gap in " +
        "the catalog, not a statement that the stack is free."));
    }

    if (resources.length) {
      var rs = el("section", { class: "report-section" });
      var rh = el("div", { class: "report-section-head" });
      rh.appendChild(el("h3", null, "What was priced"));
      rh.appendChild(el("span", { class: "mono report-section-note" },
        resources.length + " resource" + (resources.length === 1 ? "" : "s")));
      rs.appendChild(rh);

      var rscroll = el("div", { class: "report-table-scroll" });
      var rtable = el("div", { class: "report-table" });
      var rhr = el("div", { class: "report-table-row report-table-head" });
      ["Resource", "Replicas", "vCPU", "Memory", "Storage"].forEach(function (h) {
        rhr.appendChild(el("span", { class: "mono" }, h));
      });
      rtable.appendChild(rhr);
      resources.forEach(function (r) {
        var row = el("div", { class: "report-table-row" });
        row.appendChild(el("span", { class: "mono" }, r.name || r.id || "—"));
        row.appendChild(el("span", { class: "mono" }, String(r.quantity != null ? r.quantity : 1)));
        row.appendChild(el("span", { class: "mono" }, milli(r.cpuMilli, "")));
        row.appendChild(el("span", { class: "mono" }, milli(r.memoryMilliGiB, " GiB")));
        row.appendChild(el("span", { class: "mono" }, milli(r.storageMilliGiB, " GiB")));
        rtable.appendChild(row);
      });
      rscroll.appendChild(rtable);
      rs.appendChild(rscroll);
      wrap.appendChild(rs);
    }

    var warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      wrap.appendChild(warningList(warnings));
    }
  }

  // ---------------------------------------------------------------------
  // Cloud cost analysis (CUR)
  // ---------------------------------------------------------------------

  function renderCostBody(run, wrap) {
    var result = run.result || {};
    var suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];

    var band = el("div", { class: "report-verdict" });
    var gw = el("div", { class: "report-grade-wrap" });
    gw.appendChild(el("span", { class: "report-price mono" },
      typeof result.totalSavingsPct === "number" ? result.totalSavingsPct + "%" : "—"));
    gw.appendChild(el("span", { class: "mono report-score" }, "of spend recoverable"));
    band.appendChild(gw);
    band.appendChild(el("p", { class: "report-grade-note" },
      suggestions.length
        ? suggestions.length + " suggestion" + (suggestions.length === 1 ? "" : "s") +
          ", ranked by what each is worth per month."
        : "No suggestion cleared the reporting threshold for this billing period."));
    wrap.appendChild(band);

    if (!suggestions.length) {
      wrap.appendChild(emptyBand("Nothing worth changing",
        "Every rule ran against the report and none found a saving large enough to be worth the " +
        "migration risk. That is a result, not an empty scan."));
      return;
    }

    wrap.appendChild(genericFindings(suggestions, {
      title: "Suggested savings",
      note: suggestions.length + " suggestion" + (suggestions.length === 1 ? "" : "s") +
            " · largest first",
      titleOf: function (x) { return x.title || x.service || "Saving"; },
      whereOf: function (x) {
        return typeof x.monthlySavingsUsd === "number"
          ? "$" + x.monthlySavingsUsd.toFixed(2) + " / mo" : null;
      },
      bodyOf: function (x) { return x.detail || x.why || ""; },
      fixOf:  function (x) { return x.action || x.recommendation || null; },
    }));
  }

  var BODIES = {
    vuln:     renderVulnBody,
    arch:     renderArchBody,
    algo:     renderAlgoBody,
    estimate: renderEstimateBody,
    cost:     renderCostBody,
  };

  // ---------------------------------------------------------------------
  // Shared pieces the non-audit bodies use
  // ---------------------------------------------------------------------

  function money(micro) {
    if (typeof micro !== "number") return "—";
    return "$" + (micro / 1000000).toFixed(2);
  }

  /** A milli-quantity as a plain number, or a dash when it is zero/absent. */
  function milli(v, unit) {
    if (typeof v !== "number" || v === 0) return "—";
    var n = v / 1000;
    return (Number.isInteger(n) ? String(n) : n.toFixed(2)) + (unit || "");
  }

  /** Four counted facts about a shape — the arch equivalent of a grade. */
  function shapeBand(items) {
    var band = el("div", { class: "report-verdict" });
    var tiles = el("div", { class: "report-counts" });
    items.forEach(function (it) {
      var tile = el("span", {
        class: "report-count" + (it.tone ? " report-count-" + it.tone : "") + (it.n ? " has" : ""),
      });
      tile.appendChild(el("span", { class: "report-count-n mono" }, String(it.n)));
      tile.appendChild(el("span", { class: "report-count-l mono" }, it.label));
      tiles.appendChild(tile);
    });
    band.appendChild(tiles);
    return band;
  }

  function severityTiles(bySev) {
    var tiles = el("div", { class: "report-counts" });
    ["critical", "high", "medium", "low"].forEach(function (sev) {
      var n = bySev[sev] || 0;
      var tile = el("span", { class: "report-count report-count-" + sev + (n ? " has" : "") });
      tile.appendChild(el("span", { class: "report-count-n mono" }, String(n)));
      tile.appendChild(el("span", { class: "report-count-l mono" }, SEV_LABEL[sev]));
      tiles.appendChild(tile);
    });
    return tiles;
  }

  function emptyBand(title, body) {
    var box = el("div", { class: "report-clean" });
    var head = el("h3", null);
    head.appendChild(el("span", { class: "report-clean-check", "aria-hidden": "true" }, "✓ "));
    head.appendChild(document.createTextNode(title));
    box.appendChild(head);
    box.appendChild(el("p", null, body));
    return box;
  }

  function noteBand(text) {
    var box = el("div", { class: "banner banner-amber", role: "note" });
    var wrap = el("div", { class: "banner-text" });
    wrap.appendChild(el("p", null, String(text)));
    box.appendChild(wrap);
    return box;
  }

  function warningList(warnings) {
    var sec = el("section", { class: "report-section" });
    var head = el("div", { class: "report-section-head" });
    head.appendChild(el("h3", null, "Assumptions and warnings"));
    head.appendChild(el("span", { class: "mono report-section-note" },
      warnings.length + " note" + (warnings.length === 1 ? "" : "s")));
    sec.appendChild(head);
    var ul = el("ul", { class: "report-warnings" });
    warnings.forEach(function (w) {
      ul.appendChild(el("li", null,
        typeof w === "string" ? w : (w.statement || w.message || JSON.stringify(w))));
    });
    sec.appendChild(ul);
    return sec;
  }

  /**
   * A findings list for analyzers whose items are not advisories.
   *
   * Shares the audit's markup so a finding looks the same wherever it came
   * from — the accessors are the only per-analyzer part, which keeps one
   * severity treatment rather than three that drift.
   */
  function genericFindings(items, opts) {
    var section = el("section", { class: "report-section" });
    var head = el("div", { class: "report-section-head" });
    head.appendChild(el("h3", null, opts.title));
    head.appendChild(el("span", { class: "mono report-section-note" }, opts.note));
    section.appendChild(head);

    var list = el("ol", { class: "report-findings" });
    items.forEach(function (item) {
      var li = el("li", { class: "report-finding report-finding-" + (item.severity || "unknown") });

      var top = el("div", { class: "report-finding-head" });
      if (item.severity) top.appendChild(sevChip(item.severity));
      top.appendChild(el("h4", null, opts.titleOf(item)));
      var where = opts.whereOf(item);
      if (where) top.appendChild(el("span", { class: "mono report-finding-where" }, where));
      li.appendChild(top);

      var bodyText = opts.bodyOf(item);
      if (bodyText) li.appendChild(el("p", { class: "report-finding-body" }, bodyText));

      var fix = opts.fixOf(item);
      if (fix) {
        var fixRow = el("div", { class: "report-finding-fix" });
        fixRow.appendChild(el("span", { class: "report-finding-fix-label mono" }, "Fix"));
        fixRow.appendChild(el("span", { class: "report-finding-fix-text" }, fix));
        li.appendChild(fixRow);
      }
      list.appendChild(li);
    });
    section.appendChild(list);
    return section;
  }

  // ---------------------------------------------------------------------
  // Share flow
  // ---------------------------------------------------------------------

  function setShareDays(days) {
    state.shareDays = days;
    document.querySelectorAll("#share-expiry-row .choice-btn").forEach(function (b) {
      var on = b.dataset.days === String(days);
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.classList.toggle("choice-btn-selected", on);
    });
  }

  function openShare() {
    var createStage = document.getElementById("share-create-stage");
    var resultStage = document.getElementById("share-result-stage");
    var err = document.getElementById("share-error");
    if (err) err.hidden = true;
    if (createStage) createStage.hidden = false;
    if (resultStage) resultStage.hidden = true;
    setShareDays(7);
    core.openModal("modal-share");
    loadShares();
  }

  /**
   * Show the links already live for this report.
   *
   * Best-effort: a failure here hides the section rather than blocking the
   * modal. Being unable to list existing links must not stop someone minting
   * a new one — the create path is the reason they opened this.
   */
  function loadShares() {
    var stage = document.getElementById("share-existing-stage");
    var list  = document.getElementById("share-existing-list");
    if (!stage || !list || !state.runId) return;
    stage.hidden = true;

    callApi("/api/runs/" + encodeURIComponent(state.runId) + "/shares", null, "GET")
      .then(function (res) {
        var shares = (res && res.shares) || [];
        while (list.firstChild) list.removeChild(list.firstChild);
        if (!shares.length) { stage.hidden = true; return; }

        shares.forEach(function (sh) {
          var li = el("li", { class: "share-item" });
          li.appendChild(el("span", { class: "mono share-item-url" }, sh.url || ""));

          // Expired links are listed, not hidden: "this stopped working on the
          // 4th" is a different answer from "you never shared this", and the
          // person chasing a client who says the link is dead needs the first.
          var when = sh.expiresAt
            ? new Date(sh.expiresAt * 1000).toLocaleDateString("en-US",
                { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
            : "—";
          li.appendChild(el("span",
            { class: "chip " + (sh.expired ? "chip-muted" : "chip-ok") },
            sh.expired ? "expired " + when : "expires " + when));

          var copyBtn = el("button",
            { type: "button", class: "btn btn-ghost btn-sm" }, "Copy");
          copyBtn.addEventListener("click", function () {
            if (navigator.clipboard) navigator.clipboard.writeText(sh.url || "").catch(function () {});
            copyBtn.textContent = "Copied";
            setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
          });
          li.appendChild(copyBtn);

          // An expired link needs no revoking — it already grants nothing.
          if (!sh.expired) {
            var rev = el("button",
              { type: "button", class: "btn btn-ghost btn-sm share-item-revoke" }, "Revoke");
            rev.addEventListener("click", function () { revokeListed(sh, rev); });
            li.appendChild(rev);
          }
          list.appendChild(li);
        });
        stage.hidden = false;
      })
      .catch(function () { stage.hidden = true; });
  }

  /** Revoke one link from the list, then re-read rather than patching the DOM. */
  function revokeListed(sh, btn) {
    if (!window.confirm(
      "Revoke this link? Anyone who already has it — including a client you sent " +
      "it to — loses access immediately. This cannot be undone.")) return;
    setBusy(btn, true, "Revoking…");
    callApi("/api/runs/" + encodeURIComponent(state.runId) + "/share/" +
            encodeURIComponent(sh.token), null, "DELETE")
      .then(function () {
        // If the link just revoked is the one shown in the result stage, drop
        // that too — leaving it on screen would offer a copy button for a dead
        // link.
        if (state.share && state.share.token === sh.token) {
          state.share = null;
          var resultStage = document.getElementById("share-result-stage");
          var createStage = document.getElementById("share-create-stage");
          if (resultStage) resultStage.hidden = true;
          if (createStage) createStage.hidden = false;
        }
        loadShares();
      })
      .catch(function (e) { window.alert((e && e.message) || "Could not revoke the link"); })
      .then(function () { setBusy(btn, false); });
  }

  function createShare(btn) {
    if (!state.runId) return;
    var err = document.getElementById("share-error");
    setBusy(btn, true, "Creating…");
    callApi("/api/runs/" + encodeURIComponent(state.runId) + "/share",
            { expiresInDays: state.shareDays })
      .then(function (res) {
        state.share = res;
        var createStage = document.getElementById("share-create-stage");
        var resultStage = document.getElementById("share-result-stage");
        var urlInput = document.getElementById("share-url");
        var note = document.getElementById("share-expiry-note");
        if (urlInput) urlInput.value = res.url || "";
        if (note) {
          note.textContent = "Expires " + new Date(res.expiresAt * 1000).toLocaleDateString("en-US",
            { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) +
            " · read-only · this one report and nothing else";
        }
        if (createStage) createStage.hidden = true;
        if (resultStage) resultStage.hidden = false;
        var copyBtn = document.getElementById("share-copy-btn");
        if (copyBtn) copyBtn.focus();
        loadShares();
      })
      .catch(function (e) {
        if (err) { err.textContent = e.message || "Could not create the link."; err.hidden = false; }
      })
      .then(function () { setBusy(btn, false); });
  }

  function revokeShare(btn) {
    if (!state.runId || !state.share || !state.share.token) return;
    setBusy(btn, true, "Revoking…");
    callApi("/api/runs/" + encodeURIComponent(state.runId) + "/share/" +
            encodeURIComponent(state.share.token), null, "DELETE")
      .then(function () {
        state.share = null;
        core.closeModal("modal-share");
      })
      .catch(function (e) { window.alert((e && e.message) || "Could not revoke the link"); })
      .then(function () { setBusy(btn, false); });
  }

  // ---------------------------------------------------------------------
  // Open + wire
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Export — the Download file-picker
  // ---------------------------------------------------------------------

  function reportBase() {
    return core.apiUrl("") + "/api/runs/" + encodeURIComponent(state.runId) + "/report";
  }

  // Which formats exist per analyzer. The document formats (PDF page, CSV,
  // SARIF, SBOM) all describe a dependency audit — the Worker refuses them
  // for other analyzers with a 400, so the picker doesn't offer what the
  // server would bounce. JSON is the raw result and works for every run.
  function formatsFor(analyzer) {
    // The document formats describe a dependency audit specifically — SARIF
    // is a static-analysis schema, CycloneDX is a bill of materials, and the
    // CSV columns are advisory columns. The Worker refuses them for other
    // analyzers with a 400, so the picker offers only what the server will
    // actually serve rather than letting someone pick an error.
    return analyzer === "vuln"
      ? ["pdf", "csv", "json", "sarif", "cyclonedx"]
      : ["json"];
  }

  function syncExportBar(run) {
    var actions = document.getElementById("report-actions");
    if (actions) actions.hidden = !run;
    if (!run) return;

    var allowed = formatsFor(run.analyzer);
    var select = document.getElementById("report-dl-format");
    if (select) {
      var visible = 0;
      Array.prototype.forEach.call(select.options, function (opt) {
        var on = allowed.indexOf(opt.value) !== -1;
        opt.hidden = !on;
        opt.disabled = !on;
        if (on) visible++;
      });
      if (select.selectedOptions[0] && select.selectedOptions[0].disabled) {
        select.value = allowed[0];
      }
      // One legal format means the picker is noise — the button says it all.
      select.hidden = visible <= 1;
    }
    var btn = document.getElementById("report-dl-btn");
    if (btn) btn.textContent = allowed.length === 1 ? "Download JSON" : "Download";

    // "Open report" and "Share" are the client-facing document and its
    // distribution — both audit-only, same reason as the document formats.
    var htmlLink = document.getElementById("report-open-html");
    if (htmlLink) {
      htmlLink.hidden = run.analyzer !== "vuln";
      htmlLink.href = reportBase() + "?format=html";
    }
    var shareBtn = document.getElementById("report-share-btn");
    if (shareBtn) shareBtn.hidden = run.analyzer !== "vuln";
  }

  function download() {
    if (!state.runId) return;
    var select = document.getElementById("report-dl-format");
    var format = (select && !select.hidden ? select.value : "json") || "json";
    if (format === "pdf") {
      // The PDF is the printable page, printed — ?print=1 opens it straight
      // into the browser's print dialog. Same page, same stylesheet, so the
      // PDF can never disagree with the report the customer read.
      window.open(reportBase() + "?format=html&print=1", "_blank", "noopener");
      return;
    }
    // Attachment formats: navigate the hidden frame-free way — an <a> click
    // keeps the SPA untouched while content-disposition does the saving.
    var a = el("a", { href: reportBase() + "?format=" + format });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ---------------------------------------------------------------------
  // Open + wire
  // ---------------------------------------------------------------------

  function open(runId) {
    if (!runId) return;
    var body = document.getElementById("report-body");

    if (state.runId === runId && state.run) {
      syncExportBar(state.run);
      return;   // already rendered; back/forward shouldn't refetch
    }

    state.runId = runId;
    state.run = null;
    state.share = null;
    syncExportBar(null);
    if (body) {
      while (body.firstChild) body.removeChild(body.firstChild);
      body.appendChild(el("div", { class: "panel-empty" }, "Loading report…"));
    }

    callApi("/api/runs/" + encodeURIComponent(runId), null, "GET")
      .then(function (run) {
        state.run = run;
        render(run);
        syncExportBar(run);
      })
      .catch(function (e) {
        if (body) {
          while (body.firstChild) body.removeChild(body.firstChild);
          body.appendChild(core.errorState(e.message || "Could not load the run"));
        }
      });
  }

  function attach() {
    var dlBtn = document.getElementById("report-dl-btn");
    if (dlBtn) dlBtn.addEventListener("click", download);

    var shareBtn = document.getElementById("report-share-btn");
    if (shareBtn) shareBtn.addEventListener("click", openShare);

    var expiryRow = document.getElementById("share-expiry-row");
    if (expiryRow) {
      expiryRow.addEventListener("click", function (event) {
        var b = event.target.closest && event.target.closest("[data-days]");
        if (b) setShareDays(parseInt(b.dataset.days, 10));
      });
    }

    var createBtn = document.getElementById("share-create-btn");
    if (createBtn) createBtn.addEventListener("click", function () { createShare(createBtn); });

    var copyBtn = document.getElementById("share-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var input = document.getElementById("share-url");
        if (input && navigator.clipboard) {
          navigator.clipboard.writeText(input.value).then(function () {
            copyBtn.textContent = "Copied";
            setTimeout(function () { copyBtn.textContent = "Copy"; }, 1200);
          }).catch(function () {});
        }
      });
    }

    var revokeBtn = document.getElementById("share-revoke-btn");
    if (revokeBtn) revokeBtn.addEventListener("click", function () { revokeShare(revokeBtn); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  window.DashReport = { open: open };
})();
