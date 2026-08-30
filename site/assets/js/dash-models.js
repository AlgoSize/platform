// Model explorer — the curated shortlist, scored for the jobs this platform
// actually routes work to.
//
// Three views over one dataset:
//   Scatter      three plots, every axis oriented so higher is better (cost
//                included — it plots efficiency, not price), so the top-right
//                corner is the best corner on all three.
//   Fit matrix   model × task family, a letter per cell so it survives
//                greyscale and colour blindness.
//   Recommend    the ranked list for one job, the same call the router makes.
//
// Everything comes from GET /api/ai/models. This file hardcodes no model, no
// price, no score, and no task description — the registry is the single source
// of truth, and a frontend that re-typed any of it would drift the moment the
// registry changed.
//
// TWO HONESTY RULES THIS PAGE IS BUILT AROUND
//
//   1. The quality scores are seeded engineering estimates, not benchmark
//      output; the registry says so with `scored: false` and the page has to
//      say so too, or a 0–100 number reads as a measurement.
//   2. The prices are relayed from Cloudflare's published rates, not
//      re-confirmed against a bill. The caveat is rendered from the server's
//      own provenance record rather than typed here, so it cannot go stale
//      when the prices are refreshed.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el;

  var PLOTS = [
    { id: "cost_vs_capability", label: "Cost vs capability" },
    { id: "latency_vs_quality", label: "Speed vs capability" },
    { id: "cost_vs_autofix", label: "Cost vs coding" },
  ];

  // Tier → how it reads on screen. A letter AND a colour on every cell, so the
  // matrix survives greyscale printing and colour blindness.
  var TIER = {
    primary:   { mark: "P", label: "primary",   note: "first choice" },
    secondary: { mark: "S", label: "secondary", note: "fallback" },
    budget:    { mark: "B", label: "budget",    note: "cheap seat" },
    // Two different blanks. "avoid" means somebody looked at this pairing and
    // said no; "unrated" means nobody rated it. Collapsing them would lose the
    // stronger fact and leave a reader guessing which blank means "unchecked".
    avoid:     { mark: "✗", label: "avoid",     note: "actively not this" },
    unrated:   { mark: "·", label: "unrated",   note: "not rated for the job" },
  };

  var state = {
    loaded: false, view: "scatter", plot: "cost_vs_capability",
    includeDeprecated: false, task: "fix_suggestion",
    graph: null, taskFamilies: null, recommendation: null, hover: null,
  };

  function load() {
    if (state.loaded) return;
    state.loaded = true;
    fetchAndRender();
  }

  function fetchAndRender() {
    var body = document.getElementById("models-body");
    if (!body) return;
    if (!state.graph) {
      clear(body);
      body.appendChild(el("div", { class: "panel-empty" }, "Loading the model registry…"));
    }
    var q = "/api/ai/models?graph=" + encodeURIComponent(
      state.view === "matrix" ? "model_fit_by_task" : state.plot);
    if (state.includeDeprecated) q += "&includeDeprecated=1";
    if (state.view === "recommend") q += "&task=" + encodeURIComponent(state.task);

    core.callApi(q, null, "GET")
      .then(function (d) {
        state.graph = d.graph || null;
        state.taskFamilies = d.taskFamilies || [];
        state.recommendation = d.recommendation || null;
        render();
      })
      .catch(function (err) { fail(err && err.message); });
  }

  function fail(msg) {
    var body = document.getElementById("models-body");
    if (!body) return;
    clear(body);
    var panel = core.errorState ? core.errorState(msg || "Could not load the model registry.") :
      el("div", { class: "panel-empty" }, msg || "Could not load the model registry.");
    var retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Try again");
    retry.addEventListener("click", function () { state.graph = null; fetchAndRender(); });
    panel.appendChild(retry);
    body.appendChild(panel);
  }

  // -------------------------------------------------------------------------

  function render() {
    var body = document.getElementById("models-body");
    if (!body) return;
    clear(body);

    body.appendChild(controls());
    if (state.view === "scatter") body.appendChild(scatterView());
    else if (state.view === "matrix") body.appendChild(matrixView());
    else body.appendChild(recommendView());
    body.appendChild(caveat());
  }

  function controls() {
    var bar = el("div", { class: "mdl-controls" });

    var views = el("div", { class: "mdl-segment", role: "group", "aria-label": "Model explorer view" });
    [["scatter", "Scatter"], ["matrix", "Fit matrix"], ["recommend", "Recommend"]].forEach(function (v) {
      var on = state.view === v[0];
      var b = el("button", {
        class: "btn btn-ghost btn-sm mdl-seg" + (on ? " active" : ""),
        type: "button", "aria-pressed": on ? "true" : "false",
      }, v[1]);
      b.addEventListener("click", function () {
        if (state.view === v[0]) return;
        state.view = v[0]; state.hover = null; fetchAndRender();
      });
      views.appendChild(b);
    });
    bar.appendChild(views);

    if (state.view === "scatter") {
      var plots = el("div", { class: "mdl-segment", role: "group", "aria-label": "Plot" });
      PLOTS.forEach(function (p) {
        var on = state.plot === p.id;
        var b = el("button", {
          class: "btn btn-ghost btn-sm mdl-seg" + (on ? " active" : ""),
          type: "button", "aria-pressed": on ? "true" : "false",
        }, p.label);
        b.addEventListener("click", function () {
          if (state.plot === p.id) return;
          state.plot = p.id; state.hover = null; fetchAndRender();
        });
        plots.appendChild(b);
      });
      bar.appendChild(plots);
    }

    bar.appendChild(el("span", { class: "mdl-spacer" }));

    var dep = el("label", { class: "mdl-toggle" });
    var cb = el("input", { type: "checkbox" });
    if (state.includeDeprecated) cb.setAttribute("checked", "checked");
    cb.addEventListener("change", function () {
      state.includeDeprecated = cb.checked; state.hover = null; fetchAndRender();
    });
    dep.appendChild(cb);
    dep.appendChild(el("span", null, "Show superseded"));
    bar.appendChild(dep);

    return bar;
  }

  // --- scatter -------------------------------------------------------------

  function scatterView() {
    var g = state.graph || {};
    var points = g.points || [];
    var wrap = el("section", { class: "panel mdl-scatter" });

    var head = el("div", { class: "mdl-head" });
    head.appendChild(el("h3", { class: "panel-title" }, axisLabel(g.y) + " vs " + axisLabel(g.x)));
    if (g.note) head.appendChild(el("span", { class: "panel-desc" }, g.note));
    wrap.appendChild(head);

    if (!points.length) {
      wrap.appendChild(el("div", { class: "panel-empty" }, "No model matches this filter."));
      return wrap;
    }

    var laid = layout(points, g);

    var grid = el("div", { class: "mdl-plot-grid" });

    // --- the plot itself ---------------------------------------------------
    var plotCol = el("div", { class: "mdl-plot-col" });
    var yAxis = el("span", { class: "mdl-axis-y mono" }, axisLabel(g.y) + " →");
    var bedWrap = el("div", { class: "mdl-bed-wrap" });
    var bed = el("div", {
      class: "mdl-bed", role: "img",
      "aria-label": "Scatter plot of " + points.length + " models. " +
        axisLabel(g.x) + " runs left to right, " + axisLabel(g.y) + " bottom to top. " +
        "Both axes score higher-is-better, so the top-right corner is best. " +
        "The full figures are in the key below.",
    });
    bed.appendChild(el("span", { class: "mdl-best mono", "aria-hidden": "true" }, "best corner"));

    laid.forEach(function (pt, i) {
      var dot = el("button", {
        type: "button",
        class: "mdl-dot" + (pt.p.deprecated ? " deprecated" : "") + (state.hover === pt.p.model ? " active" : ""),
        "data-tier": pt.p.bestTier || "unrated",
        "data-model": pt.p.model,
        style: "left:" + pt.left + "%;top:" + pt.top + "%",
        "aria-label": ariaFor(pt.p, g),
      }, String(i + 1));
      bindHover(dot, pt.p.model);
      bed.appendChild(dot);
    });

    var hov = points.filter(function (p) { return p.model === state.hover; })[0];
    if (hov) bed.appendChild(tooltip(hov, g, laid));
    bedWrap.appendChild(bed);

    var row = el("div", { class: "mdl-bed-row" });
    row.appendChild(yAxis);
    row.appendChild(bedWrap);
    plotCol.appendChild(row);

    var xAxis = el("div", { class: "mdl-axis-x mono" }, [
      el("span", { class: "mdl-axis-end" }, (g.x && g.x.low) || ""),
      el("span", null, axisLabel(g.x) + " →"),
      el("span", { class: "mdl-axis-end" }, (g.x && g.x.high) || ""),
    ]);
    plotCol.appendChild(xAxis);
    grid.appendChild(plotCol);

    // --- legend + key ------------------------------------------------------
    var side = el("div", { class: "mdl-side" });

    var legend = el("div", { class: "mdl-legend" });
    legend.appendChild(el("span", { class: "mdl-legend-title mono" }, "Tier"));
    ["primary", "secondary", "budget", "unrated"].forEach(function (t) {
      legend.appendChild(el("span", { class: "mdl-legend-row" }, [
        el("span", { class: "mdl-swatch", "data-tier": t, "aria-hidden": "true" }),
        el("span", { class: "mono" }, TIER[t].label),
        el("span", { class: "mdl-legend-note" }, TIER[t].note),
      ]));
    });
    side.appendChild(legend);

    var key = el("div", { class: "mdl-key" });
    key.appendChild(el("span", { class: "mdl-legend-title mono" }, "Key"));
    laid.forEach(function (pt, i) {
      var b = el("button", {
        type: "button",
        class: "mdl-key-row" + (state.hover === pt.p.model ? " active" : ""),
      }, [
        el("span", { class: "mdl-key-dot", "data-tier": pt.p.bestTier || "unrated", "aria-hidden": "true" },
          String(i + 1)),
        el("span", { class: "mdl-key-name mono" }, shortName(pt.p.model)),
        el("span", { class: "mdl-key-ctx mono" }, fmtCtx(pt.p.contextWindow)),
      ]);
      bindHover(b, pt.p.model);
      key.appendChild(b);
    });
    side.appendChild(key);

    side.appendChild(el("p", { class: "mdl-note" },
      "Both axes score higher-is-better, the cost axis included — it plots " +
      "cost-efficiency, not price. Where two models score alike their dots are " +
      "nudged apart so neither hides the other; hover a dot or a key row for " +
      "exact figures."));
    grid.appendChild(side);

    wrap.appendChild(grid);
    return wrap;
  }

  /**
   * Place every point, then push overlapping pairs apart.
   *
   * Two models that score alike land on the same pixel, and one silently
   * covering the other is the failure mode that makes a scatter lie about how
   * many things are on it. Relaxation moves them a few pixels rather than
   * dropping either, so the count on screen always matches the count in the
   * data — the key is numbered against this same order.
   */
  function layout(points, g) {
    var BW = 560, BH = 380, GAP = 22, PAD = 14;
    var laid = points.map(function (p) {
      return {
        p: p,
        px: (5 + (num(p.x) / 100) * 86) / 100 * BW,
        py: (95 - (num(p.y) / 100) * 86) / 100 * BH,
      };
    });
    for (var pass = 0; pass < 40; pass++) {
      var moved = false;
      for (var i = 0; i < laid.length; i++) {
        for (var j = i + 1; j < laid.length; j++) {
          var a = laid[i], b = laid[j];
          var dx = b.px - a.px, dy = b.py - a.py;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d >= GAP) continue;
          if (d < 0.01) { dx = 0; dy = 1; d = 1; }
          var push = (GAP - d) / 2 + 0.25;
          a.px -= (dx / d) * push; a.py -= (dy / d) * push;
          b.px += (dx / d) * push; b.py += (dy / d) * push;
          moved = true;
        }
      }
      laid.forEach(function (q) {
        q.px = Math.max(PAD, Math.min(BW - PAD, q.px));
        q.py = Math.max(PAD, Math.min(BH - PAD, q.py));
      });
      if (!moved) break;
    }
    laid.forEach(function (q) {
      q.left = (q.px / BW) * 100;
      q.top = (q.py / BH) * 100;
    });
    return laid;
  }

  function tooltip(p, g, laid) {
    var mine = laid.filter(function (q) { return q.p.model === p.model; })[0];
    var left = mine ? mine.left : 50, top = mine ? mine.top : 50;
    var tip = el("div", {
      role: "tooltip", class: "mdl-tip",
      style: "left:" + left + "%;top:" + top + "%;" +
        "transform:translate(" + (left > 55 ? "-104%" : "4%") + "," + (top < 50 ? "8%" : "-108%") + ")",
    });
    tip.appendChild(el("span", { class: "mdl-tip-slug mono" }, p.model));
    tip.appendChild(el("span", { class: "mdl-tip-tier", "data-tier": p.bestTier || "unrated" },
      TIER[p.bestTier || "unrated"].label));

    var rows = el("div", { class: "mdl-tip-rows mono" });
    rows.appendChild(tipRow("context", fmtCtx(p.contextWindow)));
    rows.appendChild(tipRow("price / 1M in", price(p.priceHint && p.priceHint.inputPer1M)));
    // Null out is "this model emits no output tokens", not "$0" — an embedding
    // model priced at zero output would read as free rather than inapplicable.
    rows.appendChild(tipRow("price / 1M out",
      p.priceHint && p.priceHint.outputPer1M != null
        ? price(p.priceHint.outputPer1M) : "n/a — no output tokens"));
    rows.appendChild(tipRow(axisLabel(g.x), score(p.x)));
    rows.appendChild(tipRow(axisLabel(g.y), score(p.y)));
    tip.appendChild(rows);

    if (p.notes) tip.appendChild(el("span", { class: "mdl-tip-note" },
      (p.deprecated ? "Superseded. " : "") + p.notes));
    if (p.scored === false) {
      tip.appendChild(el("span", { class: "mdl-tip-est" },
        "Scores are engineering estimates, not benchmark results."));
    }
    return tip;
  }

  function tipRow(k, v) {
    return el("span", { class: "mdl-tip-row" }, [
      el("span", null, k), el("span", { class: "mdl-tip-val" }, v),
    ]);
  }

  // --- fit matrix ----------------------------------------------------------

  function matrixView() {
    var g = state.graph || {};
    var families = g.families || [];
    var rows = g.rows || [];
    var wrap = el("section", { class: "panel mdl-matrix" });

    var head = el("div", { class: "mdl-head" });
    head.appendChild(el("h3", { class: "panel-title" }, "Fit matrix · model × task family"));
    var lg = el("span", { class: "mdl-matrix-legend mono" });
    ["primary", "secondary", "budget", "avoid", "unrated"].forEach(function (t) {
      lg.appendChild(el("span", { class: "mdl-matrix-legend-item", "data-tier": t },
        TIER[t].mark + " " + TIER[t].label));
    });
    head.appendChild(lg);
    wrap.appendChild(head);

    if (!rows.length) {
      wrap.appendChild(el("div", { class: "panel-empty" }, "No model matches this filter."));
      return wrap;
    }

    var scroll = el("div", { class: "mdl-matrix-scroll" });
    var table = el("table", { class: "mdl-matrix-table" });
    var thead = el("thead", null, [
      el("tr", null, [el("th", { scope: "col" }, "Model")].concat(families.map(function (f) {
        return el("th", { scope: "col", title: f.description || "" },
          el("span", { class: "mono" }, f.id));
      }))),
    ]);
    table.appendChild(thead);

    var tbody = el("tbody", null, rows.map(function (r) {
      var name = el("th", { scope: "row" }, [
        el("span", { class: "mono" }, shortName(r.model)),
        el("span", { class: "mdl-row-ctx mono" }, fmtCtx(r.contextWindow)),
      ]);
      if (r.deprecated) name.appendChild(el("span", { class: "mdl-dep-chip" }, "superseded"));
      var cells = families.map(function (f) {
        var tier = (r.fit && r.fit[f.id]) || "unrated";
        var t = TIER[tier] || TIER.unrated;
        return el("td", null, el("span", {
          class: "mdl-cell", "data-tier": tier,
          title: shortName(r.model) + " · " + f.id + " · " + t.label,
        }, t.mark));
      });
      return el("tr", { class: r.deprecated ? "deprecated" : null }, [name].concat(cells));
    }));
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    wrap.appendChild(el("p", { class: "mdl-note" },
      "Every cell carries a letter as well as a colour, so the matrix survives " +
      "greyscale printing and colour blindness. A dot means nobody rated that " +
      "pairing; a cross means somebody did and said no. Those are different facts."));
    return wrap;
  }

  // --- recommend -----------------------------------------------------------

  function recommendView() {
    var rec = state.recommendation || {};
    var models = rec.models || [];
    var wrap = el("div", { class: "mdl-recommend" });

    var chips = el("div", { class: "mdl-chips", role: "group", "aria-label": "Task family" });
    (state.taskFamilies || []).forEach(function (f) {
      var on = state.task === f.id;
      var b = el("button", {
        class: "btn btn-ghost btn-sm mdl-chip" + (on ? " active" : ""),
        type: "button", "aria-pressed": on ? "true" : "false", title: f.description,
      }, f.id);
      b.addEventListener("click", function () {
        if (state.task === f.id) return;
        state.task = f.id; fetchAndRender();
      });
      chips.appendChild(b);
    });
    wrap.appendChild(chips);

    var panel = el("section", { class: "panel mdl-rec-panel" });
    var head = el("div", { class: "mdl-head" });
    head.appendChild(el("div", { class: "mdl-rec-title" }, [
      el("span", { class: "mono mdl-rec-task" }, rec.task || state.task),
      el("span", { class: "panel-desc" }, rec.description || ""),
    ]));
    head.appendChild(el("span", { class: "mdl-rec-count mono" },
      models.length + (models.length === 1 ? " model rated" : " models rated")));
    panel.appendChild(head);

    if (!models.length) {
      panel.appendChild(el("div", { class: "mdl-rec-empty" }, [
        el("strong", null, "No model on the shortlist is rated for this job"),
        el("span", null,
          "A deliberate blank, not a gap in the data. Nothing scored well enough " +
          "to recommend, so the job runs deterministically or not at all."),
      ]));
      wrap.appendChild(panel);
      return wrap;
    }

    var list = el("ol", { class: "mdl-rec-list" });
    models.forEach(function (m, i) {
      var li = el("li", { class: "mdl-rec-row", "data-tier": m.tier });
      li.appendChild(el("span", { class: "mdl-rec-rank mono" }, String(i + 1)));
      var main = el("div", { class: "mdl-rec-main" });
      main.appendChild(el("div", { class: "mdl-rec-name" }, [
        el("span", { class: "mono" }, m.model),
        el("span", { class: "mdl-tip-tier", "data-tier": m.tier }, TIER[m.tier].label),
      ]));
      if (m.notes) main.appendChild(el("span", { class: "mdl-rec-why" }, m.notes));
      li.appendChild(main);
      var right = el("div", { class: "mdl-rec-price mono" });
      right.appendChild(el("span", null, priceLine(m)));
      right.appendChild(el("span", { class: "mdl-rec-ctx" }, fmtCtx(m.contextWindow) + " context"));
      li.appendChild(right);
      list.appendChild(li);
    });
    panel.appendChild(list);
    wrap.appendChild(panel);
    return wrap;
  }

  function priceLine(m) {
    var h = m.priceHint;
    if (!h || h.inputPer1M == null) return "unpriced";
    if (h.outputPer1M == null) return price(h.inputPer1M) + " / 1M";
    return price(h.inputPer1M) + " in · " + price(h.outputPer1M) + " out";
  }

  // --- the caveat, rendered from the server's provenance record ------------

  function caveat() {
    var prov = (state.graph && state.graph.provenance) || null;
    var box = el("div", { class: "mdl-caveat" });
    box.appendChild(el("span", { class: "mdl-caveat-mark", "aria-hidden": "true" }, "▲"));
    var body = el("div", { class: "mdl-caveat-body" });
    body.appendChild(el("strong", null, "Prices are relayed, not confirmed"));
    if (prov) {
      var txt = el("span", null);
      txt.appendChild(document.createTextNode(
        prov.caveat + " Source: " + prov.sourceName + ", relayed " + prov.relayedOn + ". "));
      txt.appendChild(el("a", { href: prov.sourceUrl, target: "_blank", rel: "noopener" },
        "developers.cloudflare.com/workers-ai/models"));
      body.appendChild(txt);
    } else {
      body.appendChild(el("span", null,
        "The registry did not report where these prices came from, so treat every " +
        "figure here as unsourced rather than current."));
    }
    body.appendChild(el("span", { class: "mdl-caveat-scores" },
      "Capability, coding and speed are seeded engineering estimates used to rank " +
      "and place models — not published benchmark results. Cost is the one axis " +
      "anchored to the sourced price ladder."));
    box.appendChild(body);
    return box;
  }

  // --- helpers -------------------------------------------------------------

  function bindHover(node, model) {
    var on = function () { if (state.hover !== model) { state.hover = model; render(); } };
    var off = function () { if (state.hover === model) { state.hover = null; render(); } };
    node.addEventListener("mouseenter", on);
    node.addEventListener("focus", on);
    node.addEventListener("mouseleave", off);
    node.addEventListener("blur", off);
  }

  function ariaFor(p, g) {
    return p.model + ", " + TIER[p.bestTier || "unrated"].label + ", " +
      axisLabel(g.y) + " " + score(p.y) + ", " + axisLabel(g.x) + " " + score(p.x) +
      ", context " + fmtCtx(p.contextWindow) +
      (p.deprecated ? ", superseded" : "");
  }

  function axisLabel(a) { return (a && a.label) || ""; }
  function num(v) { return typeof v === "number" ? v : 0; }
  function score(v) { return typeof v === "number" ? v + " / 100" : "not scored"; }

  function price(v) {
    if (typeof v !== "number") return "unpriced";
    if (v === 0) return "$0";
    return "$" + (v < 0.01 ? v.toFixed(4) : v.toFixed(v < 1 ? 3 : 2));
  }

  function fmtCtx(n) {
    if (typeof n !== "number" || !n) return "—";
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + "M";
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(n);
  }

  /** The trailing segment of a @cf/vendor/model slug — the part people say. */
  function shortName(model) {
    var parts = String(model || "").split("/");
    return parts[parts.length - 1] || String(model || "");
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  window.DashModels = { load: load };
})();
