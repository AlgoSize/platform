// Team screen (D-2) — organisation, members, invites, API keys, branding.
//
// Everything here is wired to endpoints that exist on the Worker today:
//   GET    /api/org                    org + role + members + pendingInvites + branding
//   POST   /api/org/invite             402 seat_limit_reached → the seats dialog
//   DELETE /api/org/members/:userId
//   GET    /api/keys                   prefix + lifecycle only, never the secret
//   POST   /api/keys                   the one response that carries the full key
//   DELETE /api/keys/:id
//   PUT    /api/org/branding           Firm tier only — 402 white_label_not_available
//
// Role gating follows the spec's rule: an action the viewer can't take is
// not rendered disabled — it isn't rendered. The Worker enforces the same
// rules server-side; the UI just doesn't paint doors that are locked.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  var state = {
    loaded: false,
    org: null,        // GET /api/org response
    inviteRole: "member",
    pendingRevoke: null,   // key row awaiting confirm
  };

  function canManage() {
    return state.org && (state.org.role === "owner" || state.org.role === "admin");
  }

  function roleChip(role) {
    var chip = el("span", { class: "chip chip-role chip-role-" + role });
    chip.appendChild(el("span", { class: "chip-dot", "aria-hidden": "true" }));
    chip.appendChild(el("span", { class: "chip-text" }, role));
    return chip;
  }

  function fmtDate(sec) {
    if (typeof sec !== "number") return "—";
    return new Date(sec * 1000).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  }

  // ---------------------------------------------------------------------
  // Org header + seat meter
  // ---------------------------------------------------------------------

  function renderOrgHead(data) {
    var org = data.org;
    var nameEl = document.getElementById("org-name");
    var descEl = document.getElementById("org-desc");
    if (nameEl) nameEl.textContent = org.name || "Organisation";
    if (descEl) {
      descEl.textContent = "You are " +
        (state.org.role === "owner" ? "the owner" : (state.org.role === "admin" ? "an admin" : "a member")) +
        " of this organisation" +
        (org.tier ? " · " + org.tier.charAt(0).toUpperCase() + org.tier.slice(1) + " plan" : "") + ".";
    }

    var meter = document.getElementById("seat-meter");
    var text  = document.getElementById("seat-meter-text");
    var fill  = document.getElementById("seat-meter-fill");
    // A 1-seat org hides the meter — "1 of 1" is a fact nobody needs.
    if (meter && text && fill && org.seatsPurchased > 1) {
      var used = org.seatsUsed || 0;
      var full = used >= org.seatsPurchased;
      text.textContent = used + " of " + org.seatsPurchased + " seats";
      fill.style.width = Math.min(100, Math.round((used / org.seatsPurchased) * 100)) + "%";
      fill.classList.toggle("usage-meter-fill-amber", full);
      meter.hidden = false;
    } else if (meter) {
      meter.hidden = true;
    }

    var inviteBtn = document.getElementById("invite-open-btn");
    if (inviteBtn) inviteBtn.hidden = !canManage();
  }

  // ---------------------------------------------------------------------
  // Members table + pending invites
  // ---------------------------------------------------------------------

  function renderMembers(data) {
    var wrap = document.getElementById("members-table-wrap");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var manage = canManage();
    var isOwner = state.org.role === "owner";
    var myEmail = (core.me() && core.me().email) || null;

    var table = el("table", { class: "result-table member-table" });
    var thead = el("thead", null);
    var thr = el("tr", null);
    ["Email", "Role", "Joined", manage ? "Actions" : ""].forEach(function (h) {
      thr.appendChild(el("th", null, h));
    });
    thead.appendChild(thr);
    table.appendChild(thead);

    var tbody = el("tbody", null);
    (data.members || []).forEach(function (m) {
      var tr = el("tr", null);
      var emailCell = el("td", { class: "mono" }, m.email || m.userId);
      if (myEmail && m.email === myEmail) {
        emailCell.appendChild(el("span", { class: "member-you mono" }, " · you"));
      }
      tr.appendChild(emailCell);

      var roleCell = el("td", null);
      roleCell.appendChild(roleChip(m.role));
      tr.appendChild(roleCell);
      tr.appendChild(el("td", null, fmtDate(m.joinedAt || m.createdAt)));

      var actionCell = el("td", { class: "member-actions" });
      if (manage) {
        // The owner can't be removed; an admin can't remove another admin.
        // Rules mirror removeMemberHandler — the cell explains locked rows
        // rather than showing a button that would 403.
        if (m.role === "owner") {
          actionCell.appendChild(el("span", { class: "member-lock mono" }, "owner"));
        } else if (m.role === "admin" && !isOwner && m.email !== myEmail) {
          actionCell.appendChild(el("span", { class: "member-lock mono" }, "owner only"));
        } else {
          var btn = el("button", { type: "button", class: "btn btn-ghost btn-sm btn-danger-ghost" }, "Remove");
          btn.addEventListener("click", function () { removeMember(m, btn); });
          actionCell.appendChild(btn);
        }
      }
      tr.appendChild(actionCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    // Pending invites. Each one holds a seat until accepted or expired, so a
    // typo'd address costs capacity for a full week — the revoke button exists
    // to get that seat back now rather than on the TTL's schedule.
    var pendWrap = document.getElementById("pending-invites-wrap");
    if (pendWrap) {
      while (pendWrap.firstChild) pendWrap.removeChild(pendWrap.firstChild);
      var invites = data.pendingInvites || [];
      if (invites.length) {
        pendWrap.appendChild(el("h3", { class: "result-section-title" }, "Pending invites"));
        var note = el("p", { class: "panel-input-help" },
          "Each invite holds a seat until it's accepted or expires (7 days after sending).");
        pendWrap.appendChild(note);
        var ul = el("ul", { class: "invite-list" });
        invites.forEach(function (i) {
          var li = el("li", { class: "invite-item" });
          li.appendChild(el("span", { class: "mono invite-email" }, i.email));
          var sent = typeof i.sentAt === "number" ? i.sentAt : null;
          var expires = sent ? fmtDate(sent + 7 * 86400) : "—";
          li.appendChild(el("span", { class: "mono invite-expiry" }, "expires " + expires));
          // Owners and admins only — the same gate the Worker enforces. An
          // action the viewer cannot take is not rendered disabled, it is not
          // rendered, so the screen never offers something that will 403.
          if (canManage()) {
            var revokeBtn = el("button",
              { type: "button", class: "btn btn-ghost btn-sm invite-revoke" }, "Revoke");
            revokeBtn.addEventListener("click", function () { revokeInvite(i, revokeBtn); });
            li.appendChild(revokeBtn);
          }
          ul.appendChild(li);
        });
        pendWrap.appendChild(ul);
        pendWrap.hidden = false;
      } else {
        pendWrap.hidden = true;
      }
    }
  }

  /**
   * Withdraw an invite that has not been accepted.
   *
   * Confirmed rather than instant: the invite email is already in someone's
   * inbox, and revoking turns a link they may be about to click into a dead
   * one. That is recoverable — re-invite — but it should be deliberate.
   */
  function revokeInvite(invite, btn) {
    var label = invite.email || "this invite";
    if (!window.confirm(
      "Revoke the invite to " + label + "? The link in their email stops working " +
      "immediately and the seat is freed.")) return;
    setBusy(btn, true, "Revoking…");
    callApi("/api/org/invite/revoke", { email: invite.email })
      .then(function () { return load(true); })
      .catch(function (e) {
        // 404 means the list is stale — someone accepted or it lapsed between
        // render and click. Reloading shows the truth, which is more useful
        // than an error about a row that is already gone.
        if (/invite_not_found/.test(e && e.code || "")) return load(true);
        window.alert((e && e.message) || "Could not revoke invite");
      })
      .then(function () { setBusy(btn, false); });
  }

  function removeMember(m, btn) {
    var label = m.email || m.userId;
    if (!window.confirm("Remove " + label + " from the organisation? Their seat frees up immediately.")) return;
    setBusy(btn, true, "Removing…");
    callApi("/api/org/members/" + encodeURIComponent(m.userId), null, "DELETE")
      .then(function () { return load(true); })
      .catch(function (e) { window.alert(e.message || "Could not remove member"); })
      .then(function () { setBusy(btn, false); });
  }

  // ---------------------------------------------------------------------
  // Invite flow — modal + the 402 seat-limit dialog
  // ---------------------------------------------------------------------

  function openInvite() {
    var orgSpan = document.getElementById("modal-invite-org");
    if (orgSpan && state.org) orgSpan.textContent = state.org.org.name || "your organisation";
    var email = document.getElementById("invite-email");
    if (email) email.value = "";
    var err = document.getElementById("invite-error");
    if (err) err.hidden = true;
    // Only the owner may mint an admin — an admin promoting a peer is a
    // quiet escalation, and the Worker refuses it with a 403. Don't render
    // the choice for admins at all.
    var adminChoice = document.getElementById("invite-role-admin");
    if (adminChoice) adminChoice.hidden = state.org.role !== "owner";
    setInviteRole("member");
    core.openModal("modal-invite");
  }

  function setInviteRole(role) {
    state.inviteRole = role;
    document.querySelectorAll("#invite-role-row .choice-btn").forEach(function (b) {
      b.setAttribute("aria-checked", b.dataset.role === role ? "true" : "false");
      b.classList.toggle("choice-btn-selected", b.dataset.role === role);
    });
  }

  function sendInvite(btn) {
    var emailInput = document.getElementById("invite-email");
    var err = document.getElementById("invite-error");
    var email = emailInput ? emailInput.value.trim() : "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (err) { err.textContent = "Enter a valid email address."; err.hidden = false; }
      if (emailInput) emailInput.focus();
      return;
    }
    setBusy(btn, true, "Sending…");
    callApi("/api/org/invite", { email: email, role: state.inviteRole })
      .then(function () {
        core.closeModal("modal-invite");
        return load(true);
      })
      .catch(function (e) {
        if (e.code === "seat_limit_reached") {
          core.closeModal("modal-invite");
          showSeatLimit(e);
          return;
        }
        if (err) { err.textContent = e.message || "Could not send the invite."; err.hidden = false; }
      })
      .then(function () { setBusy(btn, false); });
  }

  function showSeatLimit(e) {
    var msg = document.getElementById("modal-seatlimit-msg");
    var count = document.getElementById("modal-seatlimit-count");
    // The API's message verbatim — it already names the numbers.
    if (msg) msg.textContent = e.message || "All seats on this plan are in use.";
    if (count && state.org) {
      count.textContent = state.org.org.seatsUsed + " / " + state.org.org.seatsPurchased + " · full";
    }
    core.openModal("modal-seatlimit");
  }

  // ---------------------------------------------------------------------
  // API keys — empty state, create (reveal once), list, revoke confirm
  // ---------------------------------------------------------------------

  function renderKeys(keys) {
    var wrap = document.getElementById("keys-list");
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    var manage = canManage();
    var createBtn = document.getElementById("key-create-btn");
    var live = (keys || []).filter(function (k) { return !k.revokedAt; });

    if (createBtn) createBtn.hidden = !manage || live.length === 0;

    if (!live.length) {
      // Empty state that sells the CI integration (D-2) — with the create
      // action inline, so the pitch and the door are the same element.
      var empty = el("div", { class: "keys-empty" });
      empty.appendChild(el("span", { class: "panel-tag" }, "CI"));
      empty.appendChild(el("h3", null, "Run the audit from your pipeline"));
      empty.appendChild(el("p", null,
        "A key lets CI post lockfiles to the audit endpoint without a browser session, " +
        "so a failing scan can block a merge instead of waiting for someone to remember."));
      if (manage) {
        var btn = el("button", { type: "button", class: "btn btn-primary" }, "Create key");
        btn.addEventListener("click", function () { createKey(btn); });
        empty.appendChild(btn);
      } else {
        empty.appendChild(el("p", { class: "mono keys-empty-note" },
          "Owners and admins create keys. You're viewing read-only."));
      }
      wrap.appendChild(empty);
      return;
    }

    var ul = el("ul", { class: "key-list" });
    live.forEach(function (k) {
      var li = el("li", { class: "key-item" });
      var info = el("div", { class: "key-info" });
      var top = el("div", { class: "key-top" });
      top.appendChild(el("strong", null, k.name));
      top.appendChild(el("span", { class: "mono key-prefix" }, (k.prefix || "") + "…"));
      info.appendChild(top);
      var meta = el("div", { class: "key-meta mono" });
      meta.appendChild(el("span", null, "created " + fmtDate(k.createdAt)));
      meta.appendChild(el("span", { class: k.lastUsedAt ? "key-used" : "key-unused" },
        k.lastUsedAt ? "last used " + core.formatRelativeTime(k.lastUsedAt * 1000) : "never used"));
      info.appendChild(meta);
      li.appendChild(info);

      if (manage) {
        var btn = el("button", { type: "button", class: "btn btn-ghost btn-sm btn-danger-ghost" }, "Revoke");
        btn.addEventListener("click", function () { openRevoke(k); });
        li.appendChild(btn);
      }
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
  }

  function createKey(btn) {
    var name = window.prompt("Name the key — e.g. \"CI — main branch\":", "CI");
    if (!name) return;
    setBusy(btn, true, "Creating…");
    callApi("/api/keys", { name: name })
      .then(function (res) {
        // Reveal-once: the response is the only time the full key exists in
        // a browser. The modal has no × and ignores Esc.
        var label = document.getElementById("keyreveal-name");
        var input = document.getElementById("keyreveal-value");
        if (label) label.textContent = res.name || name;
        if (input) input.value = res.key || "";
        core.openModal("modal-keyreveal");
        return loadKeys();
      })
      .catch(function (e) { window.alert(e.message || "Could not create the key"); })
      .then(function () { setBusy(btn, false); });
  }

  function openRevoke(k) {
    state.pendingRevoke = k;
    var nameEl = document.getElementById("modal-keyrevoke-name");
    var facts = document.getElementById("modal-keyrevoke-facts");
    if (nameEl) nameEl.textContent = k.name;
    if (facts) {
      while (facts.firstChild) facts.removeChild(facts.firstChild);
      facts.appendChild(el("span", { class: "modal-factstrong" }, (k.prefix || "") + "…"));
      facts.appendChild(el("span", null, "created " + fmtDate(k.createdAt)));
      facts.appendChild(el("span", null,
        k.lastUsedAt ? "last used " + core.formatRelativeTime(k.lastUsedAt * 1000) : "never used"));
    }
    core.openModal("modal-keyrevoke");
  }

  function confirmRevoke(btn) {
    var k = state.pendingRevoke;
    if (!k) return;
    setBusy(btn, true, "Revoking…");
    callApi("/api/keys/" + encodeURIComponent(k.keyId), null, "DELETE")
      .then(function () {
        core.closeModal("modal-keyrevoke");
        state.pendingRevoke = null;
        return loadKeys();
      })
      .catch(function (e) { window.alert(e.message || "Could not revoke the key"); })
      .then(function () { setBusy(btn, false); });
  }

  function loadKeys() {
    return callApi("/api/keys", null, "GET")
      .then(function (res) { renderKeys(res.keys || []); })
      .catch(function (e) {
        // Members get a 403 here — keys are owner/admin territory. Show the
        // empty-state pitch read-only rather than an error.
        if (e.code === "forbidden") { renderKeys([]); return; }
        var wrap = document.getElementById("keys-list");
        if (wrap) {
          while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
          wrap.appendChild(core.errorState(e.message || "Could not load keys"));
        }
      });
  }

  // ---------------------------------------------------------------------
  // Branding (Firm tier, D-4's white-label state)
  // ---------------------------------------------------------------------

  function renderBranding(data) {
    var body = document.getElementById("branding-body");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    var branding = data.branding || {};
    var manage = canManage();

    if (!branding.available) {
      var upsell = el("div", { class: "branding-upsell" });
      upsell.appendChild(el("p", null,
        "Custom report branding is included on the Firm plan. Reports stay Algosize-branded on this plan."));
      var a = el("a", { href: "/#pricing", class: "btn btn-ghost btn-sm" }, "See plans →");
      upsell.appendChild(a);
      body.appendChild(upsell);
      return;
    }

    if (!manage) {
      body.appendChild(el("p", { class: "panel-input-help" },
        "Branding is set by an owner or admin. " +
        (branding.appliesToNewReports
          ? "New reports carry " + (branding.companyName || "your company") + "'s branding."
          : "No custom branding is set — reports carry Algosize branding.")));
      return;
    }

    var form = el("div", { class: "stack-form" });

    form.appendChild(el("label", { class: "panel-input-label", for: "branding-name" }, "Company name"));
    var nameInput = el("input", {
      id: "branding-name", class: "panel-input", type: "text",
      maxlength: "120", placeholder: "Northwind Security",
    });
    nameInput.value = branding.companyName || "";
    form.appendChild(nameInput);

    form.appendChild(el("label", { class: "panel-input-label", for: "branding-logo" }, "Logo URL"));
    var logoInput = el("input", {
      id: "branding-logo", class: "panel-input mono", type: "url",
      placeholder: "https://cdn.example.com/mark.svg",
    });
    logoInput.value = branding.logoUrl || "";
    form.appendChild(logoInput);
    form.appendChild(el("p", { class: "panel-input-help" },
      "Absolute https:// image URL — it renders in a document your clients receive, so http, data: and javascript: are refused."));

    var msg = el("p", { class: "field-msg", id: "branding-msg" });
    msg.hidden = true;
    var actions = el("div", { class: "form-actions" });
    var save = el("button", { type: "button", class: "btn btn-primary btn-sm" }, "Save branding");
    save.addEventListener("click", function () {
      var payload = {
        companyName: nameInput.value.trim() === "" ? null : nameInput.value.trim(),
        logoUrl:     logoInput.value.trim() === "" ? null : logoInput.value.trim(),
      };
      setBusy(save, true, "Saving…");
      callApi("/api/org/branding", payload, "PUT")
        .then(function (res) {
          msg.textContent = res.note || "Saved. New reports use this branding.";
          msg.classList.remove("field-msg-error");
          msg.hidden = false;
        })
        .catch(function (e) {
          msg.textContent = e.message || "Could not save branding.";
          msg.classList.add("field-msg-error");
          msg.hidden = false;
        })
        .then(function () { setBusy(save, false); });
    });
    actions.appendChild(save);
    form.appendChild(actions);
    form.appendChild(msg);
    body.appendChild(form);
  }

  // ---------------------------------------------------------------------
  // Load + wire
  // ---------------------------------------------------------------------

  function load(force) {
    if (state.loaded && !force) return Promise.resolve();
    state.loaded = true;
    return callApi("/api/org", null, "GET").then(function (data) {
      state.org = data;
      renderOrgHead(data);
      renderMembers(data);
      renderBranding(data);
      return loadKeys();
    }).catch(function (e) {
      var wrap = document.getElementById("members-table-wrap");
      if (wrap) {
        while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
        wrap.appendChild(core.errorState(e.message || "Could not load the organisation"));
      }
    });
  }

  function attach() {
    var inviteBtn = document.getElementById("invite-open-btn");
    if (inviteBtn) inviteBtn.addEventListener("click", openInvite);

    var roleRow = document.getElementById("invite-role-row");
    if (roleRow) {
      roleRow.addEventListener("click", function (event) {
        var b = event.target.closest && event.target.closest("[data-role]");
        if (b) setInviteRole(b.dataset.role);
      });
    }

    var sendBtn = document.getElementById("invite-send-btn");
    if (sendBtn) sendBtn.addEventListener("click", function () { sendInvite(sendBtn); });

    var seatPortalBtn = document.getElementById("modal-seatlimit-portal");
    if (seatPortalBtn) {
      seatPortalBtn.addEventListener("click", function () { core.openBillingPortal(seatPortalBtn); });
    }

    var createBtn = document.getElementById("key-create-btn");
    if (createBtn) createBtn.addEventListener("click", function () { createKey(createBtn); });

    var revealCopy = document.getElementById("keyreveal-copy");
    if (revealCopy) {
      revealCopy.addEventListener("click", function () {
        var input = document.getElementById("keyreveal-value");
        if (input && navigator.clipboard) {
          navigator.clipboard.writeText(input.value).then(function () {
            revealCopy.textContent = "Copied";
            setTimeout(function () { revealCopy.textContent = "Copy"; }, 1200);
          }).catch(function () {});
        }
      });
    }
    var revealDone = document.getElementById("keyreveal-done");
    if (revealDone) {
      revealDone.addEventListener("click", function () {
        var input = document.getElementById("keyreveal-value");
        if (input) input.value = "";   // don't leave the secret in the DOM
        core.closeModal("modal-keyreveal");
      });
    }

    var revokeConfirm = document.getElementById("modal-keyrevoke-confirm");
    if (revokeConfirm) revokeConfirm.addEventListener("click", function () { confirmRevoke(revokeConfirm); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  window.DashTeam = { load: load };
})();
