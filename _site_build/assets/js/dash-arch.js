// Architecture X-ray (D-5) — the zoomable explorer over a real analysis.
//
// Renders POST /api/analyze/architecture's result: clusters at level 0,
// the selected cluster's nodes at level 1, findings and recommendations
// driven by what's selected, a lens filter (speed / cost / security), and
// a PNG export of the canvas. Canvas only — the findings panel is text the
// user can copy; rasterising it into the image helps nobody.
//
// The SVG is built with explicit fill/stroke attributes rather than CSS
// classes so the PNG export (serialize → <img> → canvas) is faithful
// without inlining a stylesheet.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  // Palette — matches the site tokens; hex literals because these land in
  // SVG attributes that must survive serialisation.
  var C = {
    bg: "#0d1118", panel: "#131825", border: "#1e2532", borderSoft: "#2a3340",
    text: "#f1f3f6", muted: "#8a93a3", dim: "#5b6373", accent: "#5eead4",
  };
  var SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  var SEV_EDGE = { critical: "#fb7185", high: "#f59e0b", medium: "#facc15", low: "#8a93a3" };
  var SEV_MARK = { critical: "▲▲", high: "▲", medium: "●", low: "·" };
  var LENSES = ["all", "speed", "cost", "security"];

  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  var state = {
    result: null,
    lens: "all",
    level: 0,          // 0 = clusters, 1 = nodes of state.cluster
    cluster: null,     // cluster id at level 1
    selected: null,    // node id (level 1) or cluster id (level 0)
    files: [],         // pending picker files as {path, content}
  };

  // A small compose file that exercises real rules: a deep synchronous
  // chain, a database exposed on a host port, and a service with its own
  // scaling profile — so Load sample produces findings, not a blank map.
  var SAMPLE_COMPOSE = [
    "services:",
    "  edge:",
    "    image: nginx:1.25",
    "    ports:",
    '      - "80:80"',
    "    depends_on:",
    "      - api",
    "  api:",
    "    image: myorg/api:1.2.3",
    "    depends_on:",
    "      - orders",
    "      - payments",
    "  orders:",
    "    image: myorg/orders:1.0.0",
    "    depends_on:",
    "      - billing",
    "      - orders-db",
    "  billing:",
    "    image: myorg/billing:2.1.0",
    "    depends_on:",
    "      - ledger",
    "  ledger:",
    "    image: myorg/ledger:1.4.0",
    "  payments:",
    "    image: myorg/payments:3.0.1",
    "    deploy:",
    "      replicas: 4",
    "    depends_on:",
    "      - payments-db",
    "  orders-db:",
    "    image: postgres:15",
    "    ports:",
    '      - "5432:5432"',
    "  payments-db:",
    "    image: postgres:15",
    "",
  ].join("\n");

  // ---------------------------------------------------------------------
  // Finding lookups
  // ---------------------------------------------------------------------

  function findingsFor(targetIds, lens) {
    var set = {};
    targetIds.forEach(function (t) { set[t] = true; });
    return (state.result.findings || []).filter(function (f) {
      if (!set[f.target]) return false;
      return lens === "all" || f.lens === lens;
    });
  }

  function worstSeverity(findings) {
    var worst = null;
    findings.forEach(function (f) {
      if (!worst || (SEV_RANK[f.severity] || 0) > (SEV_RANK[worst] || 0)) worst = f.severity;
    });
    return worst;
  }

  function clusterNodeIds(clusterId) {
    var cluster = (state.result.graph.clusters || []).find(function (c) { return c.id === clusterId; });
    var ids = cluster ? (cluster.nodes || []).slice() : [];
    ids.push(clusterId);   // some rules target the cluster itself
    return ids;
  }

  // Nodes that belong to no cluster (shared datastores, third parties) get a
  // synthetic group at level 0 so they're reachable rather than invisible.
  function ungroupedNodes() {
    return (state.result.graph.nodes || []).filter(function (n) { return !n.cluster; });
  }

  // ---------------------------------------------------------------------
  // SVG canvas
  // ---------------------------------------------------------------------

  function boxGroup(x, y, w, h, opts) {
    var g = svgEl("g", {
      transform: "translate(" + x + "," + y + ")",
      tabindex: "0", role: "button",
      "aria-label": opts.aria,
      "data-arch-id": opts.id,
      "data-arch-act": opts.act,
      style: "cursor:pointer;outline:none",
    });
    var stroke = opts.selected ? C.accent : (opts.stripe || C.border);
    g.appendChild(svgEl("rect", {
      width: w, height: h, rx: 10,
      fill: C.panel, stroke: stroke, "stroke-width": opts.selected ? 2 : 1.25,
    }));
    if (opts.stripe) {
      g.appendChild(svgEl("rect", { width: 4, height: h, rx: 2, fill: opts.stripe }));
    }
    var title = svgEl("text", {
      x: 14, y: 24, fill: C.text, "font-size": "13", "font-weight": "600",
      "font-family": "ui-monospace,Menlo,monospace",
    });
    title.textContent = opts.title.length > 26 ? opts.title.slice(0, 25) + "…" : opts.title;
    g.appendChild(title);
    var sub = svgEl("text", {
      x: 14, y: 42, fill: C.dim, "font-size": "11",
      "font-family": "ui-monospace,Menlo,monospace",
    });
    sub.textContent = opts.sub || "";
    g.appendChild(sub);
    if (opts.badge) {
      var badge = svgEl("text", {
        x: 14, y: h - 12, fill: opts.stripe || C.muted, "font-size": "11",
        "font-family": "ui-monospace,Menlo,monospace",
      });
      badge.textContent = opts.badge;
      g.appendChild(badge);
    }
    return g;
  }

  function edgeLine(a, b, label) {
    var g = svgEl("g", null);
    g.appendChild(svgEl("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: C.borderSoft, "stroke-width": 1.25,
    }));
    if (label) {
      var t = svgEl("text", {
        x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 5,
        fill: C.dim, "font-size": "10", "text-anchor": "middle",
        "font-family": "ui-monospace,Menlo,monospace",
      });
      t.textContent = label;
      g.appendChild(t);
    }
    return g;
  }

  // Grid layout: N boxes, `perRow` across, returns centres + positions.
  function layout(count, perRow, boxW, boxH, gapX, gapY, padX, padY) {
    var out = [];
    for (var i = 0; i < count; i++) {
      var col = i % perRow, row = Math.floor(i / perRow);
      var x = padX + col * (boxW + gapX);
      var y = padY + row * (boxH + gapY);
      out.push({ x: x, y: y, cx: x + boxW / 2, cy: y + boxH / 2 });
    }
    return out;
  }

  function buildCanvas() {
    var graph = state.result.graph;
    var lens = state.lens;
    var W = 920;

    var svg = svgEl("svg", {
      xmlns: SVG_NS, role: "group",
      "aria-label": state.level === 0 ? "System map, cluster level" : "Cluster detail",
      style: "display:block;max-width:100%;height:auto",
    });

    var boxes, positions, H;

    if (state.level === 0) {
      var groups = (graph.clusters || []).map(function (c) {
        var ids = clusterNodeIds(c.id);
        var fs = findingsFor(ids, lens);
        var worst = worstSeverity(fs);
        return {
          id: c.id, act: "drill", title: c.name || c.id,
          sub: (c.nodes || []).length + " node" + ((c.nodes || []).length === 1 ? "" : "s") + " · " + (c.kind || "cluster"),
          badge: fs.length ? (SEV_MARK[worst] || "") + " " + fs.length + " finding" + (fs.length === 1 ? "" : "s") : "no findings in lens",
          stripe: worst ? SEV_EDGE[worst] : null,
        };
      });
      var loose = ungroupedNodes();
      if (loose.length) {
        var looseFs = findingsFor(loose.map(function (n) { return n.id; }), lens);
        var looseWorst = worstSeverity(looseFs);
        groups.push({
          id: "__shared__", act: "drill", title: "Shared resources",
          sub: loose.length + " node" + (loose.length === 1 ? "" : "s") + " · outside clusters",
          badge: looseFs.length ? (SEV_MARK[looseWorst] || "") + " " + looseFs.length + " finding" + (looseFs.length === 1 ? "" : "s") : "no findings in lens",
          stripe: looseWorst ? SEV_EDGE[looseWorst] : null,
        });
      }

      var perRow = Math.min(3, Math.max(1, groups.length));
      var boxW = 272, boxH = 96;
      positions = layout(groups.length, perRow, boxW, boxH, 44, 56, 24, 24);
      H = (positions.length ? positions[positions.length - 1].y + boxH : 60) + 24;
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("width", W); svg.setAttribute("height", H);

      // Aggregated inter-cluster edges, drawn beneath the boxes.
      var idx = {}; groups.forEach(function (g, i) { idx[g.id] = i; });
      var nodeCluster = {};
      (graph.nodes || []).forEach(function (n) { nodeCluster[n.id] = n.cluster || "__shared__"; });
      var seen = {};
      (graph.edges || []).forEach(function (e) {
        var a = nodeCluster[e.from], b = nodeCluster[e.to];
        if (!a || !b || a === b || idx[a] === undefined || idx[b] === undefined) return;
        var key = a < b ? a + "|" + b : b + "|" + a;
        if (seen[key]) return;
        seen[key] = true;
        svg.appendChild(edgeLine(
          { x: positions[idx[a]].cx, y: positions[idx[a]].cy },
          { x: positions[idx[b]].cx, y: positions[idx[b]].cy },
          e.kind || ""));
      });

      boxes = groups.map(function (g, i) {
        return boxGroup(positions[i].x, positions[i].y, boxW, boxH, {
          id: g.id, act: g.act, title: g.title, sub: g.sub, badge: g.badge,
          stripe: g.stripe, selected: state.selected === g.id,
          aria: g.title + ", " + g.sub + ", " + g.badge + ". Press Enter to open.",
        });
      });
    } else {
      var nodes = state.cluster === "__shared__"
        ? ungroupedNodes()
        : (graph.nodes || []).filter(function (n) { return n.cluster === state.cluster; });

      var perRow2 = Math.min(3, Math.max(1, nodes.length));
      var boxW2 = 272, boxH2 = 88;
      positions = layout(nodes.length, perRow2, boxW2, boxH2, 44, 64, 24, 24);
      H = (positions.length ? positions[positions.length - 1].y + boxH2 : 60) + 24;
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("width", W); svg.setAttribute("height", H);

      var pos = {}; nodes.forEach(function (n, i) { pos[n.id] = positions[i]; });
      (graph.edges || []).forEach(function (e) {
        if (!pos[e.from] || !pos[e.to]) return;
        svg.appendChild(edgeLine(
          { x: pos[e.from].cx, y: pos[e.from].cy },
          { x: pos[e.to].cx, y: pos[e.to].cy },
          e.kind || ""));
      });

      boxes = nodes.map(function (n, i) {
        var fs = findingsFor([n.id], state.lens);
        var worst = worstSeverity(fs);
        var flags = [];
        if (n.publiclyReachable) flags.push("public");
        if (n.shared) flags.push("shared");
        return boxGroup(positions[i].x, positions[i].y, boxW2, boxH2, {
          id: n.id, act: "select",
          title: n.name || n.id,
          sub: (n.kind || "node") + (flags.length ? " · " + flags.join(" · ") : ""),
          badge: fs.length ? (SEV_MARK[worst] || "") + " " + fs.length + " finding" + (fs.length === 1 ? "" : "s") : "clean in lens",
          stripe: worst ? SEV_EDGE[worst] : null,
          selected: state.selected === n.id,
          aria: (n.name || n.id) + ", " + (n.kind || "node") + ", " + fs.length + " findings. Press Enter to inspect.",
        });
      });
    }

    boxes.forEach(function (b) { svg.appendChild(b); });
    return svg;
  }

  // ---------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------

  function findingCard(f) {
    var li = el("li", { class: "xray-finding xray-sev-" + (f.severity || "low") });
    var top = el("div", { class: "xray-finding-top" });
    var chip = el("span", { class: "chip chip-sev chip-sev-" + (f.severity || "low") });
    chip.appendChild(el("span", { class: "chip-mark", "aria-hidden": "true" }, SEV_MARK[f.severity] || "·"));
    chip.appendChild(el("span", { class: "chip-text" }, f.severity || "low"));
    top.appendChild(chip);
    top.appendChild(el("span", { class: "chip chip-muted" }, f.lens || ""));
    top.appendChild(el("span", { class: "mono xray-finding-rule" }, f.rule || ""));
    li.appendChild(top);
    if (f.why) li.appendChild(el("p", { class: "xray-finding-why" }, f.why));
    if (f.fix) {
      var fix = el("p", { class: "xray-finding-fix" });
      fix.appendChild(el("strong", null, "Fix: "));
      fix.appendChild(document.createTextNode(f.fix));
      li.appendChild(fix);
    }
    if (f.evidence) li.appendChild(el("span", { class: "mono xray-evidence" }, String(f.evidence)));
    return li;
  }

  function detailPanel() {
    var panel = el("div", { class: "xray-panel" });

    var ids, heading;
    if (state.selected && state.level === 1) {
      ids = [state.selected];
      var node = (state.result.graph.nodes || []).find(function (n) { return n.id === state.selected; });
      heading = node ? (node.name || node.id) : state.selected;
    } else if (state.level === 1) {
      ids = state.cluster === "__shared__"
        ? ungroupedNodes().map(function (n) { return n.id; })
        : clusterNodeIds(state.cluster);
      heading = "Everything in this cluster";
    } else {
      ids = null;
      heading = "All findings";
    }

    var findings = ids
      ? findingsFor(ids, state.lens)
      : (state.result.findings || []).filter(function (f) {
          return state.lens === "all" || f.lens === state.lens;
        });
    findings = findings.slice().sort(function (a, b) {
      return (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0);
    });

    var head = el("div", { class: "report-section-head" });
    head.appendChild(el("h3", null, heading));
    head.appendChild(el("span", { class: "mono report-section-note" },
      findings.length + " finding" + (findings.length === 1 ? "" : "s") +
      (state.lens === "all" ? "" : " · " + state.lens + " lens")));
    panel.appendChild(head);

    if (!findings.length) {
      panel.appendChild(el("p", { class: "panel-input-help" },
        "Nothing in this lens for this selection. Findings only fire with evidence — a silent lens means no rule could cite a file and line."));
    } else {
      var ul = el("ul", { class: "xray-finding-list" });
      findings.slice(0, 30).forEach(function (f) { ul.appendChild(findingCard(f)); });
      panel.appendChild(ul);
      if (findings.length > 30) {
        panel.appendChild(el("p", { class: "mono panel-input-help" },
          "Showing 30 of " + findings.length + " — narrow the selection or the lens for the rest."));
      }
    }
    return panel;
  }

  function recommendationsPanel() {
    var groups = state.result.recommendations || [];
    if (state.level === 1 && state.cluster && state.cluster !== "__shared__") {
      groups = groups.filter(function (g) { return g.cluster === state.cluster; });
    }
    if (!groups.length) return null;

    var panel = el("div", { class: "xray-panel" });
    var head = el("div", { class: "report-section-head" });
    head.appendChild(el("h3", null, "Recommended changes"));
    head.appendChild(el("span", { class: "mono report-section-note" }, "cheapest high-impact first"));
    panel.appendChild(head);

    groups.forEach(function (g) {
      panel.appendChild(el("h4", { class: "xray-rec-cluster mono" }, g.clusterName || g.cluster));
      var ul = el("ul", { class: "xray-rec-list" });
      (g.recommendations || []).forEach(function (r) {
        var li = el("li", { class: "xray-rec" });
        var top = el("div", { class: "xray-finding-top" });
        top.appendChild(el("span", { class: "chip chip-impact-" + (r.impact || "low") },
          (r.impact || "low") + " impact"));
        top.appendChild(el("span", { class: "chip chip-muted" }, "effort " + (r.effort || "?")));
        if (r.occurrences > 1) top.appendChild(el("span", { class: "chip chip-muted" }, "×" + r.occurrences));
        li.appendChild(top);
        li.appendChild(el("p", { class: "xray-rec-change" }, r.change || ""));
        if (r.rationale) li.appendChild(el("p", { class: "xray-finding-why" }, r.rationale));
        // The three-leg evidence for an extract-a-service recommendation —
        // rendered only when the analyzer actually produced all three.
        if (Array.isArray(r.legs) && r.legs.length) {
          var legs = el("ul", { class: "xray-legs" });
          r.legs.forEach(function (leg) {
            var legLi = el("li", { class: "xray-leg" });
            legLi.appendChild(el("strong", null, leg.leg + ": "));
            legLi.appendChild(document.createTextNode(leg.detail || leg.claim || ""));
            if (leg.evidence) legLi.appendChild(el("span", { class: "mono xray-evidence" }, " " + String(leg.evidence)));
            legs.appendChild(legLi);
          });
          li.appendChild(legs);
        }
        if (r.evidence && !Array.isArray(r.legs)) {
          li.appendChild(el("span", { class: "mono xray-evidence" }, String(r.evidence)));
        }
        ul.appendChild(li);
      });
      panel.appendChild(ul);
    });
    return panel;
  }

  // ---------------------------------------------------------------------
  // Explorer shell
  // ---------------------------------------------------------------------

  function render() {
    var out = document.getElementById("output-arch");
    if (!out || !state.result) return;
    while (out.firstChild) out.removeChild(out.firstChild);

    var result = state.result;
    var summary = result.summary || {};
    var wrap = el("div", { class: "result-wrap xray" });

    // Summary stats.
    var stats = el("div", { class: "result-stats result-stats-4" });
    [["Clusters", summary.clusters], ["Nodes", summary.nodes],
     ["Edges", summary.edges], ["Findings", summary.findings]].forEach(function (pair) {
      var card = el("div", { class: "stat-card" });
      card.appendChild(el("div", { class: "stat-label" }, pair[0]));
      card.appendChild(el("div", { class: "stat-value" }, String(pair[1] != null ? pair[1] : "—")));
      stats.appendChild(card);
    });
    wrap.appendChild(stats);

    if (summary.complete === false) {
      var limits = result.limits || {};
      var caveat = el("p", { class: "field-msg field-msg-error" },
        "Partial map: " + (limits.filesSkipped || 0) + " file" +
        ((limits.filesSkipped || 0) === 1 ? "" : "s") + " couldn't be read" +
        (limits.skipped && limits.skipped.length ? " (" + limits.skipped.slice(0, 3).join(", ") +
          (limits.skipped.length > 3 ? ", …" : "") + ")" : "") +
        ". What's drawn is real; what's missing is named, not guessed.");
      caveat.hidden = false;
      wrap.appendChild(caveat);
    }

    // Toolbar: breadcrumb, lens, export.
    var bar = el("div", { class: "xray-toolbar" });
    var crumb = el("div", { class: "xray-crumb" });
    var rootBtn = el("button", { type: "button", class: "seg-btn" + (state.level === 0 ? " xray-crumb-here" : "") }, "System");
    rootBtn.addEventListener("click", function () { go(0, null); });
    crumb.appendChild(rootBtn);
    if (state.level === 1) {
      crumb.appendChild(el("span", { class: "mono xray-crumb-sep", "aria-hidden": "true" }, "›"));
      var cluster = (result.graph.clusters || []).find(function (c) { return c.id === state.cluster; });
      crumb.appendChild(el("span", { class: "seg-btn xray-crumb-here" },
        state.cluster === "__shared__" ? "Shared resources" : (cluster ? cluster.name : state.cluster)));
    }
    bar.appendChild(crumb);

    var lensGroup = el("div", { class: "seg-group", role: "group", "aria-label": "Findings lens" });
    LENSES.forEach(function (lens) {
      var b = el("button", {
        type: "button", class: "seg-btn",
        "aria-pressed": state.lens === lens ? "true" : "false",
      }, lens === "all" ? "All lenses" : lens.charAt(0).toUpperCase() + lens.slice(1));
      b.addEventListener("click", function () { state.lens = lens; render(); });
      lensGroup.appendChild(b);
    });
    bar.appendChild(lensGroup);

    var exportBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Export PNG");
    exportBtn.addEventListener("click", function () { exportPng(exportBtn); });
    bar.appendChild(exportBtn);
    wrap.appendChild(bar);

    // Canvas.
    var canvasWrap = el("div", { class: "xray-canvas", id: "xray-canvas" });
    canvasWrap.appendChild(buildCanvas());
    wrap.appendChild(canvasWrap);
    wrap.appendChild(el("p", { class: "mono xray-hint" },
      state.level === 0
        ? "Click a cluster to open it. Enter opens, Esc goes back up."
        : "Click a node for its findings. Esc returns to the system view."));

    wrap.appendChild(detailPanel());
    var recs = recommendationsPanel();
    if (recs) wrap.appendChild(recs);

    out.appendChild(wrap);
  }

  function go(level, cluster, selected) {
    state.level = level;
    state.cluster = cluster;
    state.selected = selected || null;
    render();
  }

  function onCanvasActivate(target) {
    var id = target.getAttribute("data-arch-id");
    var act = target.getAttribute("data-arch-act");
    if (act === "drill") go(1, id);
    else if (act === "select") { state.selected = state.selected === id ? null : id; render(); }
  }

  // ---------------------------------------------------------------------
  // PNG export — canvas only, by design.
  // ---------------------------------------------------------------------

  function exportPng(btn) {
    var canvasWrap = document.getElementById("xray-canvas");
    var svg = canvasWrap && canvasWrap.querySelector("svg");
    if (!svg) return;
    setBusy(btn, true, "Exporting…");

    var clone = svg.cloneNode(true);
    // A background rect so the PNG isn't transparent-on-white in a slide.
    var bgRect = svgEl("rect", {
      width: svg.getAttribute("width"), height: svg.getAttribute("height"), fill: C.bg,
    });
    clone.insertBefore(bgRect, clone.firstChild);

    var xml = new XMLSerializer().serializeToString(clone);
    var blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var scale = 2;   // crisp on retina
      var canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      var ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (png) {
        if (png) {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(png);
          a.download = "algosize-architecture.png";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 0);
        }
        setBusy(btn, false);
      }, "image/png");
    };
    img.onerror = function () { URL.revokeObjectURL(url); setBusy(btn, false); };
    img.src = url;
  }

  // ---------------------------------------------------------------------
  // Input handling + run
  // ---------------------------------------------------------------------

  function setFiles(files) {
    state.files = files;
    var label = document.getElementById("input-arch-names");
    if (label) {
      label.textContent = files.length
        ? files.length + " file" + (files.length === 1 ? "" : "s") + ": " +
          files.slice(0, 3).map(function (f) { return f.path; }).join(", ") +
          (files.length > 3 ? ", …" : "")
        : "No files selected.";
    }
  }

  function runAnalysis(btn) {
    if (!state.files.length) {
      var out = document.getElementById("output-arch");
      if (out) {
        while (out.firstChild) out.removeChild(out.firstChild);
        out.appendChild(core.errorState("Choose files first (or click Load sample)."));
      }
      return;
    }
    setBusy(btn, true, "Analyzing…");
    callApi("/api/analyze/architecture", { files: state.files })
      .then(function (result) {
        state.result = result;
        state.level = 0; state.cluster = null; state.selected = null; state.lens = "all";
        render();
        core.loadRuns();
      })
      .catch(function (e) {
        var out = document.getElementById("output-arch");
        if (out) {
          while (out.firstChild) out.removeChild(out.firstChild);
          out.appendChild(core.errorState(e.message || "Analysis failed", e.helpUrl));
        }
      })
      .then(function () { setBusy(btn, false); });
  }

  function attach() {
    var picker = document.getElementById("input-arch-files");
    var pickBtn = document.getElementById("input-arch-btn");
    if (pickBtn && picker) {
      pickBtn.addEventListener("click", function () { picker.click(); });
      picker.addEventListener("change", function () {
        var list = Array.prototype.slice.call(picker.files || []);
        Promise.all(list.map(function (f) {
          return f.text().then(function (content) { return { path: f.name, content: content }; });
        })).then(setFiles).catch(function () {
          setFiles([]);
          window.alert("Could not read one of the selected files.");
        });
      });
    }

    var sampleBtn = document.getElementById("arch-sample-btn");
    if (sampleBtn) {
      sampleBtn.addEventListener("click", function () {
        setFiles([{ path: "docker-compose.yml", content: SAMPLE_COMPOSE }]);
        var label = document.getElementById("input-arch-names");
        if (label) label.textContent = "docker-compose.yml (built-in sample)";
      });
    }

    var runBtn = document.getElementById("arch-run-btn");
    if (runBtn) runBtn.addEventListener("click", function () { runAnalysis(runBtn); });

    // Canvas interaction — delegated, covers click + Enter/Space + Esc.
    document.addEventListener("click", function (event) {
      var g = event.target.closest && event.target.closest("[data-arch-id]");
      if (g) onCanvasActivate(g);
    });
    document.addEventListener("keydown", function (event) {
      var g = event.target.closest && event.target.closest("[data-arch-id]");
      if (g && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        onCanvasActivate(g);
        return;
      }
      if (event.key === "Escape" && state.result && state.level === 1) {
        var canvasWrap = document.getElementById("xray-canvas");
        if (canvasWrap && canvasWrap.contains(document.activeElement)) {
          event.preventDefault();
          go(0, null);
        }
      }
    });

    // "View map" from the runs feed: reload the stored run's result into
    // the explorer and scroll it into view.
    document.addEventListener("click", function (event) {
      var btn = event.target.closest && event.target.closest('button[data-run-action="viewmap"]');
      if (!btn) return;
      setBusy(btn, true, "Loading…");
      callApi("/api/runs/" + encodeURIComponent(btn.dataset.runId), null, "GET")
        .then(function (run) {
          if (run && run.result && run.result.graph) {
            state.result = run.result;
            state.level = 0; state.cluster = null; state.selected = null; state.lens = "all";
            render();
            var panel = document.getElementById("panel-arch");
            if (panel && typeof panel.scrollIntoView === "function") {
              panel.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }
        })
        .catch(function (e) { window.alert(e.message || "Could not load the run"); })
        .then(function () { setBusy(btn, false); });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  window.DashArch = {};
})();
