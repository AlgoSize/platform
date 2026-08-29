// Architecture X-ray (D-5) — the zoomable explorer over a real analysis.
//
// Renders POST /api/analyze/architecture's result the way the design canvas
// specifies it: three zoom levels over one graph (clusters → nodes → one node
// pinned), a lens that recolours by the worst finding under it, a side panel
// that explains the selection, and recommendations that carry the evidence
// arguing for them.
//
// The commitments this screen makes, and where each is honoured:
//
//   * Severity never rides on colour alone. Four redundant channels: hatch
//     DENSITY (6px pitch for critical up to none for low), GLYPH COUNT
//     (▲▲ / ▲ / ● / ·), the WORD itself in badges and rows, and the 5px left
//     stripe (position). A grayscale print or a colour-blind reader keeps the
//     ordering. The legend under the canvas teaches all of them at once.
//   * Every box is a real keyboard control: Tab reaches it, Enter/Space
//     activates, arrow keys move to the next sibling at the same level, Esc
//     goes up one level — the keyboard equivalent of the breadcrumb.
//     aria-pressed reports the pin state, and each aria-label names the node,
//     its kind, the worst severity under the active lens and the finding
//     count, so the graph is legible without seeing it.
//   * Diff mode compares against the previous architecture run. New findings
//     pulse EXACTLY ONCE (animation-iteration-count: 1, disabled entirely
//     under prefers-reduced-motion) and then the "New" badge and dashed ring
//     are the permanent signal — they survive a PNG export and a reader who
//     arrives after any animation finished. Resolved findings stay visible,
//     struck through with what they were: deleting them silently would lose
//     the only proof that last sprint's work landed.
//   * An unmeasured diff is not an empty one. No previous run, a failed
//     fetch, or an unparseable result all render as NO diff affordance — the
//     toggle only appears when a comparison actually happened.
//
// The SVG is built with explicit fill/stroke attributes rather than CSS
// classes so the PNG export (serialize → <img> → canvas) is faithful without
// inlining a stylesheet. The one exception is the one-shot pulse class, which
// is allowed to be lost in export — the permanent markers carry the diff.

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
    arrow: "#3a4454",
  };
  var SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  var SEV_EDGE = { critical: "#fb7185", high: "#f59e0b", medium: "#facc15", low: "#8a93a3" };
  var SEV_CHIPTEXT = { critical: "#fda4af", high: "#fbbf24", medium: "#fde047", low: "#8a93a3" };
  var SEV_MARK = { critical: "▲▲", high: "▲", medium: "●", low: "·" };
  var SEV_BG = {
    critical: "rgba(251,113,133,.14)", high: "rgba(245,158,11,.12)",
    medium: "rgba(250,204,21,.1)", low: "transparent",
  };
  var SEV_BORDER = {
    critical: "rgba(251,113,133,.4)", high: "rgba(245,158,11,.35)",
    medium: "rgba(250,204,21,.3)", low: "#2a3340",
  };
  var LENSES = ["all", "speed", "cost", "security"];
  var LENS_LABEL = { all: "All lenses", speed: "Speed", cost: "Cost", security: "Security" };
  var LENS_SHORT = { speed: "SPD", cost: "CST", security: "SEC" };

  // Effort and impact each get their own glyph, and they stay two separate
  // chips rather than one priority number — collapsing them would hide the
  // only comparison that matters when picking a sprint's work: an S/high
  // beats an L/high regardless of what a weighted score would say.
  var EFFORT_MARK = { S: "○", M: "◐", L: "●" };
  var IMPACT_MARK = { high: "▲▲", medium: "▲", low: "·" };
  var IMPACT_STYLE = {
    high:   { color: "#5eead4", border: "rgba(94,234,212,.35)", bg: "rgba(94,234,212,.1)" },
    medium: { color: "#8a93a3", border: "#2a3340",              bg: "transparent" },
    low:    { color: "#5b6373", border: "#1e2532",              bg: "transparent" },
  };

  var SEV_HATCH = { critical: 6, high: 7, medium: 9 };   // low: no fill at all

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  /**
   * Hatch patterns + the edge arrowhead, one <defs> per SVG.
   *
   * Per-SVG rather than shared because the PNG export serialises this element
   * on its own — a pattern living in a shared <defs> elsewhere on the page
   * would resolve on screen and come out blank in the exported image.
   */
  function canvasDefs() {
    var defs = svgEl("defs", null);
    Object.keys(SEV_HATCH).forEach(function (sev) {
      var pitch = SEV_HATCH[sev];
      var pat = svgEl("pattern", {
        id: "arch-hatch-" + sev, width: pitch, height: pitch,
        patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)",
      });
      pat.appendChild(svgEl("rect", {
        width: pitch, height: pitch, fill: SEV_EDGE[sev], "fill-opacity": "0.10",
      }));
      pat.appendChild(svgEl("rect", {
        width: Math.max(1.2, pitch / 3), height: pitch,
        fill: SEV_EDGE[sev], "fill-opacity": "0.34",
      }));
      defs.appendChild(pat);
    });
    var marker = svgEl("marker", {
      id: "arch-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5",
      markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse",
    });
    marker.appendChild(svgEl("path", { d: "M 0 1 L 10 5 L 0 9 z", fill: C.arrow }));
    defs.appendChild(marker);
    return defs;
  }

  var state = {
    result: null,
    runId: null,       // the run behind state.result, when known — powers "Full report"
    lens: "all",
    level: 0,          // 0 = clusters, 1 = nodes of state.cluster, 2 = one node pinned
    cluster: null,
    selected: null,    // node id (level 1) or cluster id (level 0)
    pinned: null,      // node id at level 2
    // Diff state. newKeys/resolvedItems null = no comparison was possible,
    // which renders as no diff affordance at all rather than "nothing
    // changed" — an unmeasured diff is not an empty one.
    diff: true,        // the "Since last run" toggle; only shown when a diff exists
    newKeys: null,     // { findingKey: true } for findings absent from the previous run
    resolvedItems: null, // previous-run findings absent from this one
    prevRunAt: null,
    // Structural drift, from the snapshot history (/api/arch/diff). Distinct
    // from the findings diff above: that one answers "what did the analyzer
    // start or stop saying", this one answers "what changed in the
    // architecture itself". null = not loaded; an object always carries its
    // own honesty state rather than being flattened to an empty diff.
    drift: null,
    files: [],
    // Keys that have already had their one-shot pulse. A lens switch or a
    // zoom re-renders the same finding; pulsing it again on every repaint
    // would turn "draws the eye once" into a screen that never sits still.
    pulsed: {},
  };

  function diffOn() { return state.diff && state.newKeys !== null; }

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

  function allFindings(lens) {
    return (state.result.findings || []).filter(function (f) {
      return lens === "all" || f.lens === lens;
    });
  }

  /**
   * A stable identity for one finding, for comparing two runs.
   *
   * target + lens + title (rule), because ids are per-run and would make
   * every finding look new on every sweep.
   */
  function findingKey(f) {
    return [f.target || "", f.lens || "", f.rule || f.title || ""].join(" ");
  }

  function isNewFinding(f) {
    return diffOn() && !!state.newKeys[findingKey(f)];
  }

  function countNew(findings) {
    if (!diffOn()) return 0;
    var n = 0;
    findings.forEach(function (f) { if (state.newKeys[findingKey(f)]) n++; });
    return n;
  }

  /** "sync_chain_depth" → "Sync chain depth" — the card's human title. */
  function ruleTitle(f) {
    var raw = f.rule || "finding";
    var s = String(raw).replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * Compare this result against the previous architecture run for the org.
   *
   * Fills BOTH halves of the diff: findings new in this run, and findings
   * from the previous run that are no longer present. Best-effort and
   * entirely optional — any failure leaves both null and the diff affordance
   * absent. Done client-side because the comparison needs two whole result
   * blobs and the runs API already serves them.
   */
  function loadDiff(currentRunId) {
    state.newKeys = null;
    state.resolvedItems = null;
    state.prevRunAt = null;

    // "arch" is the analyzer key the Worker persists (handlers/analyze.js),
    // not "architecture" — the route name and the stored value differ.
    callApi("/api/runs?analyzer=arch&limit=5", null, "GET")
      .then(function (res) {
        var items = (res && res.items) || [];
        var prev = null;
        for (var i = 0; i < items.length; i++) {
          if (!items[i] || !items[i].id) continue;
          if (currentRunId ? items[i].id !== currentRunId : i > 0) { prev = items[i]; break; }
        }
        if (!prev) return null;
        return callApi("/api/runs/" + encodeURIComponent(prev.id), null, "GET")
          .then(function (full) { return { run: prev, full: full }; });
      })
      .then(function (got) {
        if (!got || !got.full) return;
        var prevResult = got.full.result || (got.full.run && got.full.run.result);
        var prevFindings = prevResult && prevResult.findings;
        if (!Array.isArray(prevFindings)) return;

        var current = {};
        (state.result.findings || []).forEach(function (f) { current[findingKey(f)] = true; });
        var seen = {};
        var resolved = [];
        prevFindings.forEach(function (f) {
          var k = findingKey(f);
          seen[k] = true;
          // Present last run, absent now: the proof that work landed. Kept
          // with what it was, because "resolved" with no severity or evidence
          // is a claim rather than a record.
          if (!current[k]) {
            resolved.push({
              target: f.target || "", lens: f.lens || "",
              title: ruleTitle(f), severity: f.severity || "low",
              evidence: f.evidence ? String(f.evidence) : "",
            });
          }
        });
        var fresh = {};
        (state.result.findings || []).forEach(function (f) {
          var k = findingKey(f);
          if (!seen[k]) fresh[k] = true;
        });
        state.newKeys = fresh;
        state.resolvedItems = resolved;
        state.prevRunAt = got.run.createdAt || null;
        render();
      })
      .catch(function () { /* no diff is a fine outcome; leave both null */ });
  }

  /**
   * Load the structural drift for the most recent architecture snapshot.
   *
   * Deliberately never invents a comparison: the endpoint distinguishes "this
   * is the earliest snapshot" from "the comparison point is gone", and both
   * are carried through to the reader as themselves. A drift view that
   * rendered either as "nothing changed" would report a brand-new repository
   * and a lost baseline as a clean bill of health.
   */
  function loadDrift() {
    state.drift = null;
    callApi("/api/arch/snapshots?limit=1", null, "GET")
      .then(function (res) {
        var snaps = (res && res.snapshots) || [];
        if (!snaps.length || !snaps[0].snapshotId) {
          // No history yet. Distinct from "history exists and shows nothing".
          state.drift = { state: "no_history" };
          render();
          return null;
        }
        return callApi("/api/arch/diff?to=" + encodeURIComponent(snaps[0].snapshotId), null, "GET");
      })
      .then(function (res) {
        if (!res) return;
        if (res.error) { state.drift = { state: "error" }; render(); return; }
        state.drift = {
          state: res.diff && res.diff.comparable ? "ok" : "incomparable",
          diff: res.diff || null,
          note: res.note || null,
          reducedInputs: res.reducedInputs || [],
          from: res.from || null,
          to: res.to || null,
        };
        render();
      })
      .catch(function () { state.drift = { state: "error" }; render(); });
  }

  /**
   * The drift panel.
   *
   * Two honesty states the stored data forces, both stated rather than
   * styled around:
   *
   *   - a `reduced` snapshot dropped its evidence arrays to fit, so the diff
   *     is structurally right but cannot cite a file and line. Migration 0018
   *     says outright that a snapshot which silently loses its citations
   *     breaks the X-ray's core promise, so the reader is told before they
   *     ask why the evidence is missing.
   *   - a dangling prev_snapshot_id means the baseline aged out. That is not
   *     the same as having no baseline, and it must never re-point silently
   *     at an older graph.
   */
  function driftPanel() {
    var d = state.drift;
    if (!d) return null;

    var card = el("section", { class: "xray-drift", "aria-label": "Architecture drift" });
    card.appendChild(el("h3", { class: "xray-drift-head" }, "Structural drift"));

    if (d.state === "no_history") {
      card.appendChild(el("p", { class: "panel-input-help" },
        "No snapshot history yet. Every architecture run from now on is stored and " +
        "chained to the one before it, so the next run has something to compare against."));
      return card;
    }
    if (d.state === "error") {
      card.appendChild(el("p", { class: "panel-input-help" },
        "The drift history could not be read. The map above is unaffected."));
      return card;
    }
    if (d.state === "incomparable") {
      // The endpoint already distinguishes the two reasons in words. Passing
      // its note through beats re-deriving it here and getting it wrong.
      card.appendChild(el("p", { class: "panel-input-help" },
        d.note || "There is nothing to compare this snapshot against."));
      return card;
    }

    var diff = d.diff || {};
    var total = diff.changed || 0;
    card.appendChild(el("p", { class: "panel-input-help" },
      total === 0
        ? "No structural change since the previous snapshot — same services, same edges."
        : total + " structural change" + (total === 1 ? "" : "s") + " since the previous snapshot."));

    if (total > 0) {
      var list = el("ul", { class: "xray-drift-list" });
      var rows = [
        ["+", "added",   "Service", diff.nodesAdded],
        ["−", "removed", "Service", diff.nodesRemoved],
        ["+", "added",   "Edge",    diff.edgesAdded],
        ["−", "removed", "Edge",    diff.edgesRemoved],
      ];
      rows.forEach(function (r) {
        (r[3] || []).slice(0, 8).forEach(function (item) {
          var li = el("li", { class: "xray-drift-item xray-drift-" + r[1] });
          // The sign is paired with a word: colour alone never carries a
          // state anywhere else in this product either.
          li.appendChild(el("span", { class: "xray-drift-sign", "aria-hidden": "true" }, r[0]));
          li.appendChild(el("span", { class: "xray-drift-kind" }, r[2] + " " + r[1]));
          li.appendChild(el("span", { class: "mono xray-drift-name" },
            item.name || item.id || (item.from && item.from + " → " + item.to) || "—"));
          list.appendChild(li);
        });
      });
      card.appendChild(list);
    }

    if (d.reducedInputs && d.reducedInputs.length) {
      card.appendChild(el("p", { class: "field-msg field-msg-error xray-drift-reduced" },
        "One of the two snapshots was stored in reduced form and no longer carries its " +
        "evidence. What changed is still accurate; where it changed cannot be cited " +
        "from this comparison."));
    }
    return card;
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

  function ungroupedNodes() {
    return (state.result.graph.nodes || []).filter(function (n) { return !n.cluster; });
  }

  // ---------------------------------------------------------------------
  // SVG canvas
  // ---------------------------------------------------------------------

  /**
   * Trim an edge to the boundary of the boxes at each end, plus a margin so
   * the arrowhead sits in the gap instead of under the destination box.
   * Boxes are drawn after edges, so an untrimmed arrowhead would simply be
   * covered — a directed graph whose direction is invisible.
   */
  function trimEdge(a, b) {
    var dx = b.cx - a.cx, dy = b.cy - a.cy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    var exit = function (half) {
      var tx = Math.abs(ux) > 1e-6 ? half.w / Math.abs(ux) : Infinity;
      var ty = Math.abs(uy) > 1e-6 ? half.h / Math.abs(uy) : Infinity;
      return Math.min(tx, ty);
    };
    var tA = exit(a.half) + 6;
    var tB = exit(b.half) + 10;   // extra room for the arrowhead itself
    if (tA + tB >= len) { tA = len * 0.35; tB = len * 0.45; }
    return {
      x1: a.cx + ux * tA, y1: a.cy + uy * tA,
      x2: b.cx - ux * tB, y2: b.cy - uy * tB,
    };
  }

  /**
   * The three per-lens chips at the bottom of a box: SPD / CST / SEC, each
   * carrying the worst-severity glyph under that lens. All three are always
   * visible — the chips are how you decide which lens to switch to, so
   * hiding two of them would defeat the point. The active lens gets a teal
   * ring instead of the severity border.
   */
  function lensChips(g, targetIds, x, y, chipW, gap) {
    ["speed", "cost", "security"].forEach(function (ln, k) {
      var fs = findingsFor(targetIds, ln);
      var worst = worstSeverity(fs);
      var cx = x + k * (chipW + gap);
      g.appendChild(svgEl("rect", {
        x: cx, y: y, width: chipW, height: 19, rx: 5,
        fill: worst ? SEV_BG[worst] : C.bg,
        stroke: ln === state.lens ? C.accent : (worst ? SEV_BORDER[worst] : C.border),
        "stroke-width": "1",
      }));
      var t = svgEl("text", {
        x: cx + 8, y: y + 13.5,
        fill: worst ? SEV_CHIPTEXT[worst] : C.dim,
        "font-size": "10", "font-weight": "700",
        "font-family": "ui-monospace,Menlo,monospace",
      });
      t.textContent = LENS_SHORT[ln] + " " + (worst ? SEV_MARK[worst] : "—");
      g.appendChild(t);
    });
  }

  function boxGroup(x, y, w, h, opts) {
    var g = svgEl("g", {
      transform: "translate(" + x + "," + y + ")",
      tabindex: "0", role: "button",
      "aria-label": opts.aria,
      "aria-pressed": opts.pressed ? "true" : "false",
      "data-arch-id": opts.id,
      "data-arch-act": opts.act,
      style: "cursor:pointer;outline:none",
    });
    // Dimming rather than hiding at level 2: the pinned node keeps the shape
    // of the cluster around it instead of floating alone with no context.
    if (opts.dimmed) g.setAttribute("opacity", "0.2");

    var stroke = opts.selected ? C.accent
      : (opts.severity ? SEV_EDGE[opts.severity] : C.border);
    g.appendChild(svgEl("rect", {
      width: w, height: h, rx: 12,
      fill: C.panel, stroke: stroke, "stroke-width": opts.selected ? 2.5 : 1.4,
    }));
    // Hatch overlay — the colour-independent half of the severity encoding.
    if (opts.severity && SEV_HATCH[opts.severity]) {
      g.appendChild(svgEl("rect", {
        width: w, height: h, rx: 12,
        fill: "url(#arch-hatch-" + opts.severity + ")", stroke: "none",
      }));
    }
    // The 5px left stripe — severity by position, the fourth channel.
    if (opts.severity) {
      g.appendChild(svgEl("rect", { width: 5, height: h, fill: SEV_EDGE[opts.severity] }));
    }

    var title = svgEl("text", {
      x: 14, y: 26, fill: C.text,
      "font-size": opts.big ? "16" : "14", "font-weight": "600",
      "font-family": "ui-sans-serif,system-ui,sans-serif",
    });
    title.textContent = opts.title.length > 26 ? opts.title.slice(0, 25) + "…" : opts.title;
    g.appendChild(title);
    var sub = svgEl("text", {
      x: 14, y: opts.big ? 46 : 43, fill: C.muted, "font-size": "11", "letter-spacing": "1.1",
      "font-family": "ui-monospace,Menlo,monospace",
    });
    sub.textContent = opts.sub || "";
    g.appendChild(sub);

    // The severity BADGE — the word itself, top right. Clusters always carry
    // one (including "clear"); nodes only at high or above, where a reader
    // scanning the map needs the word without opening the panel.
    if (opts.badgeText) {
      var bw = 12 + opts.badgeText.length * 6.4;
      var bx = w - bw - 10;
      g.appendChild(svgEl("rect", {
        x: bx, y: 12, width: bw, height: 19, rx: 5,
        fill: opts.severity ? SEV_BG[opts.severity] : C.bg,
        stroke: opts.severity ? SEV_EDGE[opts.severity] : C.border, "stroke-width": "1",
      }));
      var bt = svgEl("text", {
        x: bx + 6, y: 25.5,
        fill: opts.severity ? SEV_EDGE[opts.severity] : C.dim,
        "font-size": "10", "font-weight": "700", "letter-spacing": ".6",
        "font-family": "ui-monospace,Menlo,monospace",
      });
      bt.textContent = opts.badgeText;
      g.appendChild(bt);
    }

    // Per-lens chips along the bottom.
    if (opts.chipIds) {
      var chipW = opts.big ? 86 : 76;
      lensChips(g, opts.chipIds, 12, h - 29, chipW, 8);
    }

    // Diff markers: a dashed teal ring is the permanent, export-surviving
    // signal; the one-shot pulse class draws the eye once and then never
    // moves again (and not at all under prefers-reduced-motion).
    if (opts.isNew) {
      var ring = svgEl("rect", {
        width: w, height: h, rx: 12, fill: "none",
        stroke: C.accent, "stroke-width": 1.5, "stroke-dasharray": "4 3",
      });
      if (opts.pulse) ring.setAttribute("class", "xray-new");
      g.appendChild(ring);
    }
    return g;
  }

  function edgeLine(t, label, opts) {
    opts = opts || {};
    var g = svgEl("g", null);
    if (opts.faded) g.setAttribute("opacity", "0.14");
    // Hot edges — carrying a high or critical finding under the active lens —
    // go solid and coloured; the rest stay thin and dashed, so the hot path
    // reads before any label does.
    g.appendChild(svgEl("line", {
      x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2,
      stroke: opts.stroke || C.borderSoft,
      "stroke-width": opts.width || 1.4,
      "stroke-dasharray": opts.hot || opts.lit || opts.solid ? "none" : "5 4",
      "marker-end": "url(#arch-arrow)",
    }));
    if (label && !opts.faded) {
      var txt = svgEl("text", {
        x: (t.x1 + t.x2) / 2, y: (t.y1 + t.y2) / 2 - 6,
        fill: opts.lit ? C.muted : C.dim, "font-size": "10", "text-anchor": "middle",
        "font-family": "ui-monospace,Menlo,monospace",
      });
      txt.textContent = label;
      g.appendChild(txt);
    }
    return g;
  }

  function edgeLabelFor(e) {
    return e.kind ? (e.via ? e.kind + " · " + e.via : e.kind) : "";
  }

  // Grid layout: N boxes, `perRow` across, returns centres + positions.
  function layout(count, perRow, boxW, boxH, gapX, gapY, padX, padY) {
    var out = [];
    for (var i = 0; i < count; i++) {
      var col = i % perRow, row = Math.floor(i / perRow);
      var x = padX + col * (boxW + gapX);
      var y = padY + row * (boxH + gapY);
      out.push({
        x: x, y: y, cx: x + boxW / 2, cy: y + boxH / 2,
        half: { w: boxW / 2, h: boxH / 2 },
      });
    }
    return out;
  }

  function buildCanvas() {
    var graph = state.result.graph;
    var lens = state.lens;
    var W = 920;

    var svg = svgEl("svg", {
      xmlns: SVG_NS, role: "group",
      "aria-label": (state.level === 0
        ? "Cluster overview"
        : (state.level === 2 ? "Node dependencies, pinned" : "Cluster internals")) +
        ", " + LENS_LABEL[lens].toLowerCase(),
      style: "display:block;max-width:100%;height:auto",
    });
    svg.appendChild(canvasDefs());

    var boxes, positions, H;

    if (state.level === 0) {
      var groups = (graph.clusters || []).map(function (c) {
        var ids = clusterNodeIds(c.id);
        var fs = findingsFor(ids, lens);
        var all = findingsFor(ids, "all");
        var worst = worstSeverity(fs);
        return {
          id: c.id, act: "drill", title: c.name || c.id, ids: ids,
          sub: (c.nodes || []).length + " NODES · " + all.length + " FINDINGS",
          badgeText: (worst ? SEV_MARK[worst] + " " + worst : "— clear"),
          severity: worst || null,
          isNew: countNew(findingsFor(ids, "all")) > 0,
        };
      });
      var loose = ungroupedNodes();
      if (loose.length) {
        var looseIds = loose.map(function (n) { return n.id; });
        var looseWorst = worstSeverity(findingsFor(looseIds, lens));
        groups.push({
          id: "__shared__", act: "drill", title: "Shared resources", ids: looseIds,
          sub: loose.length + " NODES · OUTSIDE CLUSTERS",
          badgeText: (looseWorst ? SEV_MARK[looseWorst] + " " + looseWorst : "— clear"),
          severity: looseWorst || null,
          isNew: countNew(findingsFor(looseIds, "all")) > 0,
        });
      }

      var perRow = Math.min(3, Math.max(1, groups.length));
      var boxW = 280, boxH = 118;
      positions = layout(groups.length, perRow, boxW, boxH, 36, 64, 24, 24);
      H = (positions.length ? positions[positions.length - 1].y + boxH : 60) + 24;
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("width", W); svg.setAttribute("height", H);

      // Aggregated inter-cluster edges, drawn beneath the boxes, one line per
      // ordered pair so the arrow says which way the dependency points.
      var idx = {}; groups.forEach(function (g, i) { idx[g.id] = i; });
      var nodeCluster = {};
      (graph.nodes || []).forEach(function (n) { nodeCluster[n.id] = n.cluster || "__shared__"; });
      var seen = {};
      (graph.edges || []).forEach(function (e) {
        var a = nodeCluster[e.from], b = nodeCluster[e.to];
        if (!a || !b || a === b || idx[a] === undefined || idx[b] === undefined) return;
        var key = a + "→" + b;
        if (seen[key]) return;
        seen[key] = true;
        var t = trimEdge(positions[idx[a]], positions[idx[b]]);
        // Solid at L0: the cluster level has no hot/cold distinction to draw,
        // and dashing every edge would imply one.
        svg.appendChild(edgeLine(t, edgeLabelFor(e), { solid: true, width: 1.5 }));
      });

      boxes = groups.map(function (g, i) {
        return boxGroup(positions[i].x, positions[i].y, boxW, boxH, {
          id: g.id, act: g.act, title: g.title, sub: g.sub, big: true,
          badgeText: g.badgeText, severity: g.severity,
          chipIds: g.ids,
          isNew: g.isNew, pulse: g.isNew && !state.pulsed["c:" + g.id],
          selected: state.selected === g.id,
          pressed: false,
          aria: g.title + ", " + LENS_LABEL[lens].toLowerCase() + " worst severity " +
                (g.severity || "none") + ", " + g.sub.toLowerCase() +
                ". Activate to open cluster.",
        });
      });
      groups.forEach(function (g) { if (g.isNew) state.pulsed["c:" + g.id] = true; });
    } else {
      var nodes = state.cluster === "__shared__"
        ? ungroupedNodes()
        : (graph.nodes || []).filter(function (n) { return n.cluster === state.cluster; });

      var pinnedId = state.level === 2 ? state.pinned : null;
      var lit = null;
      if (pinnedId) {
        lit = {};
        lit[pinnedId] = true;
        (graph.edges || []).forEach(function (e) {
          if (e.from === pinnedId) lit[e.to] = true;
          if (e.to === pinnedId) lit[e.from] = true;
        });
      }

      var perRow2 = Math.min(3, Math.max(1, nodes.length));
      var boxW2 = 280, boxH2 = 106;
      positions = layout(nodes.length, perRow2, boxW2, boxH2, 36, 70, 24, 24);
      H = (positions.length ? positions[positions.length - 1].y + boxH2 : 60) + 24;
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("width", W); svg.setAttribute("height", H);

      var pos = {}; nodes.forEach(function (n, i) { pos[n.id] = positions[i]; });
      (graph.edges || []).forEach(function (e) {
        if (!pos[e.from] || !pos[e.to]) return;
        var touches = !pinnedId || e.from === pinnedId || e.to === pinnedId;
        // An edge is hot when either endpoint carries a high-or-worse finding
        // under the active lens — the hot path reads before any label does.
        var endSev = worstSeverity(findingsFor([e.from, e.to], state.lens));
        var hot = (SEV_RANK[endSev] || 0) >= 3;
        var t = trimEdge(pos[e.from], pos[e.to]);
        svg.appendChild(edgeLine(t, edgeLabelFor(e), {
          faded: !!(pinnedId && !touches),
          lit: !!(pinnedId && touches),
          hot: hot,
          stroke: pinnedId && touches ? (hot ? SEV_EDGE[endSev] : C.accent)
            : (hot ? SEV_EDGE[endSev] : C.borderSoft),
          width: pinnedId && touches ? 2.6 : (hot ? 2 : 1.4),
        }));
      });

      boxes = nodes.map(function (n) {
        var fs = findingsFor([n.id], state.lens);
        var all = findingsFor([n.id], "all");
        var worst = worstSeverity(fs);
        var flags = [];
        if (n.publiclyReachable) flags.push("PUBLIC");
        if (n.shared) flags.push("SHARED");
        var nNew = countNew(all);
        var dim = !!(pinnedId && !lit[n.id]);
        var isNew = nNew > 0 && !dim;
        return boxGroup(pos[n.id].x, pos[n.id].y, boxW2, boxH2, {
          id: n.id, act: "select",
          title: n.name || n.id,
          sub: (n.kind || "node").toUpperCase() + (flags.length ? " · " + flags.join(" · ") : ""),
          // Nodes carry the word only at high or above — below that the
          // stripe, hatch and chips already say it without shouting.
          badgeText: (SEV_RANK[worst] || 0) >= 3
            ? SEV_MARK[worst] + " " + (worst === "critical" ? "crit" : worst) : null,
          severity: worst || null,
          chipIds: [n.id],
          isNew: isNew, pulse: isNew && !state.pulsed["n:" + n.id],
          dimmed: dim,
          selected: state.selected === n.id || n.id === pinnedId,
          pressed: n.id === pinnedId,
          aria: (n.name || n.id) + ", " + (n.kind || "node").toLowerCase() + ", " +
                LENS_LABEL[state.lens].toLowerCase() + " worst severity " + (worst || "none") +
                ", " + all.length + " findings" +
                (nNew ? ", " + nNew + " new since the last run" : "") +
                (n.id === pinnedId ? ". Pinned. Activate to unpin." : ". Activate to pin."),
        });
      });
      nodes.forEach(function (n) {
        if (countNew(findingsFor([n.id], "all")) > 0) state.pulsed["n:" + n.id] = true;
      });
    }

    boxes.forEach(function (b) { svg.appendChild(b); });
    return svg;
  }

  // ---------------------------------------------------------------------
  // Side panel — selection card, findings, resolved, recommendations
  // ---------------------------------------------------------------------

  function sevChip(severity) {
    var chip = el("span", { class: "chip chip-sev chip-sev-" + (severity || "low") });
    chip.appendChild(el("span", { class: "chip-mark", "aria-hidden": "true" }, SEV_MARK[severity] || "·"));
    chip.appendChild(el("span", { class: "chip-text" }, severity || "low"));
    return chip;
  }

  /** The current selection scope: which ids, what to call it, what it is. */
  function selectionScope() {
    var graph = state.result.graph;
    if (state.level === 2 && state.pinned) {
      var pn = (graph.nodes || []).find(function (n) { return n.id === state.pinned; });
      return {
        ids: [state.pinned], nodeId: state.pinned,
        kind: pn ? (pn.kind || "node").toUpperCase() : "NODE",
        name: (pn && pn.name) || state.pinned,
        summary: "Pinned. Its edges are highlighted and everything else is dimmed, so the blast radius of a change here is what you can see.",
      };
    }
    if (state.level === 1 && state.selected) {
      var sn = (graph.nodes || []).find(function (n) { return n.id === state.selected; });
      return {
        ids: [state.selected], nodeId: state.selected,
        kind: sn ? (sn.kind || "node").toUpperCase() : "NODE",
        name: (sn && sn.name) || state.selected,
        summary: "Selected. Activate it on the map to pin it and see what a change here touches.",
      };
    }
    if (state.level >= 1) {
      var ids = state.cluster === "__shared__"
        ? ungroupedNodes().map(function (n) { return n.id; })
        : clusterNodeIds(state.cluster);
      var cluster = (graph.clusters || []).find(function (c) { return c.id === state.cluster; });
      var nodeCount = state.cluster === "__shared__"
        ? ungroupedNodes().length
        : (cluster && cluster.nodes ? cluster.nodes.length : 0);
      var edgeCount = (graph.edges || []).filter(function (e) {
        return ids.indexOf(e.from) >= 0 && ids.indexOf(e.to) >= 0;
      }).length;
      return {
        ids: ids, nodeId: null, clusterId: state.cluster,
        kind: "CLUSTER",
        name: state.cluster === "__shared__" ? "Shared resources" : ((cluster && cluster.name) || state.cluster),
        summary: nodeCount + " nodes and " + edgeCount + " intra-cluster edges. Click a node to pin it.",
      };
    }
    var clusters = (graph.clusters || []).length;
    var nodesTotal = (graph.nodes || []).length;
    return {
      ids: null, nodeId: null, clusterId: null,
      kind: "ALL CLUSTERS",
      name: "Whole graph",
      summary: clusters + " clusters, " + nodesTotal + " nodes. Each cluster shows its worst finding per lens; click one to go inside.",
    };
  }

  /**
   * The selection card: what is selected, and its per-lens position at a
   * glance — the panel's answer to "what am I looking at" before any list.
   */
  function selectionCard(scope) {
    var card = el("div", { class: "xray-sel" });
    var head = el("div", { class: "xray-sel-head" });
    head.appendChild(el("span", { class: "mono xray-sel-kind" }, scope.kind));
    head.appendChild(el("span", { class: "mono xray-sel-lens" }, LENS_LABEL[state.lens] + (state.lens === "all" ? "" : " lens")));
    card.appendChild(head);
    card.appendChild(el("h3", { class: "xray-sel-name" }, scope.name));
    card.appendChild(el("p", { class: "xray-sel-summary" }, scope.summary));

    var chips = el("div", { class: "xray-sel-chips" });
    ["speed", "cost", "security"].forEach(function (ln) {
      var fs = scope.ids ? findingsFor(scope.ids, ln) : allFindings(ln);
      var worst = worstSeverity(fs);
      var chip = el("span", {
        class: "xray-lens-chip" + (ln === state.lens ? " xray-lens-chip-on" : ""),
      });
      chip.style.color = worst ? SEV_CHIPTEXT[worst] : C.dim;
      if (worst && SEV_BG[worst] !== "transparent") chip.style.background = SEV_BG[worst];
      if (ln !== state.lens && worst) chip.style.borderColor = SEV_BORDER[worst];
      chip.appendChild(el("span", { "aria-hidden": "true" }, worst ? SEV_MARK[worst] : "—"));
      chip.appendChild(el("span", null, LENS_LABEL[ln] + " " + fs.length));
      chips.appendChild(chip);
    });
    card.appendChild(chips);
    return card;
  }

  function findingCard(f) {
    var isNew = isNewFinding(f);
    var pulseKey = "f:" + findingKey(f);
    var li = el("li", {
      class: "xray-finding xray-sev-" + (f.severity || "low") +
        (isNew && !state.pulsed[pulseKey] ? " xray-new-card" : ""),
    });
    if (isNew) state.pulsed[pulseKey] = true;

    var top = el("div", { class: "xray-finding-top" });
    top.appendChild(sevChip(f.severity));
    if (isNew) {
      var newChip = el("span", { class: "chip chip-ok" });
      newChip.appendChild(el("span", { class: "chip-mark", "aria-hidden": "true" }, "+"));
      newChip.appendChild(el("span", { class: "chip-text" }, "New"));
      top.appendChild(newChip);
    }
    top.appendChild(el("span", { class: "xray-finding-title" }, ruleTitle(f)));
    li.appendChild(top);

    // Why and Fix as labelled rows — the design's structure, because a reader
    // scanning ten cards needs the two halves in the same place every time.
    if (f.why) {
      var whyRow = el("div", { class: "xray-row" });
      whyRow.appendChild(el("span", { class: "mono xray-row-label" }, "Why"));
      whyRow.appendChild(el("span", { class: "xray-finding-why" }, f.why));
      li.appendChild(whyRow);
    }
    if (f.fix) {
      var fixRow = el("div", { class: "xray-row" });
      fixRow.appendChild(el("span", { class: "mono xray-row-label" }, "Fix"));
      fixRow.appendChild(el("span", { class: "xray-finding-fix" }, f.fix));
      li.appendChild(fixRow);
    }
    var meta = el("div", { class: "xray-finding-meta" });
    if (f.evidence) meta.appendChild(el("span", { class: "mono xray-evidence" }, String(f.evidence)));
    meta.appendChild(el("span", { class: "mono xray-finding-rule" }, f.rule || ""));
    li.appendChild(meta);

    // "Generate fix" — sends THIS finding to /api/fix and renders the AI's
    // concrete change inline. A 503 means no AI provider is deployed and the
    // card says so plainly.
    var fixBtn = el("button", { class: "btn btn-ghost btn-sm xray-fix-btn", type: "button" }, "Generate fix");
    fixBtn.addEventListener("click", function () {
      setBusy(fixBtn, true, "Generating…");
      callApi("/api/fix", {
        kind: "arch",
        finding: {
          rule: f.rule, lens: f.lens, severity: f.severity, target: f.target,
          why: f.why, fix: f.fix, evidence: f.evidence,
        },
      }).then(function (res) {
        var box = el("div", { class: "fix-result" });
        if (res.fix && res.fix.text) box.appendChild(el("p", { class: "xray-finding-why" }, res.fix.text));
        if (res.fix && res.fix.code) box.appendChild(el("pre", { class: "result-snippet" }, res.fix.code));
        if (!res.fix || (!res.fix.text && !res.fix.code)) {
          box.appendChild(el("p", { class: "xray-finding-why" }, "The AI returned an empty fix. Try again."));
        }
        li.appendChild(box);
        fixBtn.remove();
      }).catch(function (err) {
        setBusy(fixBtn, false);
        li.appendChild(el("p", { class: "xray-finding-why" },
          err && err.code === "fix_generation_unavailable"
            ? "AI fix generation is not configured on this deployment."
            : "Fix generation failed: " + (err && err.message || "unknown error")));
      });
    });
    li.appendChild(fixBtn);
    return li;
  }

  function findingsPanel(scope) {
    var panel = el("div", { class: "xray-panel" });

    var findings = scope.ids ? findingsFor(scope.ids, state.lens) : allFindings(state.lens);
    // Worst first; new before existing within the same severity, because the
    // new one is the one the reader has not triaged yet.
    findings = findings.slice().sort(function (a, b) {
      var d = (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0);
      if (d !== 0) return d;
      var an = isNewFinding(a) ? 0 : 1, bn = isNewFinding(b) ? 0 : 1;
      return an - bn;
    });

    var head = el("div", { class: "report-section-head" });
    head.appendChild(el("h3", null, "Findings"));
    head.appendChild(el("span", { class: "mono report-section-note" },
      findings.length + " under " + LENS_LABEL[state.lens].toLowerCase() + " · worst first"));
    panel.appendChild(head);

    if (!findings.length) {
      // The positive empty state: nothing under THIS lens is information, and
      // the way out (other lenses may differ) is said rather than implied.
      var clean = el("div", { class: "xray-clean" });
      var strong = el("strong", null);
      strong.appendChild(el("span", { class: "mono xray-clean-mark", "aria-hidden": "true" }, "✓"));
      strong.appendChild(el("span", null, "Nothing found under this lens"));
      clean.appendChild(strong);
      clean.appendChild(el("p", null,
        "Findings only fire with evidence — a silent lens means no rule could cite a file and line. " +
        "This selection may still have findings under other lenses; the chips above say which."));
      panel.appendChild(clean);
    } else {
      var ul = el("ul", { class: "xray-finding-list" });
      findings.slice(0, 30).forEach(function (f) { ul.appendChild(findingCard(f)); });
      panel.appendChild(ul);
      if (findings.length > 30) {
        panel.appendChild(el("p", { class: "mono panel-input-help" },
          "Showing 30 of " + findings.length + " — narrow the selection or the lens for the rest."));
      }
    }

    // Resolved since last run: struck through, with what they were. Deleting
    // them silently would lose the only proof that last sprint's work landed.
    if (diffOn() && state.resolvedItems && state.resolvedItems.length) {
      var scoped = state.resolvedItems.filter(function (r) {
        if (state.lens !== "all" && r.lens !== state.lens) return false;
        if (!scope.ids) return true;
        return scope.ids.indexOf(r.target) >= 0;
      });
      if (scoped.length) {
        var box = el("div", { class: "xray-resolved" });
        var rhead = el("div", { class: "xray-finding-top" });
        rhead.appendChild(el("strong", { class: "xray-resolved-title" }, "Resolved since last run"));
        rhead.appendChild(el("span", { class: "mono report-section-note" },
          scoped.length + " no longer present"));
        box.appendChild(rhead);
        var rul = el("ul", { class: "xray-resolved-list" });
        scoped.forEach(function (r) {
          var rli = el("li", { class: "xray-resolved-item" });
          rli.appendChild(el("span", { class: "mono xray-resolved-mark", "aria-hidden": "true" }, "✓"));
          var body = el("span", { class: "xray-resolved-body" });
          body.appendChild(el("s", { class: "xray-resolved-was-title" }, r.title));
          body.appendChild(el("span", { class: "mono xray-resolved-was" },
            "was " + r.severity + (r.evidence ? " · " + r.evidence : "")));
          rli.appendChild(body);
          rul.appendChild(rli);
        });
        box.appendChild(rul);
        panel.appendChild(box);
      }
    }
    return panel;
  }

  function recCard(r) {
    var hasLegs = Array.isArray(r.legs) && r.legs.length > 0;
    var li = el("li", { class: "xray-rec" + (hasLegs ? " xray-rec-legs" : "") });

    li.appendChild(el("span", { class: "xray-rec-change" }, r.change || ""));

    var chips = el("div", { class: "xray-rec-chips" });
    var effort = el("span", { class: "chip xray-chip-effort" });
    effort.appendChild(el("span", { class: "chip-mark", "aria-hidden": "true" }, EFFORT_MARK[r.effort] || "?"));
    effort.appendChild(el("span", { class: "chip-text" }, "Effort " + (r.effort || "?")));
    chips.appendChild(effort);

    var impactKey = r.impact || "low";
    var st = IMPACT_STYLE[impactKey] || IMPACT_STYLE.low;
    var impact = el("span", { class: "chip xray-chip-impact" });
    impact.style.color = st.color;
    impact.style.borderColor = st.border;
    if (st.bg !== "transparent") impact.style.background = st.bg;
    impact.appendChild(el("span", { class: "chip-mark", "aria-hidden": "true" }, IMPACT_MARK[impactKey] || "·"));
    impact.appendChild(el("span", { class: "chip-text" }, impactKey + " impact"));
    chips.appendChild(impact);

    if (r.lens) chips.appendChild(el("span", { class: "chip chip-muted" }, LENS_LABEL[r.lens] || r.lens));
    if (r.occurrences > 1) chips.appendChild(el("span", { class: "chip chip-muted" }, "×" + r.occurrences));
    li.appendChild(chips);

    if (r.rationale) li.appendChild(el("p", { class: "xray-finding-why" }, r.rationale));

    // The three-leg evidence box for an extraction. Only rendered when the
    // analyzer actually produced all three, because "extract a microservice"
    // is the most expensive advice this tool can give and any one leg alone
    // is an argument for leaving things where they are.
    if (hasLegs) {
      var box = el("div", { class: "xray-legs-box" });
      box.appendChild(el("span", { class: "mono xray-legs-head" }, "Evidence · all three legs hold"));
      var legs = el("ul", { class: "xray-legs" });
      r.legs.forEach(function (leg, i) {
        var legLi = el("li", { class: "xray-leg" });
        legLi.appendChild(el("span", { class: "mono xray-leg-num", "aria-hidden": "true" }, String(i + 1)));
        var body = el("span", { class: "xray-leg-body" });
        body.appendChild(el("span", { class: "mono xray-leg-name" }, leg.leg || ""));
        body.appendChild(el("span", { class: "xray-leg-claim" }, leg.detail || leg.claim || ""));
        if (leg.evidence) body.appendChild(el("span", { class: "mono xray-evidence" }, String(leg.evidence)));
        legLi.appendChild(body);
        legs.appendChild(legLi);
      });
      box.appendChild(legs);
      li.appendChild(box);
    } else if (r.evidence) {
      li.appendChild(el("span", { class: "mono xray-evidence" }, String(r.evidence)));
    }
    return li;
  }

  /**
   * Recommendations scoped to the selection, widening honestly when the
   * selection has none: pinned node → its cluster → top three overall. The
   * note says which scope is showing, so a widened list never masquerades as
   * a scoped one.
   */
  function recommendationsPanel(scope) {
    var groups = state.result.recommendations || [];
    var flat = [];
    groups.forEach(function (g) {
      (g.recommendations || []).forEach(function (r) {
        flat.push(Object.assign({ cluster: g.cluster, clusterName: g.clusterName }, r));
      });
    });
    if (!flat.length) return null;

    var list, note;
    if (scope.nodeId) {
      list = flat.filter(function (r) { return r.target === scope.nodeId; });
      note = "for this node";
      if (!list.length) {
        list = flat.filter(function (r) { return r.cluster === state.cluster; });
        note = "none for this node — showing its cluster";
      }
    } else if (scope.clusterId) {
      list = flat.filter(function (r) { return r.cluster === scope.clusterId; });
      note = "for this cluster";
    } else {
      list = flat;
      note = null;
    }
    if (!list.length) { list = flat; note = "none for this selection — showing all"; }

    // Under a specific lens at the top level, the top three under that lens
    // is the design's cut: the cheapest high-impact change someone actually
    // does today, not a wall of everything.
    if (!scope.ids) {
      if (state.lens !== "all") {
        var lensed = list.filter(function (r) { return r.lens === state.lens; });
        if (lensed.length) { list = lensed; note = "top three under this lens"; }
      }
      list = list.slice(0, 3);
      if (!note) note = "top three · cheapest high-impact first";
    }

    var panel = el("div", { class: "xray-panel" });
    var head = el("div", { class: "report-section-head" });
    head.appendChild(el("h3", null, "Recommendations"));
    if (note) head.appendChild(el("span", { class: "mono report-section-note" }, note));
    panel.appendChild(head);

    var ul = el("ul", { class: "xray-rec-list" });
    list.forEach(function (r) { ul.appendChild(recCard(r)); });
    panel.appendChild(ul);
    return panel;
  }

  // ---------------------------------------------------------------------
  // Explorer shell
  // ---------------------------------------------------------------------

  function lensCounts() {
    var counts = { all: 0, speed: 0, cost: 0, security: 0 };
    (state.result.findings || []).forEach(function (f) {
      counts.all++;
      if (counts[f.lens] !== undefined) counts[f.lens]++;
    });
    return counts;
  }

  function controlsRow() {
    var bar = el("div", { class: "xray-controls" });

    var lensWrap = el("div", { class: "xray-lens-wrap" });
    lensWrap.appendChild(el("span", { class: "mono xray-controls-label" }, "Lens"));
    var lensGroup = el("div", { class: "seg-group", role: "radiogroup", "aria-label": "Analysis lens" });
    var counts = lensCounts();
    LENSES.forEach(function (lens) {
      var b = el("button", {
        type: "button", class: "seg-btn", role: "radio",
        "aria-checked": state.lens === lens ? "true" : "false",
      });
      b.appendChild(el("span", { class: "chip-mark", "aria-hidden": "true" },
        state.lens === lens ? "●" : "○"));
      b.appendChild(el("span", null, LENS_LABEL[lens]));
      // The count rides on the button so choosing a lens never requires
      // switching to it first to learn whether it is empty.
      b.appendChild(el("span", { class: "mono xray-lens-count" }, String(counts[lens] || 0)));
      b.addEventListener("click", function () { state.lens = lens; render(); });
      lensGroup.appendChild(b);
    });
    lensWrap.appendChild(lensGroup);
    bar.appendChild(lensWrap);

    var actions = el("div", { class: "xray-controls-actions" });

    // "Since last run" only exists when a comparison actually happened —
    // rendering a diff toggle with nothing behind it would promise a
    // comparison that was never made.
    if (state.newKeys !== null) {
      var diffBtn = el("button", {
        type: "button", class: "seg-btn", role: "switch",
        "aria-checked": state.diff ? "true" : "false",
      });
      diffBtn.appendChild(el("span", { class: "chip-mark", "aria-hidden": "true" }, state.diff ? "●" : "○"));
      diffBtn.appendChild(el("span", null, "Since last run"));
      if (state.diff) diffBtn.classList.add("xray-diff-on");
      diffBtn.addEventListener("click", function () { state.diff = !state.diff; render(); });
      actions.appendChild(diffBtn);
    }

    var exportBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Export PNG");
    exportBtn.addEventListener("click", function () { exportPng(exportBtn); });
    actions.appendChild(exportBtn);

    // The stored run behind this map has a full report page; the map is the
    // working view and the report is the artefact you hand over.
    if (state.runId) {
      actions.appendChild(el("a", {
        class: "btn btn-ghost btn-sm", href: "#/report/" + encodeURIComponent(state.runId),
      }, "Full report →"));
    }
    bar.appendChild(actions);
    return bar;
  }

  function crumbBar() {
    var barHead = el("div", { class: "xray-canvas-head" });
    var crumb = el("nav", { class: "xray-crumb", "aria-label": "Zoom breadcrumb" });

    function here(levelTag, label) {
      var s = el("span", { class: "seg-btn xray-crumb-here" });
      s.setAttribute("aria-current", "page");
      s.appendChild(el("span", { class: "mono xray-crumb-level", "aria-hidden": "true" }, levelTag));
      s.appendChild(el("span", null, label));
      return s;
    }
    function link(label, fn) {
      var b = el("button", { type: "button", class: "seg-btn" }, label);
      b.addEventListener("click", fn);
      return b;
    }
    function sep() { return el("span", { class: "mono xray-crumb-sep", "aria-hidden": "true" }, "/"); }

    if (state.level === 0) {
      crumb.appendChild(here("L0", "All clusters"));
    } else {
      crumb.appendChild(link("All clusters", function () { go(0, null); }));
      crumb.appendChild(sep());
      var cluster = (state.result.graph.clusters || []).find(function (c) { return c.id === state.cluster; });
      var clusterLabel = state.cluster === "__shared__"
        ? "Shared resources" : (cluster ? cluster.name : state.cluster);
      if (state.level === 2) {
        crumb.appendChild(link(clusterLabel, function () { go(1, state.cluster); }));
        crumb.appendChild(sep());
        var pinnedNode = (state.result.graph.nodes || []).find(function (n) { return n.id === state.pinned; });
        crumb.appendChild(here("L2", (pinnedNode && pinnedNode.name) || state.pinned));
      } else {
        crumb.appendChild(here("L1", clusterLabel));
      }
    }
    barHead.appendChild(crumb);

    barHead.appendChild(el("span", { class: "mono xray-hint" },
      state.level === 0 ? "Click a cluster · Tab then Enter · arrows move"
        : state.level === 2 ? "Pinned · Esc unpins · arrows move"
        : "Click a node to pin · Esc goes up"));
    return barHead;
  }

  /**
   * The legend: every severity with all three of its channels — the hatch
   * swatch, the glyph, and the word — so the encoding is taught where it is
   * used rather than in documentation nobody has open.
   */
  function legendRow() {
    var foot = el("div", { class: "xray-canvas-foot" });
    foot.appendChild(el("span", { class: "mono xray-controls-label" }, "Severity"));
    ["critical", "high", "medium", "low"].forEach(function (sev) {
      var item = el("span", { class: "xray-legend-item" });
      var swatch = el("span", { class: "xray-legend-swatch", "aria-hidden": "true" });
      swatch.style.borderColor = SEV_EDGE[sev];
      if (SEV_HATCH[sev]) {
        var pitch = SEV_HATCH[sev];
        var band = Math.max(1.2, pitch / 3);
        swatch.style.background = "repeating-linear-gradient(45deg," +
          SEV_EDGE[sev] + "44 0 " + band + "px, " + SEV_EDGE[sev] + "1a " + band + "px " + pitch + "px)";
      }
      item.appendChild(swatch);
      var mark = el("span", { class: "mono xray-legend-mark", "aria-hidden": "true" }, SEV_MARK[sev]);
      mark.style.color = SEV_EDGE[sev];
      item.appendChild(mark);
      item.appendChild(el("span", { class: "mono" }, sev));
      foot.appendChild(item);
    });
    return foot;
  }

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

    wrap.appendChild(controlsRow());

    var scope = selectionScope();

    // Two columns: the canvas card and the explanation beside it, so what is
    // selected and what it means are on screen at the same time.
    var layoutRow = el("div", { class: "xray-layout" });

    var canvasCard = el("div", { class: "xray-canvas-card" });
    canvasCard.appendChild(crumbBar());
    var canvasWrap = el("div", { class: "xray-canvas", id: "xray-canvas" });
    canvasWrap.appendChild(buildCanvas());
    canvasCard.appendChild(canvasWrap);
    canvasCard.appendChild(legendRow());
    layoutRow.appendChild(canvasCard);

    var side = el("aside", { class: "xray-side", "aria-label": "Selection detail" });
    side.appendChild(selectionCard(scope));

    // Diff summary line, only when a comparison actually happened.
    if (state.newKeys !== null) {
      var newCount = Object.keys(state.newKeys).length;
      var resolvedCount = (state.resolvedItems || []).length;
      side.appendChild(el("p", { class: "panel-input-help mono xray-diff-line" },
        state.diff
          ? (newCount || resolvedCount
              ? "Since last run: " + newCount + " new · " + resolvedCount + " resolved"
              : "No changes since the previous run.")
          : "Diff hidden — toggle Since last run to compare."));
    }

    side.appendChild(findingsPanel(scope));
    var drift = driftPanel();
    if (drift) side.appendChild(drift);
    var recs = recommendationsPanel(scope);
    if (recs) side.appendChild(recs);
    layoutRow.appendChild(side);

    wrap.appendChild(layoutRow);
    out.appendChild(wrap);
  }

  function go(level, cluster, selected) {
    state.level = level;
    state.cluster = cluster;
    state.selected = selected || null;
    // Leaving a level always drops the pin. A pin that survived a jump back to
    // the system map would silently dim a cluster the reader had not pinned.
    if (level < 2) state.pinned = null;
    render();
  }

  function onCanvasActivate(target) {
    var id = target.getAttribute("data-arch-id");
    var act = target.getAttribute("data-arch-act");
    if (act === "drill") { go(1, id); return; }
    if (act !== "select") return;

    // Pinning is a toggle: activating a pinned node unpins it — the same key
    // that got you in gets you out, so the interaction never traps.
    if (state.level === 2 && state.pinned === id) {
      state.level = 1;
      state.pinned = null;
      state.selected = id;
    } else {
      state.level = 2;
      state.pinned = id;
      state.selected = id;
    }
    render();
  }

  /**
   * Arrow keys move focus to the next sibling box at the same level — the
   * roving-focus half of the keyboard model. Movement only; Enter/Space is
   * still what activates, so an arrow press can never zoom or pin by
   * accident.
   */
  function moveFocus(current, delta) {
    var canvasWrap = document.getElementById("xray-canvas");
    if (!canvasWrap) return;
    var boxes = Array.prototype.slice.call(canvasWrap.querySelectorAll("[data-arch-id]"));
    var i = boxes.indexOf(current);
    if (i < 0 || !boxes.length) return;
    var next = boxes[(i + delta + boxes.length) % boxes.length];
    if (next && typeof next.focus === "function") next.focus();
  }

  // ---------------------------------------------------------------------
  // PNG export — canvas only, by design: the findings panel is text the user
  // can copy; rasterising it into the image helps nobody.
  // ---------------------------------------------------------------------

  function exportPng(btn) {
    var canvasWrap = document.getElementById("xray-canvas");
    var svg = canvasWrap && canvasWrap.querySelector("svg");
    if (!svg) return;
    setBusy(btn, true, "Exporting…");

    var clone = svg.cloneNode(true);
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

  function resetView() {
    state.level = 0; state.cluster = null; state.selected = null;
    state.pinned = null; state.lens = "all"; state.diff = true;
    state.pulsed = {};
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
        state.runId = (result && result.runId) || null;
        resetView();
        render();
        core.loadRuns();
        // Fired after render so the map appears immediately and the "new"
        // markers arrive when the comparison lands.
        loadDiff(result && result.runId);
        loadDrift();
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

    // Canvas interaction — delegated: click, Enter/Space, arrows, Esc.
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
      if (g && (event.key === "ArrowRight" || event.key === "ArrowDown")) {
        event.preventDefault();
        moveFocus(g, 1);
        return;
      }
      if (g && (event.key === "ArrowLeft" || event.key === "ArrowUp")) {
        event.preventDefault();
        moveFocus(g, -1);
        return;
      }
      if (event.key === "Escape" && state.result && state.level > 0) {
        var canvasWrap = document.getElementById("xray-canvas");
        if (canvasWrap && canvasWrap.contains(document.activeElement)) {
          event.preventDefault();
          // One level at a time, mirroring the breadcrumb: pinned → cluster →
          // system. Jumping straight to the top from level 2 would lose the
          // cluster the reader was working in.
          if (state.level === 2) { state.level = 1; state.pinned = null; render(); }
          else go(0, null);
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
          // The "View map" button is rendered for EVERY arch run, but a run
          // only carries a graph when the analyzer actually mapped something —
          // a sweep that skipped on no_manifests, or an older run stored
          // before the graph was kept, has none. Without the else below this
          // returned silently: the button said "Loading…", stopped, and
          // nothing happened, with no way to tell a broken button from a run
          // that has nothing to draw.
          if (run && run.result && run.result.graph) {
            state.result = run.result;
            state.runId = run.id || btn.dataset.runId || null;
            resetView();
            render();
            loadDiff(state.runId);
            loadDrift();
            var panel = document.getElementById("panel-arch");
            if (panel && typeof panel.scrollIntoView === "function") {
              panel.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          } else {
            var out = document.getElementById("output-arch");
            if (out) {
              while (out.firstChild) out.removeChild(out.firstChild);
              out.appendChild(core.errorState(
                "This run has no architecture map stored, so there is nothing to open. " +
                "A run records one only when the analyzer found manifests to map."));
              var p = document.getElementById("panel-arch");
              if (p && typeof p.scrollIntoView === "function") {
                p.scrollIntoView({ behavior: "smooth", block: "start" });
              }
            } else {
              window.alert("This run has no architecture map stored, so there is nothing to open.");
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

  // -----------------------------------------------------------------------
  // Monitored repositories — the nightly half of this page
  // -----------------------------------------------------------------------
  //
  // The manual bench above answers "what does this pile of files look like".
  // This answers "what does the repo you are already watching look like right
  // now", which is the question an alert email leaves you holding. Before
  // this, "3 new architecture findings" led to a page whose only option was
  // to re-upload your own codebase by hand.
  //
  // Opening one calls GET /api/monitors/:id/result/arch, which RE-RUNS the
  // X-ray over the repo's committed files. It is not the 03:00 snapshot: it
  // is the repo as it stands now, with the stored baseline used only to mark
  // which findings are the new ones. That endpoint never advances a baseline,
  // so looking does not consume the delta tomorrow's email will report.

  var watch = { loaded: false, monitors: [] };

  function archShortRepo(url) {
    return String(url || "").replace(/^https?:\/\/(www\.)?github\.com\//, "");
  }

  /** The Worker's finding-key rule (monitors/analyzers.js archFindingKey).
   *  Deliberately NOT this file's findingKey: the two use different
   *  separators and different fallbacks, and silently treating one as the
   *  other would mark the wrong findings as new. */
  function workerFindingKey(f) {
    if (!f || typeof f !== "object") return null;
    return [f.target || "unknown", f.lens || "unknown", f.rule || "unknown"].join("|");
  }

  function loadWatch(force) {
    if (watch.loaded && !force) return Promise.resolve();
    watch.loaded = true;
    return callApi("/api/monitors", null, "GET")
      .then(function (data) {
        watch.monitors = (data && data.monitors) || [];
        renderWatch();
      })
      .catch(function () {
        var body = document.getElementById("arch-watch-body");
        if (!body) return;
        while (body.firstChild) body.removeChild(body.firstChild);
        body.appendChild(core.errorState("Could not load your monitors."));
      });
  }

  function renderWatch() {
    var body = document.getElementById("arch-watch-body");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    var watching = watch.monitors.filter(function (m) {
      return (m.analyzers || []).indexOf("arch") !== -1;
    });

    if (!watching.length) {
      var off = el("div", { class: "night-off" });
      off.appendChild(el("p", null,
        "A repo monitor can re-draw this map every night and email you only when a new coupling appears. " +
        "Committed files only — no credentials, the same boundary as the bench above."));
      off.appendChild(el("a", { class: "btn btn-ghost btn-sm", href: "#/monitors" },
        "Enable on a repo monitor \u2192"));
      body.appendChild(off);
      return;
    }

    watching.forEach(function (m) {
      var row = el("div", { class: "night-row" });

      var top = el("div", { class: "night-row-top" });
      top.appendChild(el("strong", { class: "mono" }, archShortRepo(m.repoUrl)));

      // Null count means no sweep has recorded a baseline — rendered as
      // "first run pending", never as zero findings.
      if (m.paused) {
        top.appendChild(el("span", { class: "chip chip-muted" }, "paused"));
      } else if (m.archFindingCount === null || m.archFindingCount === undefined) {
        top.appendChild(el("span", { class: "chip chip-muted" }, "first run pending"));
      } else if (m.archFindingCount === 0) {
        top.appendChild(el("span", { class: "chip chip-ok" }, "\u2713 no findings"));
      } else {
        top.appendChild(el("span", { class: "chip chip-warn" },
          m.archFindingCount + " finding" + (m.archFindingCount === 1 ? "" : "s")));
      }
      row.appendChild(top);

      row.appendChild(el("p", { class: "night-meta mono" },
        (m.branch || "default branch") + " \u00b7 " +
        (m.lastRunAt ? "swept " + core.formatRelativeTime(m.lastRunAt * 1000)
                     : "not swept yet")));

      var actions = el("div", { class: "night-actions" });
      var open = el("button", { type: "button", class: "btn btn-primary btn-sm" }, "Draw the map \u2192");
      open.addEventListener("click", function () { openMonitored(m, open); });
      actions.appendChild(open);
      row.appendChild(actions);

      body.appendChild(row);
    });
  }

  function openMonitored(m, btn) {
    setBusy(btn, true, "Reading the repo\u2026");
    callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/result/arch", null, "GET")
      .then(function (payload) {
        var out = document.getElementById("output-arch");

        if (payload.status !== "ok") {
          // A repo we could not read is a real answer about the repo. Shown
          // with its reason rather than as an empty map, because an empty
          // graph and "no manifests found" look identical and mean opposite
          // things.
          if (out) {
            while (out.firstChild) out.removeChild(out.firstChild);
            out.appendChild(core.errorState(payload.message || "No result for this repository."));
          }
          return;
        }

        state.result = payload.result;
        state.runId = null;      // not a stored run — recomputed just now
        resetView();

        // Translate the Worker's keys into this file's, so the "New" markers
        // land on the right boxes. See workerFindingKey.
        var fresh = {};
        var newSet = {};
        (payload.delta && payload.delta.newKeys || []).forEach(function (k) { newSet[k] = true; });
        (state.result.findings || []).forEach(function (f) {
          if (newSet[workerFindingKey(f)]) fresh[findingKey(f)] = true;
        });
        // A baseline sweep has nothing to compare against, so it gets NO diff
        // affordance rather than one claiming every finding is new.
        state.newKeys = (payload.baseline && payload.baseline.isBaseline) ? null : fresh;
        state.resolvedItems = state.newKeys === null ? null : [];
        state.prevRunAt = (payload.baseline && payload.baseline.at)
          ? payload.baseline.at * 1000 : null;

        render();

        var panel = document.getElementById("panel-arch");
        if (panel && typeof panel.scrollIntoView === "function") {
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      })
      .catch(function (e) { window.alert(e.message || "Could not read that repository"); })
      .then(function () { setBusy(btn, false); });
  }

  window.DashArch = { load: loadWatch };
})();
