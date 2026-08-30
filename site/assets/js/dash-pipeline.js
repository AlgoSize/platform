// Fix pipeline — the stage model selector, live cost estimate, route-to-agent
// toggles, and the MCP handoff panel.
//
// The whole surface reads from three endpoints and holds no secret of its own:
//   GET  /api/ai/models              → the per-stage valid-model dropdowns
//   POST /api/ai/estimate            → the live per-finding cost as models change
//   POST /api/ai/stage-config/validate → the SERVER's verdict on the config
//                                        (Stage 5 ≠ Stage 4 is enforced there,
//                                        not here — the UI only shows the result)
//   GET  /api/fix/handoff            → the ready-to-paste agent prompt
//   POST /api/pipeline/run           → actually run the five stages over a scan
//
// Model choices and prices come entirely from the server registry; this file
// never hardcodes a model or a price.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el;

  var state = { loaded: false, stages: null, funnel: null, config: {}, route: {}, request: 0, lastRun: null };

  function load() {
    if (state.loaded) return;
    state.loaded = true;
    var body = document.getElementById("pipeline-body");
    if (body) {
      clear(body);
      body.appendChild(el("div", { class: "panel-empty" }, "Loading pipeline models…"));
    }
    core.callApi("/api/ai/models", null, "GET")
      .then(function (d) {
        state.stages = d.stages || [];
        state.funnel = d.funnel || null;
        render(); estimate();
      })
      .catch(function (err) { fail(err && err.message); });
  }

  function fail(msg) {
    var body = document.getElementById("pipeline-body");
    if (!body) return;
    clear(body);
    var panel = core.errorState ? core.errorState(msg || "Could not load the pipeline.") :
      el("div", { class: "panel-empty" }, msg || "Could not load the pipeline.");
    var retry = el("button", { class: "btn btn-ghost btn-sm pipe-retry", type: "button" }, "Try again");
    retry.addEventListener("click", function () {
      state.loaded = false;
      load();
    });
    panel.appendChild(retry);
    body.appendChild(panel);
  }

  function render() {
    var body = document.getElementById("pipeline-body");
    if (!body) return;
    clear(body);

    body.appendChild(funnel());
    var grid = el("div", { class: "pipe-grid" });

    // --- Left: the stage selector -----------------------------------------
    var left = el("section", { class: "panel pipe-stages" });
    left.appendChild(el("h3", { class: "panel-title" }, "Model per stage"));
    left.appendChild(el("p", { class: "panel-desc" },
      "Each stage only offers models that can do its job. Verification must differ from fix — the server rejects a config that grades a fix with its own author."));

    state.stages.forEach(function (stage) {
      left.appendChild(stageRow(stage));
    });
    grid.appendChild(left);

    // --- Right: cost + validation + handoff -------------------------------
    var right = el("div", { class: "pipe-side" });

    var cost = el("section", { class: "panel pipe-cost", id: "pipe-cost" });
    cost.appendChild(el("h3", { class: "panel-title" }, "Estimated cost / finding"));
    cost.appendChild(el("div", { class: "panel-empty", id: "pipe-cost-body" }, "…"));
    right.appendChild(cost);

    var validation = el("section", { class: "panel pipe-validation", id: "pipe-validation" });
    validation.appendChild(el("h3", { class: "panel-title" }, "Configuration check"));
    validation.appendChild(el("div", {
      class: "pipe-validation-body", id: "pipe-validation-body",
      role: "status", "aria-live": "polite", "aria-atomic": "true"
    },
      "Checking the server rules…"));
    right.appendChild(validation);

    right.appendChild(handoffPanel());

    grid.appendChild(right);
    body.appendChild(grid);
    refreshFunnel();
  }

  function funnel() {
    var section = el("section", { class: "panel pipe-funnel", id: "pipe-funnel" });
    var head = el("div", { class: "pipe-funnel-head" });
    var copy = el("div", { class: "pipe-funnel-copy" });
    copy.appendChild(el("h3", { class: "panel-title" }, "The fix funnel"));
    copy.appendChild(el("p", { class: "panel-desc" },
      "Every finding moves through the same evidence chain. The last model checks the fix, never the model that wrote it."));
    head.appendChild(copy);
    head.appendChild(el("span", { class: "pipe-funnel-state mono", id: "pipe-funnel-state" }, "awaiting choices"));
    section.appendChild(head);

    var track = el("div", { class: "pipe-funnel-track", role: "list", "aria-label": "Fix pipeline stages" });
    (state.stages || []).forEach(function (stage, i) {
      if (i) track.appendChild(el("span", { class: "pipe-funnel-line", "aria-hidden": "true" }));
      var node = el("div", { class: "pipe-funnel-node", id: "pipe-funnel-" + stage.id, role: "listitem" });
      node.appendChild(el("span", { class: "pipe-funnel-number mono" }, "S" + stage.stage));
      node.appendChild(el("strong", { class: "pipe-funnel-label" }, stage.label));
      node.appendChild(el("span", { class: "pipe-funnel-model mono", "data-funnel-model": stage.id }, "auto"));
      track.appendChild(node);
    });
    section.appendChild(track);
    return section;
  }

  function refreshFunnel() {
    var stateEl = document.getElementById("pipe-funnel-state");
    if (!stateEl) return;
    var routed = (state.stages || []).filter(function (st) {
      return st.selectable !== false && isRouted(st.id);
    }).length;
    stateEl.textContent = routed ? routed + " stage" + (routed === 1 ? "" : "s") + " routed" : "platform run";
    (state.stages || []).forEach(function (stage) {
      var node = document.getElementById("pipe-funnel-" + stage.id);
      var model = node && node.querySelector("[data-funnel-model='" + stage.id + "']");
      if (!node || !model) return;
      if (stage.selectable === false) { model.textContent = "rules · $0"; return; }
      var routedHere = isRouted(stage.id);
      node.classList.toggle("routed", routedHere);
      model.textContent = routedHere ? "your agent · $0" : (state.config[stage.id] ? shortModel(state.config[stage.id]) : "auto");
      model.classList.toggle("pipe-funnel-unpriced", !routedHere && !!state.config[stage.id] && !stage.options.some(function (o) {
        return o.model === state.config[stage.id] && o.priceHint && o.priceHint.outputPer1M != null;
      }));
    });
  }

  function shortModel(model) {
    var parts = String(model || "").split("/");
    return parts[parts.length - 1] || "selected";
  }

  function stageRow(stage) {
    // Stage 1 is an anchor, not a choice: deterministic rules, no model, no
    // price. It gets a row so the page shows the whole chain — a selector that
    // starts at S2 quietly implies detection is somewhere else.
    if (stage.selectable === false) return anchorRow(stage);

    var row = el("div", { class: "pipe-row", id: "pipe-row-" + stage.id });

    var head = el("div", { class: "pipe-row-head" });
    head.appendChild(el("span", { class: "pipe-stage-no" }, "S" + stage.stage));
    head.appendChild(el("strong", null, stage.label));
    if (stage.distinctFrom) head.appendChild(el("span", { class: "pipe-badge" }, "≠ fix"));
    head.appendChild(el("span", { class: "pipe-share mono" }, sharePct(stage.share) + " of findings"));
    row.appendChild(head);

    if (stage.description) row.appendChild(el("p", { class: "pipe-row-desc" }, stage.description));
    if (stage.note) row.appendChild(el("p", { class: "pipe-row-note mono" }, stage.note));

    // Model dropdown — valid options only.
    var sel = el("select", {
      class: "pipe-select", "data-stage": stage.id,
      "aria-label": stage.label + " model", "aria-describedby": "pipe-err-" + stage.id
    });
    sel.appendChild(el("option", { value: "" }, "Auto (recommended)"));
    stage.options.forEach(function (o) {
      var opt = el("option", { value: o.model }, o.label + priceSuffix(o));
      if (state.config[stage.id] === o.model) opt.setAttribute("selected", "selected");
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function () {
      if (sel.value) state.config[stage.id] = sel.value;
      else delete state.config[stage.id];
      refreshFunnel();
      estimate();
    });
    row.appendChild(sel);

    // Route-to-agent toggle.
    var toggle = el("label", { class: "pipe-toggle" });
    var cb = el("input", {
      type: "checkbox", "data-stage": stage.id,
      "aria-describedby": "pipe-err-" + stage.id
    });
    if (isRouted(stage.id)) cb.setAttribute("checked", "checked");
    // Verification has no toggle of its own: it follows the fix stage, because
    // the agent that wrote the patch in its own checkout is the only party
    // holding it. The server applies the same coupling, so this is a mirror of
    // the rule rather than the rule itself.
    if (stage.id === "verify") {
      cb.disabled = true;
      cb.setAttribute("aria-disabled", "true");
    }
    cb.addEventListener("change", function () {
      routedWith(stage.id).forEach(function (id) {
        if (cb.checked) state.route[id] = true; else delete state.route[id];
      });
      syncRouting();
      refreshFunnel();
      estimate();
    });
    toggle.appendChild(cb);
    toggle.appendChild(el("span", null,
      stage.id === "verify" ? "Routed with the fix" : "Route to agent"));
    row.appendChild(toggle);

    var err = el("div", {
      class: "pipe-row-err", id: "pipe-err-" + stage.id,
      hidden: "hidden", role: "alert"
    });
    row.appendChild(err);
    return row;
  }

  function anchorRow(stage) {
    var row = el("div", { class: "pipe-row pipe-row-anchor", id: "pipe-row-" + stage.id });
    var head = el("div", { class: "pipe-row-head" });
    head.appendChild(el("span", { class: "pipe-stage-no" }, "S" + stage.stage));
    head.appendChild(el("strong", null, stage.label));
    head.appendChild(el("span", { class: "pipe-badge" }, "fixed anchor"));
    head.appendChild(el("span", { class: "pipe-share mono" }, sharePct(stage.share) + " of findings"));
    row.appendChild(head);
    if (stage.description) row.appendChild(el("p", { class: "pipe-row-desc" }, stage.description));
    row.appendChild(el("p", { class: "pipe-row-note mono" }, stage.note || "no model to choose"));
    return row;
  }

  /** A funnel share as a percentage — the server's number, not one we invent. */
  function sharePct(share) {
    if (typeof share !== "number") return "—";
    return (share >= 1 ? 100 : Math.round(share * 100)) + "%";
  }

  /** Stages this toggle actually parks. Routing the fix parks verify with it. */
  function routedWith(stageId) {
    return stageId === "fix" ? ["fix", "verify"] : [stageId];
  }

  /** Is this stage routed, directly or by the S4→S5 coupling? */
  function isRouted(stageId) {
    if (stageId === "verify" && state.route.fix) return true;
    return !!state.route[stageId];
  }

  /**
   * Repaint every row's routing state from `state.route`.
   *
   * Needed because one toggle can change another row: turning on the fix stage
   * parks verification too, and a checkbox that stays unchecked while its
   * stage is routed is a lie about what will be billed.
   */
  function syncRouting() {
    (state.stages || []).forEach(function (stage) {
      if (stage.selectable === false) return;
      var row = document.getElementById("pipe-row-" + stage.id);
      if (!row) return;
      var routed = isRouted(stage.id);
      var cb = row.querySelector("input[type='checkbox']");
      var sel = row.querySelector("select");
      row.classList.toggle("routed", routed);
      if (cb) cb.checked = routed;
      if (sel) {
        sel.disabled = routed;
        sel.setAttribute("aria-disabled", routed ? "true" : "false");
      }
    });
  }

  /** A stage id as the label the server gave it, never a slug shown raw. */
  function stageLabel(id) {
    var s = (state.stages || []).filter(function (x) { return x.id === id; })[0];
    return s ? s.label : id;
  }

  function priceSuffix(o) {
    if (!o.priceHint || o.priceHint.outputPer1M == null) return "";
    return "  ·  $" + fmt(o.priceHint.outputPer1M) + "/1M out";
  }

  // Recompute cost + re-validate on every change. Both are server-truth.
  function estimate() {
    var request = ++state.request;
    var routeToMcp = Object.keys(state.route).filter(function (k) { return state.route[k]; });
    renderValidation({ pending: true });
    core.callApi("/api/ai/estimate", { config: state.config, routeToMcp: routeToMcp }, "POST")
      .then(function (d) { if (request === state.request) renderCost(d); })
      .catch(function (err) {
        if (request !== state.request) return;
        var body = document.getElementById("pipe-cost-body");
        if (!body) return;
        clear(body);
        body.appendChild(core.errorState ? core.errorState(err && err.message || "Could not estimate this pipeline.") :
          el("div", { class: "panel-empty" }, "Could not estimate this pipeline."));
      });
    // Routing goes with the config: the server must not hold a leftover
    // dropdown value against a stage the agent is running.
    core.callApi("/api/ai/stage-config/validate", { config: state.config, routeToMcp: routeToMcp }, "POST")
      .then(function (v) { if (request === state.request) renderValidation(v); })
      .catch(function (err) {
        // A 422 throws here with the validation body; surface it inline.
        if (request === state.request) renderValidation({ ok: false, errors: (err && err.errors) || [{ message: err && err.message }] });
      });
  }

  function renderCost(d) {
    var body = document.getElementById("pipe-cost-body");
    if (!body) return;
    clear(body);
    body.className = "pipe-cost-body";

    var pf = d.perFinding || {};
    var total = el("div", { class: "pipe-total" });
    if (pf.partial) {
      // A price is not a rollup. When a stage has no published rate the sum of
      // the rest is not a cheaper pipeline, it is an incomplete one — so the
      // headline says so in a word rather than showing a number a customer
      // might budget against and we could not stand behind.
      total.appendChild(el("span", { class: "pipe-total-num pipe-total-partial" }, "partial"));
      total.appendChild(el("span", { class: "pipe-total-note" },
        "no estimate while " +
        ((pf.unpricedStages || []).map(stageLabel).join(" and ") || "a stage") +
        " has no published rate"));
    } else if (pf.algosizePrice == null) {
      total.appendChild(el("span", { class: "pipe-total-num" }, "—"));
      total.appendChild(el("span", { class: "pipe-total-note" }, "choose a model to price the pipeline"));
    } else {
      total.appendChild(el("span", { class: "pipe-total-num" }, "$" + fmt(pf.algosizePrice)));
      total.appendChild(el("span", { class: "pipe-total-note" },
        "per finding · $" + fmt(pf.per100Findings) + " per 100 findings"));
    }
    body.appendChild(total);

    var list = el("ul", { class: "pipe-cost-list" });
    (state.stages || []).forEach(function (s) {
      var ps = (d.perStage || {})[s.id] || {};
      var li = el("li", null);
      var name = el("span", { class: "pipe-cost-stage" });
      name.appendChild(el("span", null, s.label));
      // The share is the whole reason these numbers are small: a stage that
      // sees a tenth of the findings contributes a tenth of its own price.
      name.appendChild(el("span", { class: "pipe-cost-share mono" }, sharePct(ps.share != null ? ps.share : s.share)));
      li.appendChild(name);
      var val;
      if (ps.routedToMcp) val = el("span", { class: "pipe-cost-routed" }, "agent · $0");
      else if (s.selectable === false) val = el("span", { class: "pipe-cost-free" }, "$0 · rules");
      else if (ps.algosizePrice == null) val = el("span", { class: "pipe-cost-null" }, ps.model ? "unpriced" : "auto");
      else val = el("span", { title: "$" + fmt(ps.algosizePricePerRun) + " when a finding reaches this stage" },
        "$" + fmt(ps.algosizePrice));
      li.appendChild(val);
      list.appendChild(li);
    });
    body.appendChild(list);
    body.appendChild(el("p", { class: "pipe-cost-foot" },
      "Blended across the funnel: each stage's price × the share of findings that reach it. " +
      "Customer price — includes the 25% platform margin. Stages routed to an agent cost $0 Workers AI."));
  }

  function renderValidation(v) {
    var summary = document.getElementById("pipe-validation-body");
    if (summary) {
      clear(summary);
      if (v.pending) {
        summary.appendChild(el("span", { class: "pipe-validation-pending" }, "Checking the server rules…"));
      } else if (v.ok) {
        summary.appendChild(el("span", { class: "pipe-validation-ok" }, "Ready to run"));
        summary.appendChild(el("p", { class: "pipe-validation-help" },
          "The selected stages satisfy the server's role and cross-model checks."));
      } else {
        summary.appendChild(el("span", { class: "pipe-validation-bad" },
          (v.errors || []).length + " configuration issue" + ((v.errors || []).length === 1 ? "" : "s")));
        summary.appendChild(el("p", { class: "pipe-validation-help" },
          "Fix the highlighted stage before starting a pipeline run."));
      }
    }
    (state.stages || []).forEach(function (s) {
      var errEl = document.getElementById("pipe-err-" + s.id);
      if (!errEl) return;
      var mine = (v.errors || []).filter(function (e) { return e.stage === s.id; });
      var row = document.getElementById("pipe-row-" + s.id);
      var controls = row ? row.querySelectorAll("select, input") : [];
      if (v.ok || mine.length === 0) {
        errEl.hidden = true;
        clear(errEl);
        controls.forEach(function (control) { control.removeAttribute("aria-invalid"); });
        return;
      }
      clear(errEl);
      errEl.hidden = false;
      controls.forEach(function (control) { control.setAttribute("aria-invalid", "true"); });
      errEl.appendChild(el("span", null, mine.map(function (e) { return e.message; }).join(" ")));
    });
  }

  // --- MCP handoff panel --------------------------------------------------
  function handoffPanel() {
    var p = el("section", { class: "panel pipe-handoff" });
    p.appendChild(el("h3", { class: "panel-title" }, "Hand a scan to your agent"));
    p.appendChild(el("p", { class: "panel-desc" },
      "Route the fix to your own Claude Code or Kimi session at zero Workers AI token cost. " +
      "Enter a scan run id, pick an agent, and get a ready-to-paste prompt. Your agent fixes the " +
      "findings and reports back with the algosize_record_patch tool."));

    var form = el("div", { class: "pipe-handoff-form" });
    var runLabel = el("label", { class: "panel-input-label", for: "pipe-run" }, "Scan run ID");
    form.appendChild(runLabel);
    var runInput = el("input", {
      class: "pipe-input", id: "pipe-run", type: "text",
      placeholder: "run_…", autocomplete: "off", spellcheck: "false"
    });
    form.appendChild(runInput);

    var agents = [
      { id: "claude_code", label: "Claude Code" },
      { id: "kimi", label: "Kimi k2.7 / k3" },
      { id: "mcp", label: "Generic MCP host" },
    ];
    var picker = el("div", { class: "pipe-agents", role: "group", "aria-label": "Coding agent" });
    agents.forEach(function (a, i) {
      var b = el("button", {
        class: "btn btn-ghost btn-sm pipe-agent" + (i === 0 ? " active" : ""),
        "data-agent": a.id, type: "button", "aria-pressed": i === 0 ? "true" : "false"
      }, a.label);
      b.addEventListener("click", function () {
        picker.querySelectorAll(".pipe-agent").forEach(function (x) {
          x.classList.remove("active");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("active");
        b.setAttribute("aria-pressed", "true");
      });
      picker.appendChild(b);
    });
    form.appendChild(picker);

    // Two actions on one run id, in the order the flow actually happens: run
    // the funnel over a scan, then hand what it parked to an agent. A second
    // input for the same value is how the two get out of step.
    var run = el("button", { class: "btn btn-primary btn-sm", id: "pipe-run-go", type: "button" }, "Run pipeline");
    run.addEventListener("click", function () { runPipeline(runInput.value); });
    form.appendChild(run);

    var go = el("button", { class: "btn btn-ghost btn-sm", id: "pipe-handoff-go", type: "button" }, "Get handoff prompt");
    go.addEventListener("click", function () { fetchHandoff(runInput.value, picker); });
    form.appendChild(go);
    p.appendChild(form);

    p.appendChild(el("div", { class: "pipe-run-out", id: "pipe-run-out", hidden: "hidden", "aria-live": "polite" }));

    p.appendChild(el("div", {
      class: "pipe-handoff-out", id: "pipe-handoff-out", hidden: "hidden",
      "aria-live": "polite"
    }));

    // The connection snippet keeps the contract's rule: NEVER render a real
    // key — an env-var placeholder only.
    var note = el("p", { class: "pipe-handoff-note" });
    note.appendChild(document.createTextNode("Your agent authenticates with your Algosize API key via "));
    note.appendChild(el("code", null, "ASK_LIVE_KEY"));
    note.appendChild(document.createTextNode(" — set it in the agent's MCP config; it is never shown here. Manage keys under "));
    note.appendChild(el("a", { href: "#/team" }, "Team → API keys"));
    note.appendChild(document.createTextNode("."));
    p.appendChild(note);
    return p;
  }

  /**
   * Run the five stages over a stored scan.
   *
   * The configuration on this page only means something once something runs
   * with it: this is the call that turns the model choices and route toggles
   * into triaged, validated findings — and into the parked set the handoff
   * below hands over.
   */
  function runPipeline(runId) {
    var out = document.getElementById("pipe-run-out");
    var btn = document.getElementById("pipe-run-go");
    runId = (runId || "").trim();
    if (!runId) { flash(out, "Enter a scan run id first."); return; }
    var routeToMcp = Object.keys(state.route).filter(function (k) { return state.route[k]; });
    core.setBusy(btn, true, "Running…");
    core.callApi("/api/pipeline/run", { runId: runId, config: state.config, routeToMcp: routeToMcp }, "POST")
      .then(function (d) {
        core.setBusy(btn, false);
        state.lastRun = d;
        renderRunOutcome(d);
      })
      .catch(function (err) {
        core.setBusy(btn, false);
        // A 422 carries the same per-stage errors the config panel renders, so
        // send it there rather than showing a second, less useful copy here.
        if (err && err.status === 422 && err.errors) {
          renderValidation({ ok: false, errors: err.errors });
          flash(out, "The stage configuration was rejected — no models were called.");
          return;
        }
        flash(out, (err && err.message) || "Could not run the pipeline.");
      });
  }

  // Outcome → the words this platform uses for it. `waiting_for_agent` leads
  // because it is the one the next action on this page depends on.
  var OUTCOME_LABEL = {
    waiting_for_agent: "waiting for agent",
    fix_ready: "fix ready",
    needs_human: "needs a person",
    fix_queued: "fix deferred (budget)",
    suppressed_fp: "false positive",
    not_exploitable: "not exploitable",
    budget_blocked: "not analysed (budget)",
    ineligible: "not fixable automatically",
    error: "stage error",
  };

  function renderRunOutcome(d) {
    var out = document.getElementById("pipe-run-out");
    if (!out) return;
    out.hidden = false;
    clear(out);

    var s = d.summary || {};
    var head = el("div", { class: "pipe-run-head" });
    head.appendChild(el("strong", null,
      (d.parked || 0) + " finding" + (d.parked === 1 ? "" : "s") + " waiting for an agent"));
    head.appendChild(el("span", { class: "pipe-run-meta mono" },
      (s.total || 0) + " considered · " + Math.round((d.ms || 0) / 100) / 10 + "s"));
    out.appendChild(head);

    var list = el("ul", { class: "pipe-run-list" });
    Object.keys(OUTCOME_LABEL).forEach(function (k) {
      var n = (s.funnel || {})[k] || 0;
      if (!n) return;
      var li = el("li", { class: k === "waiting_for_agent" ? "parked" : null });
      li.appendChild(el("span", null, OUTCOME_LABEL[k]));
      li.appendChild(el("span", { class: "mono" }, String(n)));
      list.appendChild(li);
    });
    out.appendChild(list);

    // What the run did NOT look at. A capped run that reports three fix-ready
    // findings reads as a clean sweep unless the cap is said out loud.
    var cov = d.coverage || {};
    if (cov.capped) {
      out.appendChild(el("p", { class: "pipe-run-note" },
        "Only the first " + cov.findingsConsidered + " findings were run. Re-run to continue through the rest."));
    }
    if (s.budgetState === "unmeasured") {
      out.appendChild(el("p", { class: "pipe-run-note" },
        "Spend could not be measured for this period, so the budget funnel did not gate this run — that is not the same as being under budget."));
    }
    if (d.attached === false && d.runId) {
      out.appendChild(el("p", { class: "pipe-run-note" },
        "The result was not attached to the run, so the handoff below will fall back to the whole scan."));
    }
  }

  function fetchHandoff(runId, picker) {
    var out = document.getElementById("pipe-handoff-out");
    var go = document.getElementById("pipe-handoff-go");
    runId = (runId || "").trim();
    if (!runId) { flash(out, "Enter a scan run id first."); return; }
    var active = picker.querySelector(".pipe-agent.active");
    var agent = active ? active.getAttribute("data-agent") : "mcp";
    core.setBusy(go, true, "Fetching…");
    core.callApi("/api/fix/handoff?runId=" + encodeURIComponent(runId) + "&agent=" + agent, null, "GET")
      .then(function (d) {
        core.setBusy(go, false);
        out.hidden = false;
        clear(out);
        var n = (d.findings || []).length;
        out.appendChild(el("div", { class: "pipe-handoff-meta" },
          n + " finding" + (n === 1 ? "" : "s") +
          // Parked findings have already survived triage and validation; a raw
          // scan has not. Handing over the second and calling it the first
          // would send the agent the noise the funnel exists to remove.
          (d.selection === "parked" ? " parked by the pipeline" : " from the raw scan (pipeline not run)") +
          " · framed for " + (d.agent || agent)));
        var pre = el("pre", { class: "pipe-prompt" }, d.prompt || "");
        out.appendChild(pre);
        var copy = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Copy prompt");
        copy.addEventListener("click", function () { copyText(d.prompt || ""); copy.textContent = "Copied ✓"; });
        out.appendChild(copy);
      })
      .catch(function (err) {
        core.setBusy(go, false);
        out.hidden = false; clear(out);
        out.appendChild(el("div", { class: "pipe-row-err" }, (err && err.message) || "Could not fetch the handoff."));
      });
  }

  function flash(out, msg) { out.hidden = false; clear(out); out.appendChild(el("div", { class: "pipe-row-err" }, msg)); }

  function copyText(t) {
    try { if (navigator.clipboard) navigator.clipboard.writeText(t); }
    catch (e) { /* clipboard blocked; the text is visible to select manually */ }
  }

  function fmt(n) {
    if (typeof n !== "number") return "0";
    if (n === 0) return "0";
    if (n < 0.001) return n.toExponential(1);
    return n.toFixed(n < 1 ? 4 : 2);
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  window.DashPipeline = { load: load };
})();
