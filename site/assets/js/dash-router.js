// Dashboard view router — hash-based, no framework.
//
//   #/               workspace (scorecard, tools, runs feed)  — the default
//   #/scanner        the vulnerability scanner's own bench
//   #/cost           the cloud cost analyzer's own bench
//   #/arch           the architecture X-ray's own bench
//   #/optimizer      the algorithm optimizer (D-6)
//   #/estimate       the infrastructure cost estimator (D-7)
//   #/monitors       monitors + CI setup (D-3)
//   #/team           organisation, members, keys, branding (D-2)
//   #/report/<id>    the report viewer for one run (D-4)
//   #/account        settings — profile, billing, branding, referrals…
//   #/account/<sec>  …deep-linked straight to one of its sections
//
// The tab strip is down to two entries (D-8), but every route above still
// resolves: the tools that left the strip are reached from their card on the
// Workspace, and a bookmark saved before the change still lands where it
// always did.
//
// Hash routing so deep links work, the back button works, and a "View
// report" link in the runs feed is just an <a>. Each view loads its data
// lazily on first entry — the workspace stays as fast as it was when it
// was the whole page.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;

  var VIEWS = ["workspace", "scanner", "cost", "arch", "optimizer", "estimate",
               "monitors", "team", "report", "account", "mcp"];

  function parseHash() {
    var h = window.location.hash || "";
    if (h.indexOf("#/report/") === 0) {
      return { view: "report", runId: decodeURIComponent(h.slice("#/report/".length)) };
    }
    // #/arch/<runId> — the explorer opened on ONE run, which is what a CI
    // architecture comment links to. An arch run's artefact is the map, not
    // the report viewer, so it needs its own addressable route rather than
    // borrowing #/report/. Bare #/arch still opens the live explorer.
    if (h.indexOf("#/arch/") === 0) {
      return { view: "arch", runId: decodeURIComponent(h.slice("#/arch/".length)) };
    }
    // Account sub-routes. Every section is a real link, so someone can be
    // sent straight to Billing and the back button walks back through the
    // sections they opened rather than leaving the area entirely.
    if (h === "#/account" || h.indexOf("#/account/") === 0 || h.indexOf("#/account?") === 0) {
      var rest = h.slice("#/account".length).replace(/^\//, "");
      // The confirm-email redirect lands here with a query string; strip it
      // so "?email=changed" is never mistaken for a section name.
      var section = rest.split("?")[0];
      return { view: "account", section: section ? decodeURIComponent(section) : null };
    }
    if (h === "#/monitors")  return { view: "monitors" };
    if (h === "#/team")      return { view: "team" };
    if (h === "#/optimizer") return { view: "optimizer" };
    if (h === "#/estimate")  return { view: "estimate" };
    if (h === "#/scanner")   return { view: "scanner" };
    if (h === "#/cost")      return { view: "cost" };
    if (h === "#/arch")      return { view: "arch" };
    if (h === "#/mcp")       return { view: "mcp" };
    return { view: "workspace" };
  }

  function show(route) {
    VIEWS.forEach(function (v) {
      var elView = document.getElementById("view-" + v);
      if (elView) elView.hidden = v !== route.view;
    });
    // The Account link is in the topbar actions rather than the tab strip,
    // so it gets its own current-marking; without this, opening Account
    // leaves "Workspace" looking selected while showing something else.
    var acctLink = document.getElementById("account-link");
    if (acctLink) {
      if (route.view === "account") acctLink.setAttribute("aria-current", "page");
      else acctLink.removeAttribute("aria-current");
    }
    // Views that left the tab strip still belong to the Workspace as far as
    // the strip is concerned: a tool page reached from a Workspace card is
    // somewhere inside Workspace, and marking neither tab current there
    // would read as "you are nowhere".
    var UNDER_WORKSPACE = ["report", "scanner", "cost", "arch", "optimizer", "estimate", "mcp"];
    document.querySelectorAll(".dash-tab").forEach(function (tab) {
      var current = tab.dataset.view === route.view ||
        (UNDER_WORKSPACE.indexOf(route.view) !== -1 && tab.dataset.view === "workspace");
      if (current) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });

    // Lazy loaders — each module exposes load() and is idempotent.
    if (route.view === "monitors"  && window.DashMonitors)  window.DashMonitors.load();
    if (route.view === "team"      && window.DashTeam)      window.DashTeam.load();
    if (route.view === "report"    && window.DashReport)    window.DashReport.open(route.runId);
    if (route.view === "account"   && window.DashAccount)   window.DashAccount.open(route.section);
    if (route.view === "optimizer" && window.DashOptimizer) window.DashOptimizer.load();
    if (route.view === "estimate"  && window.DashEstimate)  window.DashEstimate.load();
    if (route.view === "workspace" && window.DashWorkspace) window.DashWorkspace.load();
    // The two tool pages whose nightly half arrived later (D-9). Both are
    // idempotent, so re-entering the view costs one cached call.
    if (route.view === "arch"      && window.DashArch) {
      if (route.runId) window.DashArch.openRun(route.runId);
      else window.DashArch.load();
    }
    if (route.view === "scanner"   && window.DashScanner)   window.DashScanner.load();
    if (route.view === "mcp"       && window.DashMcp)       window.DashMcp.load();

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
