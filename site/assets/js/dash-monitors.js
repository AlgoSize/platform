// Monitors & CI screen (D-3) — scheduled scans and the CI setup wizard.
//
// Wired to what exists on the Worker:
//   GET    /api/monitors            list + monitorLimit + monitorsUsed
//   POST   /api/monitors            402 monitor_limit_reached, 409 monitor_exists
//   DELETE /api/monitors/:id
//   POST   /api/monitors/:id/pause      explicit {paused} — a toggle races itself
//   POST   /api/monitors/:id/analyzers  explicit full set, same reason
//   GET    /api/ci/snippet              audit workflow YAML + filename
//   GET    /api/ci/optimizer-snippet    optimizer workflow + config example
//   GET    /api/runs?source=ci      "has the first CI run arrived?"
//
// Deliberately NOT here: a validate-before-create endpoint. The create
// endpoint already returns structured, field-level failures, so the form
// mirrors the Worker's own URL rule client-side for instant feedback and
// treats the real POST's error as the validation result.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  // Mirrors normaliseRepoUrl in worker/src/handlers/monitors.js.
  var REPO_RE = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i;

  var state = {
    // Stored CI runs, newest first. null = the read failed, which is a
    // different thing from an empty feed and renders differently.
    ciRuns: [],
    loaded: false,
    schedule: "daily",
    limit: null,
    used: 0,
    openMonitor: null,       // monitorId of the expanded row
    createdMonitor: null,    // briefly shown after create
    // Secondary analyzers ticked in the new-monitor form. The dependency
    // audit is not in here because it is not a choice — the Worker forces
    // "vuln" into every set it stores.
    analyzers: { arch: false, estimate: false, algo: false, cost: false },
  };

  // Order and labels for the secondary analyzers, everywhere they render.
  var SECONDARY_ANALYZERS = ["arch", "estimate", "algo", "cost"];
  var ANALYZER_LABEL = {
    arch: "Architecture X-ray",
    estimate: "Cost estimate",
    algo: "Algorithm optimizer",
    cost: "Cloud spend",
  };
  var ANALYZER_SHORT = { arch: "x-ray", estimate: "estimate", algo: "algo", cost: "spend" };

  /**
   * How a monitor's hour renders.
   *
   * A monitor with no stored hour runs in whatever sweep reaches it, which
   * today is the 03:00 UTC cron — so that is what it says, rather than the
   * vaguer "daily". A stored hour is shown in UTC with the viewer's local
   * equivalent beside it, because the whole reason to set one is landing the
   * alert at a particular time WHERE YOU ARE, and making someone do the
   * offset arithmetic is how they set the wrong hour.
   */
  function hourLabel(h) {
    if (h === null || h === undefined) return "03:00 UTC";
    var utc = pad2(h) + ":00 UTC";
    var local = localHourFor(h);
    return local === null ? utc : utc + " · " + pad2(local) + ":00 local";
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /** The local hour that matches an hour-of-day in UTC, today. */
  function localHourFor(utcHour) {
    var now = new Date();
    var d = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0));
    var h = d.getHours();
    return typeof h === "number" ? h : null;
  }

  function shortRepo(url) {
    var m = REPO_RE.exec(url || "");
    return m ? m[1] + "/" + m[2] : url;
  }

  function scheduleLabel(m) {
    var sched = (m.paused ? "paused" : (m.schedule === "weekly" ? "weekly" : "daily"));
    if (m.paused && m.lastRunAt) {
      return "paused · was " + (m.schedule === "weekly" ? "weekly" : "daily") + " · " + hourLabel(m.runAtHour);
    }
    if (m.runAtHour === null || m.runAtHour === undefined) {
      return sched + " · no hour set";
    }
    return sched + " · " + hourLabel(m.runAtHour);
  }

  var DELTA_ORDER = ["critical", "high", "medium", "low", "unknown"];

  /** Map a monitor row to the five health states the redesign renders. */
  function healthState(m) {
    if (m.paused) return { id: "paused", label: "paused", glyph: "\u23F8", tone: "muted" };
    if (m.lastStatus === "failed") return { id: "broken", label: "misconfigured", glyph: "\u00D7", tone: "bad" };
    if (m.lastStatus === "skipped") return { id: "stale", label: "stale", glyph: "\u25F7", tone: "warn" };
    if (!m.lastStatus && m.lastRunAt === null) return { id: "pending", label: "baseline pending", glyph: "\u25F7", tone: "accent" };
    return { id: "healthy", label: "healthy", glyph: "\u2713", tone: "ok" };
  }

  /** The headline + because lines beside the health pill. */
  function resultCopy(m) {
    var h = healthState(m);
    if (h.id === "broken") {
      return {
        result: m.lastError || "the sweep failed",
        because: "Retrying nightly will not fix this on its own.",
        cls: "mc-result-bad",
      };
    }
    if (h.id === "stale") {
      return {
        result: "last sweep skipped",
        because: (m.lastError ? m.lastError + ". " : "") + "Baselines were left untouched.",
        cls: "mc-result-warn",
      };
    }
    if (h.id === "pending") {
      return {
        result: "first sweep pending",
        because: "Nothing has been measured yet — there is no baseline to diff against.",
        cls: "mc-result-accent",
      };
    }
    if (h.id === "paused") {
      return {
        result: (m.knownAdvisoryCount === null ? "paused" : m.knownAdvisoryCount + " advisories as of pause"),
        because: "Paused, so nothing is swept and nothing is emailed. Still counts against the monitor limit.",
        cls: "mc-result-ok",
      };
    }
    var d = m.lastDelta;
    if (!d || typeof d.total !== "number") {
      return { result: "awaiting first result", because: "The first completed sweep will establish the baseline.", cls: "mc-result-accent" };
    }
    if (d.baseline) {
      return { result: "baseline recorded", because: "The first sweep listed what was already known.", cls: "mc-result-ok" };
    }
    if (d.total === 0) {
      var known = (m.knownAdvisoryCount === null ? "unknown" : m.knownAdvisoryCount + " advisories known");
      return { result: "clean · no change", because: known + ". Nothing new since the last sweep.", cls: "mc-result-ok" };
    }
    var parts = [];
    var counts = d.counts || {};
    DELTA_ORDER.forEach(function (sev) { if (counts[sev]) parts.push("+" + counts[sev] + " " + sev); });
    return {
      result: parts.length ? parts.join(", ") : ("+" + d.total + " new"),
      because: "The email names only what is new since the stored baseline.",
      cls: "mc-result-warn",
    };
  }

  function hoursUntilNextSweep() {
    var now = new Date();
    var next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0));
    if (now.getTime() >= next.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    var ms = next.getTime() - now.getTime();
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    return h + " h " + m + " m";
  }

  function countAlertsThisWeek(monitors) {
    var weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    var n = 0;
    (monitors || []).forEach(function (mon) {
      var d = mon.lastDelta;
      if (d && typeof d.total === "number" && d.total > 0 && !d.baseline &&
          typeof d.at === "number" && d.at >= weekAgo) n += d.total;
    });
    return n;
  }

  function toolLink(tool) {
    if (tool === "scanner") return "#/tools/vuln";
    if (tool === "arch") return "#/tools/arch";
    if (tool === "estimate") return "#/tools/estimate";
    if (tool === "optimizer") return "#/tools/optimizer";
    if (tool === "cost") return "#/tools/cost";
    return "#/workspace";
  }

  var BASELINE_TOOLS = [
    { id: "security", glyph: "!", label: "Known advisories", tool: "scanner", sub: "", accent: "#f3c4c4" },
    { id: "arch", glyph: "\u25AB", label: "Architecture findings", tool: "arch", sub: "", accent: "#a5b4fc" },
    { id: "estimate", glyph: "$\u2192", label: "Estimated · priced forward", tool: "estimate", sub: "what this config would cost, from list prices", accent: "#34d399" },
    { id: "cost", glyph: "$\u2190", label: "Actual · spent", tool: "cost", sub: "what the CUR says was billed", accent: "#fbbf24" },
    { id: "complex", glyph: "\u0192", label: "Grades vs ceilings", tool: "optimizer", sub: "", accent: "#5eead4" },
  ];

  function baselineCardItems(m, toolId) {
    var on = m.analyzers || [];
    if (toolId === "security") {
      if (m.knownAdvisoryCount === null || m.knownAdvisoryCount === undefined) {
        return [{ k: "not yet swept", v: "\u2014", cls: "" }];
      }
      return [
        { k: "packages watched", v: String(m.knownAdvisoryCount) + " known", cls: "" },
        { k: "source findings", v: m.lastSource ? String(m.lastSource.total) + " held" : "\u2014", cls: "" },
      ];
    }
    if (toolId === "arch") {
      if (on.indexOf("arch") === -1) return [{ k: "not enabled", v: "\u2014", cls: "" }];
      if (m.archFindingCount === null || m.archFindingCount === undefined) return [{ k: "not yet swept", v: "\u2014", cls: "" }];
      return [{ k: "findings held", v: String(m.archFindingCount), cls: "" }];
    }
    if (toolId === "estimate") {
      if (on.indexOf("estimate") === -1) return [{ k: "not enabled", v: "\u2014", cls: "" }];
      if (!m.lastEstimate) return [{ k: "not yet swept", v: "\u2014", cls: "" }];
      var by = m.lastEstimate.byProvider || {};
      var keys = Object.keys(by).filter(function (k) { return typeof by[k] === "number"; });
      if (!keys.length) return [{ k: "no compose file", v: "\u2014", cls: "" }];
      return keys.slice(0, 3).map(function (k) {
        return { k: k, v: microUsdText(by[k]) || "\u2014", cls: k === keys[0] ? "mc-result-ok" : "" };
      });
    }
    if (toolId === "cost") {
      if (on.indexOf("cost") === -1) return [{ k: "not enabled", v: "\u2014", cls: "" }];
      if (!m.lastCost) return [{ k: "not yet swept", v: "\u2014", cls: "" }];
      return [{ k: "recorded spend", v: "$" + Math.round(m.lastCost.currentSpend).toLocaleString() + "/mo", cls: "" }];
    }
    if (toolId === "complex") {
      if (on.indexOf("algo") === -1) return [{ k: "not enabled", v: "\u2014", cls: "" }];
      if (!m.lastAlgo) return [{ k: "not yet swept", v: "\u2014", cls: "" }];
      if (!m.lastAlgo.functions) return [{ k: "no optimizer.config.json", v: "\u2014", cls: "" }];
      return [{ k: "functions graded", v: String(m.lastAlgo.functions), cls: "mc-result-ok" }];
    }
    return [{ k: "not enabled", v: "\u2014", cls: "" }];
  }

  function renderBaselineGrid(m) {
    var grid = el("div", { class: "mc-baseline-grid" });
    BASELINE_TOOLS.forEach(function (t) {
      var card = el("div", { class: "mc-baseline-card" });
      var head = el("div", { class: "mc-baseline-card-head" });
      var glyph = el("span", { class: "mc-baseline-card-glyph mono", "aria-hidden": "true" }, t.glyph);
      glyph.style.color = t.accent;
      glyph.style.borderColor = t.accent + "59";
      glyph.style.background = t.accent + "14";
      head.appendChild(glyph);
      head.appendChild(el("span", { class: "mc-baseline-card-label mono" }, t.label));
      card.appendChild(head);
      if (t.sub) card.appendChild(el("span", { class: "mc-baseline-card-sub" }, t.sub));
      baselineCardItems(m, t.id).forEach(function (it) {
        var row = el("div", { class: "mc-baseline-card-row mono" });
        row.appendChild(el("span", { class: "mc-baseline-card-k" }, it.k));
        row.appendChild(el("span", { class: "mc-baseline-card-v " + (it.cls || "") }, it.v));
        card.appendChild(row);
      });
      var link = el("a", { class: "mc-baseline-card-link mono", href: toolLink(t.tool) }, "open " + t.tool + " \u2192");
      card.appendChild(link);
      grid.appendChild(card);
    });
    return grid;
  }

  function renderSweepTimeline(m) {
    var box = el("div", { class: "mc-timeline-box" });
    var head = el("div", { class: "mc-timeline-head" });
    head.appendChild(el("span", { class: "mc-timeline-label mono" }, "Sweep timeline \u00B7 last 14 nights"));
    head.appendChild(el("span", { class: "mc-timeline-proposed mono" }, "proposed"));
    box.appendChild(head);
    var strip = el("div", { class: "mc-timeline-strip" });
    for (var i = 0; i < 14; i++) {
      var cell = el("span", { class: "mc-timeline-cell mono", title: "Per-night history is not stored yet" }, "\u00B7");
      cell.style.color = "#3a414c";
      strip.appendChild(cell);
    }
    box.appendChild(strip);
    box.appendChild(el("p", { class: "mc-timeline-note" },
      "Costs one row per monitor per night — the product keeps only the current baseline today. " +
      "What it buys that the five cards above cannot: when a finding appeared and how many nights it survived."));
    box.appendChild(el("span", { class: "mc-timeline-legend mono" }, "\u00B7 clean   n new   \u25F7 skipped   \u00D7 failed"));
    return box;
  }

  function showCreatedBanner(m) {
    var banner = document.getElementById("monitor-created-banner");
    if (!banner) return;
    while (banner.firstChild) banner.removeChild(banner.firstChild);
    var text = el("div", { class: "mc-created-text" });
    var strong = el("strong");
    strong.appendChild(el("span", { class: "mono", "aria-hidden": "true", style: "color:var(--accent-2)" }, "\u2713"));
    strong.appendChild(document.createTextNode(" Watching " + shortRepo(m.repoUrl) + " \u00B7 " + (m.branch || "default branch")));
    text.appendChild(strong);
    text.appendChild(el("p", null,
      scheduleLabel(m) + " — or run it now to check the configuration works before you walk away."));
    banner.appendChild(text);
    var runBtn = el("button", { type: "button", class: "btn btn-primary" }, "Run now \u2192");
    runBtn.addEventListener("click", function () {
      state.openMonitor = m.monitorId;
      queueRun(m, runBtn);
    });
    banner.appendChild(runBtn);
    banner.hidden = false;
  }

  function queueRun(m, btn) {
    setBusy(btn, true, "Queuing\u2026");
    callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/run", {})
      .then(function () {
        setBusy(btn, false);
        btn.textContent = "Queued \u2713";
        btn.disabled = true;
      })
      .catch(function (e) {
        setBusy(btn, false);
        window.alert(e.message || "Could not queue the run");
      });
  }

  // ---------------------------------------------------------------------
  // Monitors list
  // ---------------------------------------------------------------------

  function renderMonitors(data) {
    state.limit = data.monitorLimit;
    state.used  = data.monitorsUsed;

    var meter = document.getElementById("monitor-meter");
    var text  = document.getElementById("monitor-meter-text");
    var fill  = document.getElementById("monitor-meter-fill");
    var atLimit = typeof data.monitorLimit === "number" && data.monitorsUsed >= data.monitorLimit;
    if (meter && text && fill && data.monitorsUsed > 0) {
      text.textContent = data.monitorsUsed + " of " + data.monitorLimit + " monitored repos";
      fill.style.width = Math.min(100, Math.round((data.monitorsUsed / Math.max(1, data.monitorLimit)) * 100)) + "%";
      fill.classList.toggle("usage-meter-fill-amber", atLimit);
      meter.hidden = false;
    } else if (meter) {
      meter.hidden = true;   // zero of twenty-five is a fact nobody needs
    }

    // At the limit the add path is removed, not disabled; existing monitors
    // keep running and the note says exactly that.
    var addBtn = document.getElementById("monitor-add-btn");
    if (addBtn) addBtn.hidden = atLimit;
    var limitNote = document.getElementById("monitor-limit-note");
    if (limitNote) {
      if (atLimit) {
        while (limitNote.firstChild) limitNote.removeChild(limitNote.firstChild);
        var textWrap = el("div", { class: "banner-text" });
        var strong = el("strong", null);
        strong.appendChild(el("span", { class: "banner-glyph", "aria-hidden": "true" }, "▲"));
        strong.appendChild(document.createTextNode(
          "You're monitoring " + data.monitorsUsed + " of " + data.monitorLimit + " repositories on this plan"));
        textWrap.appendChild(strong);
        textWrap.appendChild(el("p", null,
          "Existing schedules keep firing. To watch another repo, upgrade — or remove a monitor first."));
        // Only when it is actually the misreading in front of them. Pausing
        // is the obvious way to make room and it does not: countMonitors has
        // no `paused_at IS NULL` filter, so a paused monitor still holds its
        // slot. Someone at the limit with something paused will otherwise
        // pause another one, watch nothing change, and have no way to tell
        // whether the limit or the pause is what is broken.
        if ((data.monitors || []).some(function (m) { return m.paused; })) {
          textWrap.appendChild(el("p", { class: "banner-fine" },
            "Pausing stops the emails but keeps the slot \u2014 a paused monitor still counts " +
            "toward this limit. Remove one to make room."));
        }
        limitNote.appendChild(textWrap);
        var up = el("a", { class: "btn btn-amber btn-sm", href: "/#pricing" }, "See plans →");
        limitNote.appendChild(up);
        limitNote.hidden = false;
      } else {
        limitNote.hidden = true;
      }
    }

    var wrap = document.getElementById("monitors-list");
    var emptyCreate = document.getElementById("monitor-empty-create");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var monitors = data.monitors || [];
    var sectionHead = document.querySelector("#panel-monitors .mc-section-head");
    if (sectionHead) sectionHead.hidden = !monitors.length;

    if (!monitors.length) {
      wrap.hidden = true;
      if (emptyCreate) {
        emptyCreate.hidden = false;
        var host = document.getElementById("monitor-empty-form-host");
        var form = document.getElementById("monitor-form");
        if (host && form && !host.contains(form)) {
          host.appendChild(form);
          form.hidden = false;
          form.classList.add("mc-create-form");
        }
      }
      return;
    }

    wrap.hidden = false;
    if (emptyCreate) emptyCreate.hidden = true;
    var form = document.getElementById("monitor-form");
    var panel = document.getElementById("panel-monitors");
    if (form && panel && form.parentElement !== panel) {
      panel.appendChild(form);
      form.hidden = true;
    }

    groupByRepo(monitors).forEach(function (g) {
      wrap.appendChild(renderRepoCard(g));
    });

    if (state.createdMonitor) {
      var created = monitors.find(function (m) { return m.monitorId === state.createdMonitor; });
      if (created) showCreatedBanner(created);
      else {
        var banner = document.getElementById("monitor-created-banner");
        if (banner) banner.hidden = true;
      }
    }
  }

  function renderRepoCard(g) {
    var card = el("section", { class: "mc-repo-card" });
    var head = el("div", { class: "mc-repo-head" });
    head.appendChild(el("span", { class: "mc-repo-name mono" }, g.repo));
    head.appendChild(el("span", { class: "mc-repo-note mono" },
      g.monitors.length === 1 ? "1 branch" : g.monitors.length + " branches \u00B7 one service"));
    card.appendChild(head);
    g.monitors.forEach(function (m) { card.appendChild(monitorRow(m)); });
    return card;
  }

  function monitorRow(m) {
    var health = healthState(m);
    var copy = resultCopy(m);
    var open = state.openMonitor === m.monitorId;
    var row = el("div", { class: "mc-monitor-row" });

    var summary = el("div", { class: "mc-monitor-summary", "data-health": health.id });
    var branchBox = el("div", { class: "mc-monitor-branch mono" });
    branchBox.appendChild(el("strong", null, m.branch || "default branch"));
    branchBox.appendChild(el("span", { class: "mc-monitor-schedule" }, scheduleLabel(m)));
    if (m.runAtHour !== null && m.runAtHour !== undefined && localHourFor(m.runAtHour) !== null) {
      branchBox.appendChild(el("span", { class: "mc-monitor-local" },
        "(" + pad2(localHourFor(m.runAtHour)) + ":00 your time \u2014 converted in your browser)"));
    }
    summary.appendChild(branchBox);

    var pill = el("span", { class: "mc-health-pill mono", "data-tone": health.tone });
    pill.appendChild(el("span", { "aria-hidden": "true" }, health.glyph));
    pill.appendChild(document.createTextNode(" " + health.label));
    summary.appendChild(pill);

    var result = el("div", { class: "mc-monitor-result mono" });
    result.appendChild(el("strong", { class: copy.cls }, copy.result));
    result.appendChild(el("span", null, copy.because));
    summary.appendChild(result);

    var actions = el("div", { class: "mc-monitor-actions" });
    if (!m.paused) {
      var runBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Run now");
      runBtn.addEventListener("click", function () { queueRun(m, runBtn); });
      actions.appendChild(runBtn);
    }
    var toggleBtn = el("button", {
      type: "button", class: "btn btn-ghost btn-sm",
      "aria-expanded": open ? "true" : "false",
    }, (open ? "\u25BE Close" : "\u25B8 Details"));
    toggleBtn.addEventListener("click", function () {
      state.openMonitor = open ? null : m.monitorId;
      load(true);
    });
    actions.appendChild(toggleBtn);
    summary.appendChild(actions);
    row.appendChild(summary);

    if (open) {
      var detail = el("div", { class: "mc-monitor-detail", "data-health": health.id });
      var bar = el("div", { class: "mc-baseline-bar" });
      bar.appendChild(el("span", { class: "mc-baseline-bar-label mono" }, "Baseline the sweep diffs against"));
      bar.appendChild(el("span", { class: "mc-baseline-bar-rule", "aria-hidden": "true" }));
      bar.appendChild(el("span", { class: "mc-baseline-bar-note mono" }, "stored today \u00B7 no new tables needed to show it"));
      detail.appendChild(bar);
      detail.appendChild(renderBaselineGrid(m));
      detail.appendChild(renderSweepTimeline(m));
      detail.appendChild(analyzerRow(m));

      var detailActions = el("div", { class: "mc-detail-actions" });
      if (!m.paused) {
        var runNow = el("button", { type: "button", class: "btn btn-primary btn-sm" }, "Run now");
        runNow.addEventListener("click", function () { queueRun(m, runNow); });
        detailActions.appendChild(runNow);
      }
      var pauseBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm" },
        m.paused ? "Resume" : "Pause");
      pauseBtn.addEventListener("click", function () {
        setBusy(pauseBtn, true, "\u2026");
        callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/pause", { paused: !m.paused })
          .then(function () { return load(true); })
          .catch(function (e) { window.alert(e.message || "Could not update the monitor"); })
          .then(function () { setBusy(pauseBtn, false); });
      });
      detailActions.appendChild(pauseBtn);
      var rmBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm btn-danger-ghost" }, "Remove");
      rmBtn.addEventListener("click", function () {
        if (!window.confirm("Stop monitoring " + shortRepo(m.repoUrl) +
          "? Pausing keeps the slot; removing frees it.")) return;
        setBusy(rmBtn, true, "Removing\u2026");
        callApi("/api/monitors/" + encodeURIComponent(m.monitorId), null, "DELETE")
          .then(function () { return load(true); })
          .catch(function (e) { window.alert(e.message || "Could not remove the monitor"); })
          .then(function () { setBusy(rmBtn, false); });
      });
      detailActions.appendChild(rmBtn);
      detailActions.appendChild(el("span", { class: "mc-detail-footnote mono" },
        "Run now = one manual-trigger endpoint on the queue that already exists"));
      detail.appendChild(detailActions);
      row.appendChild(detail);
    }
    return row;
  }

  /**
   * Monitors bucketed by repository, each bucket's rows in a stable order.
   *
   * Keyed on the shortened owner/name rather than the raw URL so the same
   * repository written two ways still groups. Branch order is alphabetical
   * with the default branch first, because "main and a release branch" is the
   * common shape and main is the one people look for.
   */
  function groupByRepo(monitors) {
    var order = [];
    var byRepo = {};
    monitors.forEach(function (m) {
      var key = shortRepo(m.repoUrl);
      if (!byRepo[key]) { byRepo[key] = { repo: key, monitors: [] }; order.push(key); }
      byRepo[key].monitors.push(m);
    });
    return order.map(function (key) {
      var g = byRepo[key];
      g.monitors.sort(function (a, b) {
        if (!a.branch) return -1;
        if (!b.branch) return 1;
        return a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0;
      });
      return g;
    });
  }

  /**
   * The monitor's health, which is a different question from its findings.
   */
  function healthBadge(m) {
    if (m.paused) return el("span", { class: "chip chip-muted" }, "paused");
    if (m.lastStatus === "failed") {
      return el("span", { class: "chip chip-danger", title: m.lastError || "" }, "× misconfigured");
    }
    if (m.lastStatus === "skipped") {
      return el("span", { class: "chip chip-warn", title: m.lastError || "" }, "◷ stale");
    }
    if (!m.lastStatus && m.lastRunAt === null) {
      return el("span", { class: "chip chip-muted" }, "◷ baseline pending");
    }
    return null;
  }

  // What the last run saw: the standing total.
  function statusBadge(m) {
    if (m.paused) return null;   // the health badge already says paused
    if (m.knownAdvisoryCount === null || m.knownAdvisoryCount === undefined) {
      return m.lastStatus ? null : el("span", { class: "chip chip-muted" }, "baseline pending");
    }
    if (m.knownAdvisoryCount === 0) {
      return el("span", { class: "chip chip-ok" }, "✓ clean");
    }
    return el("span", { class: "chip chip-warn" },
      m.knownAdvisoryCount + " known advisor" + (m.knownAdvisoryCount === 1 ? "y" : "ies"));
  }

  /**
   * Why the row looks the way it does, in one sentence.
   *
   * Rendered under the badges because a state without a reason is a state
   * someone has to open a support ticket about. `lastError` is the code the
   * sweep stored; it is shown verbatim rather than mapped to friendlier
   * prose, so what the screen says and what the logs say are the same string.
   */
  function healthReason(m) {
    if (m.paused) return "Paused. The slot is still counted — remove the monitor to free it.";
    if (m.lastStatus === "failed") {
      return "The last sweep failed" + (m.lastError ? " (" + m.lastError + ")" : "") +
        ". Retrying nightly will not fix this on its own.";
    }
    if (m.lastStatus === "skipped") {
      return "The last sweep was skipped" + (m.lastError ? " (" + m.lastError + ")" : "") +
        ". Baselines were left untouched, so the next successful run still reports only what is new.";
    }
    return null;
  }

  var DELTA_ORDER = ["critical", "high", "medium", "low", "unknown"];
  var DELTA_CLASS = {
    critical: "chip-danger", high: "chip-warn", medium: "chip-warn",
    low: "chip-muted", unknown: "chip-muted",
  };

  /**
   * What the last sweep found NEW (lastDelta, from migrations/0009).
   *
   * Three states, and the difference between the first two is the whole point:
   *
   *   null      no sweep has completed since the column existed. Renders
   *             NOTHING — an unknown delta must never be shown as "no change",
   *             which would assert a clean bill of health nobody measured.
   *   baseline  the first sweep. Stored as zero by the Worker rather than as
   *             the size of the whole list, because nothing can be "new"
   *             against a set that did not exist yet. Says "baseline" — the
   *             zero it holds is a starting point, not a comparison, and
   *             "no change" would be a claim about a window one sweep wide.
   *   total 0   a later sweep found nothing new. Renders "no change", which
   *             is a real result and worth saying.
   *   total > 0 one chip per severity present, worst first.
   */
  function deltaBadges(m) {
    var d = m.lastDelta;
    if (!d || typeof d.total !== "number") return null;

    var box = el("span", { class: "monitor-delta" });
    if (d.baseline) {
      box.appendChild(el("span", { class: "chip chip-muted" }, "baseline"));
      return box;
    }
    if (d.total === 0) {
      box.appendChild(el("span", { class: "chip chip-muted" }, "no change"));
      return box;
    }

    var counts = d.counts || {};
    var shown = 0;
    DELTA_ORDER.forEach(function (sev) {
      var n = counts[sev];
      if (!n) return;
      shown += n;
      box.appendChild(el("span",
        { class: "chip " + (DELTA_CLASS[sev] || "chip-muted") },
        "+" + n + " " + sev));
    });

    // Counts can be absent or not add up if an older row was written before
    // the per-severity breakdown existed. Fall back to the total rather than
    // rendering an empty box that silently loses the finding.
    if (!shown) {
      box.appendChild(el("span", { class: "chip chip-warn" },
        "+" + d.total + " new"));
    }
    return box;
  }

  // ---------------------------------------------------------------------
  // Per-row analyzer chips — which secondary analyzers this monitor runs,
  // each with the one number its last sweep produced. Clicking a chip
  // toggles the analyzer; the whole desired set is POSTed explicitly for
  // the same reason the pause endpoint takes {paused}.
  // ---------------------------------------------------------------------

  function microUsdText(v) {
    if (typeof v !== "number" || !isFinite(v)) return null;
    return "$" + (v / 1e6).toFixed(2);
  }

  /**
   * One line of chip summary for an ENABLED analyzer. Null baselines mean
   * "never ran" and say so — the null-vs-zero rule from deltaBadges applies
   * to every analyzer, not just the audit.
   */
  function analyzerSummary(m, key) {
    if (key === "arch") {
      if (m.archFindingCount === null || m.archFindingCount === undefined) return "first run pending";
      if (m.archFindingCount === 0) return "no findings";
      return m.archFindingCount + " finding" + (m.archFindingCount === 1 ? "" : "s");
    }
    if (key === "estimate") {
      if (!m.lastEstimate) return "first run pending";
      var totals = [];
      var by = m.lastEstimate.byProvider || {};
      Object.keys(by).forEach(function (p) {
        if (typeof by[p] === "number") totals.push(by[p]);
      });
      // An empty recorded baseline means the sweep looked and found no
      // compose file to price — a fact, not a pending state.
      if (!totals.length) return "no compose file";
      var cheapest = microUsdText(Math.min.apply(null, totals));
      return cheapest ? "from " + cheapest + "/mo" : "estimated";
    }
    if (key === "algo") {
      if (!m.lastAlgo) return "first run pending";
      if (!m.lastAlgo.functions) return "no config";
      return m.lastAlgo.functions + " function" + (m.lastAlgo.functions === 1 ? "" : "s") + " graded";
    }
    if (key === "cost") {
      // No stored figure means no committed cost export has been read yet.
      // "no CUR named" would be a guess — the sweep records the reason
      // separately — so this says only what it knows.
      if (!m.lastCost) return "first run pending";
      return "$" + Math.round(m.lastCost.currentSpend).toLocaleString() + "/mo";
    }
    return null;
  }

  function toggleAnalyzer(m, key, chip) {
    var enabled = (m.analyzers || []).indexOf(key) !== -1;
    if (enabled && !window.confirm(
      "Switch off " + ANALYZER_LABEL[key] + " for " + shortRepo(m.repoUrl) +
      "? Its baseline is cleared — switching it back on starts fresh with a new baseline email.")) return;
    // The full desired set, rebuilt from scratch in canonical order.
    var next = ["vuln"];
    SECONDARY_ANALYZERS.forEach(function (k) {
      var has = (m.analyzers || []).indexOf(k) !== -1;
      if (k === key ? !enabled : has) next.push(k);
    });
    setBusy(chip, true, "…");
    callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/analyzers", { analyzers: next })
      .then(function () { return load(true); })
      .catch(function (e) { window.alert(e.message || "Could not update the monitor's analyzers"); })
      .then(function () { setBusy(chip, false); });
  }

  // ---------------------------------------------------------------------
  // The baseline: what tonight's sweep will compare against
  // ---------------------------------------------------------------------
  //
  // Every "+2 new" badge on this page is a subtraction, and until now the
  // page showed only the answer. What is being subtracted FROM is already
  // stored per monitor and already served: lastAdvisoryIds, lastSource,
  // lastArchKeys, lastEstimate, lastAlgo and lastCost all come down on
  // GET /api/monitors. No new table, no new endpoint — the numbers were
  // simply never rendered.
  //
  // Why it earns a panel: a delta is only worth trusting if its starting
  // point is visible. "No change" against a baseline recorded last night and
  // "no change" against one recorded three weeks ago, before two skipped
  // sweeps, are the same two words and very different facts.
  //
  // Collapsed by default. This is the answer to a question a reader asks
  // occasionally ("compared to WHAT?"), not one they scan every morning, and
  // six rows per monitor open on a page listing twenty of them would bury the
  // states that do need daily attention.

  /** A baseline the sweep never recorded. Never rendered as a zero — the
   *  distinction this whole panel exists to make. */
  function noBaseline(note) {
    return { value: null, note: note };
  }

  function severityTail(counts) {
    var order = ["critical", "high", "medium", "low", "info"];
    var parts = [];
    order.forEach(function (k) {
      var n = Number(counts && counts[k]);
      if (n > 0) parts.push(n + " " + k);
    });
    return parts.length ? parts.join(", ") : null;
  }

  /**
   * One row per thing the sweep holds, in the order the sweep computes them.
   *
   * `diffed` is the load-bearing field. Five of these are compared against on
   * every run (monitors/run.js builds diffAdvisories, sourceDiff, archDiff,
   * estDiff and algoDiff); cloud spend is recorded and compared against
   * nothing — there is no costDiff, deliberately, because a bill differs
   * every day and "Tuesday is not Monday" would be noise dressed as a
   * finding. Listing it silently beside five real baselines would imply a
   * comparison the product does not make.
   */
  function baselineRows(m) {
    var on = m.analyzers || [];
    var rows = [];

    // Dependencies and Code both come from the vuln analyzer, which every
    // monitor runs — it is what a monitor IS — so neither is gated on `on`.
    rows.push({
      glyph: "!", label: "Dependencies", tool: "scanner", diffed: true,
      body: (m.knownAdvisoryCount === null || m.knownAdvisoryCount === undefined)
        ? noBaseline("No completed sweep has recorded an advisory list yet.")
        : {
            value: m.knownAdvisoryCount + " advisor" +
                   (m.knownAdvisoryCount === 1 ? "y" : "ies") + " known",
            note: "Tomorrow's email names the advisories that are not in this set.",
          },
      at: m.lastDelta ? m.lastDelta.at : null,
    });

    rows.push({
      glyph: "\u2039\u203a", label: "Code", tool: "scanner", diffed: true,
      body: !m.lastSource
        ? noBaseline("No source scan has been stored for this monitor yet.")
        : {
            value: m.lastSource.total + " finding" + (m.lastSource.total === 1 ? "" : "s") + " held",
            note: severityTail(m.lastSource.counts),
          },
      at: m.lastSource ? m.lastSource.at : null,
    });

    if (on.indexOf("arch") !== -1) {
      rows.push({
        glyph: "\u25ab", label: "Architecture", tool: "arch", diffed: true,
        body: (m.archFindingCount === null || m.archFindingCount === undefined)
          ? noBaseline("No X-ray snapshot has been stored for this monitor yet.")
          : {
              value: m.archFindingCount + " finding" + (m.archFindingCount === 1 ? "" : "s") + " held",
              note: "A finding key that is not in this set is what makes the sweep call something new.",
            },
        at: null,
      });
    }

    if (on.indexOf("estimate") !== -1) {
      var est = m.lastEstimate;
      var by = (est && est.byProvider) || {};
      var totals = Object.keys(by).filter(function (k) { return typeof by[k] === "number"; });
      rows.push({
        glyph: "$\u2192", label: "Infra cost", tool: "estimate", diffed: true,
        body: !est
          ? noBaseline("No estimate has been stored for this monitor yet.")
          : !totals.length
            // A recorded-but-empty baseline is a real answer: the sweep looked
            // and the repository has no compose file to price.
            ? { value: "no compose file found", note: "There is nothing to price, so there is nothing to compare." }
            : {
                value: totals.length + " provider" + (totals.length === 1 ? "" : "s") + " priced",
                note: totals.map(function (k) {
                  return k + " " + (microUsdText(by[k]) || "—");
                }).join(" · "),
              },
        at: est ? est.at : null,
      });
    }

    if (on.indexOf("algo") !== -1) {
      rows.push({
        glyph: "\u0192", label: "Complexity", tool: "optimizer", diffed: true,
        body: !m.lastAlgo
          ? noBaseline("No optimizer sweep has been stored for this monitor yet.")
          : !m.lastAlgo.functions
            ? { value: "no optimizer.config.json", note: "The sweep looked and the repository has no watchlist to grade." }
            : {
                value: m.lastAlgo.functions + " grade" + (m.lastAlgo.functions === 1 ? "" : "s") + " held",
                note: "A grade that moves to a worse bucket is what emails you; an improvement never does.",
              },
        at: m.lastAlgo ? m.lastAlgo.at : null,
      });
    }

    if (on.indexOf("cost") !== -1) {
      rows.push({
        glyph: "$\u2190", label: "Cloud spend", tool: "cost", diffed: false,
        body: !m.lastCost
          ? noBaseline("No committed cost export has been read for this monitor yet.")
          : {
              value: "$" + Math.round(m.lastCost.currentSpend).toLocaleString() + " / mo recorded",
              note: null,
            },
        at: m.lastCost ? m.lastCost.at : null,
      });
    }

    return rows;
  }

  function baselinePanel(m) {
    var rows = baselineRows(m);
    if (!rows.length) return null;

    var box = el("details", { class: "monitor-baseline" });
    var sum = el("summary", { class: "monitor-baseline-summary" });
    sum.appendChild(el("span", null, "Baseline the sweep diffs against"));
    box.appendChild(sum);

    var list = el("div", { class: "monitor-baseline-rows" });
    rows.forEach(function (r) {
      var row = el("div", {
        class: "monitor-baseline-row" + (r.body.value === null ? " monitor-baseline-row-empty" : ""),
      });
      row.appendChild(el("span", { class: "monitor-baseline-glyph mono", "aria-hidden": "true" }, r.glyph));

      var mid = el("div", { class: "monitor-baseline-body" });
      var head = el("div", { class: "monitor-baseline-head" });
      head.appendChild(el("strong", null, r.label));
      head.appendChild(el("span", { class: "monitor-baseline-value mono" },
        // Null is a sentence, never a zero. "Nothing stored" and "stored, and
        // it was nothing" are the two readings this panel exists to separate.
        r.body.value === null ? "not recorded yet" : r.body.value));
      if (typeof r.at === "number") {
        head.appendChild(el("span", { class: "monitor-baseline-at mono" },
          "recorded " + core.formatRelativeTime(r.at * 1000)));
      }
      mid.appendChild(head);
      if (r.body.note) mid.appendChild(el("p", { class: "monitor-baseline-note" }, r.body.note));
      if (!r.diffed) {
        mid.appendChild(el("p", { class: "monitor-baseline-note monitor-baseline-nodiff" },
          "Recorded, not compared. A cloud bill differs every day, so a nightly diff would " +
          "report Tuesday being different from Monday as a finding. Spend wants a threshold, " +
          "not a delta \u2014 so nothing here is ever called new."));
      }
      row.appendChild(mid);
      list.appendChild(row);
    });
    box.appendChild(list);

    box.appendChild(el("p", { class: "monitor-baseline-foot" },
      "These are the stored comparison points, not a history \u2014 the product keeps the current " +
      "baseline for each analyzer and overwrites it on every successful sweep. A skipped night " +
      "leaves them untouched on purpose, so an upstream outage can never produce a morning where " +
      "everything reads as new."));

    return box;
  }

  function analyzerRow(m) {
    var box = el("div", { class: "monitor-analyzers" });
    SECONDARY_ANALYZERS.forEach(function (key) {
      var enabled = (m.analyzers || []).indexOf(key) !== -1;
      var chip;
      if (enabled) {
        var text = ANALYZER_SHORT[key];
        var summary = analyzerSummary(m, key);
        if (summary) text += " · " + summary;
        chip = el("button", {
          type: "button", class: "chip chip-toggle chip-toggle-on",
          title: ANALYZER_LABEL[key] + " runs on this monitor's schedule — click to switch it off",
        }, text);
      } else {
        chip = el("button", {
          type: "button", class: "chip chip-toggle",
          title: "Add " + ANALYZER_LABEL[key] + " to this monitor's scheduled sweep",
        }, "+ " + ANALYZER_SHORT[key]);
      }
      chip.addEventListener("click", function () { toggleAnalyzer(m, key, chip); });
      box.appendChild(chip);
    });
    return box;
  }

  // ---------------------------------------------------------------------
  // New-monitor form — client-side mirror of the Worker's rules, plus the
  // real POST's structured errors rendered field-level.
  // ---------------------------------------------------------------------

  function setFieldMsg(inputId, msgId, ok, text) {
    var input = document.getElementById(inputId);
    var msg = document.getElementById(msgId);
    if (input) input.setAttribute("aria-invalid", ok ? "false" : "true");
    if (msg) {
      msg.textContent = text || "";
      msg.classList.toggle("field-msg-error", !ok);
      msg.classList.toggle("field-msg-ok", ok && !!text);
      msg.hidden = !text;
    }
  }

  function validateRepoField() {
    var input = document.getElementById("monitor-repo");
    var v = input ? input.value.trim() : "";
    if (!v) { setFieldMsg("monitor-repo", "monitor-repo-msg", false, ""); return false; }
    if (!REPO_RE.test(v)) {
      setFieldMsg("monitor-repo", "monitor-repo-msg", false,
        "▲ Only github.com repos — the lockfile fetcher reads from raw.githubusercontent.com.");
      return false;
    }
    setFieldMsg("monitor-repo", "monitor-repo-msg", true, "✓ " + shortRepo(v));
    return true;
  }

  function setSchedule(s) {
    state.schedule = s;
    document.querySelectorAll("#monitor-form [data-schedule]").forEach(function (b) {
      var on = b.dataset.schedule === s;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.classList.toggle("choice-btn-selected", on);
    });
  }

  function setFormAnalyzer(key, on) {
    if (!(key in state.analyzers)) return;
    state.analyzers[key] = on;
    var b = document.querySelector("#monitor-form [data-analyzer=\"" + key + "\"]");
    if (b) {
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("analyzer-opt-on", on);
    }
  }

  // The full set the create POST sends: the audit always, then whichever
  // secondaries are ticked, in canonical order.
  function formAnalyzers() {
    var out = ["vuln"];
    SECONDARY_ANALYZERS.forEach(function (k) {
      if (state.analyzers[k]) out.push(k);
    });
    return out;
  }

  function submitMonitor(event) {
    event.preventDefault();
    if (!validateRepoField()) {
      var input = document.getElementById("monitor-repo");
      if (input) input.focus();
      return;
    }
    var submit = document.getElementById("monitor-submit");
    var formError = document.getElementById("monitor-form-error");
    if (formError) formError.hidden = true;
    var repoUrl = document.getElementById("monitor-repo").value.trim();
    var branchInput = document.getElementById("monitor-branch");
    var branch = branchInput && branchInput.value.trim() ? branchInput.value.trim() : undefined;

    setBusy(submit, true, "Creating…");
    callApi("/api/monitors", {
      repoUrl: repoUrl, branch: branch, schedule: state.schedule,
      analyzers: formAnalyzers(), runAtHour: formHour(),
    })
      .then(function (res) {
        toggleForm(false);
        state.createdMonitor = res && res.monitor && res.monitor.monitorId ? res.monitor.monitorId : null;
        return load(true);
      })
      .catch(function (e) {
        // Field-level routing of the Worker's structured errors.
        if (e.code === "invalid_repo_url") {
          setFieldMsg("monitor-repo", "monitor-repo-msg", false, "▲ " + e.message);
        } else if (e.code === "invalid_branch") {
          setFieldMsg("monitor-branch", "monitor-branch-msg", false, "▲ " + e.message);
        } else if (e.code === "invalid_hour") {
          var note = document.getElementById("monitor-hour-note");
          if (note) note.textContent = "▲ " + e.message;
        } else if (e.code === "monitor_exists") {
          setFieldMsg("monitor-repo", "monitor-repo-msg", false, "▲ " + e.message);
        } else if (formError) {
          formError.textContent = e.message || "Could not create the monitor.";
          formError.hidden = false;
        }
      })
      .then(function () { setBusy(submit, false); });
  }

  function toggleForm(show) {
    var form = document.getElementById("monitor-form");
    if (!form) return;
    form.hidden = !show;
    if (show) {
      var input = document.getElementById("monitor-repo");
      if (input) input.focus();
    } else {
      form.reset();
      setFieldMsg("monitor-repo", "monitor-repo-msg", true, "");
      setFieldMsg("monitor-branch", "monitor-branch-msg", true, "");
      SECONDARY_ANALYZERS.forEach(function (k) { setFormAnalyzer(k, false); });
      updateHourNote();
      var formError = document.getElementById("monitor-form-error");
      if (formError) formError.hidden = true;
    }
  }

  // ---------------------------------------------------------------------
  // CI setup wizard — snippet + first-run status
  // ---------------------------------------------------------------------

  function loadSnippet() {
    var yamlEl = document.getElementById("ci-snippet-yaml");
    var fileEl = document.getElementById("ci-snippet-filename");
    return callApi("/api/ci/snippet", null, "GET").then(function (res) {
      if (fileEl && res.filename) fileEl.textContent = res.filename;
      if (yamlEl) yamlEl.textContent = res.workflow || "";
    }).catch(function (e) {
      if (yamlEl) yamlEl.textContent = "Could not load the workflow: " + (e.message || "error");
    });
  }

  // Same shape as loadSnippet, for the optimizer panel — plus the config
  // example, which is the part users actually have to edit.
  function loadOptimizerSnippet() {
    var yamlEl = document.getElementById("ci-opt-yaml");
    var cfgEl  = document.getElementById("ci-opt-config");
    var fileEl = document.getElementById("ci-opt-filename");
    var cfgNameEl = document.getElementById("ci-opt-config-filename");
    return callApi("/api/ci/optimizer-snippet", null, "GET").then(function (res) {
      if (fileEl && res.filename) fileEl.textContent = res.filename;
      if (cfgNameEl && res.configFilename) cfgNameEl.textContent = res.configFilename;
      if (cfgEl) cfgEl.textContent = res.configExample || "";
      if (yamlEl) yamlEl.textContent = res.workflow || "";
    }).catch(function (e) {
      if (yamlEl) yamlEl.textContent = "Could not load the workflow: " + (e.message || "error");
      if (cfgEl) cfgEl.textContent = "Could not load the example.";
    });
  }

  /**
   * The two gates that had no UI.
   *
   * Same shape as the optimizer loader and deliberately not generalised into
   * one: each snippet endpoint returns a different set of fields, and a
   * shared loader driven by a config object would be longer than the three
   * copies and harder to read when one of them changes.
   */
  function loadEstimateSnippet() {
    var yamlEl = document.getElementById("ci-est-yaml");
    var cfgEl  = document.getElementById("ci-est-config");
    var fileEl = document.getElementById("ci-est-filename");
    var cfgNameEl = document.getElementById("ci-est-config-filename");
    return callApi("/api/ci/estimate-snippet", null, "GET").then(function (res) {
      if (fileEl && res.filename) fileEl.textContent = res.filename;
      if (cfgNameEl && res.configFilename) cfgNameEl.textContent = res.configFilename;
      if (cfgEl) cfgEl.textContent = res.configExample || "";
      if (yamlEl) yamlEl.textContent = res.workflow || "";
    }).catch(function (e) {
      if (yamlEl) yamlEl.textContent = "Could not load the workflow: " + (e.message || "error");
      if (cfgEl) cfgEl.textContent = "Could not load the example.";
    });
  }

  // The cost gate shipped with its handler, its generator and
  // /api/ci/cost-snippet all in place — and no loader, so the endpoint was
  // registered and unreachable, and the Cloud cost analyzer was the one tool
  // in the product with no CI half. Same shape as the estimator's, because it
  // reads the same algosize.budget.json.
  function loadCostSnippet() {
    var yamlEl = document.getElementById("ci-cost-yaml");
    var cfgEl  = document.getElementById("ci-cost-config");
    var fileEl = document.getElementById("ci-cost-filename");
    var cfgNameEl = document.getElementById("ci-cost-config-filename");
    return callApi("/api/ci/cost-snippet", null, "GET").then(function (res) {
      if (fileEl && res.filename) fileEl.textContent = res.filename;
      if (cfgNameEl && res.configFilename) cfgNameEl.textContent = res.configFilename;
      if (cfgEl) cfgEl.textContent = res.configExample || "";
      if (yamlEl) yamlEl.textContent = res.workflow || "";
    }).catch(function (e) {
      if (yamlEl) yamlEl.textContent = "Could not load the workflow: " + (e.message || "error");
      if (cfgEl) cfgEl.textContent = "Could not load the example.";
    });
  }

  function loadArchitectureSnippet() {
    var yamlEl = document.getElementById("ci-arch-yaml");
    var fileEl = document.getElementById("ci-arch-filename");
    return callApi("/api/ci/architecture-snippet", null, "GET").then(function (res) {
      if (fileEl && res.filename) fileEl.textContent = res.filename;
      if (yamlEl) yamlEl.textContent = res.workflow || "";
    }).catch(function (e) {
      if (yamlEl) yamlEl.textContent = "Could not load the workflow: " + (e.message || "error");
    });
  }

  // ---------------------------------------------------------------------
  // CI gates — what each one enforces, and what it last did
  // ---------------------------------------------------------------------
  //
  // Five gates shipped as five always-expanded setup wizards and nothing that
  // said which of them were live. The wizards are now behind their own
  // disclosure; this strip is what is worth reading without opening any.
  //
  // The "last result" line is read from stored runs. It is never asserted and
  // never inferred: whether the secret is set on somebody's repository is
  // their repository's business, and the only evidence we hold is a run that
  // arrived. Three gates leave that evidence — handlers/ci.js persists vuln,
  // arch and algo with source "ci". The estimate and cloud-spend workflows
  // post to /api/estimate and /api/analyze/cost with an API key instead,
  // which files a run with a NULL source, so a working gate of either kind
  // has nothing to show here. Those two say that, rather than borrowing the
  // "not set up" line, which would be a claim about the customer's repo we
  // have no standing to make.

  var GATES = [
    { id: "audit", analyzer: "vuln", name: "Dependency audit gate",
      panel: "panel-ci", file: ".github/workflows/algosize-audit.yml",
      gatesOn: "advisories and source findings at or above the workflow's fail_on",
      feeds: true },
    { id: "optimizer", analyzer: "algo", name: "Optimizer gate",
      panel: "panel-ci-optimizer", file: ".github/workflows/algosize-optimizer.yml",
      gatesOn: "the Big-O ceilings committed in optimizer.config.json",
      feeds: true },
    { id: "architecture", analyzer: "arch", name: "Architecture gate",
      panel: "panel-ci-architecture", file: ".github/workflows/algosize-architecture.yml",
      gatesOn: "new architecture findings against the base branch's snapshot",
      feeds: true },
    { id: "estimate", analyzer: null, name: "Cost estimate gate",
      panel: "panel-ci-estimate", file: ".github/workflows/algosize-estimate.yml",
      gatesOn: "the monthly ceiling in algosize.budget.json, when one is set",
      feeds: false },
    { id: "cost", analyzer: null, name: "Cloud cost gate",
      panel: "panel-ci-cost", file: ".github/workflows/algosize-cost.yml",
      gatesOn: "the committed Cost & Usage export against the same budget file",
      feeds: false },
  ];

  /** Newest stored CI run per analyzer, from one page of the feed. */
  function newestByAnalyzer(items) {
    var out = {};
    (items || []).forEach(function (r) {
      if (r && r.analyzer && !out[r.analyzer]) out[r.analyzer] = r;
    });
    return out;
  }

  function renderGates() {
    var wrap = document.getElementById("ci-gates-body");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var newest = newestByAnalyzer(state.ciRuns);

    GATES.forEach(function (g) {
      var run = g.analyzer ? newest[g.analyzer] : null;
      var configured = !!run || g.feeds;
      var tone = run && run.headline && /fail/i.test(run.headline) ? "bad" : (run ? "ok" : "none");
      var card = el("div", { class: "mc-gate-card-v2", "data-tone": tone === "bad" ? "bad" : "" });

      var head = el("div", { class: "mc-gate-card-head" });
      head.appendChild(el("h3", null, g.name));
      var pillTone = run ? (tone === "bad" ? "bad" : "ok") : "muted";
      var pillLabel = run ? (tone === "bad" ? "failing" : "passing") : "not set up";
      var pill = el("span", { class: "mc-health-pill mono", "data-tone": pillTone },
        (pillTone === "ok" ? "\u2713 " : pillTone === "bad" ? "\u25B2 " : "\u25CB ") + pillLabel);
      head.appendChild(pill);
      card.appendChild(head);

      var body = el("div", { class: "mc-gate-card-body" });
      if (run || g.feeds) {
        var fileRow = el("div", { class: "mc-gate-snippet-row" });
        fileRow.appendChild(el("code", { class: "mono" }, g.file));
        body.appendChild(fileRow);
        body.appendChild(el("p", { class: "gate-card-on" }, "Gates on " + g.gatesOn + "."));
      }
      if (run) {
        var lastBox = el("div", { class: "mc-gate-last-box", "data-tone": tone === "bad" ? "bad" : "ok" });
        lastBox.appendChild(el("strong", { class: "mono" }, run.headline || "no headline"));
        var meta = (run.repo || "pipeline") +
          (run.commitSha ? " \u00B7 " + String(run.commitSha).slice(0, 7) : "") +
          (typeof run.createdAt === "number" ? " \u00B7 " + core.formatRelativeTime(run.createdAt) : "");
        lastBox.appendChild(el("span", { class: "mono" }, meta));
        body.appendChild(lastBox);
      } else if (!g.feeds) {
        body.appendChild(el("p", { class: "gate-card-blind" }, g.gatesOn ?
          "Until the workflow lands nothing runs and nothing fails." :
          "Runs from this gate are stored without the CI tag."));
      } else {
        body.appendChild(el("p", { class: "gate-card-blind" },
          "Nothing has arrived from this gate yet."));
      }

      var jump = el("a", { class: "btn btn-ghost btn-sm", href: "#/monitors" },
        configured ? "Setup \u2193" : "Set up \u2192");
      jump.addEventListener("click", function (ev) {
        ev.preventDefault();
        var panel = document.getElementById(g.panel);
        if (!panel) return;
        var det = panel.querySelector("details.gate-setup");
        if (det) det.open = true;
        if (panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      body.appendChild(jump);
      card.appendChild(body);
      wrap.appendChild(card);
    });
  }

  // ---------------------------------------------------------------------
  // Recent CI runs
  // ---------------------------------------------------------------------
  //
  // Every row is a stored run, not a reconstruction of a workflow log. The
  // optimizer's rows carry the one piece of provenance in this feed that
  // changes what a number is worth: measuredBy "ci_runner" means the Big-O
  // grade was timed on the customer's runner rather than on ours, and two
  // runs on differently-sized runners can honestly disagree.

  var CI_TAG = { vuln: "audit", arch: "x-ray", algo: "optimizer",
                 estimate: "estimate", cost: "spend" };

  function renderCiRuns() {
    var wrap = document.getElementById("ci-runs-body");
    var countEl = document.getElementById("ci-runs-count");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var items = state.ciRuns;
    if (items === null) {
      if (countEl) countEl.textContent = "Could not read the CI feed";
      wrap.appendChild(core.errorState("Could not read the CI feed."));
      return;
    }
    if (countEl) {
      countEl.textContent = items.length
        ? items.length + " in the last fetch"
        : "No CI run has arrived yet";
    }
    if (!items.length) {
      wrap.appendChild(el("div", { class: "panel-empty" },
        "No CI run has arrived yet. The first one appears here as soon as a workflow " +
        "authenticates with your key."));
      return;
    }

    items.slice(0, 12).forEach(function (r) {
      var row = el("div", { class: "mc-ci-run-row" });
      var tag = el("span", { class: "mc-ci-run-tag mono" }, CI_TAG[r.analyzer] || r.analyzer || "run");
      row.appendChild(tag);
      row.appendChild(el("span", { class: "mc-ci-run-where mono" },
        (r.repo || "pipeline") + (r.commitSha ? " \u00B7 " + String(r.commitSha).slice(0, 7) : "")));
      var verdictCls = r.headline && /fail/i.test(r.headline) ? "mc-result-bad" : "mc-result-ok";
      row.appendChild(el("span", { class: "mc-ci-run-verdict mono " + verdictCls },
        r.headline || "no headline recorded"));
      if (r.measuredBy === "ci_runner") {
        row.appendChild(el("span", {
          class: "run-item-measured mono",
          title: "The grade was timed on your CI runner, not on Algosize infrastructure.",
        }, "measured in your runner"));
      }
      row.appendChild(el("span", { class: "mc-ci-run-when mono" },
        typeof r.createdAt === "number" ? core.formatRelativeTime(r.createdAt) : "\u2014"));
      wrap.appendChild(row);
    });

    wrap.appendChild(el("p", { class: "ci-run-foot" },
      "Every row is a stored run. Optimizer rows carry measuredBy: ci_runner when the Big-O " +
      "grade was timed on your CI machine, not ours."));
  }

  function loadCiRuns() {
    return callApi("/api/runs?source=ci&limit=25", null, "GET").then(function (page) {
      state.ciRuns = (page && page.items) || [];
    }).catch(function () {
      state.ciRuns = null;
    }).then(function () {
      renderGates();
      renderCiRuns();
    });
  }

  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Pulse strip — four facts about the automation itself
  // ---------------------------------------------------------------------
  //
  // Deliberately about the SWEEP, not about findings. The Workspace already
  // shows what the analyzers found; repeating it here would make two screens
  // that disagree the moment one of them is stale. What this page owns is
  // whether the machinery is running at all.

  function renderPulse(data) {
    var wrap = document.getElementById("monitors-pulse");
    if (!wrap) return;
    var monitors = (data && data.monitors) || [];
    if (!monitors.length) { wrap.hidden = true; return; }

    var repos = {};
    monitors.forEach(function (m) { repos[shortRepo(m.repoUrl)] = true; });
    var repoCount = Object.keys(repos).length;
    var active = monitors.filter(function (m) { return !m.paused; }).length;
    var lastRun = null;
    var completed = 0;
    var attempted = 0;
    monitors.forEach(function (m) {
      if (m.paused) return;
      attempted++;
      if (m.lastRunAt) {
        completed++;
        if (!lastRun || m.lastRunAt > lastRun) lastRun = m.lastRunAt;
      }
    });
    var alerts = countAlertsThisWeek(monitors);

    var items = [
      { label: "Repos under watch", value: String(repoCount),
        note: monitors.length + " monitors \u00B7 " + (data.monitorsUsed || monitors.length) +
              " of " + (data.monitorLimit || "\u2014") + " slots", tone: null },
      { label: "Next sweep", value: hoursUntilNextSweep(), note: "tonight 03:00 UTC", tone: "accent" },
      { label: "Last sweep", value: lastRun ? core.formatRelativeTime(lastRun * 1000) : "never",
        note: completed + " completed of " + attempted + " attempted", tone: null },
      { label: "Alerts this week", value: String(alerts),
        note: alerts ? "new findings emailed" : "nothing new reported", tone: null },
    ];

    wrap.textContent = "";
    items.forEach(function (it) {
      var box = el("div", { class: "ws-pulse-item" });
      box.appendChild(el("span", { class: "ws-pulse-label mono" }, it.label));
      var valCls = "ws-pulse-value mono" + (it.tone === "accent" ? " ws-pulse-ok" : "");
      box.appendChild(el("span", { class: valCls }, it.value));
      box.appendChild(el("span", { class: "ws-pulse-note" }, it.note));
      wrap.appendChild(box);
    });
    wrap.hidden = false;
  }

  // ---------------------------------------------------------------------
  // Where the next alert goes
  // ---------------------------------------------------------------------
  //
  // Served by GET /api/monitors/route, which is the SAME resolver the sweep
  // calls before it sends anything. That is the point of the card: this is
  // not a second rendering of the notification settings, it is the delivery
  // path's own answer, so a channel that reads as wired here is a channel
  // that will actually be posted to.

  function loadAlertRoute() {
    var body = document.getElementById("alert-route-body");
    if (!body) return Promise.resolve();
    return callApi("/api/monitors/route", null, "GET")
      .then(function (route) { renderAlertRoute(body, route); })
      .catch(function (e) {
        body.textContent = "";
        body.appendChild(core.errorState(
          e.message || "The delivery route could not be read."));
      });
  }

  function renderAlertRoute(body, route) {
    body.textContent = "";

    (route.channels || []).forEach(function (c) {
      var row = el("div", { class: "mc-route-card", "data-wired": c.wired ? "true" : "false" });

      var pill = el("span", { class: "mc-health-pill mono", "data-tone": c.wired ? "ok" : "muted" },
        c.wired ? "\u2713 delivering" : "\u25CB not delivering");
      row.appendChild(pill);

      var textWrap = el("div", { class: "mc-route-card-body" });
      textWrap.appendChild(el("strong", null, c.label));
      if (c.detail && c.detail.length) {
        textWrap.appendChild(el("span", { class: "mc-route-card-target mono" }, c.detail.join(", ")));
      }
      if (c.note) textWrap.appendChild(el("span", { class: "mc-route-card-note" }, c.note));
      row.appendChild(textWrap);

      if (!c.wired) {
        row.appendChild(el("a", { class: "btn btn-ghost btn-sm", href: "#/account/notifications" },
          c.id === "slack" ? "Add a webhook \u2192" : "Turn on in Account \u2192"));
      }
      body.appendChild(row);
    });

    if (route.muted) {
      var warn = el("p", { class: "route-summary route-summary-bad" }, route.summary);
      body.insertBefore(warn, body.firstChild);
    }
  }

  // ---------------------------------------------------------------------
  // Hour-of-day select
  // ---------------------------------------------------------------------

  /**
   * Fill the schedule-hour select with all 24 UTC hours, each labelled with
   * the local time it lands at.
   *
   * Built in JS rather than in the markup because the local half depends on
   * the viewer's timezone, and a hardcoded list would be wrong for everyone
   * outside whichever zone it was written in.
   */
  function fillHourSelect() {
    var sel = document.getElementById("monitor-hour");
    if (!sel || sel.dataset.filled === "true") return;
    for (var h = 0; h < 24; h++) {
      var local = localHourFor(h);
      sel.appendChild(el("option", { value: String(h) },
        pad2(h) + ":00 UTC" + (local === null ? "" : " · " + pad2(local) + ":00 your time")));
    }
    sel.dataset.filled = "true";
    sel.addEventListener("change", updateHourNote);
    updateHourNote();
  }

  function updateHourNote() {
    var sel  = document.getElementById("monitor-hour");
    var note = document.getElementById("monitor-hour-note");
    if (!sel || !note) return;
    note.textContent = sel.value === ""
      ? "Runs at 03:00 UTC, the hour every monitor has always used."
      // The stored setting is the UTC hour. The "your time" half of each
      // option is converted from this browser's clock and is not saved, so a
      // teammate in another timezone reads the same monitor differently.
      : "Held back until this hour, so the alert lands when you are there to read it. " +
        "The hour is stored in UTC; your local time is converted in this browser, not saved.";
  }

  function formHour() {
    var sel = document.getElementById("monitor-hour");
    if (!sel || sel.value === "") return undefined;
    var n = parseInt(sel.value, 10);
    return isNaN(n) ? undefined : n;
  }

  function load(force) {
    if (state.loaded && !force) return Promise.resolve();
    var first = !state.loaded;
    state.loaded = true;
    var jobs = [
      callApi("/api/monitors", null, "GET").then(function (data) {
        renderMonitors(data);
        renderPulse(data);
      }).catch(function (e) {
        var wrap = document.getElementById("monitors-list");
        if (wrap) {
          while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
          wrap.appendChild(core.errorState(e.message || "Could not load monitors"));
        }
      }),
      loadCiRuns(),
      loadAlertRoute(),
    ];
    if (first) jobs.push(loadSnippet(), loadOptimizerSnippet(),
                         loadEstimateSnippet(), loadArchitectureSnippet(),
                         loadCostSnippet());
    return Promise.all(jobs);
  }

  function attach() {
    var addBtn = document.getElementById("monitor-add-btn");
    if (addBtn) addBtn.addEventListener("click", function () { toggleForm(true); });
    var cancelBtn = document.getElementById("monitor-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", function () { toggleForm(false); });

    var form = document.getElementById("monitor-form");
    if (form) {
      form.addEventListener("submit", submitMonitor);
      form.addEventListener("click", function (event) {
        var b = event.target.closest && event.target.closest("[data-schedule]");
        if (b) { setSchedule(b.dataset.schedule); return; }
        var a = event.target.closest && event.target.closest("[data-analyzer]");
        if (a) setFormAnalyzer(a.dataset.analyzer, a.getAttribute("aria-pressed") !== "true");
      });
    }
    var repoInput = document.getElementById("monitor-repo");
    if (repoInput) repoInput.addEventListener("blur", validateRepoField);

    // The add button starts hidden in the markup and is revealed by the list
    // load (it stays hidden at the tier limit); default it visible so the
    // form is reachable even if the list request fails.
    if (addBtn) addBtn.hidden = false;

    setSchedule("daily");
    fillHourSelect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  window.DashMonitors = { load: load };
})();
