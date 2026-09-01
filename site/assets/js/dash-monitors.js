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
      var health = healthBadge(m);
      if (health) top.appendChild(health);
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
        (m.schedule === "weekly" ? "Weekly" : "Daily") + " · " + hourLabel(m.runAtHour)));
      meta.appendChild(el("span", null,
        m.lastRunAt ? "last ran " + core.formatRelativeTime(m.lastRunAt * 1000) : "first run pending"));
      info.appendChild(meta);
      var why = healthReason(m);
      if (why) info.appendChild(el("p", { class: "monitor-why" }, why));
      var az = analyzerRow(m);
      if (az) info.appendChild(az);
      li.appendChild(info);

      var actions = el("div", { class: "monitor-actions" });

      // Run now. Not offered on a paused monitor: running it would advance
      // the baseline, so resuming later would compare against a sweep the
      // owner had already decided not to take — and the first real run would
      // report nothing new when plenty had changed. The API refuses it too;
      // this just doesn't render a button whose only outcome is a 409.
      if (!m.paused) {
        var runBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Run now");
        runBtn.addEventListener("click", function () {
          setBusy(runBtn, true, "Queuing…");
          callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/run", {})
            .then(function () {
              // 202, not 200: the run is queued, not finished. Saying
              // "queued" rather than "done" is the difference between a
              // truthful control and one that lies for a nicer moment.
              setBusy(runBtn, false);
              runBtn.textContent = "Queued ✓";
              runBtn.disabled = true;
            })
            .catch(function (e) {
              setBusy(runBtn, false);
              window.alert(e.message || "Could not queue the run");
            });
        });
        actions.appendChild(runBtn);
      }

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

  /**
   * The monitor's health, which is a different question from its findings.
   *
   * Health comes first because a monitor that cannot run has no findings
   * worth reading. Before migrations/0017 there was nothing to read here:
   * a monitor whose repo has no supported lockfile failed every night,
   * recorded nothing, and rendered "baseline pending" forever — exactly what
   * a healthy monitor shows on its first day. Those two now differ.
   *
   *   failed   ran, and will keep failing until the configuration changes
   *   skipped  transient upstream failure; the baseline was deliberately
   *            left alone, so the next successful sweep still diffs honestly
   *   null     genuinely never attempted — the only honest "pending"
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

    var active = 0, unhealthy = 0, pending = 0, lastRun = null;
    monitors.forEach(function (m) {
      if (m.paused) return;
      active++;
      if (m.lastStatus === "failed" || m.lastStatus === "skipped") unhealthy++;
      if (!m.lastStatus && m.lastRunAt === null) pending++;
      if (m.lastRunAt && (!lastRun || m.lastRunAt > lastRun)) lastRun = m.lastRunAt;
    });

    var items = [
      { label: "Watching", value: String(active),
        note: monitors.length > active
          ? (monitors.length - active) + " paused"
          : (active === 1 ? "repository" : "repositories") },
      { label: "Healthy", value: String(Math.max(0, active - unhealthy - pending)),
        note: unhealthy ? unhealthy + " need attention" : "all sweeping cleanly",
        tone: unhealthy ? "bad" : "ok" },
      { label: "Awaiting first sweep", value: String(pending),
        note: pending ? "no baseline yet" : "every monitor has a baseline",
        tone: pending ? "warn" : null },
      { label: "Last sweep", value: lastRun ? core.formatRelativeTime(lastRun * 1000) : "never",
        note: lastRun ? "most recent result" : "nothing has run yet",
        tone: lastRun ? null : "warn" },
    ];

    wrap.textContent = "";
    items.forEach(function (it) {
      var box = el("div", { class: "ws-pulse-item" });
      box.appendChild(el("span", { class: "ws-pulse-label mono" }, it.label));
      box.appendChild(el("span", {
        class: "ws-pulse-value mono" + (it.tone ? " ws-pulse-" + it.tone : ""),
      }, it.value));
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

    // Said first and said plainly, because "nothing will be delivered" is
    // the one state on this page that someone has to act on today.
    var summary = el("p", {
      class: "route-summary" + (route.muted ? " route-summary-bad" : ""),
    }, route.summary);
    body.appendChild(summary);

    (route.channels || []).forEach(function (c) {
      var row = el("div", { class: "route-row route-row-" + (c.wired ? "on" : "off") });

      var pill = el("span", { class: "chip " + (c.wired ? "chip-ok" : "chip-muted") },
        c.wired ? "wired" : "not delivering");
      row.appendChild(pill);

      var textWrap = el("div", { class: "route-text" });
      textWrap.appendChild(el("strong", null, c.label));
      if (c.detail && c.detail.length) {
        textWrap.appendChild(el("span", { class: "route-target mono" }, c.detail.join(", ")));
      }
      if (c.note) textWrap.appendChild(el("span", { class: "route-note" }, c.note));
      row.appendChild(textWrap);

      // The fix lives on the Account screen for both channels — notification
      // preferences for email, the org's webhook for Slack — so an unwired
      // channel links there rather than explaining where to look.
      if (!c.wired) {
        row.appendChild(el("a", { class: "btn btn-ghost btn-sm", href: "#/account/notifications" },
          c.id === "slack" ? "Set up Slack →" : "Notification settings →"));
      }
      body.appendChild(row);
    });
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
      : "Held back until this hour, so the alert lands when you are there to read it.";
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
      checkFirstRun(),
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

    var refresh = document.getElementById("ci-status-refresh");
    if (refresh) {
      refresh.addEventListener("click", function () {
        setBusy(refresh, true, "Checking…");
        checkFirstRun().then(function () { setBusy(refresh, false); });
      });
    }

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
