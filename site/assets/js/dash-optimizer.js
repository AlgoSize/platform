// Algorithm Optimizer page (D-6) — the automation half.
//
// The bench itself (paste → sandbox → grade) is driven by dashboard.js, which
// has owned #panel-algo since it was a workspace panel. This module owns what
// turns a one-off grade into standing enforcement:
//
//   - the WATCHLIST: a client-side builder for optimizer.config.json. The
//     committed file is the storage — this page only drafts it. The draft
//     persists in localStorage as a convenience, but the product never
//     stores it server-side: the repo's copy is the single source of truth
//     the CI gate and the nightly sweep actually read.
//   - the GATE card: GET /api/ci/optimizer-snippet for the real workflow +
//     GET /api/keys so step ① can honestly say "already done" when the org
//     has a key. States we cannot know (is the secret set on THEIR repo?
//     did a gate fire?) are not invented — the card shows setup, not a
//     fabricated feed.
//   - the NIGHTLY card: GET /api/monitors, filtered to monitors running the
//     "algo" analyzer. Null baselines render as "first run pending", never
//     as zero — the same null-vs-empty rule as everywhere else.
//
// Wired to dashboard.js through three small hooks (onBenchResult, lastBench,
// ceilingAbove) so the bench can offer "Watch this function" and "Measure
// the rewrite" without this module re-implementing the run flow.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  // Grade buckets, best to worst. Two spellings per polynomial bucket: the
  // analyzer emits superscripts ("O(n²)") while config ceilings are typed
  // with carets ("O(n^2)") — they MUST rank identically, mirroring
  // worker/src/monitors/analyzers.js bigORank.
  var BUCKETS = ["O(1)", "O(log n)", "O(n)", "O(n log n)", "O(n^2)", "O(n^3)"];
  var PRETTY = { "O(n^2)": "O(n²)", "O(n^3)": "O(n³)" };
  var RANKS = {
    "O(1)": 0, "O(log n)": 1, "O(n)": 2, "O(n log n)": 3,
    "O(n²)": 4, "O(n^2)": 4, "O(n³)": 5, "O(n^3)": 5,
  };
  var UNRANKED = 100;

  function rank(label) {
    if (label in RANKS) return RANKS[label];
    var m = typeof label === "string" ? label.match(/^O\(n\^([0-9.]+)\)$/) : null;
    if (m && parseFloat(m[1]) > 3) return Math.min(5 + (parseFloat(m[1]) - 3), UNRANKED - 1);
    return UNRANKED;
  }

  function pretty(label) { return PRETTY[label] || label; }

  /** The ceiling one bucket above a measured grade — the noise-safe default,
   *  so run-to-run timing jitter can't turn a green build red. */
  function ceilingAbove(grade) {
    var r = rank(grade);
    if (r >= UNRANKED) return "O(n log n)";   // unmeasurable: a sane middle default
    var i = Math.min(r + 1, BUCKETS.length - 1);
    // rank 4 maps back to the ASCII spelling humans type into JSON.
    return BUCKETS[i];
  }

  /** Top-level function name out of pasted source. A convenience for
   *  pre-filling — the row's field stays editable, so a miss costs nothing. */
  function parseFunctionName(code) {
    var m = /(?:^|\s)function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(code || "");
    return m ? m[1] : null;
  }

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  var STORAGE_KEY = "algosize.optimizer.watchlist";
  var NIGHTLY_CAP = 12;   // MAX_ALGO_ENTRIES in monitors/analyzers.js

  var state = {
    loaded: false,
    bench: null,          // { code, sampleInput, result } — last successful run
    entries: loadEntries(),
    snippet: null,        // /api/ci/optimizer-snippet response
    hasApiKey: null,      // null = unknown yet; boolean once /api/keys answers
    monitors: null,       // /api/monitors monitors array, or null before load
    deepLink: null,       // why a scorecard link could not be followed
  };

  function loadEntries() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed.filter(function (e) {
        return e && typeof e.functionName === "string" && typeof e.baseline === "string";
      }) : [];
    } catch (e) { return []; }
  }

  function saveEntries() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries)); }
    catch (e) { /* draft persistence is a convenience, never a requirement */ }
  }

  // -----------------------------------------------------------------------
  // Watchlist
  // -----------------------------------------------------------------------

  function configJson() {
    return JSON.stringify({
      entries: state.entries.map(function (e) {
        var out = { name: e.functionName, file: e.file || "", functionName: e.functionName, baseline: e.baseline };
        if (e.sampleInput !== undefined) out.sampleInput = e.sampleInput;
        return out;
      }),
    }, null, 2);
  }

  function renderWatchlist() {
    var wrap = document.getElementById("opt-watch-rows");
    var count = document.getElementById("opt-watch-count");
    var actions = document.getElementById("opt-watch-actions");
    var cap = document.getElementById("opt-watch-cap");
    var jsonPre = document.getElementById("opt-watch-json");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var entries = state.entries;
    if (jsonPre) jsonPre.textContent = configJson();
    if (actions) actions.hidden = entries.length === 0;

    if (count) {
      var over = entries.filter(function (e) { return e.measured && rank(e.measured) > rank(e.baseline); }).length;
      count.textContent = entries.length
        ? entries.length + (entries.length === 1 ? " entry" : " entries") +
          (over ? " · " + over + " over ceiling" : "") + " · optimizer.config.json"
        : "optimizer.config.json · fed by the bench, read by both automations";
    }

    if (cap) {
      if (entries.length > NIGHTLY_CAP) {
        while (cap.firstChild) cap.removeChild(cap.firstChild);
        var capText = el("div", { class: "banner-text" });
        capText.appendChild(el("p", null,
          "The nightly watch grades the first " + NIGHTLY_CAP + " entries. The rest stay in the file and " +
          "still gate every pull request — only the scheduled sweep stops at the cap."));
        cap.appendChild(capText);
        cap.hidden = false;
      } else {
        cap.hidden = true;
      }
    }

    if (!entries.length) {
      wrap.appendChild(el("div", { class: "panel-empty" },
        "Nothing watched yet — measure a function on the bench, then “Watch this function” " +
        "promotes it here with a ceiling one bucket above its grade."));
      return;
    }

    entries.forEach(function (entry, idx) {
      var row = el("div", { class: "watch-row" });

      var head = el("div", { class: "watch-row-top" });
      head.appendChild(el("strong", { class: "mono watch-fn" }, entry.functionName));

      var pills = el("span", { class: "watch-pills" });
      var ceil = el("select", { class: "panel-input watch-ceiling", "aria-label": "Complexity ceiling for " + entry.functionName });
      BUCKETS.forEach(function (b) {
        var opt = el("option", { value: b }, "under " + pretty(b));
        if (b === entry.baseline) opt.selected = true;
        ceil.appendChild(opt);
      });
      ceil.addEventListener("change", function () {
        entry.baseline = ceil.value;
        saveEntries();
        renderWatchlist();
      });
      pills.appendChild(ceil);

      if (entry.measured) {
        var overCeil = rank(entry.measured) > rank(entry.baseline);
        pills.appendChild(el("span",
          { class: "chip " + (overCeil ? "chip-danger" : "chip-ok") },
          (overCeil ? "↑ " : "✓ ") + pretty(entry.measured)));
      } else {
        pills.appendChild(el("span", { class: "chip chip-muted" }, "not yet measured"));
      }

      var rm = el("button", { type: "button", class: "btn btn-ghost btn-sm btn-danger-ghost" }, "Remove");
      rm.addEventListener("click", function () {
        state.entries.splice(idx, 1);
        saveEntries();
        renderWatchlist();
        renderGate();
      });
      pills.appendChild(rm);
      head.appendChild(pills);
      row.appendChild(head);

      var fileWrap = el("div", { class: "watch-file" });
      var file = el("input", {
        type: "text", class: "panel-input mono watch-file-input", spellcheck: "false",
        placeholder: "src/path/to/file.js", "aria-label": "Repo-root-relative file for " + entry.functionName,
      });
      file.value = entry.file || "";
      file.addEventListener("input", function () {
        entry.file = file.value.trim();
        saveEntries();
        if (jsonPre) jsonPre.textContent = configJson();
        msg.hidden = !!entry.file;
      });
      fileWrap.appendChild(file);
      var msg = el("p", { class: "field-msg field-msg-error" },
        "▲ File path is required — root-relative, so the gate can slice the function out of the PR's checkout.");
      msg.hidden = !!entry.file;
      fileWrap.appendChild(msg);
      row.appendChild(fileWrap);

      wrap.appendChild(row);
    });
  }

  function addFromBench() {
    var bench = state.bench;
    if (!bench || !bench.result) return;
    var name = parseFunctionName(bench.code);
    if (!name) return;
    var grade = (bench.result.bigO && bench.result.bigO.label) || "unknown";
    var existing = null;
    state.entries.forEach(function (e) { if (e.functionName === name) existing = e; });
    if (existing) {
      existing.measured = grade;
      if (bench.sampleInput !== undefined) existing.sampleInput = bench.sampleInput;
    } else {
      var entry = {
        functionName: name,
        file: "",
        baseline: ceilingAbove(grade),
        measured: grade,
      };
      if (bench.sampleInput !== undefined) entry.sampleInput = bench.sampleInput;
      state.entries.push(entry);
    }
    saveEntries();
    renderWatchlist();
    renderGate();
    var panel = document.getElementById("panel-watchlist");
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: "nearest" });
  }

  // -----------------------------------------------------------------------
  // The gate card — real setup, no invented feed
  // -----------------------------------------------------------------------

  function gateStep(glyph, glyphClass, title, bodyNodes) {
    var step = el("div", { class: "opt-step" });
    step.appendChild(el("span", { class: "opt-step-glyph mono " + glyphClass, "aria-hidden": "true" }, glyph));
    var body = el("div", { class: "opt-step-body" });
    body.appendChild(el("strong", null, title));
    bodyNodes.forEach(function (n) { body.appendChild(n); });
    step.appendChild(body);
    return step;
  }

  function renderGate() {
    var wrap = document.getElementById("opt-gate-body");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var s = state.snippet;
    if (!s) {
      wrap.appendChild(core.errorState("Could not load the gate setup."));
      return;
    }

    // ① the key. /api/keys tells us whether the ORG has a key; whether the
    // repo secret is set is their repo's business, and the workflow's
    // skip-with-notice behavior makes guessing unnecessary.
    if (state.hasApiKey) {
      var doneP = el("p", null, "The gate uses the same ");
      doneP.appendChild(el("code", { class: "mono" }, s.secretName || "ALGOSIZE_API_KEY"));
      doneP.appendChild(document.createTextNode(
        " repository secret as the dependency audit, and this organisation already has an API key. Zero new setup here."));
      wrap.appendChild(gateStep("✓", "opt-step-done", "① API key — already done", [doneP]));
    } else {
      var keyP = el("p", null, "Mint one on the ");
      keyP.appendChild(el("a", { href: "#/team" }, "Team screen"));
      keyP.appendChild(document.createTextNode(
        " and add it as the " + (s.secretName || "ALGOSIZE_API_KEY") +
        " repository secret — the same secret the dependency audit uses."));
      wrap.appendChild(gateStep("①", "", "Create an API key", [keyP]));
    }

    // ② the config — the watchlist card IS the file.
    var n = state.entries.length;
    wrap.appendChild(gateStep("②", "", "Commit the config", [
      el("p", null, n
        ? "The watchlist above is the file — " + n + (n === 1 ? " entry" : " entries") +
          " drafted. Copy or download it, commit as " + (s.configFilename || "optimizer.config.json") + " at the repo root."
        : "The watchlist above becomes " + (s.configFilename || "optimizer.config.json") +
          " — measure a function on the bench and watch it to start the file."),
    ]));

    // ③ the workflow — the real YAML, copyable.
    var fileRow = el("div", { class: "snippet-row" });
    var yamlPre = el("pre", { class: "result-snippet", id: "opt-gate-yaml" }, s.workflow || "");
    fileRow.appendChild(yamlPre);
    fileRow.appendChild(el("button", {
      type: "button", class: "btn btn-ghost btn-sm", "data-copy-target": "opt-gate-yaml",
    }, "Copy"));
    var savedAs = el("p", null, "Save as ");
    savedAs.appendChild(el("code", { class: "mono" }, s.filename || ".github/workflows/algosize-optimizer.yml"));
    savedAs.appendChild(document.createTextNode(
      ". A build goes red only when a measured grade exceeds an entry's ceiling; a missing file or function is a warning, never a failure."));
    wrap.appendChild(gateStep("③", "", "Commit the workflow", [savedAs, fileRow]));

    wrap.appendChild(el("p", { class: "opt-safety mono" },
      "Until the secret exists the workflow skips itself with a notice — your builds never go red from setup."));
  }

  // -----------------------------------------------------------------------
  // The nightly card — real monitors, null is never zero
  // -----------------------------------------------------------------------

  var REPO_RE = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/*$/i;
  function shortRepo(url) {
    var m = REPO_RE.exec(url || "");
    return m ? m[1] : url;
  }

  function renderNight() {
    var wrap = document.getElementById("opt-night-body");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    if (state.deepLink) wrap.appendChild(core.deepLinkNote(state.deepLink));

    if (state.monitors === null) {
      wrap.appendChild(core.errorState("Could not load monitors."));
      return;
    }

    var watching = state.monitors.filter(function (m) {
      return (m.analyzers || []).indexOf("algo") !== -1;
    });

    if (!watching.length) {
      var off = el("div", { class: "night-off" });
      off.appendChild(el("p", null,
        "The repo monitor re-grades the watched functions every night and emails only regressions — " +
        "a grade moving to a worse bucket, or to unknown. Improvements never trigger an email."));
      off.appendChild(el("a", { class: "btn btn-ghost btn-sm", href: "#/monitors" }, "Enable on a repo monitor →"));
      wrap.appendChild(off);
      return;
    }

    watching.forEach(function (m) {
      var row = el("div", { class: "night-row" });
      var top = el("div", { class: "night-row-top" });
      top.appendChild(el("strong", { class: "mono" }, shortRepo(m.repoUrl)));
      if (m.paused) {
        top.appendChild(el("span", { class: "chip chip-muted" }, "paused"));
      } else if (!m.lastAlgo) {
        // Null baseline: the sweep has not completed an optimizer pass yet.
        // Distinct from zero, which means "ran, and the repo has no config".
        top.appendChild(el("span", { class: "chip chip-muted" }, "first run pending"));
      } else if (!m.lastAlgo.functions) {
        top.appendChild(el("span", { class: "chip chip-warn" }, "no config in repo"));
      } else {
        top.appendChild(el("span", { class: "chip chip-ok" },
          "✓ " + m.lastAlgo.functions + " function" + (m.lastAlgo.functions === 1 ? "" : "s") + " graded"));
      }
      row.appendChild(top);

      var meta = el("p", { class: "night-meta mono" },
        m.paused ? "Paused — resumes where the baseline left off."
        : !m.lastAlgo ? "Grades record silently as the baseline; the first email is a regression, not a report."
        : !m.lastAlgo.functions ? "The sweep looked and found no optimizer.config.json — commit the watchlist file to start grading."
        : "baseline " + (typeof m.lastAlgo.at === "number" ? core.formatRelativeTime(m.lastAlgo.at * 1000) : "recorded") +
          " · regressions email, improvements never do");
      row.appendChild(meta);

      // Show the actual grades. Offered whenever the repo might have a
      // config — not when the last sweep proved it has none, where the only
      // possible outcome is "still no config".
      if (!m.lastAlgo || m.lastAlgo.functions) {
        var actions = el("div", { class: "night-actions" });
        var open = el("button", { type: "button", class: "btn btn-ghost btn-sm",
          "data-monitor": m.monitorId }, "Show the grades \u2192");
        var slot = el("div");
        open.addEventListener("click", function () { openMonitored(m, open, slot); });
        actions.appendChild(open);
        row.appendChild(actions);
        row.appendChild(slot);
      }

      wrap.appendChild(row);
    });
  }

  /**
   * Load one monitored repo's current grades in place.
   *
   * Rendered as a TABLE under its own row rather than through the bench
   * above, because they answer different questions: the bench measures one
   * function you pasted, a watchlist is N committed functions against the N
   * ceilings the repo asked for. Forcing the second into the first would
   * throw away the ceilings, which are the only thing that makes a grade a
   * verdict rather than a number.
   *
   * Re-measures from the repo's COMMITTED files via
   * GET /api/monitors/:id/result/algo, which never advances the baseline.
   */
  function openMonitored(m, btn, slot) {
    setBusy(btn, true, "Measuring\u2026");
    callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/result/algo", null, "GET")
      .then(function (payload) {
        while (slot.firstChild) slot.removeChild(slot.firstChild);

        if (payload.status !== "ok") {
          slot.appendChild(el("p", { class: "night-grade-skip" },
            payload.message || "No grades for this repository."));
          // When every entry failed, the API now says which one and why. A
          // reader told only "check the file and function names" has to guess
          // between a wrong path, a renamed function and a rejected one —
          // three different fixes. Naming the entry turns that into a task.
          var why = payload.skipped || [];
          if (why.length) {
            var list = el("ul", { class: "night-skip-list" });
            why.slice(0, 12).forEach(function (sk) {
              var li = el("li", {});
              li.appendChild(el("span", { class: "mono" }, (sk && sk.name) || "unnamed"));
              li.appendChild(document.createTextNode(" — " + ((sk && sk.reason) || "skipped")));
              list.appendChild(li);
            });
            slot.appendChild(list);
          }
          return;
        }

        var entries = (payload.result && payload.result.entries) || [];
        var skipped = (payload.result && payload.result.skipped) || [];

        if (!entries.length && !skipped.length) {
          slot.appendChild(el("p", { class: "night-grade-skip" },
            "The config lists no entries to measure."));
          return;
        }

        var table = el("div", { class: "night-grades" });
        entries.forEach(function (e) {
          // No ceiling means the repo asked for a measurement, not a gate —
          // so it can never be "over", and is not coloured as if it were.
          var over = e.ceiling && e.grade &&
            rank(e.grade) > rank(e.ceiling);
          var r = el("div", {
            class: "night-grade-row " + (!e.ceiling ? "" : over ? "night-grade-over" : "night-grade-ok"),
          });
          r.appendChild(el("span", { class: "night-grade-name mono" }, e.name));
          r.appendChild(el("span", { class: "night-grade-value mono" },
            e.grade ? pretty(e.grade) : "unmeasured"));
          r.appendChild(el("span", { class: "night-grade-ceiling mono" },
            e.ceiling ? "ceiling " + pretty(e.ceiling) : "no ceiling"));
          table.appendChild(r);
        });
        // Entries the sweep could not measure are listed, not dropped: a
        // watchlist that silently shrinks is one that stops covering things
        // without ever saying so.
        skipped.forEach(function (sk) {
          var r = el("div", { class: "night-grade-row" });
          r.appendChild(el("span", { class: "night-grade-name mono" }, sk.name || "unnamed"));
          r.appendChild(el("span", { class: "night-grade-skip" }, sk.reason || "skipped"));
          table.appendChild(r);
        });
        slot.appendChild(table);
      })
      .catch(function (e) { window.alert(e.message || "Could not measure that repository"); })
      .then(function () { setBusy(btn, false); });
  }

  // -----------------------------------------------------------------------
  // Load + hooks
  // -----------------------------------------------------------------------

  function load(force) {
    if (state.loaded && !force) return Promise.resolve();
    state.loaded = true;
    renderWatchlist();
    return Promise.all([
      callApi("/api/ci/optimizer-snippet", null, "GET").then(function (res) {
        state.snippet = res;
      }).catch(function () { state.snippet = null; }),
      callApi("/api/keys", null, "GET").then(function (res) {
        state.hasApiKey = !!(res && res.keys && res.keys.length);
      }).catch(function () { state.hasApiKey = null; }),
      callApi("/api/monitors", null, "GET").then(function (res) {
        state.monitors = (res && res.monitors) || [];
      }).catch(function () { state.monitors = null; }),
    ]).then(function () {
      renderGate();
      renderNight();
    });
  }

  function attach() {
    var copy = document.getElementById("opt-watch-copy");
    if (copy) copy.addEventListener("click", function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(configJson()).then(function () {
        copy.textContent = "Copied!";
        setTimeout(function () { copy.textContent = "Copy JSON"; }, 1200);
      }).catch(function () { /* clipboard may be denied */ });
    });
    var dl = document.getElementById("opt-watch-download");
    if (dl) dl.addEventListener("click", function () {
      var blob = new Blob([configJson()], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: "optimizer.config.json" });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  /**
   * Open one watched repository's grades, straight from a scorecard cell.
   *
   * This page renders the open button ONLY when the repo has gradeable
   * entries, so a valid link can land on a row with no button — "unopenable"
   * rather than a click that quietly does nothing.
   */
  function openMonitor(monitorId) {
    return load().then(function () {
      state.deepLink = core.findDeepLink(state.monitors, monitorId, "algo");
      renderNight();
      if (state.deepLink) return;
      if (!core.clickMonitorRow("opt-night-body", monitorId)) {
        state.deepLink = { reason: "unopenable", monitorId: monitorId };
        renderNight();
      }
    });
  }

  window.DashOptimizer = {
    load: load,
    openMonitor: openMonitor,
    // Called by dashboard.js after every successful bench run, BEFORE it
    // renders, so the verdict can offer the watch handoff.
    onBenchResult: function (bench) { state.bench = bench; },
    lastBench: function () { return state.bench; },
    addFromBench: addFromBench,
    ceilingAbove: ceilingAbove,
    prettyGrade: pretty,
    gradeRank: rank,
    parseFunctionName: parseFunctionName,
  };
})();
