// The cloud cost analyzer's monitored half.
//
// This was the last tool page without one. Its column on the Workspace
// scorecard could be graded from a nightly sweep and never opened, because
// the Worker had no way to re-read a monitored repository's spend — so the
// grid had one cell in six that was a dead end, and the scorecard's own
// comment said so rather than pretending otherwise.
//
// Opening one calls GET /api/monitors/:id/result/cost, which re-reads the
// Cost & Usage export the repository has committed — the path `cur` in
// algosize.budget.json names — and renders it through the SAME renderer the
// manual upload uses. A nightly figure and a hand-run figure must never come
// from two implementations that can disagree about what a saving is worth.
//
// ---------------------------------------------------------------------------
// The one page here that shows a standing result, not a diff
// ---------------------------------------------------------------------------
// Every other tool's monitored half marks what is NEW since the last sweep.
// This one has nothing to mark, on purpose: a bill differs every single day,
// so a diff would report Tuesday being different from Monday as a finding —
// noise dressed up as a result. runCostForMonitor stores no baseline for
// exactly that reason, and inspectCost returns `delta: null` rather than an
// empty delta that would read as "we compared and nothing changed".
//
// So this page says what the repository spent, and says nothing at all about
// movement. Alerting on spend wants a threshold, not a diff, and that is its
// own piece of work.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;

  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  var state = { loaded: false, monitors: [], deepLink: null };

  function shortRepo(url) {
    return String(url || "").replace(/^https?:\/\/(www\.)?github\.com\//, "");
  }

  function money(n) {
    if (typeof n !== "number" || !isFinite(n)) return null;
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function load(force) {
    if (state.loaded && !force) return Promise.resolve();
    state.loaded = true;
    return callApi("/api/monitors", null, "GET")
      .then(function (data) {
        state.monitors = (data && data.monitors) || [];
        render();
      })
      .catch(function () {
        var body = document.getElementById("cost-watch-body");
        if (!body) return;
        while (body.firstChild) body.removeChild(body.firstChild);
        body.appendChild(core.errorState("Could not load your monitors."));
      });
  }

  function render() {
    var body = document.getElementById("cost-watch-body");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    // A scorecard link asked for a repo this list does not have. Held in
    // state and re-emitted here rather than inserted after the fact, so it
    // survives the render that a later load triggers.
    if (state.deepLink) body.appendChild(core.deepLinkNote(state.deepLink));

    // Filtered, because cloud spend is opt-in per monitor. A repo watched
    // only for advisories has no spend to show and belongs in neither the
    // list nor a "nothing here" count.
    var watching = state.monitors.filter(function (m) {
      return (m.analyzers || []).indexOf("cost") !== -1;
    });

    if (!watching.length) {
      var off = el("div", { class: "night-off" });
      off.appendChild(el("p", null,
        "Switch cloud spend on for a monitor and it reads the Cost & Usage export that repository " +
        "has committed, every night. It never contacts a cloud account and accepts no credential — " +
        "a repo that has not named an export in algosize.budget.json is telling us not to read its " +
        "billing data, and that stays not measured rather than becoming a zero."));
      off.appendChild(el("a", { class: "btn btn-ghost btn-sm", href: "#/monitors" },
        "Watch a repository →"));
      body.appendChild(off);
      return;
    }

    watching.forEach(function (m) {
      body.appendChild(monitorRow(m));
    });
  }

  function monitorRow(m) {
    var row = el("div", { class: "night-row" });

    var top = el("div", { class: "night-row-top" });
    top.appendChild(el("strong", { class: "mono" }, shortRepo(m.repoUrl)));

    // null = no sweep has stored a figure. Rendered as pending, never as $0:
    // a cloud bill of zero and a bill nobody read are opposite claims, and
    // this column is the one where the difference costs real money.
    if (m.paused) {
      top.appendChild(el("span", { class: "chip chip-muted" }, "paused"));
    } else if (!m.lastCost || typeof m.lastCost.currentSpend !== "number") {
      top.appendChild(el("span", { class: "chip chip-muted" }, "first run pending"));
    } else {
      top.appendChild(el("span", { class: "chip chip-warn" },
        money(m.lastCost.currentSpend) + " / mo"));
      // The savings figure only when the sweep actually found some. A "0%
      // recoverable" chip on a bill nobody has looked at for savings reads
      // as a verdict rather than as an absence.
      if (typeof m.lastCost.totalSavingsPct === "number" && m.lastCost.totalSavingsPct > 0) {
        top.appendChild(el("span", { class: "chip chip-ok" },
          m.lastCost.totalSavingsPct + "% recoverable"));
      }
    }
    row.appendChild(top);

    row.appendChild(el("p", { class: "night-meta mono" },
      (m.branch || "default branch") + " · " +
      (m.lastCost && m.lastCost.at
        ? "read " + core.formatRelativeTime(m.lastCost.at * 1000)
        : m.lastRunAt ? "swept " + core.formatRelativeTime(m.lastRunAt * 1000)
                      : "not swept yet")));

    var actions = el("div", { class: "night-actions" });
    var open = el("button", { type: "button", class: "btn btn-primary btn-sm",
      // Tagged so a scorecard link can drive this exact button rather than
      // re-implementing what clicking it does.
      "data-monitor": m.monitorId }, "Read the bill →");
    open.addEventListener("click", function () { openMonitored(m, open); });
    actions.appendChild(open);
    row.appendChild(actions);

    return row;
  }

  /**
   * Re-read one watched repository's committed export and render it.
   *
   * Through core.renderCost — the manual upload's own renderer — so the two
   * paths cannot drift about what a top spender or a saving looks like.
   */
  function openMonitored(m, btn) {
    setBusy(btn, true, "Reading…");
    callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/result/cost", null, "GET")
      .then(function (payload) {
        if (payload.status !== "ok") {
          // Every non-ok reason is a sentence, not a code. "cur_missing" on
          // its own sends someone hunting for a file whose path only the
          // payload knows.
          window.alert(explain(payload));
          return;
        }
        core.renderCost(payload.result);
        var panel = document.getElementById("panel-cost");
        if (panel && typeof panel.scrollIntoView === "function") {
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      })
      .catch(function (e) { window.alert(e.message || "Could not read that repository's spend"); })
      .then(function () { setBusy(btn, false); });
  }

  function explain(payload) {
    var reason = payload && payload.reason;
    var detail = payload && payload.detail;
    if (reason === "analyzer_off") {
      return "Cloud spend is switched off for this monitor. Turn it on from Monitors & CI.";
    }
    if (reason === "no_cur") {
      return "This repository has not named a Cost & Usage export. Set `cur` in " +
             "algosize.budget.json to the path of a committed export, and the next read will price it.";
    }
    if (reason === "cur_missing") {
      return "algosize.budget.json names " + (detail || "an export") + ", but that file is not " +
             "committed on this branch.";
    }
    if (reason === "cur_too_large") {
      return "The committed export " + (detail || "") + " is too large to read in one request. " +
             "A month-scoped export is the usual fix.";
    }
    if (reason === "github_throttled") {
      return "GitHub rate-limited the request. Nothing is wrong with the repository — try again shortly.";
    }
    return "No spend could be read for this repository" + (reason ? " (" + reason + ")." : ".");
  }

  /**
   * Open one watched repository's spend, straight from a scorecard cell.
   *
   * Drives the row's own button rather than calling openMonitored directly,
   * so the busy state, the renderer and the scroll are the ones that already
   * work. The list is filtered to monitors running the cost analyzer, so a
   * repo can be watched and still have no row here — that is "filtered", and
   * it is a different sentence from "that monitor is gone".
   */
  function openMonitor(monitorId) {
    return load().then(function () {
      state.deepLink = core.findDeepLink(state.monitors, monitorId, "cost");
      render();
      if (state.deepLink) return;
      if (!core.clickMonitorRow("cost-watch-body", monitorId)) {
        state.deepLink = { reason: "unopenable", monitorId: monitorId };
        render();
      }
    });
  }

  window.DashCost = { load: load, openMonitor: openMonitor };
})();
