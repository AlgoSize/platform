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
//
// Model choices and prices come entirely from the server registry; this file
// never hardcodes a model or a price.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el;

  var state = { loaded: false, stages: null, config: {}, route: {}, request: 0 };

  function load() {
    if (state.loaded) return;
    state.loaded = true;
    var body = document.getElementById("pipeline-body");
    if (body) {
      clear(body);
      body.appendChild(el("div", { class: "panel-empty" }, "Loading pipeline models…"));
    }
    core.callApi("/api/ai/models", null, "GET")
      .then(function (d) { state.stages = d.stages || []; render(); estimate(); })
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
    var routed = Object.keys(state.route).filter(function (k) { return state.route[k]; }).length;
    stateEl.textContent = routed ? routed + " stage" + (routed === 1 ? "" : "s") + " routed" : "platform run";
    (state.stages || []).forEach(function (stage) {
      var node = document.getElementById("pipe-funnel-" + stage.id);
      var model = node && node.querySelector("[data-funnel-model='" + stage.id + "']");
      if (!node || !model) return;
      var routedHere = !!state.route[stage.id];
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
    var row = el("div", { class: "pipe-row", id: "pipe-row-" + stage.id });

    var head = el("div", { class: "pipe-row-head" });
    head.appendChild(el("span", { class: "pipe-stage-no" }, "S" + stage.stage));
    head.appendChild(el("strong", null, stage.label));
    if (stage.distinctFrom) head.appendChild(el("span", { class: "pipe-badge" }, "≠ fix"));
    row.appendChild(head);

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
    if (state.route[stage.id]) cb.setAttribute("checked", "checked");
    cb.addEventListener("change", function () {
      state.route[stage.id] = cb.checked;
      row.classList.toggle("routed", cb.checked);
      sel.disabled = cb.checked;
      sel.setAttribute("aria-disabled", cb.checked ? "true" : "false");
      refreshFunnel();
      estimate();
    });
    toggle.appendChild(cb);
    toggle.appendChild(el("span", null, "Route to agent"));
    row.appendChild(toggle);

    var err = el("div", {
      class: "pipe-row-err", id: "pipe-err-" + stage.id,
      hidden: "hidden", role: "alert"
    });
    row.appendChild(err);
    return row;
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
    core.callApi("/api/ai/stage-config/validate", { config: state.config }, "POST")
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
    if (pf.algosizePrice == null) {
      total.appendChild(el("span", { class: "pipe-total-num" }, "—"));
      total.appendChild(el("span", { class: "pipe-total-note" }, "not fully priced"));
    } else {
      total.appendChild(el("span", { class: "pipe-total-num" }, "$" + fmt(pf.algosizePrice)));
      total.appendChild(el("span", { class: "pipe-total-note" },
        "per finding" + (pf.partial ? " (partial — some stage unpriced)" : "")));
    }
    body.appendChild(total);

    var list = el("ul", { class: "pipe-cost-list" });
    (state.stages || []).forEach(function (s) {
      var ps = (d.perStage || {})[s.id] || {};
      var li = el("li", null);
      li.appendChild(el("span", { class: "pipe-cost-stage" }, s.label));
      var val;
      if (ps.routedToMcp) val = el("span", { class: "pipe-cost-routed" }, "agent · $0");
      else if (ps.algosizePrice == null) val = el("span", { class: "pipe-cost-null" }, ps.model ? "unpriced" : "auto");
      else val = el("span", null, "$" + fmt(ps.algosizePrice));
      li.appendChild(val);
      list.appendChild(li);
    });
    body.appendChild(list);
    body.appendChild(el("p", { class: "pipe-cost-foot" },
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

    var go = el("button", { class: "btn btn-primary btn-sm", id: "pipe-handoff-go", type: "button" }, "Get handoff prompt");
    go.addEventListener("click", function () { fetchHandoff(runInput.value, picker); });
    form.appendChild(go);
    p.appendChild(form);

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
          n + " finding" + (n === 1 ? "" : "s") + " · framed for " + (d.agent || agent)));
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
