// Dashboard view router — hash-based, no framework.
//
//   #/               workspace (analyzers + runs feed)   — the default
//   #/monitors       monitors + CI setup (D-3)
//   #/team           organisation, members, keys, branding (D-2)
//   #/report/<id>    the report viewer for one run (D-4)
//
// Hash routing so deep links work, the back button works, and a "View
// report" link in the runs feed is just an <a>. Each view loads its data
// lazily on first entry — the workspace stays as fast as it was when it
// was the whole page.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;

  var VIEWS = ["workspace", "monitors", "team", "report"];

  function parseHash() {
    var h = window.location.hash || "";
    if (h.indexOf("#/report/") === 0) {
      return { view: "report", runId: decodeURIComponent(h.slice("#/report/".length)) };
    }
    if (h === "#/monitors") return { view: "monitors" };
    if (h === "#/team")     return { view: "team" };
    return { view: "workspace" };
  }

  function show(route) {
    VIEWS.forEach(function (v) {
      var elView = document.getElementById("view-" + v);
      if (elView) elView.hidden = v !== route.view;
    });
    document.querySelectorAll(".dash-tab").forEach(function (tab) {
      var current = tab.dataset.view === route.view ||
        (route.view === "report" && tab.dataset.view === "workspace");
      if (current) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });

    // Lazy loaders — each module exposes load() and is idempotent.
    if (route.view === "monitors" && window.DashMonitors) window.DashMonitors.load();
    if (route.view === "team"     && window.DashTeam)     window.DashTeam.load();
    if (route.view === "report"   && window.DashReport)   window.DashReport.open(route.runId);

    // A fresh view starts at the top — otherwise switching tabs keeps the
    // previous tab's scroll depth, which reads as a broken page.
    window.scrollTo(0, 0);
  }

  function onRoute() { show(parseHash()); }

  window.addEventListener("hashchange", onRoute);

  var backBtn = document.getElementById("report-back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", function () {
      // Prefer real history so back-from-report returns to the filter state
      // the user left; fall back to the workspace for direct deep links.
      if (window.history.length > 1) window.history.back();
      else window.location.hash = "#/";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onRoute);
  } else {
    onRoute();
  }
})();
