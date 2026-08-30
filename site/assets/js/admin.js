// Algosize admin control panel — vanilla JS, no build step.
//
// Seven sections, all reading /api/admin/* behind the requireAdmin allowlist
// on the Worker. Two write actions live here: revoking someone else's session
// and setting a feature flag. Everything else is read-only by design — the
// operator actions the product already has (revoke a key, remove a member)
// belong to the owner of the org, not to us.
//
// THE RULE THIS FILE IS BUILT AROUND
//
// The API is careful to return null-with-a-reason for anything it cannot
// compute, and that care is only worth something if the renderer preserves
// it. So: `unknown()` is the ONLY way a missing value reaches the screen, and
// it never renders as an empty cell, a dash, or a zero. An empty cell reads
// as zero, zero reads as "all clear", and "all clear" is the wrong thing to
// tell someone deciding whether to act.

(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  function apiUrl(path) {
    var base = (window.ALGOSIZE_API_BASE || "").replace(/\/$/, "");
    return base + path;
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k === "html") n.innerHTML = v;
        else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v === true ? "" : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /**
   * The one way a value we do not have reaches the screen.
   *
   * Always a word, always the reason on hover, never a dash and never a zero.
   * The whole null-with-a-reason discipline on the API side is wasted if this
   * function ever quietly degrades to an empty string.
   */
  function unknown(reason) {
    return el("span", {
      class: "adm-unknown",
      text: "not known",
      title: reason || "This value could not be determined.",
    });
  }

  function fmtInt(n) {
    if (n === null || n === undefined) return null;
    return Number(n).toLocaleString();
  }

  function fmtMoney(cents, currency) {
    if (cents === null || cents === undefined) return null;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: (currency || "usd").toUpperCase(),
        maximumFractionDigits: 0,
      }).format(cents / 100);
    } catch (e) {
      return "$" + Math.round(cents / 100).toLocaleString();
    }
  }

  function fmtDate(sec) {
    if (!sec) return null;
    var d = new Date(sec * 1000);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }

  function fmtDateTime(sec) {
    if (!sec) return null;
    var d = new Date(sec * 1000);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return fmtDate(sec) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC";
  }

  function fmtRelative(sec) {
    if (!sec) return null;
    var diff = Math.floor(Date.now() / 1000) - sec;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    var days = Math.floor(diff / 86400);
    if (days < 45) return days + "d ago";
    return fmtDate(sec);
  }

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  var blocked = false;

  /**
   * Every read goes through here so a 401 or a 403 is handled once.
   *
   * On either, the whole panel is replaced by the access message rather than
   * each section rendering its own empty state — a page of empty tables
   * beside an error banner implies the tables are genuinely empty.
   */
  function api(path, options) {
    return fetch(apiUrl(path), Object.assign({ credentials: "include" }, options || {}))
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
          if (res.status === 401) { block("unauthenticated", body); throw new ApiError(401, "unauthenticated", body); }
          if (res.status === 403) { block("forbidden", body); throw new ApiError(403, "forbidden", body); }
          if (!res.ok) throw new ApiError(res.status, (body && body.error) || "request_failed", body);
          return body;
        });
      });
  }

  function ApiError(status, code, body) {
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.message = (body && body.message) || code;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function block(kind, body) {
    if (blocked) return;
    blocked = true;
    $$(".adm-page").forEach(function (p) { p.hidden = true; });
    $("#adm-page-blocked").hidden = false;
    $("#adm-nav").hidden = true;
    if (kind === "unauthenticated") {
      $("#adm-blocked-title").textContent = "You are not signed in";
      $("#adm-blocked-msg").textContent =
        "This panel needs an active session. Sign in with the email address on the admin allowlist.";
      $("#adm-blocked-signin").hidden = false;
    } else {
      $("#adm-blocked-title").textContent = "Admin access required";
      $("#adm-blocked-msg").textContent = (body && body.message) ||
        "You are signed in, but this account is not on the ADMIN_EMAILS allowlist. " +
        "Adding an address to it is a deploy, not an action in this panel.";
    }
  }

  // -------------------------------------------------------------------------
  // Shared renderers
  // -------------------------------------------------------------------------

  function skeleton(rows) {
    var wrap = el("div", { class: "adm-skel" });
    for (var i = 0; i < (rows || 5); i++) wrap.appendChild(el("div", { class: "adm-skel-row" }));
    return wrap;
  }

  function stateBox(kind, title, message, actions) {
    return el("div", { class: "adm-state", "data-kind": kind }, [
      el("strong", { text: title }),
      el("span", { text: message || "" }),
      actions && actions.length ? el("div", { class: "adm-state-actions" }, actions) : null,
    ]);
  }

  function errorBox(err, retry) {
    return stateBox(
      "error",
      "Could not load this section",
      (err && err.message) || "The request failed.",
      retry ? [el("button", { class: "adm-btn", type: "button", onclick: retry, text: "Try again" })] : null,
    );
  }

  function pill(text, tone) {
    return el("span", { class: "adm-pill", "data-tone": tone || "", text: text });
  }

  var STATUS_TONE = {
    active: "ok", trialing: "info", past_due: "warn",
    unpaid: "danger", canceled: "danger", incomplete: "warn",
  };

  function statusPill(status) {
    if (!status) return pill("no subscription", "");
    return pill(String(status).replace(/_/g, " "), STATUS_TONE[status] || "");
  }

  /**
   * A table from a column spec. `render` returns a node, a string, or null —
   * and null becomes `unknown()`, never a blank cell. That is the rule stated
   * at the top of the file, enforced in the one place every cell passes
   * through so no individual renderer has to remember it.
   */
  function table(columns, rows, options) {
    options = options || {};
    if (!rows.length) {
      return stateBox("empty", options.emptyTitle || "Nothing here", options.emptyMessage || "");
    }
    var thead = el("thead", null, [
      el("tr", null, columns.map(function (c) {
        return el("th", { text: c.label, scope: "col" });
      })),
    ]);
    var tbody = el("tbody", null, rows.map(function (row, i) {
      var tr = el("tr", {
        "data-clickable": options.onRow ? "true" : null,
        tabindex: options.onRow ? "0" : null,
      }, columns.map(function (c) {
        var value = c.render(row, i);
        var td = el("td", { class: c.numeric ? "adm-num" : (c.wrap ? "adm-wrap" : null) });
        if (value === null || value === undefined) td.appendChild(unknown(c.unknownReason && c.unknownReason(row)));
        else if (typeof value === "string") td.textContent = value;
        else td.appendChild(value);
        return td;
      }));
      if (options.onRow) {
        tr.addEventListener("click", function () { options.onRow(row); });
        tr.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); options.onRow(row); }
        });
      }
      return tr;
    }));
    return el("div", { class: "adm-tablewrap" }, [el("table", { class: "adm-table" }, [thead, tbody])]);
  }

  function region(title, meta, bodyNode, note) {
    return el("div", { class: "adm-region" }, [
      el("div", { class: "adm-region-head" }, [
        el("span", { class: "adm-region-title", text: title }),
        meta ? el("span", { class: "adm-region-meta", text: meta }) : null,
      ]),
      bodyNode,
      note ? el("div", { class: "adm-note", text: note }) : null,
    ]);
  }

  function toast(message, tone) {
    var node = el("div", { class: "adm-toast", "data-tone": tone || "", text: message });
    $("#adm-toasts").appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 5000);
  }

  function announce(message) { $("#adm-live").textContent = message; }

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------

  function renderOverview() {
    var attention = $("#adm-overview-attention");
    var kpis = $("#adm-overview-kpis");
    var activity = $("#adm-overview-activity");
    clear(attention); clear(kpis); clear(activity);
    attention.appendChild(region("Requires attention", null, skeleton(3)));
    activity.appendChild(skeleton(6));

    return api("/api/admin/overview").then(function (data) {
      $("#adm-overview-stamp").textContent = "as of " + fmtDateTime(data.generatedAt);

      // --- attention or calm ---------------------------------------------
      clear(attention);
      if (data.alerts.length) {
        var list = el("div", null, data.alerts.map(function (a) {
          return el("div", { class: "adm-alert", "data-tone": a.tone }, [
            el("span", { class: "adm-alert-sev", text: a.severity, "aria-hidden": "true" }),
            el("span", { class: "adm-alert-text", text: a.text }),
            el("span", { class: "adm-alert-meta", text: a.meta || "" }),
            a.to ? el("button", {
              class: "adm-btn", type: "button", text: "Open " + a.to,
              onclick: function () { go(a.to); },
            }) : null,
          ]);
        }));
        attention.appendChild(el("div", { class: "adm-region", "data-emphasis": "attention" }, [
          el("div", { class: "adm-region-head" }, [
            el("span", { class: "adm-region-title", text: "Requires attention" }),
            el("span", { class: "adm-region-meta", text: data.alerts.length + " item" + (data.alerts.length === 1 ? "" : "s") }),
          ]),
          list,
        ]));
        announce(data.alerts.length + " items require attention");
      } else {
        // The checks are NAMED, not summarised. "Nothing needs attention" on
        // its own is indistinguishable from checks that never ran.
        attention.appendChild(el("div", { class: "adm-region" }, [
          el("div", { class: "adm-calm" }, [
            el("span", { class: "adm-calm-head" }, [
              el("span", { class: "adm-calm-mark", "aria-hidden": "true", text: "✓" }),
              el("span", { text: "Nothing needs attention" }),
            ]),
            el("ul", { class: "adm-calm-list" }, (data.checked || []).map(function (c) {
              return el("li", { text: c });
            })),
          ]),
        ]));
      }

      // --- KPIs ------------------------------------------------------------
      var k = data.kpis;
      kpi(kpis, "Live subscriptions", fmtInt(k.activeSubscriptions.value), null,
          k.activeSubscriptions.trialing + " on trial", null);

      if (k.revenue.mrr === null) {
        kpi(kpis, "MRR", null, reasonText(k.revenue.reason), "revenue unavailable", "warn");
      } else {
        kpi(kpis, "MRR", fmtMoney(k.revenue.mrr, k.revenue.currency), null,
            k.revenue.partial
              ? "at least — " + k.revenue.unpricedOrgs + " account" +
                (k.revenue.unpricedOrgs === 1 ? "" : "s") + " on an unconfigured price"
              : "all accounts priced",
            k.revenue.partial ? "warn" : null);
      }

      kpi(kpis, "Free near quota", fmtInt(k.freeNearQuota.value), null,
          "of " + k.freeNearQuota.of + " free accounts · " + (k.freeNearQuota.limit - 1) +
          "+ of " + k.freeNearQuota.limit + " runs used",
          k.freeNearQuota.value > 0 ? "warn" : null);

      var m = k.monitors;
      kpi(kpis, "Monitors", m.active + " active",
          null,
          [m.overdue ? m.overdue + " overdue" : null,
           m.neverRun ? m.neverRun + " never run" : null,
           m.paused ? m.paused + " paused" : null].filter(Boolean).join(" · ") || "all ran recently",
          m.overdue ? "warn" : null);

      kpi(kpis, "Runs today", fmtInt(k.runsToday.total), null,
          k.runsToday.ci + " CI · " + k.runsToday.dashboard + " dashboard", null);

      // --- activity --------------------------------------------------------
      clear(activity);
      activity.appendChild(auditTable(data.activity, { compact: true }));

      // --- nav badges ------------------------------------------------------
      setBadge("billing", countBy(data.alerts, "billing"), "danger");
      setBadge("automation", countBy(data.alerts, "automation"), "warn");
      setBadge("overview", data.alerts.length || "", data.alerts.length ? "danger" : "");
    }).catch(function (err) {
      if (blocked) return;
      clear(attention);
      attention.appendChild(errorBox(err, function () { renderOverview(); }));
      clear(activity);
    });
  }

  function countBy(alerts, to) {
    var n = alerts.filter(function (a) { return a.to === to; }).length;
    return n || "";
  }

  function setBadge(nav, value, tone) {
    var node = $('[data-badge="' + nav + '"]');
    if (!node) return;
    node.textContent = value === "" || value === null ? "" : String(value);
    if (tone) node.setAttribute("data-tone", tone); else node.removeAttribute("data-tone");
  }

  function kpi(parent, label, value, unknownReason, context, tone) {
    var valueNode = el("span", { class: "adm-kpi-value" });
    if (value === null || value === undefined) {
      valueNode.setAttribute("data-unknown", "true");
      valueNode.textContent = "not known";
      if (unknownReason) valueNode.title = unknownReason;
    } else {
      valueNode.textContent = value;
    }
    parent.appendChild(el("div", { class: "adm-kpi" }, [
      el("span", { class: "adm-kpi-label", text: label }),
      valueNode,
      el("span", { class: "adm-kpi-context", "data-tone": tone || "", text: context || "" }),
    ]));
  }

  var REASONS = {
    stripe_not_configured: "STRIPE_SECRET_KEY is not set on this deployment.",
    stripe_unreachable:    "Stripe could not be reached, so the price amounts are unavailable.",
    no_prices_configured:  "No STRIPE_PRICE_* variables are set, so no price maps to a tier.",
    price_not_in_config:   "This account is on a Stripe price that is not in the STRIPE_PRICE_* configuration.",
    some_orgs_on_unconfigured_prices: "Some accounts are on prices outside the STRIPE_PRICE_* configuration.",
    no_stripe_customer:    "This account has never been through checkout, so Stripe holds nothing for it.",
    entitlement_resolver_failed: "The entitlement resolver failed for this account.",
  };
  function reasonText(code) { return REASONS[code] || code || "No reason given."; }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  var accountsCache = [];

  function renderAccounts() {
    var mount = $("#adm-accounts-table");
    clear(mount); mount.appendChild(skeleton(8));

    var params = [];
    var q = $("#adm-accounts-q").value.trim();
    var status = $("#adm-accounts-status").value;
    if (q) params.push("q=" + encodeURIComponent(q));
    if (status) params.push("status=" + encodeURIComponent(status));

    return api("/api/admin/accounts" + (params.length ? "?" + params.join("&") : "")).then(function (data) {
      accountsCache = data.accounts;
      $("#adm-accounts-count").textContent = data.total + " account" + (data.total === 1 ? "" : "s");
      clear(mount);
      mount.appendChild(table([
        { label: "Account", render: function (a) { return a.name; } },
        { label: "Tier", render: function (a) {
            // A price outside our config is NOT rounded up to a tier. The API
            // is explicit about that and the table has to be too.
            return a.tier ? pill(a.tier, "accent") : pill("unconfigured price", "warn");
          } },
        { label: "Status", render: function (a) { return statusPill(a.subStatus); } },
        { label: "Seats", numeric: true, render: function (a) {
            var text = a.seatsUsed + " / " + a.seatsPurchased;
            return a.seatsOver > 0
              ? el("span", { class: "adm-mono", style: "color:var(--adm-warn)", text: text + " (+" + a.seatsOver + ")" })
              : el("span", { class: "adm-mono", text: text });
          } },
        { label: "MRR", numeric: true,
          render: function (a) { return a.mrrKnown ? fmtMoney(a.mrr, "usd") : null; },
          unknownReason: function () { return reasonText(data.revenueAvailable ? "price_not_in_config" : data.revenueReason); } },
        { label: "Runs 30d", numeric: true, render: function (a) {
            return el("span", { class: "adm-mono", text: a.runs30.total + " (" + a.runs30.ci + " CI)" });
          } },
        { label: "Monitors", numeric: true, render: function (a) { return String(a.monitors.active); } },
        { label: "Created", render: function (a) { return fmtDate(a.createdAt); } },
      ], accountsCache, {
        onRow: function (a) { openAccount(a.orgId); },
        emptyTitle: q || status ? "No accounts match those filters" : "No accounts yet",
        emptyMessage: q || status
          ? "Clear the search or status filter to see everything."
          : "Accounts appear here as soon as somebody signs up.",
      }));
      if (!data.revenueAvailable) {
        mount.appendChild(el("div", { class: "adm-note", text: "Revenue is unavailable: " + reasonText(data.revenueReason) }));
      }
    }).catch(function (err) {
      if (blocked) return;
      clear(mount); mount.appendChild(errorBox(err, renderAccounts));
    });
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  function renderUsers() {
    var mount = $("#adm-users-table");
    clear(mount); mount.appendChild(skeleton(8));
    $("#adm-users-csv").href = apiUrl("/api/admin/users.csv");

    var params = [];
    var q = $("#adm-users-q").value.trim();
    var plan = $("#adm-users-plan").value;
    if (q) params.push("q=" + encodeURIComponent(q));
    if (plan) params.push("plan=" + encodeURIComponent(plan));

    return api("/api/admin/users" + (params.length ? "?" + params.join("&") : "")).then(function (data) {
      $("#adm-users-count").textContent =
        data.count + (data.total !== undefined && data.total !== data.count ? " of " + data.total : "") + " users";
      clear(mount);
      mount.appendChild(table([
        { label: "Email", render: function (u) { return u.email; } },
        { label: "Account", render: function (u) { return u.orgName || null; },
          unknownReason: function () { return "This user has no active organisation."; } },
        { label: "Role", render: function (u) { return u.role ? pill(u.role, u.role === "owner" ? "accent" : "") : null; },
          unknownReason: function () {
            return "No membership row for this user's active organisation — a real inconsistency worth investigating.";
          } },
        { label: "Tier", render: function (u) { return u.tier ? pill(u.tier, "accent") : pill(u.plan, ""); } },
        { label: "Status", render: function (u) { return statusPill(u.orgSubStatus || u.subStatus); } },
        { label: "Sign-in", render: function (u) {
            // A row from before the auth_method column has no answer, and
            // guessing "magic link" would be a lie support could act on.
            return u.authMethodKnown ? el("span", { class: "adm-mono", text: u.authMethod.replace(/_/g, " ") }) : null;
          },
          unknownReason: function () { return "This account predates the auth-method column and has not signed in since."; } },
        { label: "Signed up", render: function (u) { return fmtDate(u.createdAt); } },
      ], data.items, {
        onRow: function (u) { openUser(u.userId); },
        emptyTitle: q || plan ? "No users match those filters" : "No users yet",
        emptyMessage: q || plan ? "Clear the filters to see everyone." : "",
      }));
    }).catch(function (err) {
      if (blocked) return;
      clear(mount); mount.appendChild(errorBox(err, renderUsers));
    });
  }

  // -------------------------------------------------------------------------
  // Billing
  // -------------------------------------------------------------------------

  function renderBilling() {
    var mount = $("#adm-billing-body");
    clear(mount); mount.appendChild(region("At risk", null, skeleton(4)));

    return api("/api/admin/billing").then(function (data) {
      $("#adm-billing-stamp").textContent = "as of " + fmtDateTime(data.generatedAt);
      clear(mount);

      mount.appendChild(region(
        "At risk", data.atRisk.length + " account" + (data.atRisk.length === 1 ? "" : "s"),
        table([
          { label: "Account", render: function (r) { return r.name; } },
          { label: "Status", render: function (r) { return statusPill(r.subStatus); } },
          { label: "Access", render: function (r) {
              if (r.daysOfAccessLeft === null) {
                return el("span", { class: "adm-unknown", text: "no paid-through date",
                  title: "No current_period_end is stored, so we cannot say when access ends." });
              }
              if (r.accessEnded) {
                return el("span", { style: "color:var(--adm-danger)", text: "ended " + Math.abs(r.daysOfAccessLeft) + "d ago" });
              }
              return el("span", { style: r.daysOfAccessLeft <= 3 ? "color:var(--adm-warn)" : "",
                text: r.daysOfAccessLeft + "d left" });
            } },
          { label: "Paid through", render: function (r) { return fmtDate(r.currentPeriodEnd); } },
          { label: "MRR at risk", numeric: true,
            render: function (r) { return r.mrrKnown ? fmtMoney(r.mrrAtRisk, "usd") : null; },
            unknownReason: function () { return reasonText(data.revenueReason || "price_not_in_config"); } },
        ], data.atRisk, {
          emptyTitle: "No accounts at risk",
          emptyMessage: "Nothing is past due, unpaid or cancelled right now.",
        }),
        data.invoicesNote,
      ));

      mount.appendChild(region(
        "Trials", data.trials.length + " running",
        table([
          { label: "Account", render: function (t) { return t.name; } },
          { label: "Converts in", render: function (t) {
              return t.daysLeft === null ? null : t.daysLeft + " days";
            },
            unknownReason: function () { return "No trial end date is stored for this account."; } },
          { label: "Trial ends", render: function (t) { return fmtDate(t.currentPeriodEnd); } },
        ], data.trials, { emptyTitle: "No trials running", emptyMessage: "" }),
      ));

      var tiers = Object.keys(data.byTier).map(function (k) {
        return Object.assign({ tier: k }, data.byTier[k]);
      });
      mount.appendChild(region(
        "Revenue by tier",
        data.revenueAvailable ? null : "unavailable",
        table([
          { label: "Tier", render: function (t) {
              return t.tier === "unconfigured_price"
                ? pill("unconfigured price", "warn")
                : pill(t.tier, "accent");
            } },
          { label: "Accounts", numeric: true, render: function (t) { return String(t.count); } },
          { label: "MRR", numeric: true,
            render: function (t) { return t.mrrKnown ? fmtMoney(t.mrr, "usd") : null; },
            unknownReason: function () {
              return "At least one account in this bucket is on a price outside the STRIPE_PRICE_* configuration.";
            } },
        ], tiers, { emptyTitle: "No live subscriptions", emptyMessage: "" }),
        data.revenueAvailable ? null : "Revenue is unavailable: " + reasonText(data.revenueReason),
      ));

      mount.appendChild(region(
        "Plan changes", null,
        auditTable(data.planChanges, { compact: true }),
        "Every row here was written by Stripe, not by a person — that is what the `system` actor means.",
      ));
    }).catch(function (err) {
      if (blocked) return;
      clear(mount); mount.appendChild(errorBox(err, renderBilling));
    });
  }

  // -------------------------------------------------------------------------
  // Automation
  // -------------------------------------------------------------------------

  function renderAutomation() {
    var mount = $("#adm-automation-body");
    clear(mount); mount.appendChild(region("Monitors", null, skeleton(6)));

    return api("/api/admin/automation").then(function (data) {
      $("#adm-automation-stamp").textContent = "as of " + fmtDateTime(data.generatedAt);
      clear(mount);

      var s = data.monitors.summary;
      mount.appendChild(region(
        "Monitors",
        s.active + " active · " + s.paused + " paused",
        table([
          { label: "Repository", render: function (m) { return m.repoUrl.replace(/^https?:\/\/github\.com\//, ""); } },
          { label: "Branch", render: function (m) { return m.branch || "default"; } },
          { label: "Account", render: function (m) { return m.orgName || null; },
            unknownReason: function () { return "This monitor's organisation row is missing."; } },
          { label: "Schedule", render: function (m) { return m.schedule; } },
          { label: "Last run", render: function (m) {
              if (m.paused) return pill("paused", "");
              // Never-run and overdue are different facts and get different
              // words. A monitor that has never run is not one that stopped.
              if (m.neverRun) return pill("never run", "warn");
              return el("span", { class: "adm-mono", "data-tone": m.overdue ? "warn" : null,
                style: m.overdue ? "color:var(--adm-warn)" : "", text: fmtRelative(m.lastRunAt) });
            } },
          { label: "Last delta", render: function (m) { return deltaText(m.lastDelta); },
            unknownReason: function () { return "No delta has been recorded for this monitor yet."; } },
        ], data.monitors.items, {
          emptyTitle: "No monitors", emptyMessage: "Nobody has set up a scheduled scan yet.",
        }),
        s.note,
      ));

      var w = data.webhooks.counts.last24h;
      mount.appendChild(region(
        "Stripe webhooks",
        "24h — " + w.processed + " processed · " + w.duplicate + " duplicate · " +
        w.ignored + " ignored · " + w.failed + " failed",
        table([
          { label: "Event", render: function (d) { return el("span", { class: "adm-mono", text: d.eventType }); } },
          { label: "Outcome", render: function (d) {
              // A duplicate is a success that correctly did nothing. It gets a
              // neutral pill on purpose: painting it red teaches whoever reads
              // this feed to ignore red rows.
              var tone = d.outcome === "failed" ? "danger" : d.outcome === "processed" ? "ok" : "";
              return pill(d.outcome, tone);
            } },
          { label: "Account", render: function (d) { return d.orgId || null; },
            unknownReason: function () {
              return "This delivery could not be attributed to an account — usually a customer with no org row.";
            } },
          { label: "Detail", wrap: true, render: function (d) { return d.error || ""; } },
          { label: "Received", render: function (d) { return fmtDateTime(d.receivedAt); } },
        ], data.webhooks.items, {
          emptyTitle: "No webhook deliveries recorded",
          emptyMessage: "Stripe has not delivered anything since delivery logging shipped.",
        }),
      ));

      var e = data.email.counts.last24h;
      var emailBody = table([
        { label: "Recipient", render: function (s2) { return s2.recipient; } },
        { label: "Template", render: function (s2) { return el("span", { class: "adm-mono", text: s2.template }); } },
        { label: "Outcome", render: function (s2) {
            var tone = s2.outcome === "sent" ? "ok" : s2.outcome === "failed" ? "danger" : "warn";
            return pill(s2.outcome, tone);
          } },
        { label: "Reason", render: function (s2) { return s2.reason ? el("span", { class: "adm-mono", text: s2.reason }) : ""; } },
        { label: "Sent", render: function (s2) { return fmtDateTime(s2.sentAt); } },
      ], data.email.items, {
        emptyTitle: "No email sends recorded",
        emptyMessage: "Nothing has attempted to send since send logging shipped.",
      });

      var emailRegion = region(
        "Transactional email",
        "24h — " + e.sent + " sent · " + e.skipped + " skipped · " + e.failed + " failed",
        emailBody,
        data.email.configured
          ? null
          : "Not configured, so every send silently does nothing. Missing: " + data.email.missing.join(", ") +
            ". A skipped send is not a failure and not a delivery — nothing left the building.",
      );
      mount.appendChild(emailRegion);

      if (data.mcp) mount.appendChild(mcpRegion(data.mcp));
    }).catch(function (err) {
      if (blocked) return;
      clear(mount); mount.appendChild(errorBox(err, renderAutomation));
    });
  }

  /**
   * MCP adoption over the last 30 days.
   *
   * Aggregate only — no organisation is named. The per-customer view is the
   * account drawer, where an operator is already looking at one customer on
   * purpose; a list of who is using a beta does not belong in a summary
   * somebody leaves open on a second monitor.
   */
  function mcpRegion(m) {
    var body = el("div", { class: "adm-mcp" });

    // "Off" and "on but unused" are different facts about a flagged surface,
    // and only one of them is a product problem. Said in words rather than
    // left to be inferred from a zero.
    var head = el("div", { class: "adm-mcp-state" }, [
      pill(m.enabled ? "enabled" : "disabled", m.enabled ? "ok" : ""),
      el("span", { class: "adm-region-meta",
        text: m.enabled
          ? (m.calls === 0 ? "on, and nothing has called it yet" : "on")
          : "off environment-wide; per-org flags may still enable it" }),
    ]);
    body.appendChild(head);

    var stats = el("div", { class: "adm-mcp-stats" }, [
      statCell("Calls", String(m.calls)),
      statCell("Orgs calling", String(m.orgsCalling)),
      statCell("Runs consumed", String(m.runsConsumed)),
      statCell("Refused for quota", String(m.quotaRefused)),
      // null is "no calls", not zero. A 0% error rate over zero calls
      // describes an untested surface, not a healthy one.
      statCell("Error rate", m.errorRate == null ? "no calls" : Math.round(m.errorRate * 100) + "%"),
      statCell("Avg duration", m.avgDurationMs == null ? "—" : m.avgDurationMs + "ms"),
      statCell("Orgs with a grant", String(m.oauth.orgsWithGrant)),
      statCell("Live tokens", String(m.oauth.liveTokens)),
    ]);
    body.appendChild(stats);

    if (m.topTools && m.topTools.length) {
      var list = el("div", { class: "adm-mcp-tools" });
      m.topTools.forEach(function (t) {
        list.appendChild(el("div", { class: "adm-mcp-tool" }, [
          el("span", { class: "adm-mono", text: t.tool }),
          el("span", { class: "adm-region-meta", text: t.calls + " calls" }),
          t.errors
            ? el("span", { class: "adm-region-meta", "data-tone": "warn",
                style: "color:var(--adm-warn)", text: t.errors + " failed" })
            : null,
        ]));
      });
      body.appendChild(list);
    }

    return region(
      "MCP",
      "last " + m.windowDays + " days",
      body,
      "Aggregate across all accounts. Tool arguments and results are never stored, " +
      "so this counts calls and outcomes only.",
    );
  }

  function statCell(label, value) {
    return el("div", { class: "adm-mcp-stat" }, [
      el("span", { class: "adm-mcp-stat-label", text: label }),
      el("span", { class: "adm-mcp-stat-value", text: value }),
    ]);
  }

  function deltaText(delta) {
    if (!delta) return null;
    var parts = [];
    if (delta.newCount) parts.push("+" + delta.newCount + " new");
    if (delta.resolvedCount) parts.push("−" + delta.resolvedCount + " resolved");
    if (!parts.length) parts.push("no change");
    return el("span", { class: "adm-mono", text: parts.join(" · ") });
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  var auditCursor = null;
  var auditRows = [];

  function auditTable(events, opts) {
    opts = opts || {};
    return table([
      { label: "When", render: function (e) {
          return el("span", { class: "adm-mono", title: fmtDateTime(e.createdAt), text: fmtRelative(e.createdAt) });
        } },
      { label: "Actor", render: function (e) {
          // `system` is typeset differently so an unattended change is never
          // read as somebody's doing.
          return e.system
            ? pill("system", "")
            : el("span", { class: "adm-mono", text: e.actor });
        } },
      { label: "Action", render: function (e) { return el("span", { class: "adm-mono", text: e.action }); } },
      { label: "Target", render: function (e) {
          if (!e.targetId) return "";
          return el("span", { class: "adm-mono", text: (e.targetType ? e.targetType + " " : "") + e.targetId });
        } },
      { label: "Account", render: function (e) { return e.orgId ? el("span", { class: "adm-mono", text: e.orgId }) : ""; } },
      { label: "Detail", wrap: true, render: function (e) {
          return e.metadata ? el("span", { class: "adm-mono", style: "font-size:11px;color:var(--adm-dim)",
            text: describeMetadata(e.metadata) }) : "";
        } },
    ], events, {
      emptyTitle: opts.compact ? "No activity yet" : "No audit entries match",
      emptyMessage: opts.compact
        ? "Privileged actions appear here as they happen."
        : "Clear the filters, or wait for the next privileged action.",
    });
  }

  function describeMetadata(meta) {
    if (meta.changes) {
      return Object.keys(meta.changes).map(function (k) {
        var c = meta.changes[k];
        return k + ": " + String(c.from) + " → " + String(c.to);
      }).join(", ");
    }
    if (meta.from && meta.to && meta.to.rolloutPct !== undefined) {
      return (meta.from.enabled ? "on" : "off") + " " + meta.from.rolloutPct + "% → " +
             (meta.to.enabled ? "on" : "off") + " " + meta.to.rolloutPct + "%";
    }
    return Object.keys(meta).map(function (k) {
      var v = meta[k];
      return k + "=" + (typeof v === "object" ? JSON.stringify(v) : String(v));
    }).join(" · ");
  }

  function renderAudit(append) {
    var mount = $("#adm-audit-table");
    if (!append) { clear(mount); mount.appendChild(skeleton(10)); auditRows = []; auditCursor = null; }

    var params = ["limit=50"];
    var actor = $("#adm-audit-actor").value.trim();
    var action = $("#adm-audit-action").value;
    if (actor) params.push("actor=" + encodeURIComponent(actor));
    if (action) params.push("action=" + encodeURIComponent(action));
    if (append && auditCursor) params.push("before=" + encodeURIComponent(auditCursor));

    return api("/api/admin/audit?" + params.join("&")).then(function (data) {
      // Populate the filter menu from the server's own vocabulary so it can
      // never drift from the actions the writers actually emit.
      var select = $("#adm-audit-action");
      if (select.options.length <= 1 && data.actions) {
        data.actions.forEach(function (a) { select.appendChild(el("option", { value: a, text: a })); });
        select.value = action;
      }
      auditRows = auditRows.concat(data.events);
      auditCursor = data.cursor;
      $("#adm-audit-stamp").textContent = auditRows.length + " entr" + (auditRows.length === 1 ? "y" : "ies") +
        (data.hasMore ? " (more available)" : "");
      clear(mount);
      mount.appendChild(auditTable(auditRows, {}));
      $("#adm-audit-more").hidden = !data.hasMore;
    }).catch(function (err) {
      if (blocked) return;
      clear(mount); mount.appendChild(errorBox(err, function () { renderAudit(false); }));
    });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  var settingsTab = "access";
  var settingsData = null;

  function renderSettings() {
    var mount = $("#adm-settings-body");
    $$("#adm-settings-tabs .adm-tab").forEach(function (t) {
      t.setAttribute("aria-selected", t.getAttribute("data-subnav") === settingsTab ? "true" : "false");
    });
    $$("#adm-nav-settings-sub .adm-nav-subbtn").forEach(function (t) {
      if (t.getAttribute("data-subnav") === settingsTab) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });

    if (settingsTab === "flags") return renderFlags(mount);

    clear(mount); mount.appendChild(region("Loading", null, skeleton(5)));
    return api("/api/admin/settings").then(function (data) {
      settingsData = data;
      applyEnvBar(data);
      clear(mount);
      if (settingsTab === "access")      renderAccess(mount, data);
      if (settingsTab === "connections") renderConnections(mount, data);
      if (settingsTab === "environment") renderEnvironment(mount, data);
    }).catch(function (err) {
      if (blocked) return;
      clear(mount); mount.appendChild(errorBox(err, renderSettings));
    });
  }

  function renderAccess(mount, data) {
    mount.appendChild(region(
      "Administrators", data.admins.emails.length + " on the allowlist",
      table([
        { label: "Email", render: function (a) { return el("span", { class: "adm-mono", text: a.email }); } },
        { label: "", render: function (a) { return a.self ? pill("you", "accent") : ""; } },
        { label: "Access", render: function () { return pill("full", ""); } },
      ], data.admins.emails, { emptyTitle: "No administrators configured", emptyMessage: "ADMIN_EMAILS is empty, which locks everyone out of this panel." }),
      data.admins.note + " Source: " + data.admins.source + ".",
    ));
  }

  function renderConnections(mount, data) {
    mount.appendChild(region(
      "Connections", null,
      table([
        { label: "Service", render: function (c) { return c.name; } },
        { label: "State", render: function (c) {
            return c.configured ? pill("configured", "ok") : pill("not configured", "warn");
          } },
        { label: "Detail", wrap: true, render: function (c) {
            if (!c.note) return c.detail;
            // A deliberate opt-out still owes the reader what it costs.
            return el("span", {}, [
              c.detail,
              el("span", { style: "display:block;margin-top:2px;color:var(--adm-muted)", text: c.note }),
            ]);
          } },
        { label: "Missing", wrap: true, render: function (c) {
            return c.missing.length
              ? el("span", { class: "adm-mono", style: "color:var(--adm-warn)", text: c.missing.join(", ") })
              : "";
          } },
        { label: "", render: function (c) {
            return c.testEndpoint
              ? el("button", { class: "adm-btn adm-btn-sm", type: "button", text: "Test",
                  onclick: function () { testConnection(c); } })
              : "";
          } },
      ], data.connections, { emptyTitle: "No connections", emptyMessage: "" }),
      "\"Not configured\" is not an outage — nothing is broken, the integration simply has no credentials. " +
      "The two need different responses, which is why they are different words here.",
    ));
  }

  function testConnection(c) {
    toast("Testing " + c.name + "…");
    api(c.testEndpoint).then(function (res) {
      // `summary` is stripe-check's shape, `message` is sandbox-check's. Take
      // whichever the endpoint actually sent: falling through to "checks
      // failed" would discard the one sentence that says what to do about it.
      var detail = res.summary || res.message || (res.ok ? "all checks passed" : "checks failed");
      toast(c.name + ": " + detail, res.ok ? "ok" : "danger");
    }).catch(function (err) {
      if (blocked) return;
      toast(c.name + ": " + err.message, "danger");
    });
  }

  function renderEnvironment(mount, data) {
    var envRows = [
      { k: "Environment", v: data.environment.name || null,
        reason: "ENVIRONMENT_NAME is not set on this deployment." },
      { k: "Site origin", v: data.environment.siteOrigin || null,
        reason: "SITE_ORIGIN is not set, which breaks magic links and checkout redirects." },
      { k: "Stripe mode", v: data.environment.stripeMode || null,
        reason: "No Stripe key is set, so there is no mode to report." },
    ];
    mount.appendChild(region(
      "Deployment", null,
      table([
        { label: "Setting", render: function (r) { return r.k; } },
        { label: "Value", render: function (r) { return r.v ? el("span", { class: "adm-mono", text: r.v }) : null; },
          unknownReason: function (r) { return r.reason; } },
      ], envRows, { emptyTitle: "", emptyMessage: "" }),
    ));

    mount.appendChild(region(
      "Bindings", null,
      table([
        { label: "Binding", render: function (b) { return el("span", { class: "adm-mono", text: b.name }); } },
        { label: "State", render: function (b) { return b.set ? pill("bound", "ok") : pill("absent", "warn"); } },
      ], data.environment.bindings, { emptyTitle: "", emptyMessage: "" }),
      "Presence only. This endpoint never returns a binding's value — a configuration report " +
      "that echoes secrets is a way to exfiltrate them.",
    ));

    if (data.environment.counts) {
      var counts = Object.keys(data.environment.counts).map(function (k) {
        return { k: k, v: data.environment.counts[k] };
      });
      mount.appendChild(region("Data", null, table([
        { label: "Table", render: function (r) { return r.k; } },
        { label: "Rows", numeric: true, render: function (r) { return fmtInt(r.v); } },
      ], counts, { emptyTitle: "", emptyMessage: "" })));
    }

    var schemaMount = el("div");
    mount.appendChild(region("Schema", null, schemaMount,
      "Reports schema STATE, not migration history — there is no ledger table."));
    schemaMount.appendChild(skeleton(4));
    api(data.environment.schemaEndpoint).then(function (schema) {
      clear(schemaMount);
      schemaMount.appendChild(table([
        { label: "Migration", render: function (m) { return el("span", { class: "adm-mono", text: m.migration + " " + m.name }); } },
        { label: "State", render: function (m) { return m.applied ? pill("applied", "ok") : pill("pending", "danger"); } },
        { label: "Checks", wrap: true, render: function (m) {
            return el("span", { class: "adm-mono", style: "font-size:11px;color:var(--adm-dim)",
              text: m.checks.map(function (c) { return (c.present ? "✓ " : "✗ ") + c.target; }).join("  ") });
          } },
      ], schema.migrations, { emptyTitle: "", emptyMessage: "" }));
      if (!schema.ok) {
        schemaMount.appendChild(el("div", { class: "adm-note", text: schema.summary }));
        setBadge("settings", schema.pending.length, "danger");
      }
    }).catch(function (err) {
      if (blocked) return;
      clear(schemaMount); schemaMount.appendChild(errorBox(err, null));
    });
  }

  function renderFlags(mount) {
    clear(mount); mount.appendChild(region("Feature flags", null, skeleton(5)));
    return api("/api/admin/flags").then(function (data) {
      clear(mount);
      var body = el("div");
      if (!data.flags.length) {
        body.appendChild(stateBox("empty", "No feature flags",
          "Flags appear here once something creates one. Create one below to gate a feature."));
      }
      data.flags.forEach(function (f) { body.appendChild(flagRow(f)); });
      mount.appendChild(region("Feature flags", data.flags.length + " defined", body,
        "A flag fails closed: an unknown flag, or an unreachable database, resolves to off. " +
        "A partial rollout buckets deterministically per user, so nobody flips in and out between page loads."));
      mount.appendChild(newFlagForm());
    }).catch(function (err) {
      if (blocked) return;
      clear(mount); mount.appendChild(errorBox(err, function () { renderFlags(mount); }));
    });
  }

  function flagRow(f) {
    var pct = el("input", {
      class: "adm-input adm-flag-pct", type: "number", min: "0", max: "100", step: "1",
      value: String(f.rolloutPct), "aria-label": "Rollout percentage for " + f.key,
    });
    var toggle = el("button", {
      class: "adm-btn " + (f.enabled ? "adm-btn-primary" : ""), type: "button",
      text: f.enabled ? "On" : "Off",
      "aria-pressed": f.enabled ? "true" : "false",
      onclick: function () { setFlag(f.key, { enabled: !f.enabled }); },
    });
    return el("div", { class: "adm-flag" }, [
      el("div", { class: "adm-flag-main" }, [
        el("span", { class: "adm-flag-key", text: f.key }),
        f.description ? el("span", { class: "adm-flag-desc", text: f.description }) : null,
        el("span", { class: "adm-flag-meta",
          text: (f.updatedBy ? "last set by " + f.updatedBy : "never set by a person") +
                " · " + (fmtRelative(f.updatedAt) || "") }),
      ]),
      el("div", { class: "adm-flag-controls" }, [
        pct,
        el("span", { class: "adm-flag-meta", text: "%" }),
        el("button", {
          class: "adm-btn adm-btn-sm", type: "button", text: "Set",
          onclick: function () { setFlag(f.key, { rolloutPct: Number(pct.value) }); },
        }),
        toggle,
      ]),
    ]);
  }

  function newFlagForm() {
    var key = el("input", { class: "adm-input", type: "text", placeholder: "flag_key", "aria-label": "New flag key" });
    var desc = el("input", { class: "adm-input", type: "text", placeholder: "What does it gate?", "aria-label": "New flag description" });
    return region("Create a flag", null, el("div", { class: "adm-flag" }, [
      el("div", { class: "adm-flag-main" }, [
        el("div", { class: "adm-filters" }, [key, desc]),
        el("span", { class: "adm-flag-meta",
          text: "Created OFF at 100%. A flag that springs into existence enabled is indistinguishable " +
                "from shipping the feature by accident." }),
      ]),
      el("div", { class: "adm-flag-controls" }, [
        el("button", {
          class: "adm-btn adm-btn-primary", type: "button", text: "Create",
          onclick: function () {
            var k = key.value.trim();
            if (!k) { toast("Give the flag a key first.", "danger"); return; }
            setFlag(k, { enabled: false, description: desc.value.trim() || undefined });
            key.value = ""; desc.value = "";
          },
        }),
      ]),
    ]));
  }

  function setFlag(key, patch) {
    return api("/api/admin/flags/" + encodeURIComponent(key), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(function (res) {
      toast(key + " — " + (res.flag.enabled ? "on" : "off") + " at " + res.flag.rolloutPct + "%", "ok");
      announce("Flag " + key + " updated");
      renderFlags($("#adm-settings-body"));
    }).catch(function (err) {
      if (blocked) return;
      toast(err.message, "danger");
    });
  }

  // -------------------------------------------------------------------------
  // Drawers
  // -------------------------------------------------------------------------

  var openDrawerNode = null;
  var lastFocus = null;

  function openDrawer(title, subtitle) {
    closeDrawer();
    lastFocus = document.activeElement;
    var scrim = el("div", { class: "adm-scrim", onclick: closeDrawer });
    var body = el("div", { class: "adm-drawer-body" });
    var drawer = el("aside", {
      class: "adm-drawer", role: "dialog", "aria-modal": "true", "aria-label": title,
    }, [
      el("div", { class: "adm-drawer-head" }, [
        el("div", null, [
          el("h2", { class: "adm-drawer-title", text: title }),
          subtitle ? el("span", { class: "adm-drawer-sub", text: subtitle }) : null,
        ]),
        el("button", { class: "adm-btn adm-btn-sm", type: "button", text: "Close", onclick: closeDrawer }),
      ]),
      body,
    ]);
    document.body.appendChild(scrim);
    document.body.appendChild(drawer);
    openDrawerNode = { scrim: scrim, drawer: drawer };
    drawer.querySelector("button").focus();
    return body;
  }

  function closeDrawer() {
    if (!openDrawerNode) return;
    openDrawerNode.scrim.remove();
    openDrawerNode.drawer.remove();
    openDrawerNode = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function defList(pairs) {
    var dl = el("dl", { class: "adm-deflist" });
    pairs.forEach(function (p) {
      if (!p) return;
      dl.appendChild(el("dt", { text: p[0] }));
      var dd = el("dd");
      var v = p[1];
      if (v === null || v === undefined) dd.appendChild(unknown(p[2]));
      else if (typeof v === "string") dd.textContent = v;
      else dd.appendChild(v);
      dl.appendChild(dd);
    });
    return dl;
  }

  function openUser(userId) {
    var body = openDrawer("User", userId);
    body.appendChild(skeleton(8));
    api("/api/admin/users/" + encodeURIComponent(userId)).then(function (data) {
      clear(body);
      var u = data.user;
      body.appendChild(el("h3", { style: "margin:0;font-size:14px", text: u.email }));
      body.appendChild(defList([
        ["User id", el("span", { class: "adm-mono", text: u.userId })],
        ["Signed up", fmtDateTime(u.createdAt)],
        ["Sign-in", u.authMethodKnown ? u.authMethod.replace(/_/g, " ") : null,
         "This account predates the auth-method column and has not signed in since."],
        ["Last run", fmtDateTime(u.lastRunAt),
         "This user has never run an analyzer. We do not store a separate last-active timestamp."],
        ["Stripe customer", u.stripeCustomerId ? el("span", { class: "adm-mono", text: u.stripeCustomerId }) : null,
         "This user has never been through checkout."],
      ]));

      body.appendChild(region("Organisations", null, table([
        { label: "Account", render: function (m) { return m.orgName || m.orgId; } },
        { label: "Role", render: function (m) { return pill(m.role, m.role === "owner" ? "accent" : ""); } },
        { label: "Status", render: function (m) { return statusPill(m.subStatus); } },
        { label: "Joined", render: function (m) { return fmtDate(m.joinedAt); } },
      ], data.memberships, { emptyTitle: "No memberships", emptyMessage: "This user is not in any organisation." })));

      body.appendChild(region(
        "Sessions",
        data.sessions.length + (data.sessionsComplete ? "" : "+"),
        table([
          { label: "Device", wrap: true, render: function (s) { return s.userAgent || null; },
            unknownReason: function () { return "No user agent was captured when this session was issued."; } },
          { label: "Where", render: function (s) {
              return s.country || s.ip ? el("span", { class: "adm-mono", text: [s.country, s.ip].filter(Boolean).join(" · ") }) : null;
            },
            unknownReason: function () { return "No location headers were present — normal outside Cloudflare."; } },
          { label: "Started", render: function (s) { return fmtRelative(s.issuedAt); } },
          { label: "", render: function (s) {
              return el("button", {
                class: "adm-btn adm-btn-sm adm-btn-danger", type: "button", text: "Revoke",
                onclick: function () { revokeSession(userId, s.sessionId); },
              });
            } },
        ], data.sessions, {
          emptyTitle: "No sessions listed",
          emptyMessage: "Either this user is signed out everywhere, or their sessions predate the session index.",
        }),
        data.sessionsNote,
      ));

      body.appendChild(region("Activity", null, auditTable(data.activity, { compact: true })));
    }).catch(function (err) {
      if (blocked) return;
      clear(body); body.appendChild(errorBox(err, function () { openUser(userId); }));
    });
  }

  function revokeSession(userId, sessionId) {
    if (!window.confirm(
      "Revoke this session?\n\nThe person will be signed out immediately, mid-task, with no warning. " +
      "This is recorded in the audit log against your email.")) return;
    api("/api/admin/users/" + encodeURIComponent(userId) + "/sessions/" + encodeURIComponent(sessionId), {
      method: "DELETE",
    }).then(function () {
      toast("Session revoked", "ok");
      openUser(userId);
    }).catch(function (err) {
      if (blocked) return;
      toast(err.message, "danger");
    });
  }

  function openAccount(orgId) {
    var body = openDrawer("Account", orgId);
    body.appendChild(skeleton(10));
    api("/api/admin/accounts/" + encodeURIComponent(orgId)).then(function (data) {
      clear(body);
      var a = data.account;
      body.appendChild(el("h3", { style: "margin:0;font-size:14px", text: a.name }));
      body.appendChild(defList([
        ["Org id", el("span", { class: "adm-mono", text: a.orgId })],
        ["Tier", a.tier ? pill(a.tier, "accent") : pill("unconfigured price", "warn")],
        ["Status", statusPill(a.subStatus)],
        ["Entitlement", a.entitlement
          ? el("span", null, [
              pill(a.entitlement.active ? "active" : "not entitled", a.entitlement.active ? "ok" : "danger"),
              el("span", { class: "adm-mono", style: "margin-left:8px;color:var(--adm-dim)", text: a.entitlement.reason }),
            ])
          : null,
         "The entitlement resolver failed for this account — distinct from 'not entitled'."],
        ["Paid through", fmtDate(a.currentPeriodEnd), "No paid-through date is stored for this account."],
        ["Seats", el("span", { class: "adm-mono",
          text: a.seatsUsed + " of " + a.seatsPurchased + (a.seatsOver ? " (+" + a.seatsOver + " over)" : "") })],
        ["MRR", a.mrrKnown ? fmtMoney(a.mrr, "usd") : null, reasonText(a.mrrReason)],
        ["Stripe customer", a.stripeCustomerId ? el("span", { class: "adm-mono", text: a.stripeCustomerId }) : null,
         "This account has never been through checkout."],
      ]));

      body.appendChild(region("Members", data.members.length + "", table([
        { label: "Email", render: function (m) { return m.email || null; },
          unknownReason: function () { return "This membership points at a user row that no longer exists."; } },
        { label: "Role", render: function (m) { return pill(m.role, m.role === "owner" ? "accent" : ""); } },
        { label: "Sign-in", render: function (m) { return m.authMethodKnown ? m.authMethod.replace(/_/g, " ") : null; },
          unknownReason: function () { return "This account predates the auth-method column."; } },
        { label: "Joined", render: function (m) { return fmtDate(m.joinedAt); } },
      ], data.members, { emptyTitle: "No members", emptyMessage: "" })));

      body.appendChild(region("API keys", null, table([
        { label: "Name", render: function (k) { return k.name; } },
        { label: "Prefix", render: function (k) { return el("span", { class: "adm-mono", text: k.prefix }); } },
        { label: "Last used", render: function (k) { return fmtRelative(k.lastUsedAt); },
          unknownReason: function () { return "This key has never been used."; } },
        { label: "State", render: function (k) { return k.revokedAt ? pill("revoked", "danger") : pill("live", "ok"); } },
      ], data.apiKeys, { emptyTitle: "No API keys", emptyMessage: "This account has not created any." })));

      body.appendChild(region("Monitors", null, table([
        { label: "Repository", render: function (m) { return m.repoUrl.replace(/^https?:\/\/github\.com\//, ""); } },
        { label: "Last run", render: function (m) {
            if (m.pausedAt) return pill("paused", "");
            if (m.neverRun) return pill("never run", "warn");
            return fmtRelative(m.lastRunAt);
          } },
      ], data.monitors, { emptyTitle: "No monitors", emptyMessage: "" })));

      var invoiceMount = el("div");
      body.appendChild(region("Invoices", null, invoiceMount));
      invoiceMount.appendChild(skeleton(3));
      api("/api/admin/accounts/" + encodeURIComponent(orgId) + "/invoices").then(function (res) {
        clear(invoiceMount);
        if (res.invoices === null) {
          // Explicitly NOT an empty table. An empty invoice list and an
          // unreachable Stripe look identical on screen and mean opposites.
          invoiceMount.appendChild(stateBox("error", "Invoices unavailable", reasonText(res.reason)));
          return;
        }
        invoiceMount.appendChild(table([
          { label: "Invoice", render: function (i) { return el("span", { class: "adm-mono", text: i.number || i.id }); } },
          { label: "Amount", numeric: true, render: function (i) { return fmtMoney(i.amountDue, i.currency); } },
          { label: "Status", render: function (i) {
              var tone = i.status === "paid" ? "ok" : i.status === "open" ? "warn" : "";
              return pill(i.status, tone);
            } },
          { label: "Attempts", numeric: true, render: function (i) { return i.attemptCount === null ? "" : String(i.attemptCount); } },
          { label: "Date", render: function (i) { return fmtDate(i.created); } },
          { label: "", render: function (i) {
              return i.hostedInvoiceUrl
                ? el("a", { class: "adm-btn adm-btn-sm", href: i.hostedInvoiceUrl, target: "_blank", rel: "noopener", text: "Open" })
                : "";
            } },
        ], res.invoices, {
          emptyTitle: "No invoices",
          emptyMessage: res.reason === "no_stripe_customer"
            ? "This account has never been through checkout."
            : "Stripe holds no invoices for this customer.",
        }));
      }).catch(function (err) {
        if (blocked) return;
        clear(invoiceMount); invoiceMount.appendChild(errorBox(err, null));
      });

      body.appendChild(region("Webhooks", null, table([
        { label: "Event", render: function (w) { return el("span", { class: "adm-mono", text: w.eventType }); } },
        { label: "Outcome", render: function (w) {
            return pill(w.outcome, w.outcome === "failed" ? "danger" : w.outcome === "processed" ? "ok" : "");
          } },
        { label: "When", render: function (w) { return fmtRelative(w.receivedAt); } },
      ], data.webhooks, { emptyTitle: "No deliveries", emptyMessage: "" })));

      body.appendChild(region("Audit", null, auditTable(data.audit, { compact: true })));
    }).catch(function (err) {
      if (blocked) return;
      clear(body); body.appendChild(errorBox(err, function () { openAccount(orgId); }));
    });
  }

  // -------------------------------------------------------------------------
  // Command palette
  // -------------------------------------------------------------------------

  var paletteNode = null;
  var paletteIndex = 0;
  var paletteItems = [];

  function openPalette() {
    if (paletteNode) return;
    var scrim = el("div", { class: "adm-scrim", onclick: closePalette });
    var input = el("input", {
      class: "adm-palette-input", type: "text", placeholder: "Jump to a section, account or user…",
      "aria-label": "Command palette",
    });
    var list = el("ul", { class: "adm-palette-list", role: "listbox" });
    var box = el("div", { class: "adm-palette", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" }, [input, list]);
    document.body.appendChild(scrim);
    document.body.appendChild(box);
    paletteNode = { scrim: scrim, box: box, input: input, list: list };

    input.addEventListener("input", function () { fillPalette(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); }
      else if (e.key === "Enter") { e.preventDefault(); if (paletteItems[paletteIndex]) paletteItems[paletteIndex].run(); }
      else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
    });
    fillPalette("");
    input.focus();
  }

  function closePalette() {
    if (!paletteNode) return;
    paletteNode.scrim.remove();
    paletteNode.box.remove();
    paletteNode = null;
  }

  var SECTIONS = [
    { kind: "section", label: "Overview", to: "overview" },
    { kind: "section", label: "Accounts", to: "accounts" },
    { kind: "section", label: "Users", to: "users" },
    { kind: "section", label: "Billing", to: "billing" },
    { kind: "section", label: "Automation", to: "automation" },
    { kind: "section", label: "Audit log", to: "audit" },
    { kind: "section", label: "Settings", to: "settings" },
  ];

  function fillPalette(query) {
    var q = query.trim().toLowerCase();
    paletteItems = [];

    SECTIONS.forEach(function (s) {
      if (q && s.label.toLowerCase().indexOf(q) === -1) return;
      paletteItems.push({
        kind: "go to", label: s.label, meta: "",
        run: function () { closePalette(); go(s.to); },
      });
    });

    if (q.length >= 2) {
      accountsCache.forEach(function (a) {
        if (a.name.toLowerCase().indexOf(q) === -1 &&
            a.orgId.toLowerCase().indexOf(q) === -1 &&
            (a.stripeCustomerId || "").toLowerCase().indexOf(q) === -1) return;
        paletteItems.push({
          kind: "account", label: a.name, meta: a.subStatus || "no subscription",
          run: function () { closePalette(); openAccount(a.orgId); },
        });
      });
    }

    paletteIndex = 0;
    renderPalette(q);
  }

  function renderPalette(q) {
    var list = paletteNode.list;
    clear(list);
    if (!paletteItems.length) {
      list.appendChild(el("li", null, [
        el("div", { class: "adm-palette-empty",
          text: q ? "Nothing matches “" + q + "”. Accounts are searchable once the Accounts page has loaded." : "Type to search." }),
      ]));
      return;
    }
    paletteItems.forEach(function (item, i) {
      list.appendChild(el("li", { role: "presentation" }, [
        el("button", {
          class: "adm-palette-item", type: "button", role: "option",
          "aria-selected": i === paletteIndex ? "true" : "false",
          onclick: item.run,
        }, [
          el("span", { class: "adm-palette-kind", text: item.kind }),
          el("span", { class: "adm-palette-label", text: item.label }),
          el("span", { class: "adm-palette-meta", text: item.meta || "" }),
        ]),
      ]));
    });
  }

  function movePalette(delta) {
    if (!paletteItems.length) return;
    paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
    $$(".adm-palette-item", paletteNode.list).forEach(function (b, i) {
      b.setAttribute("aria-selected", i === paletteIndex ? "true" : "false");
      if (i === paletteIndex && b.scrollIntoView) b.scrollIntoView({ block: "nearest" });
    });
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  var PAGES = {
    overview:   { id: "adm-page-overview",   load: renderOverview },
    accounts:   { id: "adm-page-accounts",   load: renderAccounts },
    users:      { id: "adm-page-users",      load: renderUsers },
    billing:    { id: "adm-page-billing",    load: renderBilling },
    automation: { id: "adm-page-automation", load: renderAutomation },
    audit:      { id: "adm-page-audit",      load: function () { return renderAudit(false); } },
    settings:   { id: "adm-page-settings",   load: renderSettings },
  };

  var currentPage = null;

  function go(page, options) {
    options = options || {};
    if (!PAGES[page] || blocked) return;
    currentPage = page;
    document.body.setAttribute("data-page", page);
    $$(".adm-page").forEach(function (p) { p.hidden = p.id !== PAGES[page].id; });
    $$("#adm-nav .adm-nav-btn").forEach(function (b) {
      if (b.getAttribute("data-nav") === page) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    $("#adm-nav-settings-sub").hidden = page !== "settings";
    if (!options.silent) {
      var hash = "#" + page + (page === "settings" ? "/" + settingsTab : "");
      if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
    }
    PAGES[page].load();
  }

  function readHash() {
    var raw = (window.location.hash || "").replace(/^#/, "");
    if (!raw) return { page: "overview" };
    var parts = raw.split("/");
    return { page: PAGES[parts[0]] ? parts[0] : "overview", sub: parts[1] };
  }

  function applyEnvBar(data) {
    var bar = $("#adm-envbar");
    var name = (data && data.environment && data.environment.name) || null;
    var mode = (data && data.environment && data.environment.stripeMode) || null;
    // Production is called out in red because acting on production while
    // believing you are on staging is the most expensive mistake this
    // surface allows. An unnamed environment stays neutral rather than
    // being assumed safe.
    var kind = name === "production" ? "production" : name === "staging" ? "staging" : "unknown";
    bar.setAttribute("data-env", kind);
    $("#adm-env-mark").textContent = kind === "production" ? "●" : kind === "staging" ? "◐" : "○";
    $("#adm-env-name").textContent = name || "environment not named";
    $("#adm-env-detail").textContent = mode
      ? "Stripe " + mode + " mode" + (mode === "live" ? " — real cards" : "")
      : "no Stripe key set";
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function boot() {
    $$("[data-nav]").forEach(function (b) {
      b.addEventListener("click", function () { go(b.getAttribute("data-nav")); });
    });
    $$("[data-subnav]").forEach(function (b) {
      b.addEventListener("click", function () {
        settingsTab = b.getAttribute("data-subnav");
        go("settings");
      });
    });

    $("#adm-palette-open").addEventListener("click", openPalette);
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
      else if (e.key === "Escape") { closePalette(); closeDrawer(); }
    });

    var debounce = null;
    function onFilter(fn) {
      return function () {
        clearTimeout(debounce);
        debounce = setTimeout(fn, 220);
      };
    }
    $("#adm-accounts-q").addEventListener("input", onFilter(renderAccounts));
    $("#adm-accounts-status").addEventListener("change", renderAccounts);
    $("#adm-accounts-refresh").addEventListener("click", renderAccounts);
    $("#adm-users-q").addEventListener("input", onFilter(renderUsers));
    $("#adm-users-plan").addEventListener("change", renderUsers);
    $("#adm-users-refresh").addEventListener("click", renderUsers);
    $("#adm-audit-actor").addEventListener("input", onFilter(function () { renderAudit(false); }));
    $("#adm-audit-action").addEventListener("change", function () { renderAudit(false); });
    $("#adm-audit-refresh").addEventListener("click", function () { renderAudit(false); });
    $("#adm-audit-more").addEventListener("click", function () { renderAudit(true); });

    $("#adm-signout").addEventListener("click", function () {
      fetch(apiUrl("/api/logout"), { method: "POST", credentials: "include" })
        .then(function () { window.location.href = "/"; })
        .catch(function () { window.location.href = "/"; });
    });

    window.addEventListener("hashchange", function () {
      var h = readHash();
      if (h.sub) settingsTab = h.sub;
      if (h.page !== currentPage || h.sub) go(h.page, { silent: true });
    });

    // Identity first: it is the fastest way to find out we are blocked, and
    // rendering a page of skeletons behind a 403 is worse than not starting.
    api("/api/me").then(function (me) {
      $("#adm-whoami").textContent = (me && me.email) || "";
    }).catch(function () { /* blocked() has already taken over if it was 401 */ });

    // The environment banner comes from /settings, which is also the cheapest
    // admin-gated call — so it doubles as the gate check.
    api("/api/admin/settings").then(function (data) {
      settingsData = data;
      applyEnvBar(data);
    }).catch(function () { /* handled by block() */ });

    var start = readHash();
    if (start.sub) settingsTab = start.sub;
    go(start.page, { silent: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
