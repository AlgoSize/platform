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
//   DELETE /api/runs/:id/share/:token        revoke it
//
// The share list the original mock proposed (views counter, all active
// links) has no backing endpoint — links are shown when minted, and revoke
// works on the link just created. No fabricated UI over missing data.

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

  function render(run) {
    var body = document.getElementById("report-body");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    if (run.analyzer !== "vuln") {
      body.appendChild(core.errorState(
        "Reports are produced for dependency audits; this is a \"" + run.analyzer + "\" run."));
      return;
    }

    var result = run.result || {};
    var summary = result.summary || {};
    var counts = summary.counts || result.counts || {};
    var advisories = Array.isArray(result.advisories) ? result.advisories : [];

    var wrap = el("div", { class: "report-wrap" });

    var masthead = el("div", { class: "report-masthead" });
    var title = el("div", { class: "report-masthead-title" });
    title.appendChild(el("span", { class: "eyebrow" }, "Dependency audit"));
    var repo = (result.ci && result.ci.repo) || (run.input && (run.input.repo || run.input.repoUrl)) || "Audit report";
    title.appendChild(el("h2", null, String(repo).replace(/^https?:\/\/(www\.)?github\.com\//, "")));
    masthead.appendChild(title);
    wrap.appendChild(masthead);

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

    wrap.appendChild(scopeFooter(run));
    body.appendChild(wrap);
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
      .catch(function (e) { window.alert(e.message || "Could not revoke the link"); })
      .then(function () { setBusy(btn, false); });
  }

  // ---------------------------------------------------------------------
  // Open + wire
  // ---------------------------------------------------------------------

  function open(runId) {
    if (!runId) return;
    var body = document.getElementById("report-body");
    var actions = document.getElementById("report-actions");

    // Download links point straight at the report route; the browser handles
    // content-disposition. Set before the fetch so they work even while the
    // in-page render is loading.
    var origin = core.apiUrl("");
    var base = origin + "/api/runs/" + encodeURIComponent(runId) + "/report";
    var htmlLink  = document.getElementById("report-open-html");
    var sarifLink = document.getElementById("report-dl-sarif");
    var cdxLink   = document.getElementById("report-dl-cdx");
    if (htmlLink)  htmlLink.href  = base + "?format=html";
    if (sarifLink) sarifLink.href = base + "?format=sarif";
    if (cdxLink)   cdxLink.href   = base + "?format=cyclonedx";

    if (state.runId === runId && state.run) {
      if (actions) actions.hidden = state.run.analyzer !== "vuln";
      return;   // already rendered; back/forward shouldn't refetch
    }

    state.runId = runId;
    state.run = null;
    state.share = null;
    if (actions) actions.hidden = true;
    if (body) {
      while (body.firstChild) body.removeChild(body.firstChild);
      body.appendChild(el("div", { class: "panel-empty" }, "Loading report…"));
    }

    callApi("/api/runs/" + encodeURIComponent(runId), null, "GET")
      .then(function (run) {
        state.run = run;
        render(run);
        if (actions) actions.hidden = run.analyzer !== "vuln";
      })
      .catch(function (e) {
        if (body) {
          while (body.firstChild) body.removeChild(body.firstChild);
          body.appendChild(core.errorState(e.message || "Could not load the run"));
        }
      });
  }

  function attach() {
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
