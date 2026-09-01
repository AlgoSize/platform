// Vulnerability scanner (#/scanner) — the nightly half.
//
// The bench in dashboard.js answers "what is in this lockfile I just gave
// you". This answers "what is in the repository you are already watching",
// which is the question an alert email leaves you holding — and before this
// the only way to answer it was to paste the repo URL into the manual form
// and burn a quota run re-doing what the sweep did at 03:00.
//
// Opening one calls GET /api/monitors/:id/result/vuln, which re-audits the
// repo's COMMITTED lockfiles and hands back the same payload the manual scan
// produces. It renders through core.renderVuln — the manual renderer — on
// purpose: a nightly advisory and a hand-scanned advisory are the same thing
// and must never be drawn by two implementations that can disagree about what
// a severity looks like.
//
// That endpoint never advances a baseline, so reading a result here does not
// consume the delta tomorrow's email is going to report.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  var state = { loaded: false, monitors: [], deepLink: null };

  function shortRepo(url) {
    return String(url || "").replace(/^https?:\/\/(www\.)?github\.com\//, "");
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
        var body = document.getElementById("vuln-watch-body");
        if (!body) return;
        while (body.firstChild) body.removeChild(body.firstChild);
        body.appendChild(core.errorState("Could not load your monitors."));
      });
  }

  function render() {
    var body = document.getElementById("vuln-watch-body");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    // A scorecard link asked for a repo this list does not have. Said out
    // loud, and from state rather than inserted after the fact: the note has
    // to survive the render that follows, which is the bug this shape avoids.
    if (state.deepLink) body.appendChild(core.deepLinkNote(state.deepLink));

    // Every monitor runs the dependency audit — it is what a monitor IS — so
    // there is no per-analyzer filter here, unlike the other tool pages.
    if (!state.monitors.length) {
      var off = el("div", { class: "night-off" });
      off.appendChild(el("p", null,
        "A repo monitor re-audits a repository's committed lockfiles every night and emails you only " +
        "what is new since the last run. Public repositories, no credentials."));
      off.appendChild(el("a", { class: "btn btn-ghost btn-sm", href: "#/monitors" },
        "Watch a repository →"));
      body.appendChild(off);
      return;
    }

    state.monitors.forEach(function (m) {
      var row = el("div", { class: "night-row" });

      var top = el("div", { class: "night-row-top" });
      top.appendChild(el("strong", { class: "mono" }, shortRepo(m.repoUrl)));

      // null count = no completed sweep. Rendered as pending, never as zero:
      // "we have not looked" must not read as "we looked and it was clean".
      if (m.paused) {
        top.appendChild(el("span", { class: "chip chip-muted" }, "paused"));
      } else if (m.knownAdvisoryCount === null || m.knownAdvisoryCount === undefined) {
        top.appendChild(el("span", { class: "chip chip-muted" }, "first run pending"));
      } else if (m.knownAdvisoryCount === 0) {
        top.appendChild(el("span", { class: "chip chip-ok" }, "✓ clean"));
      } else {
        top.appendChild(el("span", { class: "chip chip-warn" },
          m.knownAdvisoryCount + " known advisor" + (m.knownAdvisoryCount === 1 ? "y" : "ies")));
      }

      // What the last sweep found NEW. Absent entirely when the delta was
      // never measured — the same null-vs-zero rule as the count above.
      if (m.lastDelta && typeof m.lastDelta.total === "number" && m.lastDelta.total > 0) {
        top.appendChild(el("span", { class: "chip chip-danger" },
          "+" + m.lastDelta.total + " new last sweep"));
      }
      row.appendChild(top);

      row.appendChild(el("p", { class: "night-meta mono" },
        (m.branch || "default branch") + " · " +
        (m.lastRunAt ? "swept " + core.formatRelativeTime(m.lastRunAt * 1000)
                     : "not swept yet")));

      var actions = el("div", { class: "night-actions" });
      var open = el("button", { type: "button", class: "btn btn-primary btn-sm",
        // Tagged so a scorecard link can drive this exact button rather than
        // re-implementing what clicking it does.
        "data-monitor": m.monitorId }, "Show the advisories →");
      open.addEventListener("click", function () { openMonitored(m, open); });
      actions.appendChild(open);
      row.appendChild(actions);

      body.appendChild(row);
    });
  }

  function openMonitored(m, btn) {
    setBusy(btn, true, "Re-auditing…");
    callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/result/vuln", null, "GET")
      .then(function (payload) {
        if (payload.status !== "ok") {
          // A repo we could not read is an answer about the repo, not a
          // failure of the click — and an empty advisory list would read as
          // "clean", which is the one thing it must never say.
          var out = document.getElementById("output-vuln");
          if (out) {
            while (out.firstChild) out.removeChild(out.firstChild);
            out.appendChild(core.errorState(payload.message || "No result for this repository."));
          }
          return;
        }

        core.renderVuln(payload.result);

        var panel = document.getElementById("panel-vuln");
        if (panel && typeof panel.scrollIntoView === "function") {
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      })
      .catch(function (e) { window.alert(e.message || "Could not audit that repository"); })
      .then(function () { setBusy(btn, false); });
  }

  /**
   * Open one watched repository's audit, straight from a scorecard cell.
   *
   * Drives the row's own button rather than calling openMonitored directly,
   * so the busy state, the result slot and the scroll are the ones that
   * already work — a second path to the same result is a second thing to
   * keep in step.
   */
  function openMonitor(monitorId) {
    return load().then(function () {
      // No analyzer filter here: every monitor runs the dependency audit —
      // it is what a monitor IS — so this list is never filtered and a
      // watched repo always has a row.
      state.deepLink = core.findDeepLink(state.monitors, monitorId);
      render();
      if (state.deepLink) return;
      if (!core.clickMonitorRow("vuln-watch-body", monitorId)) {
        state.deepLink = { reason: "unopenable", monitorId: monitorId };
        render();
      }
    });
  }

  window.DashScanner = { load: load, openMonitor: openMonitor };
})();
