// Algosize admin page — vanilla JS only.
//
// Loads the signed-up email roster from /api/admin/users (gated by the
// requireAdmin middleware on the Worker — non-admins get 403, unauth'd
// get 401 and are bounced back to /). Renders the list as a table with
// a CSV-export link that hits /api/admin/users.csv.

(function () {
  "use strict";

  function apiUrl(path) {
    var base = (window.ALGOSIZE_API_BASE || "").replace(/\/$/, "");
    return base + path;
  }

  function $(sel) { return document.querySelector(sel); }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === "class") n.className = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
    }
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDate(unixSec) {
    if (!unixSec) return "—";
    var d = new Date(unixSec * 1000);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
      " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC";
  }

  function showError(title, msg) {
    var box = $("#admin-error");
    var t = $("#admin-error-title");
    var m = $("#admin-error-msg");
    if (t) t.textContent = title;
    if (m) m.textContent = msg;
    if (box) box.hidden = false;
    var table = $("#admin-users-table");
    if (table) table.innerHTML = "";
  }

  function renderRows(items) {
    var wrap = el("div", { class: "admin-table-wrap" });
    var table = el("table", { class: "admin-table" });
    var thead = el("thead");
    var trh = el("tr");
    ["Email", "Plan", "Sub status", "Stripe customer", "Signed up"].forEach(function (h) {
      trh.appendChild(el("th", null, h));
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    var tbody = el("tbody");
    items.forEach(function (u) {
      var tr = el("tr");
      tr.appendChild(el("td", { class: "mono" }, u.email));

      var planTd = el("td");
      var planPill = el("span", {
        class: "admin-pill " + (u.plan === "paid" ? "admin-pill-paid" : "admin-pill-free"),
      }, u.plan || "free");
      planTd.appendChild(planPill);
      tr.appendChild(planTd);

      var subTd = el("td");
      var sub = u.subStatus;
      var subClass = sub === "active" ? "admin-pill-active"
        : sub === "inactive" ? "admin-pill-inactive"
        : "admin-pill-none";
      subTd.appendChild(el("span", { class: "admin-pill " + subClass }, sub || "—"));
      tr.appendChild(subTd);

      tr.appendChild(el("td", { class: "mono" }, u.stripeCustomerId || "—"));
      tr.appendChild(el("td", { class: "mono" }, fmtDate(u.createdAt)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function loadUsers() {
    var container = $("#admin-users-table");
    var countEl = $("#admin-user-count");
    if (container) container.innerHTML = '<div class="panel-empty">Loading users…</div>';

    fetch(apiUrl("/api/admin/users"), {
      method: "GET",
      headers: { "Accept": "application/json" },
      credentials: "include",
    }).then(function (res) {
      if (res.status === 401) {
        // Not signed in — bounce to home where they can request a magic link.
        window.location.assign("/?auth=required");
        return null;
      }
      if (res.status === 403) {
        showError("Access denied", "You're signed in but this account is not on the admin allowlist.");
        return null;
      }
      return res.json().then(function (body) {
        if (!res.ok) throw new Error((body && body.message) || ("HTTP " + res.status));
        return body;
      });
    }).then(function (body) {
      if (!body) return;
      if (countEl) countEl.textContent = body.count;
      if (container) {
        container.innerHTML = "";
        if (!body.items || !body.items.length) {
          container.appendChild(el("div", { class: "panel-empty" }, "No users yet."));
        } else {
          container.appendChild(renderRows(body.items));
        }
      }
    }).catch(function (err) {
      console.error("admin load error", err);
      if (container) {
        container.innerHTML = "";
        container.appendChild(el("div", { class: "panel-empty" },
          "Could not load users: " + (err.message || "unknown error")));
      }
    });
  }

  function loadMe() {
    fetch(apiUrl("/api/me"), { credentials: "include" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        if (!body) return;
        var emailEl = $("#admin-user-email");
        if (emailEl && body.email) {
          emailEl.textContent = body.email;
          emailEl.hidden = false;
        }
      }).catch(function () { /* non-fatal */ });
  }

  function attach() {
    // CSV download URL — same endpoint, content-disposition does the rest.
    var csvBtn = $("#admin-csv-btn");
    if (csvBtn) csvBtn.href = apiUrl("/api/admin/users.csv");

    var refreshBtn = $("#admin-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", loadUsers);

    var logoutBtn = $("#admin-logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        fetch(apiUrl("/api/logout"), { method: "POST", credentials: "include" })
          .finally(function () { window.location.assign("/"); });
      });
    }

    loadMe();
    loadUsers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
