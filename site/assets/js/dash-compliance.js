// Compliance & release audit.
//
// The page is built around one idea, and every layout decision below follows
// from it: HOW WE KNOW and WHAT THE ANSWER IS are two different questions, and
// collapsing them into a single colour or a single score is what turns a
// compliance dashboard into a liability.
//
// So each control gets two independent cells:
//
//   evidence state   automated · attested · not covered   — a fact about THIS
//                    TOOL. "Not covered" says Algosize has no artifact bearing
//                    on the control and never will from a repository scan.
//   result           met · not met · insufficient evidence · n/a · expired —
//                    a finding about the CUSTOMER, and only meaningful where
//                    evidence exists.
//
// A not-covered control therefore has NO RESULT. Not "not met" — that would be
// a finding about the customer for something we simply cannot see. The row
// renders "— no result" and the coverage tally excludes it, because the one
// number a reader skims must not be inflated by the edge of what a code
// analyzer can reach.
//
// Nothing here decides anything. Every verdict, rationale and qualifier is
// rendered from GET /api/compliance/coverage, which resolves each control
// through worker/src/compliance/resolve.js. This file hardcodes no control, no
// framework text and no threshold.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var elBase = core.el;

  /** el(tag, attrs, textOrChildren) — see dash-models.js for why. */
  function el(tag, attrs, kids) {
    if (kids == null || typeof kids === "string" || typeof kids === "number") {
      return elBase(tag, attrs, kids);
    }
    var n = elBase(tag, attrs);
    (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c === null || c === undefined) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // -------------------------------------------------------------------------
  // Vocabulary. Glyphs carry the meaning alongside colour so the two axes stay
  // readable in greyscale and to a colour-blind reader — the same reason the
  // fit matrix uses letters.
  // -------------------------------------------------------------------------

  var EVIDENCE = {
    automated:   { glyph: "⚙", label: "automated",   cls: "cmp-ev-auto" },
    attested:    { glyph: "✍", label: "attested",    cls: "cmp-ev-att" },
    not_covered: { glyph: "○", label: "not covered", cls: "cmp-ev-none" },
  };

  var RESULT = {
    met:                  { glyph: "✓", label: "met",                  cls: "cmp-res-met" },
    not_met:              { glyph: "✕", label: "not met",              cls: "cmp-res-notmet" },
    insufficient_evidence:{ glyph: "◐", label: "insufficient",         cls: "cmp-res-insuf" },
    attestation_expired:  { glyph: "⏱", label: "attestation expired",  cls: "cmp-res-expired" },
    not_applicable:       { glyph: "—", label: "not applicable",       cls: "cmp-res-na" },
  };

  /** Qualifiers the resolver attaches. Rendered as chips so the reason a row
   *  was downgraded is visible without opening anything. */
  var FLAG = {
    single_scan:        "one scan only",
    sbom_incomplete:    "sbom incomplete",
    shallow_coverage:   "pattern-matched",
    no_run_in_period:   "no scan in period",
    predates_period:    "predates period",
    no_artifact_possible: "no artifact exists",
    awaiting_attestation: "awaiting attestation",
    attestation_revoked:  "revoked",
    expired:            "expired",
    scoped_out:         "scoped out",
  };

  var state = {
    loaded: false,
    frameworkId: null,
    monitorId: null,
    from: null,
    to: null,
    data: null,
    frameworks: null,
    attestFor: null,   // control id the attest form is aimed at
    busy: false,
  };

  function load() {
    if (state.loaded) return;
    state.loaded = true;
    fetchAndRender();
  }

  function refresh() { if (state.loaded) fetchAndRender(); }

  function fetchAndRender() {
    var body = document.getElementById("compliance-body");
    if (!body) return;
    if (!state.data) {
      clear(body);
      body.appendChild(el("div", { class: "panel-empty" }, "Reading the control catalog…"));
    }

    var q = "/api/compliance/coverage";
    var qs = [];
    if (state.frameworkId) qs.push("framework=" + encodeURIComponent(state.frameworkId));
    if (state.monitorId) qs.push("monitor=" + encodeURIComponent(state.monitorId));
    if (state.from) qs.push("from=" + encodeURIComponent(state.from));
    if (state.to) qs.push("to=" + encodeURIComponent(state.to));
    if (qs.length) q += "?" + qs.join("&");

    // The framework list is fetched once. It is catalog metadata, identical for
    // every org, and re-reading it on each period change would be noise.
    var pre = state.frameworks
      ? Promise.resolve(null)
      : core.callApi("/api/compliance/frameworks", null, "GET")
          .then(function (f) { state.frameworks = f.frameworks || []; })
          .catch(function () { state.frameworks = null; });

    pre.then(function () { return core.callApi(q, null, "GET"); })
      .then(function (d) {
        state.data = d;
        state.frameworkId = d.framework && d.framework.id;
        if (d.monitor) state.monitorId = d.monitor.monitorId;
        if (d.period) { state.from = d.period.startOn; state.to = d.period.endOn; }
        render();
      })
      .catch(function (err) { fail(err && err.message); });
  }

  function fail(msg) {
    var body = document.getElementById("compliance-body");
    if (!body) return;
    clear(body);
    var panel = core.errorState
      ? core.errorState(msg || "Could not read the coverage map.")
      : el("div", { class: "panel-empty" }, msg || "Could not read the coverage map.");
    var retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Try again");
    retry.addEventListener("click", function () { state.data = null; fetchAndRender(); });
    panel.appendChild(retry);
    body.appendChild(panel);
  }

  // -------------------------------------------------------------------------

  function render() {
    var body = document.getElementById("compliance-body");
    if (!body) return;
    var d = state.data;
    clear(body);

    body.appendChild(renderHeader(d));
    body.appendChild(renderDisclaimer(d));

    if (!d.monitor) {
      body.appendChild(renderNoSubject());
      return;
    }

    body.appendChild(renderCoverage(d));
    body.appendChild(renderControls(d));

    var grid = el("div", { class: "cmp-two" });
    grid.appendChild(renderAttest(d));
    grid.appendChild(renderPack(d));
    body.appendChild(grid);
  }

  // ---- header -------------------------------------------------------------

  function renderHeader(d) {
    var published = (d.audits || []).filter(function (a) { return a.status === "published"; });
    var latest = published.length ? published[0] : null;

    var head = el("header", { class: "cmp-head" });

    var titleRow = el("div", { class: "cmp-head-title" });
    titleRow.appendChild(el("h2", { class: "cmp-h1" }, "Compliance & release audit"));
    titleRow.appendChild(statusPill(latest));
    head.appendChild(titleRow);

    head.appendChild(el("p", { class: "cmp-lede" }, statusLine(d, latest)));

    var cards = el("div", { class: "cmp-cards" });

    // Subject.
    cards.appendChild(factCard("Repository · branch", [
      el("span", { class: "cmp-fact-strong mono" },
        d.monitor ? repoName(d.monitor.repoUrl) : "no repository under watch"),
      el("span", { class: "cmp-fact-sub mono" },
        d.monitor ? (d.monitor.branch || "default branch") : "put one under watch to scope an audit"),
    ]));

    // Framework picker.
    var fw = el("div", { class: "cmp-card" });
    fw.appendChild(el("span", { class: "cmp-fact-label mono" }, "Framework"));
    var group = el("div", { class: "cmp-fw-group", role: "radiogroup", "aria-label": "Framework" });
    (state.frameworks || [{
      id: d.framework.id, short: d.framework.short, name: d.framework.name,
      version: d.framework.version, note: d.framework.note,
    }]).forEach(function (f) {
      var on = f.id === d.framework.id;
      var b = el("button", {
        type: "button", role: "radio", "aria-checked": on ? "true" : "false",
        class: "cmp-fw" + (on ? " cmp-fw-on" : ""),
      }, [
        el("span", { class: "mono", "aria-hidden": "true" }, on ? "◉" : "○"),
        f.short || f.name,
      ]);
      b.addEventListener("click", function () {
        if (f.id === state.frameworkId) return;
        state.frameworkId = f.id;
        state.data = null;
        fetchAndRender();
      });
      group.appendChild(b);
    });
    fw.appendChild(group);
    fw.appendChild(el("span", { class: "cmp-fact-note" }, d.framework.note || ""));
    cards.appendChild(fw);

    // Period.
    var scansOk = d.scans && d.scans.total > 0;
    cards.appendChild(factCard("Evidence period", [
      el("span", { class: "cmp-fact-strong mono tnum" },
        d.period.startOn + " → " + d.period.endOn),
      el("span", { class: "cmp-fact-sub mono " + (scansOk ? "cmp-ink-ok" : "cmp-ink-warn") },
        scansOk
          ? d.scans.total + " scan" + (d.scans.total === 1 ? "" : "s") + " in this window"
          : "no scan of this repository landed in this window"),
    ]));

    // Retention. Stated plainly because it is the fact that decides whether a
    // published pack was worth publishing.
    cards.appendChild(factCard("Retention", [
      el("span", { class: "cmp-fact-body" },
        "Source evidence is readable for 90 days. A published record is kept for one year."),
      el("span", { class: "cmp-fact-note" },
        "After 90 days the published record is the only copy of what it froze."),
    ]));

    head.appendChild(cards);

    var actions = el("div", { class: "cmp-actions" });
    var pub = el("button", { class: "btn btn-primary btn-sm", type: "button" },
      latest ? "Publish a correction" : "Publish evidence record");
    pub.disabled = !d.monitor;
    pub.addEventListener("click", function () { publish(pub, latest); });
    actions.appendChild(pub);
    head.appendChild(actions);

    var banner = bannerFor(d);
    if (banner) head.appendChild(banner);

    return head;
  }

  function statusPill(latest) {
    if (!latest) {
      return el("span", { class: "cmp-pill cmp-pill-never mono" }, [
        el("span", { "aria-hidden": "true" }, "○"), "never published",
      ]);
    }
    return el("span", { class: "cmp-pill cmp-pill-pub mono" }, [
      el("span", { "aria-hidden": "true" }, "◆"), "published " + isoOf(latest.publishedAt),
    ]);
  }

  function statusLine(d, latest) {
    if (!d.monitor) {
      return "Nothing below is blank because it passed — there is no repository under watch to read evidence from.";
    }
    if (!latest) {
      return "This map is computed live from the scans already stored. Nothing is frozen until you publish, " +
             "and the controls no analyzer can see are marked as such from the first second.";
    }
    return "Live map below. The last published record froze " +
           (latest.summary && latest.summary.total ? latest.summary.total : "these") +
           " controls on " + isoOf(latest.publishedAt) + " and is kept until " + isoOf(latest.retainUntil) + ".";
  }

  /**
   * The banner exists for one kind of news: something that makes the map below
   * mean less than it appears to. It is not a decoration and stays absent when
   * there is nothing to say.
   */
  function bannerFor(d) {
    if (!d.monitor) return null;
    if (d.monitor.paused) {
      return banner("warn", "⚠", "The watch on this repository is paused",
        "No advisory feed is being read between scans, so a newly published disclosure against these dependencies will not be noticed. Every control below is answered from evidence that has stopped being refreshed.");
    }
    if (!d.scans || !d.scans.total) {
      return banner("warn", "◐", "No scan landed inside this period",
        "Every automated control below reads “insufficient evidence” because nothing was measured in this window — not because anything failed.");
    }
    var expired = (d.controls || []).filter(function (c) { return c.result === "attestation_expired"; });
    if (expired.length) {
      return banner("warn", "⏱",
        expired.length + " attestation" + (expired.length === 1 ? " has" : "s have") + " expired",
        "An expired claim carries no weight until it is renewed. These controls do not keep passing quietly: " +
        expired.map(function (c) { return c.id; }).join(", ") + ".");
    }
    return null;
  }

  function banner(kind, glyph, title, bodyText) {
    return el("div", { class: "cmp-banner cmp-banner-" + kind, role: "status" }, [
      el("span", { class: "cmp-banner-glyph mono", "aria-hidden": "true" }, glyph),
      el("div", { class: "cmp-banner-body" }, [
        el("strong", { class: "cmp-banner-title" }, title),
        el("span", { class: "cmp-banner-text" }, bodyText),
      ]),
    ]);
  }

  function renderDisclaimer(d) {
    return el("div", { class: "cmp-note" }, [
      el("span", { class: "cmp-note-glyph mono", "aria-hidden": "true" }, "◇"),
      el("p", { class: "cmp-note-text" }, d.disclaimer ||
        "This page is evidence about a codebase, not a certification of conformity."),
    ]);
  }

  function renderNoSubject() {
    var s = el("section", { class: "cmp-empty-panel" });
    s.appendChild(el("span", { class: "cmp-eyebrow mono" }, "No subject"));
    s.appendChild(el("strong", { class: "cmp-empty-title" },
      "No repository is under watch, so there is nothing to evidence."));
    s.appendChild(el("p", { class: "cmp-empty-body" },
      "An audit is a claim about a codebase over a window of time. Scan runs carry no repository of " +
      "their own, so a watch is what ties evidence to a repository. Add one from Monitors & CI and " +
      "this map fills itself in from the scans that follow."));
    var go = el("a", { class: "btn btn-ghost btn-sm", href: "#/monitors" }, "Open Monitors & CI →");
    s.appendChild(go);
    return s;
  }

  // ---- coverage -----------------------------------------------------------

  function renderCoverage(d) {
    var s = el("section", { class: "cmp-panel" });

    var head = el("div", { class: "cmp-panel-head" }, [
      el("div", { class: "cmp-panel-titles" }, [
        el("h3", { class: "cmp-h2" }, "Coverage"),
        el("span", { class: "cmp-panel-sub" },
          "counts, not a percentage — a denominator here would mostly measure how much of the framework is about code"),
      ]),
      el("span", { class: "cmp-panel-meta mono" },
        d.summary.total + " controls in " + (d.framework.short || d.framework.name)),
    ]);
    s.appendChild(head);

    var grid = el("div", { class: "cmp-cov" });

    // How we know.
    var left = el("div", { class: "cmp-cov-col" });
    left.appendChild(el("span", { class: "cmp-fact-label mono" }, "How we know · evidence state"));
    var evRow = el("div", { class: "cmp-chips" });
    ["automated", "attested", "not_covered"].forEach(function (k) {
      var v = EVIDENCE[k];
      evRow.appendChild(el("span", { class: "cmp-count " + v.cls }, [
        el("span", { class: "mono", "aria-hidden": "true" }, v.glyph),
        el("span", { class: "cmp-count-n mono tnum" }, String(d.summary.byState[k] || 0)),
        el("span", { class: "cmp-count-label mono" }, v.label),
      ]));
    });
    left.appendChild(evRow);
    left.appendChild(el("span", { class: "cmp-cov-note" }, evidenceSentence(d)));
    grid.appendChild(left);

    // What the answer is.
    var right = el("div", { class: "cmp-cov-col" });
    right.appendChild(el("span", { class: "cmp-fact-label mono" },
      "What the answer is · result, evidenced controls only"));
    var resRow = el("div", { class: "cmp-chips" });
    ["met", "not_met", "insufficient_evidence", "attestation_expired", "not_applicable"].forEach(function (k) {
      var v = RESULT[k];
      resRow.appendChild(el("span", { class: "cmp-count cmp-count-res " + v.cls }, [
        el("span", { class: "mono", "aria-hidden": "true" }, v.glyph),
        el("span", { class: "cmp-count-n mono tnum" }, String(d.summary.byResult[k] || 0)),
        el("span", { class: "cmp-count-label" }, v.label),
      ]));
    });
    right.appendChild(resRow);
    right.appendChild(el("span", { class: "cmp-cov-note" },
      "Results exist only where evidence exists. The " + (d.summary.byState.not_covered || 0) +
      " not-covered controls have no result at all — they are the edge of what a code analyzer " +
      "can see, not findings about you."));
    grid.appendChild(right);

    s.appendChild(grid);
    return s;
  }

  function evidenceSentence(d) {
    var a = d.summary.byState.automated || 0;
    var t = d.summary.byState.attested || 0;
    var n = d.summary.byState.not_covered || 0;
    return a + " control" + (a === 1 ? " is" : "s are") + " answered by a scan artifact, " +
           t + " by a signed human claim, and " + n + " by neither — this platform holds no " +
           "artifact bearing on " + (n === 1 ? "that one" : "those") + " and never will from a repository scan.";
  }

  // ---- controls -----------------------------------------------------------

  function renderControls(d) {
    var s = el("section", { class: "cmp-controls" });

    s.appendChild(el("div", { class: "cmp-panel-head cmp-panel-head-bare" }, [
      el("div", { class: "cmp-panel-titles" }, [
        el("h3", { class: "cmp-h2" }, "Controls"),
        el("span", { class: "cmp-panel-sub" }, "two columns, two questions — read them separately"),
      ]),
      el("div", { class: "cmp-legend mono" }, [
        el("span", {}, [
          el("span", { class: "cmp-ev-auto" }, "⚙ automated"), " · ",
          el("span", { class: "cmp-ev-att" }, "✍ attested"), " · ",
          el("span", { class: "cmp-ev-none" }, "○ not covered"),
        ]),
        el("span", {}, [
          el("span", { class: "cmp-res-met" }, "✓ met"), " · ",
          el("span", { class: "cmp-res-notmet" }, "✕ not met"), " · ",
          el("span", { class: "cmp-res-insuf" }, "◐ insufficient"), " · ",
          el("span", { class: "cmp-res-expired" }, "⏱ expired"), " · ",
          el("span", { class: "cmp-res-na" }, "— n/a"),
        ]),
      ]),
    ]));

    (d.framework.groups || []).forEach(function (g) {
      var rows = d.controls.filter(function (c) { return c.group === g.code; });
      if (!rows.length) return;
      s.appendChild(renderGroup(g, rows));
    });

    return s;
  }

  function renderGroup(g, rows) {
    var box = el("div", { class: "cmp-group" });

    var evidenced = rows.filter(function (r) { return r.evidenceState !== "not_covered"; });
    var met = evidenced.filter(function (r) { return r.result === "met"; }).length;

    box.appendChild(el("div", { class: "cmp-group-head" }, [
      el("div", { class: "cmp-group-titles" }, [
        el("span", { class: "cmp-group-code mono" }, g.code),
        el("strong", { class: "cmp-group-name" }, g.name),
      ]),
      el("span", { class: "cmp-group-tally mono" },
        met + " met of " + evidenced.length + " evidenced · " +
        (rows.length - evidenced.length) + " not covered"),
    ]));

    box.appendChild(el("div", { class: "cmp-row cmp-row-head" }, [
      el("span", { class: "cmp-col-label mono" }, "Control"),
      el("span", { class: "cmp-col-label mono" }, "Practice · rationale"),
      el("span", { class: "cmp-col-label mono" }, "How we know"),
      el("span", { class: "cmp-col-label mono" }, "Result"),
      el("span", { class: "cmp-col-label mono" }, "Asserted · provenance"),
    ]));

    rows.forEach(function (r) { box.appendChild(renderRow(r)); });
    return box;
  }

  function renderRow(r) {
    var covered = r.evidenceState !== "not_covered";
    var row = el("div", { class: "cmp-row" + (covered ? "" : " cmp-row-none") });

    row.appendChild(el("span", { class: "cmp-cid mono tnum" }, r.id));

    // Practice + rationale + qualifier chips.
    var mid = el("div", { class: "cmp-cell" });
    mid.appendChild(el("span", { class: "cmp-ctitle" }, r.title));
    if (r.rationale) mid.appendChild(el("span", { class: "cmp-crationale" }, r.rationale));
    var flags = (r.qualifiers || []).filter(function (q) { return FLAG[q]; });
    if (flags.length) {
      var fr = el("div", { class: "cmp-flags" });
      flags.forEach(function (q) {
        fr.appendChild(el("span", { class: "cmp-flag mono" }, FLAG[q]));
      });
      mid.appendChild(fr);
    }
    row.appendChild(mid);

    // How we know.
    var ev = EVIDENCE[r.evidenceState] || EVIDENCE.not_covered;
    var evCell = el("div", { class: "cmp-cell" });
    evCell.appendChild(el("span", { class: "cmp-mobile-label mono" }, "How we know"));
    evCell.appendChild(el("span", { class: "cmp-ev " + ev.cls }, [
      el("span", { class: "mono", "aria-hidden": "true" }, ev.glyph), ev.label,
    ]));
    evCell.appendChild(el("span", { class: "cmp-ev-sub mono" }, evidenceSub(r)));
    row.appendChild(evCell);

    // Result. A not-covered control gets no result badge at all.
    var resCell = el("div", { class: "cmp-cell" });
    resCell.appendChild(el("span", { class: "cmp-mobile-label mono" }, "Result"));
    if (covered) {
      var res = RESULT[r.result] || RESULT.insufficient_evidence;
      resCell.appendChild(el("span", { class: "cmp-res " + res.cls }, [
        el("span", { class: "mono", "aria-hidden": "true" }, res.glyph), res.label,
      ]));
    } else {
      resCell.appendChild(el("span", { class: "cmp-noresult mono" },
        "— no result · this tool has no artifact for this control"));
    }
    row.appendChild(resCell);

    // Asserted / provenance / attestation.
    var last = el("div", { class: "cmp-cell" });
    last.appendChild(el("span", { class: "cmp-mobile-label mono" }, "Asserted · provenance"));
    if (r.attestation) {
      last.appendChild(el("span", { class: "cmp-statement" }, "“" + r.attestation.statement + "”"));
      last.appendChild(el("span", { class: "cmp-prov mono" },
        (r.attestation.ownerEmail || "owner unrecorded") + " · expires " + r.attestation.expiresOn));
      if (r.attestation.documentUrl) {
        last.appendChild(el("a", {
          class: "cmp-doc mono", href: r.attestation.documentUrl,
          rel: "noopener noreferrer", target: "_blank",
        }, r.attestation.documentUrl));
      }
      var rev = el("button", { class: "cmp-mini", type: "button" }, "Revoke");
      rev.addEventListener("click", function () { revoke(rev, r.attestation.id); });
      last.appendChild(rev);
    } else if (r.asserted) {
      last.appendChild(el("span", { class: "cmp-asserted mono tnum" }, r.asserted));
      last.appendChild(el("span", { class: "cmp-prov mono" }, r.provenance || ""));
    } else if (!covered) {
      last.appendChild(el("span", { class: "cmp-why" }, r.why || ""));
    } else {
      last.appendChild(el("span", { class: "cmp-why" },
        "Nothing has been asserted for this control in this period."));
    }

    // Attesting is offered where a human claim is the intended answer, and
    // nowhere else. An automated control is answered by an artifact, and the
    // API refuses a signature over the top of a measurement.
    if (r.coverage === "attested" && !r.attestation) {
      var att = el("button", { class: "cmp-mini cmp-mini-att", type: "button" }, [
        el("span", { class: "mono", "aria-hidden": "true" }, "✍"), "Attest",
      ]);
      att.addEventListener("click", function () {
        state.attestFor = r.id;
        render();
        var f = document.getElementById("cmp-att-statement");
        if (f) f.focus();
      });
      last.appendChild(att);
    }
    row.appendChild(last);

    return row;
  }

  function evidenceSub(r) {
    if (r.evidenceState === "not_covered") return "no artifact possible";
    if (r.evidenceState === "attested") {
      return r.attestation ? "signed claim" : "awaiting a signature";
    }
    if (r.capturedAt) {
      return (r.sourceAnalyzer || "scan") + " · " + isoOf(r.capturedAt);
    }
    return "no artifact in period";
  }

  // ---- attest -------------------------------------------------------------

  function renderAttest(d) {
    var s = el("section", { class: "cmp-panel" });
    s.appendChild(el("div", { class: "cmp-panel-head" }, [
      el("div", { class: "cmp-panel-titles" }, [
        el("h3", { class: "cmp-h2" }, "Attest a control"),
        el("span", { class: "cmp-panel-sub" },
          "a human claim with an owner and an end date — never perpetual"),
      ]),
    ]));

    var attestable = d.controls.filter(function (c) {
      return c.coverage === "attested" && !c.attestation;
    });

    var form = el("div", { class: "cmp-form" });

    if (!attestable.length) {
      form.appendChild(el("p", { class: "cmp-fact-body" },
        "Every control that can be attested on this framework already carries a live claim. " +
        "Revoke one from its row to replace it."));
      s.appendChild(form);
      s.appendChild(renderAttestStates(d));
      return s;
    }

    var sel = el("select", { class: "cmp-input mono", id: "cmp-att-control", "aria-label": "Control" });
    attestable.forEach(function (c) {
      var o = el("option", { value: c.id }, c.id + " · " + c.title);
      if (c.id === state.attestFor) o.setAttribute("selected", "selected");
      sel.appendChild(o);
    });
    form.appendChild(field("Control", sel));

    var stmt = el("textarea", {
      class: "cmp-input", id: "cmp-att-statement", rows: "3",
      placeholder: "What is true, in one or two sentences an auditor can check.",
    });
    form.appendChild(field("Statement", stmt));

    var pair = el("div", { class: "cmp-form-pair" });
    var owner = el("input", {
      class: "cmp-input mono", id: "cmp-att-owner", type: "email", placeholder: "name@company.com",
    });
    pair.appendChild(field("Accountable owner · email", owner));
    var expiry = el("input", { class: "cmp-input mono", id: "cmp-att-expiry", type: "date" });
    pair.appendChild(field("Expiry · required", expiry));
    form.appendChild(pair);

    var doc = el("input", {
      class: "cmp-input mono", id: "cmp-att-doc", type: "url", placeholder: "https://",
    });
    form.appendChild(field("Document URL · optional", doc));

    form.appendChild(el("p", { class: "cmp-fact-note" }, [
      "On expiry the control reverts to ",
      el("span", { class: "cmp-res-expired mono" }, "⏱ attestation expired"),
      ". It does not keep passing quietly.",
    ]));

    var msg = el("p", { class: "cmp-form-msg", id: "cmp-att-msg" }, "");
    form.appendChild(msg);

    var sign = el("button", { class: "btn btn-primary btn-sm", type: "button" }, "Sign attestation");
    sign.addEventListener("click", function () {
      submitAttestation(sign, msg, { sel: sel, stmt: stmt, owner: owner, expiry: expiry, doc: doc });
    });
    form.appendChild(sign);

    s.appendChild(form);
    s.appendChild(renderAttestStates(d));
    return s;
  }

  function field(label, input) {
    return el("label", { class: "cmp-field" }, [
      el("span", { class: "cmp-fact-label mono" }, label), input,
    ]);
  }

  function renderAttestStates(d) {
    var live = d.controls.filter(function (c) { return c.attestation; });
    var expired = d.controls.filter(function (c) { return c.result === "attestation_expired"; });
    var waiting = d.controls.filter(function (c) {
      return c.coverage === "attested" && !c.attestation;
    });

    var box = el("div", { class: "cmp-states" });
    box.appendChild(el("span", { class: "cmp-fact-label mono" }, "Attestation states on this framework"));
    var chips = el("div", { class: "cmp-chips" });
    chips.appendChild(stateChip("cmp-res-met", "✓", live.length - expired.length, "live"));
    chips.appendChild(stateChip("cmp-res-expired", "⏱", expired.length, "expired"));
    chips.appendChild(stateChip("cmp-res-insuf", "◐", waiting.length, "awaiting a signature"));
    box.appendChild(chips);
    return box;
  }

  function stateChip(cls, glyph, n, label) {
    return el("span", { class: "cmp-count cmp-count-res " + cls }, [
      el("span", { class: "mono", "aria-hidden": "true" }, glyph),
      el("span", { class: "cmp-count-n mono tnum" }, String(Math.max(0, n))),
      el("span", { class: "cmp-count-label" }, label),
    ]);
  }

  function submitAttestation(button, msg, f) {
    msg.textContent = "";
    msg.className = "cmp-form-msg";
    var statement = f.stmt.value.trim();
    if (!statement) { formError(msg, "An attestation needs a statement."); return; }
    if (!f.owner.value.trim()) { formError(msg, "An attestation needs an accountable owner."); return; }
    if (!f.expiry.value) {
      formError(msg, "An attestation needs an end date. There are no perpetual attestations.");
      return;
    }

    core.setBusy(button, true, "Signing…");
    core.callApi("/api/compliance/attestations", {
      frameworkId: state.frameworkId,
      controlId: f.sel.value,
      statement: statement,
      ownerEmail: f.owner.value.trim(),
      expiresAt: f.expiry.value,
      documentUrl: f.doc.value.trim() || null,
    }, "POST")
      .then(function () {
        state.attestFor = null;
        state.data = null;
        fetchAndRender();
      })
      .catch(function (err) {
        core.setBusy(button, false);
        formError(msg, (err && err.message) || "The attestation could not be stored.");
      });
  }

  function formError(msg, text) {
    msg.textContent = text;
    msg.className = "cmp-form-msg cmp-form-msg-err";
  }

  function revoke(button, id) {
    core.setBusy(button, true, "Revoking…");
    core.callApi("/api/compliance/attestations/" + encodeURIComponent(id) + "/revoke", null, "POST")
      .then(function () { state.data = null; fetchAndRender(); })
      .catch(function () { core.setBusy(button, false); });
  }

  // ---- published record ---------------------------------------------------

  function renderPack(d) {
    var s = el("section", { class: "cmp-panel" });
    s.appendChild(el("div", { class: "cmp-panel-head" }, [
      el("div", { class: "cmp-panel-titles" }, [
        el("h3", { class: "cmp-h2" }, "Evidence record"),
        el("span", { class: "cmp-panel-sub" }, "publishing freezes every fact on this page"),
      ]),
    ]));

    var published = (d.audits || []).filter(function (a) { return a.status === "published"; });
    var body = el("div", { class: "cmp-pack" });

    if (!published.length) {
      body.appendChild(el("p", { class: "cmp-fact-body" },
        "Nothing has been published for this framework. Publishing copies each control's wording, " +
        "verdict and the numbers behind it into a record that survives the 90-day evidence window — " +
        "which is what makes it worth handing to an auditor months later."));
      s.appendChild(body);
      return s;
    }

    var a = published[0];

    // Three states, and only the first is a checksum anyone should act on.
    //
    // `packHashScope` is what the stored hash COVERS. Until migration 0030 it
    // covered a document the download endpoint never served, so running
    // sha256sum on the downloaded file produced a mismatch and told a recipient
    // their evidence pack had been tampered with. A hash that cannot verify is
    // worse than no hash on the one panel whose whole claim is verifiability,
    // so a pre-0030 pack says what it is instead of printing a number.
    if (a.packSha256 && a.packHashScope === "document") {
      body.appendChild(el("span", { class: "cmp-fact-label mono" },
        "SHA-256 · verify against the file you were sent"));
      body.appendChild(el("code", { class: "cmp-sha mono" }, a.packSha256));
      body.appendChild(el("span", { class: "cmp-fact-note" },
        "Run sha256sum on the downloaded .json — this is the hash of those exact bytes, " +
        "and the download repeats it in an x-algosize-pack-sha256 header."));
    } else if (a.packSha256) {
      body.appendChild(el("span", { class: "cmp-fact-label mono" },
        "SHA-256 · does not cover this download"));
      body.appendChild(el("code", { class: "cmp-sha cmp-sha-stale mono" }, a.packSha256));
      body.appendChild(el("span", { class: "cmp-fact-note" },
        "This pack was published before the hash was taken over the file we serve, so the " +
        "checksum above is of a different document and will not match the download. The record " +
        "itself is intact and unedited — only the checksum is unusable. Publish a fresh pack for " +
        "this period to get one that verifies."));
    } else {
      body.appendChild(el("span", { class: "cmp-fact-label mono" }, "SHA-256"));
      body.appendChild(el("span", { class: "cmp-fact-note" },
        "No checksum was recorded for this pack. The record is still complete; there is simply " +
        "nothing here to verify a downloaded copy against."));
    }

    body.appendChild(el("span", { class: "cmp-fact-label mono" }, "Frozen · size · retained until"));
    body.appendChild(el("span", { class: "cmp-fact-strong mono tnum" },
      isoOf(a.publishedAt) + " · " + formatBytes(a.packBytes) + " · kept until " + isoOf(a.retainUntil)));

    var dl = el("a", {
      class: "btn btn-ghost btn-sm",
      href: core.apiUrl("/api/compliance/audits/" + encodeURIComponent(a.id) + "/pack"),
    }, "Download record (.json)");
    body.appendChild(dl);

    // Said plainly rather than offered as a dead button. The bulk bundle needs
    // an object store whose lifecycle rule is scoped so a one-year record is
    // not swept away by a rule written for 90-day reports.
    body.appendChild(el("span", { class: "cmp-fact-note" },
      "Contains every control, its wording as of catalog " + (a.catalogVersion || "—") +
      ", the verdict and the numbers asserted. The bulk bundle — full SBOM, SARIF and per-scan " +
      "artifacts — is not available yet."));

    if (published.length > 1) {
      body.appendChild(el("span", { class: "cmp-fact-note" },
        published.length + " records published for this framework. A correction supersedes; it never edits."));
    }

    s.appendChild(body);
    return s;
  }

  function publish(button, latest) {
    core.setBusy(button, true, "Freezing…");
    var payload = {
      frameworkId: state.frameworkId,
      monitorId: state.monitorId,
      from: state.from,
      to: state.to,
    };
    if (latest) payload.supersedes = latest.id;
    core.callApi("/api/compliance/audits", payload, "POST")
      .then(function () { state.data = null; fetchAndRender(); })
      .catch(function (err) {
        core.setBusy(button, false);
        window.alert((err && err.message) || "The record could not be published.");
      });
  }

  // ---- small helpers ------------------------------------------------------

  function factCard(label, kids) {
    var c = el("div", { class: "cmp-card" });
    c.appendChild(el("span", { class: "cmp-fact-label mono" }, label));
    kids.forEach(function (k) { c.appendChild(k); });
    return c;
  }

  function repoName(url) {
    if (!url) return "—";
    var m = String(url).match(/github\.com\/([\w.-]+\/[\w.-]+)/i);
    return m ? m[1] : url;
  }

  /** Unix seconds to YYYY-MM-DD, UTC. Matches the worker's isoDay, on purpose:
   *  a date in a compliance record is quoted back months later by someone in
   *  another timezone, so it must not shift with the reader. */
  function isoOf(sec) {
    if (typeof sec !== "number" || !isFinite(sec)) return "—";
    return new Date(sec * 1000).toISOString().slice(0, 10);
  }

  function formatBytes(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  window.DashCompliance = { load: load, refresh: refresh };
})();
