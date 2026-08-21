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
    loaded: false,
    schedule: "daily",
    limit: null,
    used: 0,
    // Secondary analyzers ticked in the new-monitor form. The dependency
    // audit is not in here because it is not a choice — the Worker forces
    // "vuln" into every set it stores.
    analyzers: { arch: false, estimate: false, algo: false },
  };

  // Order and labels for the secondary analyzers, everywhere they render.
  var SECONDARY_ANALYZERS = ["arch", "estimate", "algo"];
  var ANALYZER_LABEL = {
    arch: "Architecture X-ray",
    estimate: "Cost estimate",
    algo: "Algorithm optimizer",
  };
  var ANALYZER_SHORT = { arch: "x-ray", estimate: "cost", algo: "algo" };

  function shortRepo(url) {
    var m = REPO_RE.exec(url || "");
    return m ? m[1] + "/" + m[2] : url;
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
        limitNote.appendChild(textWrap);
        var up = el("a", { class: "btn btn-amber btn-sm", href: "/#pricing" }, "See plans →");
        limitNote.appendChild(up);
        limitNote.hidden = false;
      } else {
        limitNote.hidden = true;
      }
    }

    var wrap = document.getElementById("monitors-list");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var monitors = data.monitors || [];
    if (!monitors.length) {
      var empty = el("div", { class: "keys-empty" });
      empty.appendChild(el("span", { class: "panel-tag" }, "Watch"));
      empty.appendChild(el("h3", null, "No repositories under watch yet"));
      empty.appendChild(el("p", null,
        "A monitor re-scans a repo on a schedule and emails only what's new since the last run — " +
        "start with the repo whose dependencies you'd least like to discover in an incident."));
      wrap.appendChild(empty);
      return;
    }

    var ul = el("ul", { class: "monitor-list" });
    monitors.forEach(function (m) {
      var li = el("li", { class: "monitor-item" + (m.paused ? " monitor-item-paused" : "") });

      var info = el("div", { class: "monitor-info" });
      var top = el("div", { class: "monitor-top" });
      top.appendChild(el("strong", { class: "mono" }, shortRepo(m.repoUrl)));
      top.appendChild(el("span", { class: "mono monitor-branch" }, m.branch || "default branch"));
      var badge = statusBadge(m);
      if (badge) top.appendChild(badge);
      // What changed since the previous sweep, beside the standing total. The
      // two answer different questions — "how exposed is this repo" versus
      // "did anything move" — and the second is the one a daily reader is
      // actually scanning for.
      var delta = deltaBadges(m);
      if (delta) top.appendChild(delta);
      info.appendChild(top);

      var meta = el("div", { class: "monitor-meta mono" });
      meta.appendChild(el("span", null, (m.paused ? "Paused · " : "") +
        (m.schedule === "weekly" ? "Weekly" : "Daily") + " · 03:00 UTC"));
      meta.appendChild(el("span", null,
        m.lastRunAt ? "last ran " + core.formatRelativeTime(m.lastRunAt * 1000) : "first run pending"));
      info.appendChild(meta);
      var az = analyzerRow(m);
      if (az) info.appendChild(az);
      li.appendChild(info);

      var actions = el("div", { class: "monitor-actions" });
      var pauseBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm" },
        m.paused ? "Resume" : "Pause");
      pauseBtn.addEventListener("click", function () {
        setBusy(pauseBtn, true, "…");
        callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/pause", { paused: !m.paused })
          .then(function () { return load(true); })
          .catch(function (e) { window.alert(e.message || "Could not update the monitor"); })
          .then(function () { setBusy(pauseBtn, false); });
      });
      actions.appendChild(pauseBtn);

      var rmBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm btn-danger-ghost" }, "Remove");
      rmBtn.addEventListener("click", function () {
        if (!window.confirm("Stop monitoring " + shortRepo(m.repoUrl) +
          "? Pausing keeps the slot; removing frees it.")) return;
        setBusy(rmBtn, true, "Removing…");
        callApi("/api/monitors/" + encodeURIComponent(m.monitorId), null, "DELETE")
          .then(function () { return load(true); })
          .catch(function (e) { window.alert(e.message || "Could not remove the monitor"); })
          .then(function () { setBusy(rmBtn, false); });
      });
      actions.appendChild(rmBtn);
      li.appendChild(actions);
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
  }

  // What the last run saw: the standing total.
  function statusBadge(m) {
    if (m.paused) return el("span", { class: "chip chip-muted" }, "paused");
    if (m.knownAdvisoryCount === null || m.knownAdvisoryCount === undefined) {
      return el("span", { class: "chip chip-muted" }, "baseline pending");
    }
    if (m.knownAdvisoryCount === 0) {
      return el("span", { class: "chip chip-ok" }, "✓ clean");
    }
    return el("span", { class: "chip chip-warn" },
      m.knownAdvisoryCount + " known advisor" + (m.knownAdvisoryCount === 1 ? "y" : "ies"));
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
   *   total 0   swept, nothing new. Renders "no change", which is a real
   *             result and worth saying.
   *   total > 0 one chip per severity present, worst first.
   *
   * A baseline sweep is stored as zero by the Worker rather than as the size
   * of the whole list, so a first run reads "no change" rather than claiming
   * every advisory it discovered is new.
   */
  function deltaBadges(m) {
    var d = m.lastDelta;
    if (!d || typeof d.total !== "number") return null;

    var box = el("span", { class: "monitor-delta" });
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
    callApi("/api/monitors", { repoUrl: repoUrl, branch: branch, schedule: state.schedule, analyzers: formAnalyzers() })
      .then(function () {
        toggleForm(false);
        return load(true);
      })
      .catch(function (e) {
        // Field-level routing of the Worker's structured errors.
        if (e.code === "invalid_repo_url") {
          setFieldMsg("monitor-repo", "monitor-repo-msg", false, "▲ " + e.message);
        } else if (e.code === "invalid_branch") {
          setFieldMsg("monitor-branch", "monitor-branch-msg", false, "▲ " + e.message);
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

  function checkFirstRun() {
    var dot = document.getElementById("ci-status-dot");
    var text = document.getElementById("ci-status-text");
    return callApi("/api/runs?source=ci&limit=1", null, "GET").then(function (page) {
      var run = page && page.items && page.items[0];
      if (run) {
        // The waiting row flips in place — the facts that prove the wiring
        // worked: repo, commit, what the scan found, and a path to the report.
        if (dot) dot.className = "ci-status-dot ci-status-dot-ok";
        if (text) {
          while (text.firstChild) text.removeChild(text.firstChild);
          text.appendChild(document.createTextNode("Connected — last CI run "));
          text.appendChild(el("span", { class: "mono" },
            (run.repo || "pipeline") + (run.commitSha ? " @ " + String(run.commitSha).slice(0, 7) : "")));
          text.appendChild(document.createTextNode(" · " + (run.headline || "") + " · "));
          text.appendChild(el("a", { href: "#/report/" + encodeURIComponent(run.id) }, "view report"));
        }
      } else {
        if (dot) dot.className = "ci-status-dot ci-status-dot-wait";
        if (text) text.textContent =
          "Waiting for the first CI run — this flips as soon as a request authenticates with your key.";
      }
    }).catch(function () {
      if (text) text.textContent = "Could not check for CI runs.";
    });
  }

  // ---------------------------------------------------------------------

  function load(force) {
    if (state.loaded && !force) return Promise.resolve();
    var first = !state.loaded;
    state.loaded = true;
    var jobs = [
      callApi("/api/monitors", null, "GET").then(renderMonitors).catch(function (e) {
        var wrap = document.getElementById("monitors-list");
        if (wrap) {
          while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
          wrap.appendChild(core.errorState(e.message || "Could not load monitors"));
        }
      }),
      checkFirstRun(),
    ];
    if (first) jobs.push(loadSnippet(), loadOptimizerSnippet());
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

    var refresh = document.getElementById("ci-status-refresh");
    if (refresh) {
      refresh.addEventListener("click", function () {
        setBusy(refresh, true, "Checking…");
        checkFirstRun().then(function () { setBusy(refresh, false); });
      });
    }

    setSchedule("daily");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  window.DashMonitors = { load: load };
})();
