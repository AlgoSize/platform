// Infrastructure Cost Estimator panel.
//
// Drives POST /api/estimate and renders the comparison. Three rules shape
// everything below, and they are product requirements rather than style
// preferences:
//
//   1. NOTHING LEAVES THE BROWSER EXCEPT THE ESTIMATE REQUEST ITSELF.
//      The uploaded file is read into memory, POSTed once, and dropped. The
//      exports (CSV / JSON / printable report) are generated here from the
//      RESPONSE — they never re-upload the configuration, and there is no
//      server-side artifact to leak or to expire.
//
//   2. AN ESTIMATE MUST NEVER READ AS A BILL. Every total is rendered with
//      its range, its confidence, and the named assumptions that produced the
//      range. A provider whose catalog is stale says so on its own card.
//
//   3. AN UNPRICED RESOURCE MUST NEVER READ AS A FREE ONE. Unsupported
//      resources get their own block, above the fold of each card, because
//      "we could not price this" and "this costs nothing" are the two
//      readings a cost tool must never let a customer confuse.
//
// DOM is built with createElement throughout — never innerHTML — so a service
// name out of a customer's manifest can never become an injection sink.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  var lastResult = null;      // the most recent estimate response
  var providersMeta = null;   // GET /api/estimate/providers
  var selectedProviders = {}; // id -> bool

  // -----------------------------------------------------------------------
  // Formatting
  // -----------------------------------------------------------------------

  /**
   * micro-USD integer -> display string.
   *
   * Rounds to cents BEFORE splitting, so $23.999808 renders as "$24.00" and
   * not "$23.100" — the naive split of a micro value carries no decimal carry.
   */
  function money(micro) {
    if (typeof micro !== "number" || !isFinite(micro)) return "—";
    var cents = Math.round(micro / 10000);
    var sign = cents < 0 ? "-" : "";
    cents = Math.abs(cents);
    var whole = Math.floor(cents / 100);
    var frac = String(cents % 100);
    if (frac.length < 2) frac = "0" + frac;
    return sign + "$" + whole.toLocaleString("en-US") + "." + frac;
  }

  function num(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return (Math.round(n * 1000) / 1000).toLocaleString("en-US");
  }

  var CONFIDENCE_LABEL = {
    high: "High confidence",
    medium: "Medium confidence",
    low: "Low confidence",
  };

  // Human wording for the closed set of uncertainty causes the engine emits.
  var CAUSE_LABEL = {
    missing_region: "Region not specified",
    missing_instance_type: "Instance type not specified",
    utilization_assumption: "Utilization assumed",
    bundled_plan_allocation: "Bundled plan",
    unknown_egress: "Egress volume unknown",
    unsupported_managed_service_overhead: "Included allowance applied",
    minimum_billable_duration: "Provider minimum billing period",
    stale_pricing_catalog: "Pricing catalog not verified",
  };

  // -----------------------------------------------------------------------
  // Small DOM helpers
  // -----------------------------------------------------------------------

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function frag() { return document.createDocumentFragment(); }

  function row(label, value, cls) {
    var d = el("div", { class: "est-kv" + (cls ? " " + cls : "") });
    d.appendChild(el("span", { class: "est-kv-label" }, label));
    d.appendChild(el("span", { class: "est-kv-value mono" }, value));
    return d;
  }

  function $(id) { return document.getElementById(id); }

  // -----------------------------------------------------------------------
  // Providers
  // -----------------------------------------------------------------------

  function loadProviders() {
    var host = $("est-providers");
    if (!host) return Promise.resolve();
    return callApi("/api/estimate/providers", null, "GET").then(function (meta) {
      providersMeta = meta;
      clear(host);
      (meta.providers || []).forEach(function (p) {
        if (selectedProviders[p.id] === undefined) selectedProviders[p.id] = true;
        var id = "est-prov-" + p.id;
        var wrap = el("label", { class: "est-provider", for: id });
        var cb = el("input", { type: "checkbox", id: id });
        cb.checked = !!selectedProviders[p.id];
        cb.addEventListener("change", function () { selectedProviders[p.id] = cb.checked; });
        wrap.appendChild(cb);
        var body = el("span", { class: "est-provider-body" });
        body.appendChild(el("span", { class: "est-provider-name" }, p.name));
        var sub = el("span", { class: "est-provider-sub mono" },
          p.billingModel === "plan" ? "plan-billed" : "metered");
        body.appendChild(sub);
        // Stale pricing is disclosed at selection time, not only in the
        // result — the user deserves to know before they read a number.
        if (p.freshness && p.freshness.stale) {
          body.appendChild(el("span", { class: "est-provider-flag", title: p.freshness.reason || "" }, "unverified pricing"));
        }
        wrap.appendChild(body);
        host.appendChild(wrap);
      });
      if (!(meta.providers || []).length) {
        host.appendChild(el("span", { class: "panel-empty" }, "No providers are configured."));
      }
      updateUnverifiedBanner(meta.providers || []);
    }).catch(function (err) {
      clear(host);
      host.appendChild(el("span", { class: "panel-empty" }, "Could not load providers: " + err.message));
    });
  }

  /**
   * The page-level amber band (D-7). Shown while ANY provider's catalog is
   * not human-verified — driven by the providers response, never hardcoded
   * on, so the day a human verifies the catalog the band goes away without
   * a frontend change. Per-card flags keep carrying the per-provider state.
   */
  function updateUnverifiedBanner(providers) {
    var banner = $("est-unverified-banner");
    if (!banner) return;
    var anyUnverified = providers.some(function (p) {
      return p.freshness && p.freshness.verificationStatus !== "verified";
    });
    banner.hidden = !anyUnverified;
  }

  function chosenProviders() {
    return Object.keys(selectedProviders).filter(function (k) { return selectedProviders[k]; });
  }

  // -----------------------------------------------------------------------
  // Input mode
  // -----------------------------------------------------------------------

  function currentType() {
    var s = $("est-input-type");
    return s ? s.value : "kubernetes";
  }

  function syncInputMode() {
    var manual = currentType() === "manual";
    var doc = $("est-doc-input"), man = $("est-manual-input");
    if (doc) doc.hidden = manual;
    if (man) man.hidden = !manual;
    if (manual && $("est-manual-rows") && !$("est-manual-rows").children.length) addManualRow();
  }

  function addManualRow(preset) {
    var tbody = $("est-manual-rows");
    if (!tbody) return;
    var p = preset || {};
    var tr = el("tr", { class: "est-row" });

    function cell(field, placeholder, value) {
      var td = el("td", null);
      var input = el("input", { class: "panel-input est-cell mono", "data-field": field, placeholder: placeholder || "" });
      if (value != null) input.value = value;
      td.appendChild(input);
      return td;
    }

    tr.appendChild(cell("name", "api", p.name));
    var tdType = el("td", null);
    var sel = el("select", { class: "panel-input est-cell", "data-field": "type" });
    ["container", "vm", "storage", "database", "network", "other"].forEach(function (t) {
      var o = el("option", { value: t }, t);
      if (p.type === t) o.selected = true;
      sel.appendChild(o);
    });
    tdType.appendChild(sel);
    tr.appendChild(tdType);

    tr.appendChild(cell("cpuCores", "2", p.cpuCores));
    tr.appendChild(cell("memoryGiB", "4", p.memoryGiB));
    tr.appendChild(cell("storageGiB", "", p.storageGiB));
    tr.appendChild(cell("egressGiB", "", p.egressGiB));
    tr.appendChild(cell("quantity", "1", p.quantity));

    var tdDel = el("td", null);
    var del = el("button", { type: "button", class: "btn btn-ghost btn-sm est-row-del", "aria-label": "Remove this resource" }, "×");
    del.addEventListener("click", function () { tr.parentNode && tr.parentNode.removeChild(tr); });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);

    tbody.appendChild(tr);
  }

  function readManualRows() {
    var tbody = $("est-manual-rows");
    if (!tbody) return [];
    return Array.prototype.map.call(tbody.querySelectorAll("tr"), function (tr) {
      var out = {};
      Array.prototype.forEach.call(tr.querySelectorAll("[data-field]"), function (input) {
        out[input.getAttribute("data-field")] = input.value;
      });
      return out;
    });
  }

  // -----------------------------------------------------------------------
  // Sample
  // -----------------------------------------------------------------------

  var SAMPLES = {
    kubernetes: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: web\n          resources:\n            requests:\n              cpu: \"500m\"\n              memory: \"1Gi\"\n            limits:\n              cpu: \"1\"\n              memory: \"2Gi\"\n---\napiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: db\nspec:\n  replicas: 1\n  template:\n    spec:\n      containers:\n        - name: postgres\n          resources:\n            requests:\n              cpu: \"2\"\n              memory: \"8Gi\"\n",
    compose: "services:\n  web:\n    image: nginx\n    deploy:\n      replicas: 3\n      resources:\n        limits:\n          cpus: \"1.0\"\n          memory: 2G\n        reservations:\n          cpus: \"0.5\"\n          memory: 1G\n  worker:\n    image: app/worker\n    deploy:\n      replicas: 2\n      resources:\n        reservations:\n          cpus: \"0.25\"\n          memory: 512M\n",
    "terraform-plan": JSON.stringify({
      format_version: "1.2",
      planned_values: {
        root_module: {
          resources: [
            { address: "aws_instance.web", type: "aws_instance", name: "web", values: { instance_type: "t3.medium", count: 2 } },
          ],
        },
      },
    }, null, 2),
  };

  function loadSample() {
    var t = currentType();
    if (t === "manual") {
      var tbody = $("est-manual-rows");
      if (tbody) clear(tbody);
      addManualRow({ name: "api", type: "container", cpuCores: "2", memoryGiB: "4", quantity: "3" });
      addManualRow({ name: "worker", type: "container", cpuCores: "1", memoryGiB: "2", quantity: "2" });
      addManualRow({ name: "uploads", type: "storage", storageGiB: "500", egressGiB: "200", quantity: "1" });
      return;
    }
    var ta = $("est-paste");
    if (ta) ta.value = SAMPLES[t] || "";
    var name = $("est-file-name");
    if (name) name.textContent = "No file selected.";
  }

  // -----------------------------------------------------------------------
  // Run
  // -----------------------------------------------------------------------

  function buildPayload() {
    var type = currentType();
    var durRaw = ($("est-duration") || {}).value || "1:month";
    var parts = durRaw.split(":");
    var options = {
      providers: chosenProviders(),
      duration: { value: Number(parts[0]) || 1, unit: parts[1] || "month" },
      capacityBasis: ($("est-basis") || {}).value || "requests",
    };

    if (type === "manual") {
      var rows = readManualRows();
      if (!rows.length) throw new Error("Add at least one resource.");
      return { inputType: "manual", content: { resources: rows }, options: options };
    }

    var pasted = ($("est-paste") || {}).value || "";
    if (!pasted.trim()) throw new Error("Choose a file or paste your configuration first.");
    var content = pasted;
    if (type === "terraform-plan") {
      // The adapter takes the parsed plan or its JSON text; sending the text
      // keeps the byte ceiling meaningful and the parse error attributable.
      content = pasted;
    }
    return { inputType: type, content: content, options: options };
  }

  function run() {
    var btn = $("est-run-btn");
    var out = $("output-estimate");
    var payload;
    try {
      payload = buildPayload();
    } catch (e) {
      clear(out);
      out.appendChild(el("div", { class: "est-error" }, e.message));
      return;
    }
    if (!payload.options.providers.length) {
      clear(out);
      out.appendChild(el("div", { class: "est-error" }, "Select at least one provider to compare."));
      return;
    }

    setBusy(btn, true, "Estimating…");
    clear(out);
    out.appendChild(el("div", { class: "panel-empty" }, "Pricing against the local catalog…"));

    callApi("/api/estimate", payload).then(function (result) {
      lastResult = result;
      render(result);
    }).catch(function (err) {
      lastResult = null;
      renderError(err);
    }).then(function () {
      setBusy(btn, false);
    });
  }

  function renderError(err) {
    var out = $("output-estimate");
    clear(out);
    var box = el("div", { class: "est-error" });
    box.appendChild(el("strong", null, "Could not produce an estimate"));
    box.appendChild(el("p", null, err.message || "Unknown error."));
    // A rejected credential is the one error worth expanding: the user needs
    // the line numbers to fix their file, and we deliberately never received
    // the value itself.
    if (err.code === "secrets_detected") {
      box.appendChild(el("p", { class: "est-error-hint" },
        "Nothing was stored. Remove the credential and re-run — the estimator never needs one."));
    }
    out.appendChild(box);
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  function render(result) {
    var out = $("output-estimate");
    clear(out);
    var f = frag();

    // ---- header: the disclaimer, first and unmissable --------------------
    var head = el("div", { class: "est-result-head" });
    head.appendChild(el("p", { class: "est-disclaimer" },
      (result.disclaimer && result.disclaimer.estimate) ||
      "This is an estimate, not a bill."));
    var meta = el("p", { class: "est-meta mono" });
    meta.appendChild(document.createTextNode(
      "Catalog " + (result.pricingCatalogVersion || "—") +
      " · " + (result.inputType || "") +
      " · " + describeDuration(result.duration)));
    if (result.durationWasDefaulted) {
      meta.appendChild(el("span", { class: "est-meta-note" }, " (period defaulted)"));
    }
    head.appendChild(meta);
    f.appendChild(head);

    // ---- comparison table -------------------------------------------------
    var providers = result.providers || [];
    if (providers.length > 1) f.appendChild(comparisonTable(providers));

    // ---- per-provider cards ----------------------------------------------
    providers.forEach(function (p) { f.appendChild(providerCard(p)); });

    // ---- document-level warnings -----------------------------------------
    var warnings = result.warnings || [];
    if (warnings.length) {
      var w = el("details", { class: "est-warnings" });
      w.appendChild(el("summary", null, warnings.length + " note" + (warnings.length === 1 ? "" : "s") + " about how this was read"));
      var ul = el("ul", { class: "est-warn-list" });
      warnings.forEach(function (item) {
        ul.appendChild(el("li", null, item.message || String(item.code || "")));
      });
      w.appendChild(ul);
      f.appendChild(w);
    }

    // ---- exports ----------------------------------------------------------
    f.appendChild(exportBar());

    // ---- privacy note, repeated at the point of export -------------------
    f.appendChild(el("p", { class: "est-privacy est-privacy-foot" },
      (result.disclaimer && result.disclaimer.privacy) ||
      "We estimate from the configuration you provide. We do not connect to or access your cloud account."));

    out.appendChild(f);
  }

  function describeDuration(d) {
    if (!d || typeof d !== "object") return "";
    var v = d.value, u = d.unit;
    return "per " + (v === 1 ? u : v + " " + u + "s");
  }

  function comparisonTable(providers) {
    var wrap = el("div", { class: "est-table-wrap" });
    var t = el("table", { class: "est-table est-compare" });
    var thead = el("thead", null);
    var hr = el("tr", null);
    ["Provider", "Billing", "Estimate", "Range", "Confidence"].forEach(function (h) {
      hr.appendChild(el("th", { scope: "col" }, h));
    });
    thead.appendChild(hr);
    t.appendChild(thead);

    var tb = el("tbody", null);
    providers.forEach(function (p) {
      var tr = el("tr", null);
      tr.appendChild(el("td", null, p.providerName || p.providerId));
      tr.appendChild(el("td", { class: "mono" }, p.billingModel || "—"));
      tr.appendChild(el("td", { class: "mono est-total" }, money(p.estimatedTotalMicroUsd)));
      // A blank range is meaningful: the engine omits bounds when no
      // assumption widened the estimate, rather than printing low===high and
      // implying a precision the catalog does not have.
      var range = (typeof p.lowerBoundMicroUsd === "number")
        ? money(p.lowerBoundMicroUsd) + " – " + money(p.upperBoundMicroUsd)
        : "—";
      tr.appendChild(el("td", { class: "mono" }, range));
      tr.appendChild(el("td", null, confidenceBadge(p.confidence)));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  function confidenceBadge(level) {
    // The word carries the meaning; colour is a second channel, never the only
    // one — same reasoning as the architecture panel's severity encoding.
    return el("span", { class: "est-conf est-conf-" + (level || "low") },
      CONFIDENCE_LABEL[level] || "Unknown");
  }

  function providerCard(p) {
    var card = el("article", { class: "est-card" });

    var head = el("header", { class: "est-card-head" });
    var titles = el("div", null);
    titles.appendChild(el("h3", { class: "est-card-title" }, p.providerName || p.providerId));
    titles.appendChild(el("p", { class: "est-card-sub mono" },
      (p.billingModel === "plan" ? "plan-billed" : "metered") +
      " · catalog " + (p.pricingCatalogVersion || "—") +
      " · verified " + (p.pricingLastVerified || "—")));
    head.appendChild(titles);
    var totals = el("div", { class: "est-card-total" });
    totals.appendChild(el("div", { class: "est-total-figure mono" }, money(p.estimatedTotalMicroUsd)));
    if (typeof p.lowerBoundMicroUsd === "number") {
      totals.appendChild(el("div", { class: "est-total-range mono" },
        money(p.lowerBoundMicroUsd) + " – " + money(p.upperBoundMicroUsd)));
    }
    totals.appendChild(confidenceBadge(p.confidence));
    head.appendChild(totals);
    card.appendChild(head);

    // Unsupported FIRST. "We could not price this" must never be mistaken for
    // "this is free", so it sits above the line items rather than below them.
    if ((p.unsupportedResources || []).length) {
      var un = el("div", { class: "est-unsupported" });
      un.appendChild(el("strong", null,
        p.unsupportedResources.length + " resource" + (p.unsupportedResources.length === 1 ? "" : "s") + " could not be priced"));
      un.appendChild(el("p", { class: "est-unsupported-note" },
        "These are NOT included in the total above, and they are not free — they are unknown."));
      var ul = el("ul", null);
      p.unsupportedResources.forEach(function (u) {
        ul.appendChild(el("li", null, (u.resourceId ? u.resourceId + ": " : "") + (u.message || u.reason)));
      });
      un.appendChild(ul);
      card.appendChild(un);
    }

    // Line items.
    if ((p.lineItems || []).length) {
      var wrap = el("div", { class: "est-table-wrap" });
      var t = el("table", { class: "est-table" });
      var thead = el("thead", null), hr = el("tr", null);
      ["Resource", "Category", "Quantity", "Unit", "Unit price", "Cost"].forEach(function (h) {
        hr.appendChild(el("th", { scope: "col" }, h));
      });
      thead.appendChild(hr); t.appendChild(thead);
      var tb = el("tbody", null);
      p.lineItems.forEach(function (li) {
        var tr = el("tr", { class: li.allocated ? "est-line-allocated" : "" });
        tr.appendChild(el("td", { class: "mono" }, li.resourceId || "—"));
        tr.appendChild(el("td", null, li.category || "—"));
        tr.appendChild(el("td", { class: "mono" }, num(li.quantity)));
        tr.appendChild(el("td", { class: "mono" }, li.unit || "—"));
        // An allocated line is shown at zero on purpose: plan-billed providers
        // publish no per-vCPU rate, and inventing one would be fabricating a
        // price the provider does not sell.
        tr.appendChild(el("td", { class: "mono" },
          li.allocated ? "included in plan" : money(li.unitPriceMicroUsd)));
        tr.appendChild(el("td", { class: "mono" },
          li.allocated ? "—" : money(li.estimatedCostMicroUsd)));
        tb.appendChild(tr);
      });
      t.appendChild(tb); wrap.appendChild(t);
      card.appendChild(wrap);
    }

    // Assumptions — every range must be explained by one of these.
    if ((p.assumptions || []).length) {
      var a = el("div", { class: "est-assumptions" });
      a.appendChild(el("h4", null, "Why this is a range"));
      var al = el("ul", { class: "est-assumption-list" });
      p.assumptions.forEach(function (item) {
        var li = el("li", null);
        li.appendChild(el("span", { class: "est-cause" }, CAUSE_LABEL[item.cause] || item.cause));
        li.appendChild(document.createTextNode(" " + (item.statement || "")));
        var eff = item.effect || {};
        if (eff.lowerMicroUsd || eff.upperMicroUsd) {
          li.appendChild(el("span", { class: "est-effect mono" },
            " (" + money(eff.lowerMicroUsd) + " to " + money(eff.upperMicroUsd) + ")"));
        }
        al.appendChild(li);
      });
      a.appendChild(al);
      card.appendChild(a);
    }

    // The provider's own caveats, straight from the catalog.
    if ((p.limitations || []).length) {
      var lim = el("details", { class: "est-limitations" });
      lim.appendChild(el("summary", null, "What this provider's pricing does not cover"));
      var ll = el("ul", null);
      p.limitations.forEach(function (s) { ll.appendChild(el("li", null, s)); });
      lim.appendChild(ll);
      card.appendChild(lim);
    }

    return card;
  }

  // -----------------------------------------------------------------------
  // Export — all generated locally from the response
  // -----------------------------------------------------------------------

  function exportBar() {
    var bar = el("div", { class: "est-exports" });
    bar.appendChild(el("span", { class: "est-exports-label" }, "Save this estimate"));
    var csv = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Download CSV");
    csv.addEventListener("click", function () { downloadCsv(); });
    var jsonBtn = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Download JSON");
    jsonBtn.addEventListener("click", function () { downloadJson(); });
    var rep = el("button", { type: "button", class: "btn btn-primary btn-sm" }, "Open report (PDF)");
    rep.addEventListener("click", function () { openReport(); });
    bar.appendChild(csv); bar.appendChild(jsonBtn); bar.appendChild(rep);
    bar.appendChild(el("p", { class: "est-exports-note" },
      "Generated in your browser from this result. Your configuration is not re-uploaded or stored."));
    return bar;
  }

  function download(filename, mime, text) {
    var blob = new Blob([text], { type: mime + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /** RFC-4180 quoting. A resource id can contain a comma or a quote. */
  function csvCell(v) {
    var s = v === undefined || v === null ? "" : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadCsv() {
    if (!lastResult) return;
    var lines = [];
    // A spreadsheet strips context, so the caveat rides in the file itself
    // rather than only on the screen it was exported from.
    lines.push(csvCell("# " + (lastResult.disclaimer && lastResult.disclaimer.estimate || "Estimate, not a bill.")));
    lines.push(csvCell("# " + (lastResult.disclaimer && lastResult.disclaimer.privacy || "")));
    lines.push(csvCell("# Pricing catalog: " + (lastResult.pricingCatalogVersion || "")));
    lines.push("");
    lines.push(["provider", "billing_model", "resource", "category", "quantity", "unit",
      "unit_price_usd", "cost_usd", "allocated"].join(","));
    (lastResult.providers || []).forEach(function (p) {
      (p.lineItems || []).forEach(function (li) {
        lines.push([
          csvCell(p.providerName || p.providerId),
          csvCell(p.billingModel),
          csvCell(li.resourceId),
          csvCell(li.category),
          csvCell(li.quantity),
          csvCell(li.unit),
          csvCell(li.allocated ? "" : (li.unitPriceMicroUsd / 1e6).toFixed(6)),
          csvCell(li.allocated ? "" : (li.estimatedCostMicroUsd / 1e6).toFixed(6)),
          csvCell(li.allocated ? "included_in_plan" : ""),
        ].join(","));
      });
    });
    lines.push("");
    lines.push(["provider", "total_usd", "lower_usd", "upper_usd", "confidence", "unpriced_resources"].join(","));
    (lastResult.providers || []).forEach(function (p) {
      lines.push([
        csvCell(p.providerName || p.providerId),
        csvCell((p.estimatedTotalMicroUsd / 1e6).toFixed(6)),
        csvCell(typeof p.lowerBoundMicroUsd === "number" ? (p.lowerBoundMicroUsd / 1e6).toFixed(6) : ""),
        csvCell(typeof p.upperBoundMicroUsd === "number" ? (p.upperBoundMicroUsd / 1e6).toFixed(6) : ""),
        csvCell(p.confidence),
        csvCell((p.unsupportedResources || []).length),
      ].join(","));
    });
    download("algosize-estimate.csv", "text/csv", lines.join("\r\n"));
  }

  function downloadJson() {
    if (!lastResult) return;
    download("algosize-estimate.json", "application/json", JSON.stringify(lastResult, null, 2));
  }

  /**
   * Printable, customer-presentable report.
   *
   * Opened in a new window and printed from there rather than fetched from the
   * server: the estimate never becomes a stored artifact, so there is no link
   * to leak, expire, or accidentally share. The org name is used when /api/me
   * has one so the page can carry the customer's own letterhead.
   */
  function openReport() {
    if (!lastResult) return;
    var me = (core.me && core.me()) || {};
    var org = (me.org && (me.org.name || me.org.orgName)) || me.orgName || "";
    var win = window.open("", "_blank");
    if (!win) return;
    var doc = win.document;
    doc.open();
    doc.write("<!doctype html><html><head><meta charset=\"utf-8\"><title>Infrastructure cost estimate</title></head><body></body></html>");
    doc.close();

    var style = doc.createElement("style");
    style.textContent = REPORT_CSS;
    doc.head.appendChild(style);

    var b = doc.body;
    function mk(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    var header = mk("header", "rep-head");
    header.appendChild(mk("div", "rep-brand", org || "Infrastructure cost estimate"));
    if (org) header.appendChild(mk("div", "rep-sub", "Infrastructure cost estimate"));
    header.appendChild(mk("div", "rep-date", new Date().toLocaleDateString()));
    b.appendChild(header);

    var disc = mk("p", "rep-disclaimer",
      (lastResult.disclaimer && lastResult.disclaimer.estimate) || "This is an estimate, not a bill.");
    b.appendChild(disc);

    var summary = mk("table", "rep-table");
    var thead = doc.createElement("thead");
    var hr = doc.createElement("tr");
    ["Provider", "Estimate", "Range", "Confidence", "Unpriced"].forEach(function (h) {
      hr.appendChild(mk("th", null, h));
    });
    thead.appendChild(hr); summary.appendChild(thead);
    var tb = doc.createElement("tbody");
    (lastResult.providers || []).forEach(function (p) {
      var tr = doc.createElement("tr");
      tr.appendChild(mk("td", null, p.providerName || p.providerId));
      tr.appendChild(mk("td", "rep-num", money(p.estimatedTotalMicroUsd)));
      tr.appendChild(mk("td", "rep-num", typeof p.lowerBoundMicroUsd === "number"
        ? money(p.lowerBoundMicroUsd) + " – " + money(p.upperBoundMicroUsd) : "—"));
      tr.appendChild(mk("td", null, CONFIDENCE_LABEL[p.confidence] || p.confidence || "—"));
      tr.appendChild(mk("td", "rep-num", String((p.unsupportedResources || []).length)));
      tb.appendChild(tr);
    });
    summary.appendChild(tb);
    b.appendChild(summary);

    (lastResult.providers || []).forEach(function (p) {
      b.appendChild(mk("h2", "rep-h2", p.providerName || p.providerId));
      if ((p.unsupportedResources || []).length) {
        var box = mk("div", "rep-warn");
        box.appendChild(mk("strong", null, "Not included in this total"));
        var ul = doc.createElement("ul");
        p.unsupportedResources.forEach(function (u) {
          ul.appendChild(mk("li", null, (u.resourceId ? u.resourceId + ": " : "") + (u.message || u.reason)));
        });
        box.appendChild(ul);
        b.appendChild(box);
      }
      if ((p.assumptions || []).length) {
        b.appendChild(mk("h3", "rep-h3", "Assumptions behind the range"));
        var al = doc.createElement("ul");
        p.assumptions.forEach(function (a) {
          al.appendChild(mk("li", null, (CAUSE_LABEL[a.cause] || a.cause) + " — " + (a.statement || "")));
        });
        b.appendChild(al);
      }
      if ((p.limitations || []).length) {
        b.appendChild(mk("h3", "rep-h3", "What this pricing does not cover"));
        var ll = doc.createElement("ul");
        p.limitations.forEach(function (s) { ll.appendChild(mk("li", null, s)); });
        b.appendChild(ll);
      }
    });

    var foot = mk("footer", "rep-foot");
    foot.appendChild(mk("p", null,
      (lastResult.disclaimer && lastResult.disclaimer.privacy) || ""));
    foot.appendChild(mk("p", null, "Pricing catalog " + (lastResult.pricingCatalogVersion || "—") +
      " · generated " + new Date().toISOString()));
    b.appendChild(foot);

    win.focus();
    setTimeout(function () { win.print(); }, 150);
  }

  var REPORT_CSS = [
    "*{box-sizing:border-box}",
    "body{font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#14181f;margin:40px;max-width:900px}",
    ".rep-head{display:flex;align-items:baseline;gap:16px;border-bottom:2px solid #14181f;padding-bottom:12px;margin-bottom:20px}",
    ".rep-brand{font-size:22px;font-weight:700}",
    ".rep-sub{color:#5b6373}",
    ".rep-date{margin-left:auto;color:#5b6373;font-variant-numeric:tabular-nums}",
    ".rep-disclaimer{background:#fff8e1;border-left:3px solid #b8860b;padding:10px 14px;margin:0 0 22px}",
    ".rep-table{width:100%;border-collapse:collapse;margin-bottom:26px}",
    ".rep-table th,.rep-table td{border-bottom:1px solid #dfe3ea;padding:8px 10px;text-align:left}",
    ".rep-table th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#5b6373}",
    ".rep-num{text-align:right;font-variant-numeric:tabular-nums}",
    ".rep-h2{font-size:16px;margin:26px 0 8px;padding-top:14px;border-top:1px solid #dfe3ea}",
    ".rep-h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#5b6373;margin:16px 0 6px}",
    ".rep-warn{background:#fdecec;border-left:3px solid #c0392b;padding:10px 14px;margin:10px 0}",
    "ul{margin:6px 0;padding-left:20px}li{margin:3px 0}",
    ".rep-foot{margin-top:34px;padding-top:12px;border-top:1px solid #dfe3ea;color:#5b6373;font-size:12px}",
    "@media print{body{margin:0}.rep-h2{break-after:avoid}.rep-warn,.rep-table{break-inside:avoid}}",
  ].join("");

  // -----------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------

  function attach() {
    if (!$("panel-estimate")) return;

    var typeSel = $("est-input-type");
    if (typeSel) typeSel.addEventListener("change", syncInputMode);

    var fileBtn = $("est-file-btn"), file = $("est-file");
    if (fileBtn && file) {
      fileBtn.addEventListener("click", function () { file.click(); });
      file.addEventListener("change", function () {
        var f = file.files && file.files[0];
        var label = $("est-file-name");
        if (!f) { if (label) label.textContent = "No file selected."; return; }
        if (label) label.textContent = f.name;
        // Read into the textarea so the user can see and edit exactly what
        // will be sent. Nothing is uploaded until they press Estimate.
        var reader = new FileReader();
        reader.onload = function () {
          var ta = $("est-paste");
          if (ta) ta.value = String(reader.result || "");
        };
        reader.readAsText(f);
      });
    }

    var addRow = $("est-add-row");
    if (addRow) addRow.addEventListener("click", function () { addManualRow(); });

    var sample = $("est-sample-btn");
    if (sample) sample.addEventListener("click", loadSample);

    var runBtn = $("est-run-btn");
    if (runBtn) runBtn.addEventListener("click", run);

    syncInputMode();
    loadProviders();
  }

  // -----------------------------------------------------------------------
  // "Keep it priced" — the nightly watch card (D-7)
  // -----------------------------------------------------------------------
  //
  // Real monitor data only. The same null-vs-empty rule as everywhere else:
  // lastEstimate null = the sweep has not priced yet ("first run pending"),
  // an EMPTY byProvider = the sweep looked and found no compose file — a
  // fact, not an error, and not a pending state.

  var EST_REPO_RE = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/*$/i;
  function estShortRepo(url) {
    var m = EST_REPO_RE.exec(url || "");
    return m ? m[1] : url;
  }

  var watchLoaded = false;

  var watchMonitors = [];
  var watchDeepLink = null;

  function loadWatch(force) {
    var wrap = $("est-watch-body");
    if (!wrap) return Promise.resolve();
    if (watchLoaded && !force) return Promise.resolve();
    watchLoaded = true;
    return callApi("/api/monitors", null, "GET").then(function (res) {
      // Kept, not just passed through: renderWatch is now called a second
      // time by openMonitor, and a renderer that only ever sees its list as
      // an argument cannot be called again.
      watchMonitors = (res && res.monitors) || [];
      renderWatch(watchMonitors);
    }).catch(function () {
      clear(wrap);
      wrap.appendChild(el("div", { class: "est-error" }, "Could not load monitors."));
    });
  }

  function renderWatch(monitors) {
    var wrap = $("est-watch-body");
    if (!wrap) return;
    clear(wrap);

    if (watchDeepLink) wrap.appendChild(core.deepLinkNote(watchDeepLink));

    var watching = monitors.filter(function (m) {
      return (m.analyzers || []).indexOf("estimate") !== -1;
    });

    if (!watching.length) {
      var off = el("div", { class: "night-off" });
      off.appendChild(el("p", null,
        "A repo monitor can price your committed compose file every night and email you only when a " +
        "provider's total moves. Committed text only — no cloud account, no credentials, same boundary as this page."));
      off.appendChild(el("a", { class: "btn btn-ghost btn-sm", href: "#/monitors" }, "Enable on a repo monitor →"));
      wrap.appendChild(off);
      return;
    }

    watching.forEach(function (m) {
      var row = el("div", { class: "night-row" });
      var top = el("div", { class: "night-row-top" });
      top.appendChild(el("strong", { class: "mono" }, estShortRepo(m.repoUrl)));

      var byProvider = m.lastEstimate && m.lastEstimate.byProvider;
      var totals = [];
      if (byProvider) {
        Object.keys(byProvider).forEach(function (pid) {
          if (typeof byProvider[pid] === "number") totals.push({ id: pid, micro: byProvider[pid] });
        });
        totals.sort(function (a, b) { return a.micro - b.micro; });
      }

      if (m.paused) {
        top.appendChild(el("span", { class: "chip chip-muted" }, "paused"));
      } else if (!m.lastEstimate) {
        top.appendChild(el("span", { class: "chip chip-muted" }, "first run pending"));
      } else if (!totals.length) {
        top.appendChild(el("span", { class: "chip chip-warn" }, "no compose file"));
      } else {
        top.appendChild(el("span", { class: "chip chip-ok" },
          "cheapest " + money(totals[0].micro) + "/mo"));
      }
      row.appendChild(top);

      var meta = el("p", { class: "night-meta mono" },
        m.paused ? "Paused — resumes against the same baseline."
        : !m.lastEstimate ? "First price within a day; the baseline email lists every provider's total."
        : !totals.length ? "We looked at the repo root and found nothing to price — a fact, not an error. The watch keeps looking nightly."
        : totals.map(function (t) { return t.id + " " + money(t.micro); }).join(" · ") +
          (typeof m.lastEstimate.at === "number"
            ? " · priced " + new Date(m.lastEstimate.at * 1000).toISOString().slice(0, 10)
            : ""));
      row.appendChild(meta);

      // Open the monitored repo's CURRENT price in the estimator above.
      // Not offered when the last sweep found nothing to price — a button
      // whose only outcome is "still no compose file" is a button that
      // wastes a click. Paused monitors keep it: a paused watch still has a
      // committed compose file worth pricing on demand.
      if (m.lastEstimate === null || totals.length || m.paused) {
        var actions = el("div", { class: "night-actions" });
        var open = el("button", { type: "button", class: "btn btn-primary btn-sm",
          "data-monitor": m.monitorId }, "Price it now \u2192");
        open.addEventListener("click", function () { openMonitored(m, open); });
        actions.appendChild(open);
        row.appendChild(actions);
      }

      wrap.appendChild(row);
    });
  }

  /**
   * Load a monitored repository's current estimate into the panel above.
   *
   * Re-prices the repo's COMMITTED compose file through
   * GET /api/monitors/:id/result/estimate and renders it with `render` — the
   * same function the manual path uses, so a nightly price and a pasted-in
   * price cannot disagree about what a provider row looks like. The endpoint
   * never advances the baseline, so looking does not consume the change
   * tomorrow's email would have reported.
   */
  function openMonitored(m, btn) {
    setBusy(btn, true, "Pricing\u2026");
    callApi("/api/monitors/" + encodeURIComponent(m.monitorId) + "/result/estimate", null, "GET")
      .then(function (payload) {
        if (payload.status !== "ok") {
          var out = $("output-estimate");
          if (out) {
            clear(out);
            out.appendChild(core.errorState(payload.message || "No estimate for this repository."));
          }
          return;
        }
        render(payload.result);
        var panel = $("panel-estimate");
        if (panel && typeof panel.scrollIntoView === "function") {
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      })
      .catch(function (e) { window.alert(e.message || "Could not price that repository"); })
      .then(function () { setBusy(btn, false); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  // Router hook: the panel wires itself at parse time; entering the view
  // (re)loads the automation card, which is the only part that goes stale.
  /**
   * Open one watched repository's estimate, straight from a scorecard cell.
   *
   * The button is rendered only for a repo with something to price, so an
   * absent one is "unopenable" — a real state, not a dead click.
   */
  function openMonitor(monitorId) {
    return loadWatch().then(function () {
      watchDeepLink = core.findDeepLink(watchMonitors, monitorId, "estimate");
      renderWatch(watchMonitors);
      if (watchDeepLink) return;
      if (!core.clickMonitorRow("est-watch-body", monitorId)) {
        watchDeepLink = { reason: "unopenable", monitorId: monitorId };
        renderWatch(watchMonitors);
      }
    });
  }

  window.DashEstimate = { load: loadWatch, openMonitor: openMonitor };
})();
