// Account management — the settings area.
//
// Ten sections behind #/account/<section>:
//   profile  security  billing  invoices  branding
//   referrals  team  keys  notifications  danger
//
// Endpoints, so a grep for a path finds its caller:
//   GET    /api/account                    summary pane + capabilities
//   PATCH  /api/account/profile            name, avatar, company name
//   POST   /api/account/email              start a login-email change
//   DELETE /api/account/email              abandon one
//   GET    /api/account/sessions           devices signed in
//   DELETE /api/account/sessions/:id       revoke one
//   POST   /api/account/sessions/revoke-others
//   GET    /api/account/logins             sign-in history
//   GET    /api/account/notifications      catalog + this user's answers
//   PUT    /api/account/notifications
//   GET    /api/billing/summary            plan, card, address (live Stripe)
//   GET    /api/billing/invoices           invoice history + PDFs
//   PUT    /api/billing/email              where invoices go
//   POST   /api/billing/portal             → Stripe's hosted portal
//   GET    /api/org                        members, invites, branding
//   PUT    /api/org/branding               name, logo, accent
//   PUT    /api/org/domain                 set a custom hostname
//   POST   /api/org/domain/verify          check DNS now
//   DELETE /api/org/domain
//   GET    /api/referrals                  link, funnel, credit ledger
//   POST   /api/referrals/invite
//   GET    /api/account/export             download everything
//   GET    /api/account/delete-preview     the real consequences, counted
//   DELETE /api/account/org
//
// Two rules carried over from the Team screen, for the same reasons:
//
//   * Nothing is built with innerHTML. Every node goes through core.el(),
//     which sets text via textContent — that is the whole XSS story on a page
//     that renders company names, member emails and DNS values.
//   * An action the viewer cannot take is not rendered disabled, it is not
//     rendered. Where a control is absent for a reason someone would ask
//     about, a sentence says why instead.
//
// And one rule this screen adds: a value we could not load is never drawn as
// a zero. "$0.00 of credit" and "we could not read your credit ledger" mean
// opposite things to the person reading them, so `known: false` from the API
// renders as an em dash and a note, never as a number.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi, setBusy = core.setBusy;

  var state = {
    loaded: false,
    section: null,
    account: null,      // GET /api/account
    org: null,          // GET /api/org
    billing: null,      // GET /api/billing/summary
    invoices: null,
    referrals: null,
    notifications: null,
    sessions: null,
    logins: null,
    keys: null,
    notifDirty: {},     // pending notification toggles, "<id>:<channel>" → bool
  };

  // ---------------------------------------------------------------------
  // small builders
  // ---------------------------------------------------------------------

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function fmtDate(sec) {
    if (typeof sec !== "number" || !sec) return "—";
    return new Date(sec * 1000).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  }

  function fmtDateTime(sec) {
    if (typeof sec !== "number" || !sec) return "—";
    return new Date(sec * 1000).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    });
  }

  /** A panel with a header and an empty body, returned as { panel, body }. */
  function panel(title, desc, actions) {
    var p = el("section", { class: "panel acct-panel" });
    var head = el("header", { class: "panel-head" });
    var heading = el("div", { class: "panel-heading" });
    heading.appendChild(el("h2", null, title));
    if (desc) heading.appendChild(el("p", { class: "panel-desc" }, desc));
    head.appendChild(heading);
    if (actions && actions.length) {
      var act = el("div", { class: "panel-actions" });
      actions.forEach(function (a) { act.appendChild(a); });
      head.appendChild(act);
    }
    p.appendChild(head);
    var body = el("div", { class: "panel-body" });
    p.appendChild(body);
    return { panel: p, body: body };
  }

  /** Label + input pair. Returns { wrap, input }. */
  function field(labelText, id, value, opts) {
    opts = opts || {};
    var wrap = el("div", { class: "acct-field" });
    wrap.appendChild(el("label", { class: "panel-input-label", for: id }, labelText));
    var input = el("input", {
      id: id, type: opts.type || "text", class: "panel-input acct-input",
    });
    if (opts.placeholder) input.setAttribute("placeholder", opts.placeholder);
    if (opts.mono) input.classList.add("mono");
    if (opts.readonly) input.setAttribute("readonly", "readonly");
    input.value = value == null ? "" : String(value);
    wrap.appendChild(input);
    if (opts.help) wrap.appendChild(el("p", { class: "panel-input-help" }, opts.help));
    return { wrap: wrap, input: input };
  }

  /** A read-only "this is set by something else" row. */
  function staticField(labelText, node, help) {
    var wrap = el("div", { class: "acct-field" });
    wrap.appendChild(el("span", { class: "panel-input-label" }, labelText));
    var box = el("div", { class: "acct-static" });
    box.appendChild(node);
    wrap.appendChild(box);
    if (help) wrap.appendChild(el("p", { class: "panel-input-help" }, help));
    return wrap;
  }

  function chip(text, kind, glyph) {
    var c = el("span", { class: "chip " + (kind || "chip-muted") });
    if (glyph) c.appendChild(el("span", { class: "chip-dot", "aria-hidden": "true" }));
    c.appendChild(el("span", { class: "chip-text" }, text));
    return c;
  }

  function msgSlot(id) {
    return el("p", { class: "field-msg", id: id, hidden: "hidden" });
  }

  function showMsg(node, text, isError) {
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("field-msg-error", !!isError);
    node.classList.toggle("field-msg-ok", !isError);
    node.hidden = false;
  }

  function button(label, cls, onClick) {
    var b = el("button", { type: "button", class: "btn " + cls }, label);
    if (onClick) b.addEventListener("click", function () { onClick(b); });
    return b;
  }

  /**
   * An inline confirmation, rendered in place rather than as a modal.
   *
   * In place because every one of these is about the thing directly above it
   * — this session, this subscription, this organisation — and a centred
   * dialog detaches the question from its subject. It also means the
   * consequences can be as long as they need to be without a scroll trap.
   *
   * `items` are the consequences, listed rather than summarised: "removes
   * your data" is a sentence nobody reads.
   */
  function confirmBox(opts) {
    var box = el("div", {
      class: "acct-confirm" + (opts.danger ? " acct-confirm-danger" : ""),
      role: "alertdialog",
    });
    var head = el("div", { class: "acct-confirm-head" });
    head.appendChild(el("span", { class: "acct-confirm-glyph", "aria-hidden": "true" }, "!"));
    var text = el("div", { class: "acct-confirm-text" });
    text.appendChild(el("strong", null, opts.title));
    if (opts.body) text.appendChild(el("p", null, opts.body));
    if (opts.items && opts.items.length) {
      var ul = el("ul", { class: "acct-consequences" });
      opts.items.forEach(function (t) {
        var li = el("li", null);
        li.appendChild(el("span", { class: "acct-consequence-mark", "aria-hidden": "true" }, "×"));
        li.appendChild(el("span", null, t));
        ul.appendChild(li);
      });
      text.appendChild(ul);
    }
    head.appendChild(text);
    box.appendChild(head);

    if (opts.extra) box.appendChild(opts.extra);

    var actions = el("div", { class: "acct-confirm-actions" });
    actions.appendChild(button(opts.cancelLabel || "Cancel", "btn-ghost", opts.onCancel));
    var go = button(opts.confirmLabel || "Confirm",
      opts.danger ? "btn-red" : "btn-primary",
      function (btn) { opts.onConfirm(btn); });
    if (opts.confirmDisabled) go.disabled = true;
    actions.appendChild(go);
    box.appendChild(actions);
    if (opts.note) box.appendChild(el("p", { class: "acct-confirm-note mono" }, opts.note));

    box.confirmButton = go;
    return box;
  }

  /** An empty state that carries its own call to action. */
  function richEmpty(title, body, cta) {
    var wrap = el("div", { class: "acct-empty" });
    wrap.appendChild(el("strong", null, title));
    wrap.appendChild(el("p", null, body));
    if (cta) wrap.appendChild(cta);
    return wrap;
  }

  /** Copy-to-clipboard row for a link or a secret. */
  function copyRow(value, opts) {
    opts = opts || {};
    var row = el("div", { class: "acct-copy" + (opts.emphasis ? " acct-copy-strong" : "") });
    row.appendChild(el("code", { class: "acct-copy-value" }, value));
    var btn = el("button", {
      type: "button", class: "acct-copy-btn" + (opts.emphasis ? " acct-copy-btn-strong" : ""),
    }, "copy");
    btn.addEventListener("click", function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(value).then(function () {
        btn.textContent = "copied";
        setTimeout(function () { btn.textContent = "copy"; }, 1200);
      }).catch(function () { /* clipboard denied — the text is selectable */ });
    });
    row.appendChild(btn);
    return row;
  }

  /** Segment meter, matching the header's quota pill. */
  function meter(used, total, warn) {
    var wrap = el("span", {
      class: "acct-meter", role: "img",
      "aria-label": used + " of " + total + " used",
    });
    for (var i = 0; i < total && i < 40; i++) {
      var seg = el("span", { class: "acct-meter-seg" });
      if (i < used) seg.classList.add(warn ? "acct-meter-seg-warn" : "acct-meter-seg-on");
      wrap.appendChild(seg);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------
  // section catalog
  // ---------------------------------------------------------------------

  var SECTIONS = [
    { id: "profile", label: "Profile", title: "Profile & identity",
      desc: "Who you are on the account, and how you get in. Nothing here touches billing.",
      render: renderProfile },
    { id: "security", label: "Security", title: "Security",
      desc: "Where your account is signed in, and what to do when a device is lost.",
      render: renderSecurity },
    { id: "billing", label: "Billing & Plan", title: "Billing & plan",
      desc: "Your plan, usage and renewal. Card details live in Stripe's portal.",
      render: renderBilling },
    { id: "invoices", label: "Invoices", title: "Invoices",
      desc: "Every invoice raised against this organisation, with the PDF for each.",
      render: renderInvoices },
    { id: "branding", label: "Branding", title: "Branding",
      desc: "Your mark on client-facing reports and shared links.",
      render: renderBranding },
    { id: "referrals", label: "Referrals & Credits", title: "Referrals & credits",
      desc: "Credit against your Algosize bill for organisations you bring in.",
      render: renderReferrals },
    { id: "team", label: "Team", title: "Team",
      desc: "Members, roles and seats. An outstanding invite holds a seat until accepted or revoked.",
      render: renderTeam },
    { id: "keys", label: "API Keys", title: "API keys",
      desc: "Keys for CI ingestion. Shown in full exactly once, at creation.",
      render: renderKeys },
    { id: "notifications", label: "Notifications", title: "Notifications",
      desc: "What Algosize tells you about, and on which channel.",
      render: renderNotifications },
    { id: "danger", label: "Danger Zone", title: "Danger zone",
      desc: "Irreversible operations. Each one states its consequences before it will run.",
      render: renderDanger },
  ];

  function sectionById(id) {
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === id) return SECTIONS[i];
    return SECTIONS[0];
  }

  // ---------------------------------------------------------------------
  // summary pane + nav
  // ---------------------------------------------------------------------

  function renderSummary() {
    var host = document.getElementById("acct-summary");
    if (!host) return;
    clear(host);
    var a = state.account;
    if (!a) { host.hidden = true; return; }
    host.hidden = false;

    var ent = a.entitlement || {};
    var org = a.org || {};
    var failed = org.subStatus === "past_due" || org.subStatus === "unpaid";

    var stats = el("div", { class: "acct-summary-stats" });

    // Plan
    var planStat = el("div", { class: "acct-stat" });
    planStat.appendChild(el("span", { class: "acct-stat-label" }, "Plan"));
    var planVal = el("span", { class: "acct-stat-value" });
    planVal.appendChild(el("span", null, planName(org.tier, ent.active)));
    planVal.appendChild(failed
      ? chip("Past due", "chip-warn", true)
      : chip(ent.active ? "Active" : "Free", ent.active ? "chip-ok" : "chip-muted", true));
    planStat.appendChild(planVal);
    stats.appendChild(planStat);

    // Renewal / failure
    var renewStat = el("div", { class: "acct-stat" });
    renewStat.appendChild(el("span", { class: "acct-stat-label" },
      failed ? "Payment failed" : ent.active ? "Renews" : "Status"));
    renewStat.appendChild(el("span", {
      class: "acct-stat-value acct-stat-num" + (failed ? " acct-stat-warn" : ""),
    }, ent.currentPeriodEnd ? fmtDate(ent.currentPeriodEnd) : ent.active ? "—" : "Free tier"));
    stats.appendChild(renewStat);

    // Credit — never a zero we did not read.
    var creditStat = el("div", { class: "acct-stat" });
    creditStat.appendChild(el("span", { class: "acct-stat-label" }, "Credit balance"));
    var credit = a.credit;
    creditStat.appendChild(el("span", {
      class: "acct-stat-value acct-stat-num acct-stat-accent",
    }, credit && credit.known ? credit.balance : "—"));
    if (credit && !credit.known) {
      creditStat.appendChild(el("span", { class: "acct-stat-note" }, "could not be read"));
    }
    stats.appendChild(creditStat);

    // Seats
    if (org.orgId) {
      var seatStat = el("div", { class: "acct-stat" });
      seatStat.appendChild(el("span", { class: "acct-stat-label" }, "Seats"));
      var seatVal = el("span", { class: "acct-stat-value acct-stat-num" },
        String(org.seatsUsed) + " ");
      seatVal.appendChild(el("span", { class: "acct-stat-of" }, "of " + org.seatsPurchased));
      seatStat.appendChild(seatVal);
      stats.appendChild(seatStat);
    }

    host.appendChild(stats);

    var cta = el("div", { class: "acct-summary-cta" });
    if (a.capabilities && a.capabilities.billing.canManage && org.hasStripeCustomer) {
      cta.appendChild(button(failed ? "Fix payment method" : "Manage billing", "btn-primary",
        function (btn) { core.openBillingPortal(btn); }));
      cta.appendChild(el("span", { class: "acct-summary-note mono" }, "Opens Stripe's secure portal"));
    } else if (!ent.active) {
      var up = el("a", { href: "/#pricing", class: "btn btn-primary" }, "See plans →");
      cta.appendChild(up);
      cta.appendChild(el("span", { class: "acct-summary-note mono" },
        a.usage ? (a.usage.monthlyRunsUsed || 0) + " of " + a.usage.monthlyRunsLimit + " free runs used this month" : ""));
    }
    if (cta.firstChild) host.appendChild(cta);
  }

  function planName(tier, active) {
    if (!active) return "Free";
    if (!tier) return "Paid";
    return tier.charAt(0).toUpperCase() + tier.slice(1);
  }

  function renderNav() {
    var host = document.getElementById("acct-nav");
    if (!host) return;
    clear(host);
    var a = state.account || {};
    var org = a.org || {};

    SECTIONS.forEach(function (s) {
      var link = el("a", {
        class: "acct-nav-item" + (s.id === state.section ? " acct-nav-item-on" : ""),
        href: "#/account/" + s.id,
      });
      link.appendChild(el("span", { class: "acct-nav-label" }, s.label));
      if (s.id === state.section) link.setAttribute("aria-current", "page");

      // Counts, where one is known and useful at a glance.
      var badge = null;
      if (s.id === "team" && org.seatsUsed != null) badge = String(org.seatsUsed);
      if (s.id === "keys" && state.keys) badge = String(state.keys.length);
      if (badge) link.appendChild(el("span", { class: "acct-nav-badge mono" }, badge));
      if (s.id === "danger") link.classList.add("acct-nav-item-danger");

      host.appendChild(link);
    });
  }

  // ---------------------------------------------------------------------
  // PROFILE
  // ---------------------------------------------------------------------

  function renderProfile(body) {
    var a = state.account;
    var p = a.profile;
    var org = a.org || {};
    var canRename = a.capabilities && a.capabilities.team.canManage;

    // --- identity card ---
    var idCard = panel("Your details", null);
    var top = el("div", { class: "acct-identity" });
    var avatar = el("span", { class: "acct-avatar", "aria-hidden": "true" }, p.initials);
    if (p.avatarUrl) {
      avatar = el("img", { class: "acct-avatar", src: p.avatarUrl, alt: "" });
    }
    top.appendChild(avatar);
    var who = el("div", { class: "acct-identity-who" });
    who.appendChild(el("strong", null, p.displayName || p.email || "Your account"));
    who.appendChild(el("span", { class: "mono acct-dim" }, p.email || ""));
    top.appendChild(who);
    idCard.body.appendChild(top);

    var grid = el("div", { class: "acct-grid" });
    var name = field("Full name", "acct-name", p.displayName, { placeholder: "Dana Kessler" });
    grid.appendChild(name.wrap);
    var avatarF = field("Avatar URL", "acct-avatar-url", p.avatarUrl, {
      placeholder: "https://…/you.png", mono: true,
      help: "https only. Leave blank to use your initials.",
    });
    grid.appendChild(avatarF.wrap);

    var companyF = null;
    if (canRename) {
      companyF = field("Company name", "acct-company", org.name, { placeholder: "Northgate Partners" });
      grid.appendChild(companyF.wrap);
    } else if (org.name) {
      grid.appendChild(staticField("Company name",
        el("span", null, org.name),
        "Only an owner or admin can rename the organisation."));
    }

    var roleBox = el("span", { class: "acct-role-line" });
    roleBox.appendChild(chip(org.role || "member", "chip-role-" + (org.role || "member")));
    roleBox.appendChild(el("span", { class: "acct-dim" }, "Set by the organisation, not editable here"));
    grid.appendChild(staticField("Role", roleBox));
    idCard.body.appendChild(grid);

    var pMsg = msgSlot("acct-profile-msg");
    var actions = el("div", { class: "form-actions acct-actions-right" });
    actions.appendChild(button("Save profile", "btn-primary", function (btn) {
      var payload = {
        displayName: name.input.value.trim() === "" ? null : name.input.value.trim(),
        avatarUrl:   avatarF.input.value.trim() === "" ? null : avatarF.input.value.trim(),
      };
      if (companyF) payload.companyName = companyF.input.value.trim();
      setBusy(btn, true, "Saving…");
      callApi("/api/account/profile", payload, "PATCH")
        .then(function (res) {
          // A partial save is reported as one. The org rename can be refused
          // while the personal fields succeed, and calling that "Saved"
          // would hide the half that did not happen.
          if (res.refused) showMsg(pMsg, res.refused.message, true);
          else showMsg(pMsg, "Saved.", false);
          return reload();
        })
        .catch(function (e) { showMsg(pMsg, e.message || "Could not save.", true); })
        .then(function () { setBusy(btn, false); });
    }));
    idCard.body.appendChild(actions);
    idCard.body.appendChild(pMsg);
    body.appendChild(idCard.panel);

    // --- login email ---
    var mailCard = panel("Login email",
      "This address receives your sign-in links, so a change only takes effect once the new address confirms it.");
    var pending = p.pendingEmailChange;
    if (pending) {
      var box = el("div", { class: "acct-pending" });
      box.setAttribute("role", "status");
      var pt = el("div", { class: "acct-pending-text" });
      pt.appendChild(el("strong", null, "Check your inbox at " + pending.newEmail));
      pt.appendChild(el("p", null,
        "Expires " + fmtDateTime(pending.expiresAt) + " UTC. Until you confirm from the new address, " +
        "sign-in links keep going to " + (p.email || "your current address") +
        " — an unfinished change cannot lock you out."));
      var pa = el("div", { class: "acct-pending-actions" });
      pa.appendChild(button("Cancel change", "btn-ghost btn-sm", function (btn) {
        setBusy(btn, true, "Cancelling…");
        callApi("/api/account/email", null, "DELETE")
          .then(function () { return reload(); })
          .catch(function (e) { window.alert(e.message || "Could not cancel."); })
          .then(function () { setBusy(btn, false); });
      }));
      pt.appendChild(pa);
      box.appendChild(pt);
      mailCard.body.appendChild(box);
    } else {
      var row = el("div", { class: "acct-inline-form" });
      var newMail = field("New address", "acct-new-email", "", {
        type: "email", mono: true, placeholder: p.email || "you@company.com",
      });
      row.appendChild(newMail.wrap);
      var mMsg = msgSlot("acct-email-msg");
      row.appendChild(button("Change email", "btn-ghost", function (btn) {
        var v = newMail.input.value.trim();
        if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          showMsg(mMsg, "Enter a valid email address.", true);
          newMail.input.focus();
          return;
        }
        setBusy(btn, true, "Sending…");
        callApi("/api/account/email", { email: v })
          .then(function () { return reload(); })
          .catch(function (e) { showMsg(mMsg, e.message || "Could not start the change.", true); })
          .then(function () { setBusy(btn, false); });
      }));
      mailCard.body.appendChild(row);
      mailCard.body.appendChild(mMsg);
      mailCard.body.appendChild(el("p", { class: "panel-input-help" },
        "We email the new address to confirm it, and tell your current address that the change was requested."));
    }
    body.appendChild(mailCard.panel);

    // --- how you sign in ---
    var authCard = panel("How you sign in",
      "Algosize has no password. Access is a sign-in link emailed to you, or Google — so there is nothing here to leak or rotate.");
    var methods = el("div", { class: "acct-methods" });

    var googleOn = p.authMethod === "google";
    methods.appendChild(methodRow("Google", "G",
      googleOn ? "Connected" : "Not connected",
      googleOn ? (p.email + " · last used to sign in") : "Sign in with Google to connect it.",
      googleOn));
    methods.appendChild(methodRow("Sign-in link", "✉", "Always on",
      "Sent to " + (p.email || "your login email") + ". Cannot be disabled — it is the recovery path if Google is lost.",
      true));
    authCard.body.appendChild(methods);
    if (!p.authMethodKnown) {
      authCard.body.appendChild(el("p", { class: "panel-input-help" },
        "We have no record of how this account last signed in — it predates sign-in tracking. Both methods above still work."));
    }
    body.appendChild(authCard.panel);
  }

  function methodRow(name, glyph, statusText, detail, on) {
    var row = el("div", { class: "acct-method" + (on ? " acct-method-on" : "") });
    row.appendChild(el("span", { class: "acct-method-glyph mono", "aria-hidden": "true" }, glyph));
    var mid = el("div", { class: "acct-method-mid" });
    var line = el("span", { class: "acct-method-name" });
    line.appendChild(el("span", null, name));
    line.appendChild(chip(statusText, on ? "chip-ok" : "chip-muted", on));
    mid.appendChild(line);
    mid.appendChild(el("span", { class: "mono acct-dim" }, detail));
    row.appendChild(mid);
    return row;
  }

  // ---------------------------------------------------------------------
  // SECURITY
  // ---------------------------------------------------------------------

  function renderSecurity(body) {
    var sessions = state.sessions;
    var revokeAll = button("Revoke all others", "btn-ghost btn-sm btn-danger-ghost", function (btn) {
      setBusy(btn, true, "Signing out…");
      callApi("/api/account/sessions/revoke-others", null, "POST")
        .then(function (res) {
          window.alert(res.message);
          return loadSessions().then(function () { paint(); });
        })
        .catch(function (e) { window.alert(e.message || "Could not revoke."); })
        .then(function () { setBusy(btn, false); });
    });

    var list = sessions ? sessions.sessions : [];
    var count = list.length;
    var card = panel("Active sessions",
      count + (count === 1 ? " device signed in." : " devices signed in.") +
      " Revoking a session signs that device out immediately.",
      count > 1 ? [revokeAll] : []);

    if (!sessions) {
      card.body.appendChild(el("div", { class: "panel-empty" }, "Loading sessions…"));
    } else if (!count) {
      card.body.appendChild(core.emptyState("No sessions are indexed for this account."));
    } else {
      list.forEach(function (s) {
        card.body.appendChild(sessionRow(s));
      });
    }

    // The two separate caveats, said separately. They are different facts and
    // collapsing them would misdescribe both.
    var notes = el("div", { class: "acct-notes" });
    if (sessions && sessions.indexedOnly) {
      notes.appendChild(el("p", { class: "panel-input-help" },
        "This is a floor, not a count: sessions created before device tracking shipped are not listed. " +
        "Every session expires 30 days after it was created."));
    }
    if (sessions && sessions.complete === false) {
      notes.appendChild(el("p", { class: "panel-input-help field-msg-error" },
        "This list was truncated — there are more sessions than shown. Revoke all others, then re-check."));
    }
    if (notes.firstChild) card.body.appendChild(notes);
    body.appendChild(card.panel);

    // --- login history ---
    var hist = el("details", { class: "panel acct-details" });
    var sum = el("summary", { class: "acct-details-summary" });
    var st = el("span", { class: "acct-details-title" });
    st.appendChild(el("strong", null, "Sign-in history"));
    st.appendChild(el("span", { class: "acct-dim" },
      state.logins ? state.logins.logins.length + " recorded" : "recorded sign-ins"));
    sum.appendChild(st);
    sum.appendChild(el("span", { class: "mono acct-dim", "aria-hidden": "true" }, "expand"));
    hist.appendChild(sum);
    var hb = el("div", { class: "acct-details-body" });
    if (!state.logins) {
      hb.appendChild(el("div", { class: "panel-empty" }, "Loading…"));
    } else if (!state.logins.logins.length) {
      hb.appendChild(el("p", { class: "panel-input-help" }, state.logins.since));
    } else {
      state.logins.logins.forEach(function (l) {
        var r = el("div", { class: "acct-login-row" });
        r.appendChild(el("span", { class: "mono" }, fmtDateTime(l.at)));
        r.appendChild(el("span", { class: "mono acct-dim" }, methodLabel(l.method)));
        r.appendChild(el("span", { class: "mono acct-dim" },
          [l.device, l.ip, l.country].filter(Boolean).join(" · ") || "unknown device"));
        hb.appendChild(r);
      });
      hb.appendChild(el("p", { class: "panel-input-help" }, state.logins.since));
    }
    hist.appendChild(hb);
    body.appendChild(hist);

    // --- 2FA, shown inert ---
    var tfa = el("div", { class: "acct-inert" });
    var tfaMid = el("div", null);
    var tfaLine = el("span", { class: "acct-method-name" });
    tfaLine.appendChild(el("strong", null, "Two-factor authentication"));
    tfaLine.appendChild(chip("Not available yet", "chip-muted"));
    tfaMid.appendChild(tfaLine);
    tfaMid.appendChild(el("p", null,
      "Deliberately shown as inert rather than as a switch that does nothing. Sign-in today is an emailed " +
      "link or Google, so your second factor is whatever protects that mailbox — enabling 2FA on it, or on " +
      "the Google account it is attached to, is the real control until this ships."));
    tfa.appendChild(tfaMid);
    body.appendChild(tfa);
  }

  function methodLabel(m) {
    if (m === "google") return "Google";
    if (m === "magic_link") return "Sign-in link";
    if (m === "checkout") return "Checkout";
    if (m === "signup") return "Signup";
    return m || "unknown";
  }

  function sessionRow(s) {
    var row = el("div", { class: "acct-session" + (s.current ? " acct-session-current" : "") });
    var mid = el("div", { class: "acct-session-mid" });
    var line = el("span", { class: "acct-method-name" });
    line.appendChild(el("span", { class: "acct-session-device" }, s.device || "Unknown device"));
    if (s.current) line.appendChild(chip("This device", "chip-ok", true));
    mid.appendChild(line);
    mid.appendChild(el("span", { class: "mono acct-dim" },
      [s.ip, s.country, s.issuedAt ? "signed in " + core.formatRelativeTime(s.issuedAt * 1000) : null]
        .filter(Boolean).join(" · ")));
    row.appendChild(mid);

    if (s.current) {
      // Not a disabled button: the reason is worth a sentence, and a greyed
      // control invites clicking to find out why.
      row.appendChild(el("span", { class: "acct-dim acct-session-lock" },
        "Cannot revoke the session you are using"));
    } else {
      row.appendChild(button("Revoke", "btn-ghost btn-sm btn-danger-ghost", function () {
        openSessionConfirm(row, s);
      }));
    }
    return row;
  }

  function openSessionConfirm(row, s) {
    if (row.nextSibling && row.nextSibling.classList &&
        row.nextSibling.classList.contains("acct-confirm")) return;
    var box = confirmBox({
      danger: true,
      title: "Revoke " + (s.device || "this device") + "?",
      body: "That device is signed out at once and needs a fresh sign-in link to return. Any analysis " +
            "running in that tab is abandoned. This cannot be undone, and it does not affect your other devices.",
      cancelLabel: "Keep signed in",
      confirmLabel: "Revoke session",
      onCancel: function () { box.remove(); },
      onConfirm: function (btn) {
        setBusy(btn, true, "Revoking…");
        callApi("/api/account/sessions/" + encodeURIComponent(s.sessionId), null, "DELETE")
          .then(function () { return loadSessions().then(function () { paint(); }); })
          .catch(function (e) {
            window.alert(e.message || "Could not revoke that session.");
            setBusy(btn, false);
          });
      },
    });
    row.parentNode.insertBefore(box, row.nextSibling);
  }

  // ---------------------------------------------------------------------
  // BILLING
  // ---------------------------------------------------------------------

  function renderBilling(body) {
    var b = state.billing;
    if (!b) { body.appendChild(el("div", { class: "panel-empty" }, "Loading billing…")); return; }

    var sub = b.subscription;
    var failed = b.org.subStatus === "past_due" || b.org.subStatus === "unpaid";

    // --- payment-failed banner ---
    if (failed) {
      var alertBox = el("div", { class: "banner banner-amber", role: "alert" });
      var at = el("div", { class: "banner-text" });
      var strong = el("strong", null);
      strong.appendChild(el("span", { class: "banner-glyph", "aria-hidden": "true" }, "▲"));
      strong.appendChild(el("span", null, "Your payment didn't go through"));
      at.appendChild(strong);
      at.appendChild(el("p", null,
        (b.paymentMethod
          ? "The card ending " + b.paymentMethod.last4 + " was declined. "
          : "The last payment was declined. ") +
        "Stripe retries automatically. Your access stays on until " +
        fmtDate(b.entitlement && b.entitlement.currentPeriodEnd) +
        ", after which the account drops to the free tier until a payment succeeds."));
      alertBox.appendChild(at);
      alertBox.appendChild(button("Update payment method ↗", "btn-amber",
        function (btn) { core.openBillingPortal(btn); }));
      body.appendChild(alertBox);
    }

    // --- plan card ---
    var planActions = [];
    if (b.org.role === "owner") {
      planActions.push(button("Change plan ↗", "btn-ghost btn-sm",
        function (btn) { core.openBillingPortal(btn); }));
      if (b.entitlement && b.entitlement.active) {
        planActions.push(button("Cancel subscription", "btn-ghost btn-sm btn-danger-ghost", function () {
          openCancelConfirm(planCard.body);
        }));
      }
    }
    var planCard = panel(planName(b.org.tier, b.entitlement && b.entitlement.active) + " plan",
      null, planActions);

    var priceLine = el("div", { class: "acct-price" });
    if (sub && sub.amount) {
      priceLine.appendChild(el("span", { class: "acct-price-amount mono" },
        sub.amount + " / " + (sub.interval || "month")));
      if (sub.quantity && sub.quantity > 1) {
        priceLine.appendChild(el("span", { class: "acct-dim" }, "× " + sub.quantity + " seats"));
      }
    } else if (b.reason) {
      priceLine.appendChild(el("span", { class: "acct-dim" }, stripeReasonText(b)));
    } else {
      priceLine.appendChild(el("span", { class: "acct-dim" }, "No paid subscription."));
    }
    planCard.body.appendChild(priceLine);

    if (sub && sub.cancelAtPeriodEnd) {
      planCard.body.appendChild(el("p", { class: "panel-input-help field-msg-error" },
        "Cancels on " + fmtDate(sub.currentPeriodEnd) + ". Until then nothing changes."));
    } else if (b.entitlement && b.entitlement.currentPeriodEnd) {
      planCard.body.appendChild(el("p", { class: "panel-input-help" },
        (failed ? "Access continues to " : "Renews ") + fmtDate(b.entitlement.currentPeriodEnd) + "."));
    }

    // Usage — Algosize's own meter, not a generic one.
    var a = state.account;
    if (a && a.usage) {
      var u = el("div", { class: "acct-usage" });
      var uh = el("div", { class: "acct-usage-head" });
      uh.appendChild(el("span", { class: "panel-input-label" }, "Scan runs this month"));
      uh.appendChild(el("span", { class: "mono" },
        (a.usage.monthlyRunsUsed || 0) + " of " + a.usage.monthlyRunsLimit));
      u.appendChild(uh);
      u.appendChild(meter(a.usage.monthlyRunsUsed || 0, a.usage.monthlyRunsLimit,
        (a.usage.monthlyRunsUsed || 0) >= a.usage.monthlyRunsLimit));
      u.appendChild(el("p", { class: "panel-input-help" },
        "Free tier. Upgrading removes the limit."));
      planCard.body.appendChild(u);
    }
    body.appendChild(planCard.panel);

    // --- payment method + address ---
    var pmCard = panel("Payment method & billing address",
      "Shown from what Stripe holds, so you can see what is on file without leaving the page. Editing happens in Stripe.");
    var cols = el("div", { class: "acct-grid" });

    var pmBox = el("div", { class: "acct-subblock" });
    pmBox.appendChild(el("span", { class: "panel-input-label" }, "Card on file"));
    if (b.paymentMethod) {
      var cardBox = el("div", {
        class: "acct-card" + (b.paymentMethod.expired || failed ? " acct-card-bad" : ""),
      });
      cardBox.appendChild(el("span", { class: "acct-card-brand mono" },
        String(b.paymentMethod.brand || "card").toUpperCase()));
      var cardMid = el("div", { class: "acct-card-mid" });
      cardMid.appendChild(el("span", { class: "mono acct-card-num" },
        "•••• " + b.paymentMethod.last4));
      var expLine = el("span", { class: "acct-card-exp" });
      expLine.appendChild(el("span", { class: "mono" },
        "Expires " + String(b.paymentMethod.expMonth).padStart(2, "0") + " / " + b.paymentMethod.expYear));
      if (b.paymentMethod.expired) expLine.appendChild(chip("Expired", "chip-warn"));
      else if (failed) expLine.appendChild(chip("Declined", "chip-warn"));
      cardMid.appendChild(expLine);
      cardBox.appendChild(cardMid);
      pmBox.appendChild(cardBox);
    } else {
      pmBox.appendChild(el("div", { class: "acct-static acct-dim" },
        b.reason ? stripeReasonText(b) : "No card on file."));
    }
    cols.appendChild(pmBox);

    var addrBox = el("div", { class: "acct-subblock" });
    addrBox.appendChild(el("span", { class: "panel-input-label" }, "Billing address"));
    if (b.billingAddress) {
      var addr = el("div", { class: "acct-static acct-address" });
      [b.billingAddress.name, b.billingAddress.line1, b.billingAddress.line2,
       [b.billingAddress.city, b.billingAddress.postalCode].filter(Boolean).join(" "),
       b.billingAddress.country]
        .filter(Boolean)
        .forEach(function (line) { addr.appendChild(el("span", null, line)); });
      addrBox.appendChild(addr);
    } else {
      addrBox.appendChild(el("div", { class: "acct-static acct-dim" },
        b.reason ? stripeReasonText(b) : "No billing address on file."));
    }
    cols.appendChild(addrBox);
    pmCard.body.appendChild(cols);

    if (b.org.role === "owner") {
      var pmActions = el("div", { class: "form-actions" });
      pmActions.appendChild(button("Edit in Stripe ↗", "btn-ghost",
        function (btn) { core.openBillingPortal(btn); }));
      pmCard.body.appendChild(pmActions);
    }
    body.appendChild(pmCard.panel);

    // --- portal ---
    if (b.org.role === "owner") {
      var portal = el("div", { class: "acct-portal" });
      var pt = el("div", { class: "acct-portal-text" });
      pt.appendChild(el("strong", null, "Manage billing in Stripe"));
      pt.appendChild(el("p", null,
        "Card details, invoice history, plan changes and cancellation all complete in Stripe's secure " +
        "customer portal. Algosize never sees or stores your card number."));
      portal.appendChild(pt);
      portal.appendChild(button("Open Stripe portal ↗", "btn-primary",
        function (btn) { core.openBillingPortal(btn); }));
      body.appendChild(portal);
    } else {
      body.appendChild(el("p", { class: "panel-input-help" },
        "Only the owner of this organisation can change billing."));
    }
  }

  function stripeReasonText(b) {
    if (b.reason === "no_stripe_customer") return "Never been through checkout — nothing on file with Stripe yet.";
    if (b.reason === "stripe_not_configured") return "Billing is not configured in this environment.";
    if (b.reason === "stripe_unreachable") return "Could not reach Stripe. Your plan and seats are from our own records and are accurate.";
    return "";
  }

  function openCancelConfirm(host) {
    var existing = host.querySelector(".acct-confirm");
    if (existing) return;
    var b = state.billing;
    var a = state.account;
    var endDate = fmtDate(b.entitlement && b.entitlement.currentPeriodEnd);

    var items = [
      "Client-facing reports stop being white-labelled — shared links revert to Algosize branding.",
      (b.org.seatsUsed > 1
        ? b.org.seatsUsed + " members lose paid access. Only the owner keeps a free-tier login."
        : "The account drops to the free tier."),
      "Scheduled monitors stop, and CI ingestion returns 402 on the next push.",
      "Scan runs drop to 5 a month, and existing reports become read-only.",
    ];

    var extra = null;
    if (a && a.credit && a.credit.known && a.credit.balanceCents > 0) {
      extra = el("p", { class: "acct-confirm-credit" },
        "Your " + a.credit.balance + " of credit stays on the account and applies to a future Algosize " +
        "invoice. It is not refunded as cash.");
    }

    var box = confirmBox({
      danger: true,
      title: "Cancel the " + planName(b.org.tier, true) + " subscription?",
      body: "You keep access until " + endDate + " — cancelling does not cut you off today. After that date this is what stops:",
      items: items,
      extra: extra,
      cancelLabel: "Keep my plan",
      confirmLabel: "Continue in Stripe ↗",
      note: "Cancellation completes in Stripe's portal — the subscription is Stripe's record, so Algosize never ends it behind Stripe's back.",
      onCancel: function () { box.remove(); },
      onConfirm: function (btn) { core.openBillingPortal(btn); },
    });
    host.appendChild(box);
    box.scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------------
  // INVOICES
  // ---------------------------------------------------------------------

  function renderInvoices(body) {
    var inv = state.invoices;
    if (!inv) { body.appendChild(el("div", { class: "panel-empty" }, "Loading invoices…")); return; }

    if (inv.invoices === null) {
      // null is not empty. Saying "no invoices" when we could not look is the
      // one wrong answer this screen can give a customer with a filing cabinet.
      body.appendChild(core.errorState(
        inv.message || "Could not load your invoices from Stripe. Nothing is wrong with your account."));
    } else if (!inv.invoices.length) {
      var b = state.billing;
      var next = b && b.entitlement && b.entitlement.currentPeriodEnd;
      body.appendChild(richEmpty(
        "No invoices yet",
        inv.reason === "no_stripe_customer"
          ? "This organisation has not been through checkout, so nothing has been charged."
          : next
            ? "Your first invoice is raised on " + fmtDate(next) + ". It will appear here and go to your billing email the same day."
            : "Nothing has been charged yet.",
        null));
    } else {
      var actions = [button("Full history in Stripe ↗", "btn-ghost btn-sm",
        function (btn) { core.openBillingPortal(btn); })];
      var card = panel(
        inv.invoices.length + (inv.invoices.length === 1 ? " invoice" : " invoices"),
        inv.totalPaid ? inv.totalPaid + " paid to date" : null,
        actions);
      inv.invoices.forEach(function (i) {
        card.body.appendChild(invoiceRow(i));
      });
      body.appendChild(card.panel);
    }

    body.appendChild(billingEmailCard());
  }

  function invoiceRow(i) {
    var row = el("div", { class: "acct-invoice" });
    row.appendChild(el("span", { class: "mono acct-invoice-date" }, fmtDate(i.created)));
    row.appendChild(el("span", { class: "mono acct-dim acct-invoice-num" }, i.number || i.id));
    row.appendChild(el("span", { class: "mono acct-invoice-amount" }, i.amount));

    var tone = i.status === "paid" ? "chip-ok"
      : (i.status === "open" || i.status === "uncollectible") ? "chip-warn"
      : "chip-muted";
    row.appendChild(chip(i.status, tone));

    var links = el("span", { class: "acct-invoice-links" });
    if (i.pdfUrl) {
      links.appendChild(el("a", {
        class: "btn btn-ghost btn-sm", href: i.pdfUrl, target: "_blank", rel: "noopener",
      }, "PDF ↓"));
    }
    // An unpaid invoice needs a way to be paid, not just downloaded.
    if (i.hostedInvoiceUrl && i.status !== "paid") {
      links.appendChild(el("a", {
        class: "btn btn-primary btn-sm", href: i.hostedInvoiceUrl, target: "_blank", rel: "noopener",
      }, "Pay ↗"));
    }
    row.appendChild(links);
    return row;
  }

  function billingEmailCard() {
    var b = state.billing;
    var card = panel("Billing email",
      "Where invoices and payment failures are sent. Separate from your login email, so finance can receive " +
      "invoices without holding an account.");

    if (!b || b.org.role !== "owner") {
      card.body.appendChild(el("p", { class: "panel-input-help" },
        "Only the owner can change where invoices are sent."));
      return card.panel;
    }

    var current = b.billingEmail || {};
    var f = field("Invoice recipient", "acct-billing-email",
      current.explicit ? current.address : "", {
        type: "email", mono: true,
        placeholder: current.address || "finance@company.com",
      });
    var msg = msgSlot("acct-billing-email-msg");
    var row = el("div", { class: "acct-inline-form" });
    row.appendChild(f.wrap);
    row.appendChild(button("Save", "btn-primary", function (btn) {
      var v = f.input.value.trim();
      setBusy(btn, true, "Saving…");
      callApi("/api/billing/email", { email: v === "" ? null : v }, "PUT")
        .then(function (res) {
          showMsg(msg, res.note, false);
          return loadBilling();
        })
        .catch(function (e) { showMsg(msg, e.message || "Could not save.", true); })
        .then(function () { setBusy(btn, false); });
    }));
    card.body.appendChild(row);
    card.body.appendChild(msg);
    card.body.appendChild(el("p", { class: "panel-input-help" },
      "Payment-failure notices go to both this address and the owner — a finance inbox nobody reads is how " +
      "a card decline becomes a lapsed account."));
    return card.panel;
  }

  // ---------------------------------------------------------------------
  // BRANDING
  // ---------------------------------------------------------------------

  var ACCENTS = [
    { name: "Pine", hex: "#1c5f4a" },
    { name: "Ink", hex: "#1d3557" },
    { name: "Oxblood", hex: "#6b2130" },
    { name: "Slate", hex: "#3f4854" },
  ];

  function renderBranding(body) {
    var org = state.org;
    if (!org) { body.appendChild(el("div", { class: "panel-empty" }, "Loading branding…")); return; }
    var br = org.branding || {};

    if (!br.available) {
      body.appendChild(brandingLocked(org));
      return;
    }
    if (org.role !== "owner" && org.role !== "admin") {
      var ro = panel("Branding", "Only an owner or admin can change branding.");
      ro.body.appendChild(el("p", { class: "panel-input-help" },
        br.companyName || br.logoUrl
          ? "Reports currently carry " + (br.companyName || "your logo") + "."
          : "Reports currently carry Algosize branding."));
      body.appendChild(ro.panel);
      return;
    }

    // --- logo + accent ---
    var card = panel("Logo & accent", "Applied to the report header, the share email and the shared web view.");
    var logoRow = el("div", { class: "acct-logo-row" });
    var preview = br.logoUrl
      ? el("img", { class: "acct-logo-preview", src: br.logoUrl, alt: "Your current logo" })
      : el("span", { class: "acct-logo-preview acct-logo-empty", "aria-hidden": "true" }, "—");
    logoRow.appendChild(preview);
    var nameF = field("Company name", "acct-brand-name", br.companyName, {
      placeholder: "Northgate Partners",
    });
    var logoF = field("Logo URL", "acct-brand-logo", br.logoUrl, {
      mono: true, placeholder: "https://…/logo.svg",
      help: "https only, and it must stay reachable — it is loaded inside a document you send to clients.",
    });
    var fields = el("div", { class: "acct-grid" });
    fields.appendChild(nameF.wrap);
    fields.appendChild(logoF.wrap);
    card.body.appendChild(logoRow);
    card.body.appendChild(fields);

    // Accent picker.
    var chosen = { hex: br.accent || null };
    var accentWrap = el("div", { class: "acct-field" });
    accentWrap.appendChild(el("span", { class: "panel-input-label" }, "Accent colour"));
    var group = el("div", { class: "acct-accents", role: "radiogroup", "aria-label": "Accent colour" });
    var swatches = [];
    function paintAccents() {
      swatches.forEach(function (s) {
        var on = chosen.hex === s.hex;
        s.node.setAttribute("aria-checked", on ? "true" : "false");
        s.node.classList.toggle("acct-accent-on", on);
      });
      repaintBrandPreview();
    }
    ACCENTS.concat(br.accent && !ACCENTS.some(function (a) { return a.hex === br.accent; })
      ? [{ name: "Current", hex: br.accent }] : []).forEach(function (a) {
      var b = el("button", {
        type: "button", role: "radio", class: "acct-accent",
        "aria-label": a.name, "aria-checked": "false",
      });
      b.appendChild(el("span", { class: "acct-accent-dot", "aria-hidden": "true" }));
      b.lastChild.style.background = a.hex;
      b.appendChild(el("span", null, a.name));
      b.addEventListener("click", function () { chosen.hex = a.hex; paintAccents(); });
      swatches.push({ node: b, hex: a.hex });
      group.appendChild(b);
    });
    var clearAccent = el("button", { type: "button", class: "acct-accent" });
    clearAccent.appendChild(el("span", null, "Default"));
    clearAccent.addEventListener("click", function () { chosen.hex = null; paintAccents(); });
    swatches.push({ node: clearAccent, hex: null });
    group.appendChild(clearAccent);
    accentWrap.appendChild(group);
    accentWrap.appendChild(el("p", { class: "panel-input-help" },
      "Applies to buttons, badges and rules. Never to severity — a palette that made critical findings look " +
      "calm would defeat the point of the report."));
    card.body.appendChild(accentWrap);

    var bMsg = msgSlot("acct-brand-msg");
    var bActions = el("div", { class: "form-actions acct-actions-right" });
    bActions.appendChild(button("Save branding", "btn-primary", function (btn) {
      setBusy(btn, true, "Saving…");
      callApi("/api/org/branding", {
        companyName: nameF.input.value.trim() === "" ? null : nameF.input.value.trim(),
        logoUrl:     logoF.input.value.trim() === "" ? null : logoF.input.value.trim(),
        accent:      chosen.hex,
      }, "PUT")
        .then(function (res) {
          showMsg(bMsg, res.note || "Saved. New reports use this branding.", false);
          return loadOrg();
        })
        .catch(function (e) { showMsg(bMsg, e.message || "Could not save branding.", true); })
        .then(function () { setBusy(btn, false); });
    }));
    card.body.appendChild(bActions);
    card.body.appendChild(bMsg);
    body.appendChild(card.panel);

    // --- preview, against real components ---
    var prevCard = panel("Preview as your client sees it",
      "The real components, not swatches — a report header on paper, and the share email in a dark client.");
    var previews = el("div", { class: "acct-previews" });
    previews.appendChild(reportPreview(nameF, chosen));
    previews.appendChild(emailPreview(nameF, chosen));
    prevCard.body.appendChild(previews);
    body.appendChild(prevCard.panel);

    function repaintBrandPreview() {
      var host = document.getElementById("acct-preview-wrap");
      if (!host) return;
      clear(host);
      host.appendChild(reportPreview(nameF, chosen));
      host.appendChild(emailPreview(nameF, chosen));
    }
    previews.id = "acct-preview-wrap";
    nameF.input.addEventListener("input", repaintBrandPreview);
    paintAccents();

    // --- custom domain ---
    body.appendChild(domainCard(br.domain || {}));

    // --- reset ---
    var reset = el("div", { class: "acct-reset" });
    var rt = el("div", null);
    rt.appendChild(el("strong", null, "Reset branding to Algosize default"));
    rt.appendChild(el("p", null,
      "Clears the name, logo and accent. Reports already shared keep the branding they were created with."));
    reset.appendChild(rt);
    reset.appendChild(button("Reset branding", "btn-ghost btn-danger-ghost", function (btn) {
      if (!window.confirm("Clear your company name, logo and accent? Reports already shared are unchanged.")) return;
      setBusy(btn, true, "Resetting…");
      callApi("/api/org/branding", { companyName: null, logoUrl: null, accent: null }, "PUT")
        .then(function () { return loadOrg().then(function () { paint(); }); })
        .catch(function (e) { window.alert(e.message || "Could not reset."); })
        .then(function () { setBusy(btn, false); });
    }));
    body.appendChild(reset);
  }

  function brandingLocked(org) {
    var wrap = el("div", { class: "acct-upsell" });
    var head = el("div", { class: "acct-upsell-head" });
    head.appendChild(el("span", { class: "acct-upsell-glyph", "aria-hidden": "true" }, "◈"));
    var ht = el("div", null);
    var line = el("span", { class: "acct-method-name" });
    line.appendChild(el("strong", null, "Branding is a Firm feature"));
    line.appendChild(chip((org.org && org.org.tier ? org.org.tier : "free") + " plan", "chip-muted"));
    ht.appendChild(line);
    ht.appendChild(el("p", null,
      "Reports you share today carry Algosize branding. On Firm they carry yours — your logo and accent in " +
      "the report header, on a domain you own, with the Algosize attribution reduced to a single line."));
    head.appendChild(ht);
    wrap.appendChild(head);

    var items = el("div", { class: "acct-upsell-items" });
    [["Your mark, not ours", "Logo and accent in the report header, the share email and the shared web view."],
     ["Your domain", "reports.yourfirm.com instead of algosize.com/r/… ."],
     ["One attribution line", "“powered by Algosize” stays — everything above it becomes yours."]]
      .forEach(function (pair) {
        var it = el("div", { class: "acct-upsell-item" });
        it.appendChild(el("strong", null, pair[0]));
        it.appendChild(el("span", null, pair[1]));
        items.appendChild(it);
      });
    wrap.appendChild(items);

    var cta = el("div", { class: "acct-upsell-cta" });
    cta.appendChild(el("a", { class: "btn btn-primary", href: "/#pricing" }, "See plans →"));
    var a = state.account;
    if (a && a.credit && a.credit.known && a.credit.balanceCents > 0) {
      cta.appendChild(el("span", { class: "mono acct-dim" },
        a.credit.balance + " of credit applies to your first invoice"));
    }
    wrap.appendChild(cta);
    wrap.appendChild(el("p", { class: "panel-input-help" },
      "Shown as a locked panel rather than a hidden section — someone comparing plans should be able to see " +
      "what Firm buys without leaving the account area."));
    return wrap;
  }

  function reportPreview(nameF, chosen) {
    var accent = chosen.hex || "#0f766e";
    var name = nameF.input.value.trim() || "Your firm";
    var wrap = el("div", { class: "acct-preview" });
    wrap.appendChild(el("span", { class: "panel-input-label" }, "Report header · printed"));
    var paper = el("div", { class: "acct-preview-paper" });
    var ph = el("div", { class: "acct-preview-paper-head" });
    var mark = el("span", { class: "acct-preview-mark" }, initials(name));
    mark.style.background = accent;
    ph.appendChild(mark);
    var pn = el("div", { class: "acct-preview-paper-name" });
    pn.appendChild(el("strong", null, name));
    pn.appendChild(el("span", null, "powered by Algosize"));
    ph.appendChild(pn);
    paper.appendChild(ph);
    var score = el("div", { class: "acct-preview-score" });
    score.appendChild(el("span", { class: "acct-preview-grade" }, "F"));
    score.appendChild(el("span", { class: "acct-preview-num" }, "27 / 100"));
    var rule = el("span", { class: "acct-preview-rule" });
    rule.style.background = accent;
    score.appendChild(rule);
    paper.appendChild(score);
    wrap.appendChild(paper);
    return wrap;
  }

  function emailPreview(nameF, chosen) {
    var accent = chosen.hex || "#0f766e";
    var name = nameF.input.value.trim() || "Your firm";
    var wrap = el("div", { class: "acct-preview" });
    wrap.appendChild(el("span", { class: "panel-input-label" }, "Share email · dark client"));
    var mail = el("div", { class: "acct-preview-mail" });
    var mh = el("div", { class: "acct-preview-mail-head" });
    var mark = el("span", { class: "acct-preview-mark" }, initials(name));
    mark.style.background = accent;
    mh.appendChild(mark);
    mh.appendChild(el("strong", null, name));
    mail.appendChild(mh);
    mail.appendChild(el("p", null, "Your dependency audit for acme/api-gateway is ready. 1 critical finding needs attention."));
    var cta = el("span", { class: "acct-preview-btn" }, "View report");
    cta.style.background = accent;
    mail.appendChild(cta);
    mail.appendChild(el("span", { class: "acct-preview-foot" }, "Sent by " + name + " via Algosize"));
    wrap.appendChild(mail);
    return wrap;
  }

  function initials(name) {
    var words = String(name || "").split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  function domainCard(domain) {
    var card = panel("Custom domain", "Shared reports served from your domain instead of algosize.com.");
    var f = field("Domain", "acct-domain", domain.hostname, {
      mono: true, placeholder: "reports.yourfirm.com",
    });
    if (domain.status === "failed") f.input.classList.add("acct-input-bad");
    var msg = msgSlot("acct-domain-msg");

    var row = el("div", { class: "acct-inline-form" });
    row.appendChild(f.wrap);
    row.appendChild(button(domain.hostname ? "Replace" : "Add domain", "btn-ghost", function (btn) {
      var v = f.input.value.trim();
      if (!v) { showMsg(msg, "Enter a hostname you own.", true); return; }
      setBusy(btn, true, "Checking…");
      callApi("/api/org/domain", { domain: v }, "PUT")
        .then(function () { return loadOrg().then(function () { paint(); }); })
        .catch(function (e) { showMsg(msg, e.message || "Could not set that domain.", true); })
        .then(function () { setBusy(btn, false); });
    }));
    card.body.appendChild(row);
    card.body.appendChild(msg);

    if (!domain.hostname) {
      var unset = el("div", { class: "acct-domain-state acct-domain-unset" });
      var ut = el("div", null);
      ut.appendChild(el("strong", null, "No domain set"));
      ut.appendChild(el("p", null,
        "Reports are served from algosize.com/r/… . Adding a domain does not break existing links — they keep working."));
      unset.appendChild(ut);
      card.body.appendChild(unset);
      return card.panel;
    }

    card.body.appendChild(domainState(domain));
    return card.panel;
  }

  function domainState(domain) {
    var box = el("div", { class: "acct-domain-state acct-domain-" + (domain.status || "unset") });
    box.setAttribute("role", domain.status === "failed" ? "alert" : "status");

    var head = el("div", { class: "acct-domain-head" });
    var title = el("span", { class: "acct-method-name" });
    if (domain.status === "verified") {
      title.appendChild(el("strong", null, "Verified"));
      title.appendChild(chip("Live", "chip-ok", true));
    } else if (domain.status === "pending") {
      title.appendChild(el("strong", null, "Waiting for DNS"));
      title.appendChild(chip("Pending", "chip-warn"));
    } else if (domain.status === "failed") {
      title.appendChild(el("strong", null, "Verification failed"));
      title.appendChild(chip("Failed", "chip-danger"));
    }
    head.appendChild(title);
    if (domain.checkedAt) {
      head.appendChild(el("span", { class: "mono acct-dim" },
        "checked " + core.formatRelativeTime(domain.checkedAt * 1000) +
        (domain.status !== "verified" ? " · attempt " + domain.attempts + " of " + domain.maxAttempts : "")));
    }
    box.appendChild(head);

    if (domain.detail) box.appendChild(el("p", { class: "acct-domain-detail" }, domain.detail));

    // The record itself, on anything that is not yet live.
    if (domain.status !== "verified" && domain.record) {
      box.appendChild(el("span", { class: "panel-input-label" }, "Add this record at your DNS provider"));
      var tbl = el("div", { class: "acct-dns" });
      [["TYPE", domain.record.type], ["NAME", domain.record.name], ["VALUE", domain.record.value]]
        .forEach(function (pair) {
          var r = el("div", { class: "acct-dns-row" });
          r.appendChild(el("span", { class: "mono acct-dim" }, pair[0]));
          r.appendChild(el("span", { class: "mono" }, pair[1]));
          tbl.appendChild(r);
        });
      box.appendChild(tbl);
    }

    // Verified DNS still is not a served hostname. Say which half is done.
    if (domain.status === "verified" && !domain.servingReady && domain.servingNote) {
      box.appendChild(el("p", { class: "acct-domain-detail" }, domain.servingNote));
    }

    var acts = el("div", { class: "acct-domain-actions" });
    acts.appendChild(button(domain.status === "failed" ? "Retry verification" : "Check now",
      domain.status === "failed" ? "btn-primary btn-sm" : "btn-ghost btn-sm", function (btn) {
        setBusy(btn, true, "Checking…");
        callApi("/api/org/domain/verify", null, "POST")
          .then(function () { return loadOrg().then(function () { paint(); }); })
          .catch(function (e) { window.alert(e.message || "Could not check DNS."); })
          .then(function () { setBusy(btn, false); });
      }));
    acts.appendChild(button("Remove domain", "btn-ghost btn-sm btn-danger-ghost", function (btn) {
      if (!window.confirm("Remove " + domain.hostname + "? Shared reports go back to algosize.com — links already sent keep working.")) return;
      setBusy(btn, true, "Removing…");
      callApi("/api/org/domain", null, "DELETE")
        .then(function () { return loadOrg().then(function () { paint(); }); })
        .catch(function (e) { window.alert(e.message || "Could not remove."); })
        .then(function () { setBusy(btn, false); });
    }));
    box.appendChild(acts);

    box.appendChild(el("p", { class: "panel-input-help" },
      "Existing shared links keep working in every state — a domain that is pending or failed never takes a client's report offline."));
    return box;
  }

  // ---------------------------------------------------------------------
  // REFERRALS
  // ---------------------------------------------------------------------

  function renderReferrals(body) {
    var r = state.referrals;
    if (!r) { body.appendChild(el("div", { class: "panel-empty" }, "Loading referrals…")); return; }

    var credit = r.credit || {};
    var terms = r.terms || {};

    // --- balance ---
    var bal = el("div", { class: "acct-credit" });
    var left = el("div", { class: "acct-credit-left" });
    left.appendChild(el("span", { class: "acct-stat-label" }, "Credit balance"));
    left.appendChild(el("span", { class: "acct-credit-amount" },
      credit.known ? credit.balance : "—"));
    // The qualifier is inline and in normal weight, not a tooltip and not a
    // footnote: this is the sentence someone forwards to their finance team.
    left.appendChild(el("strong", { class: "acct-credit-policy" }, terms.cashPolicy || ""));
    if (!credit.known) {
      left.appendChild(el("span", { class: "field-msg field-msg-error" },
        "Your credit ledger could not be read, so this is unknown rather than zero."));
    } else if (credit.expiringAt) {
      left.appendChild(el("span", { class: "acct-dim" },
        credit.expiring + " of this expires " + fmtDate(credit.expiringAt) + ". " + (terms.expiry || "")));
    } else if (credit.balanceCents > 0) {
      left.appendChild(el("span", { class: "acct-dim" }, terms.expiry || ""));
    }
    bal.appendChild(left);

    if (credit.known && credit.unsyncedCents > 0) {
      // Our ledger and Stripe's disagree. Surfaced, not hidden — a discount
      // that silently fails to apply is a billing dispute after the invoice.
      left.appendChild(el("span", { class: "field-msg field-msg-error" },
        "Some of this credit has not reached Stripe yet, so it may not come off your next invoice. " +
        "It is not lost — contact support if the next invoice does not reflect it."));
    }
    body.appendChild(bal);

    // --- link ---
    var linkCard = panel("Your referral link", terms.earnRule || null);
    if (r.usage && r.usage.limitReached) {
      var lim = el("div", { class: "acct-domain-state acct-domain-pending", role: "alert" });
      var lt = el("div", null);
      lt.appendChild(el("strong", null,
        "Referral link paused — " + r.usage.used + " of " + r.usage.limit + " signups used"));
      lt.appendChild(el("p", null,
        "The link stops accepting new signups at " + r.usage.limit + " per window" +
        (r.usage.windowEndsAt ? ", and resets on " + fmtDate(r.usage.windowEndsAt) : "") +
        ". Credit you have already earned is unaffected and stays on the account."));
      lt.appendChild(el("p", null,
        "If you are referring at this volume deliberately, we will lift the cap — this limit exists to catch " +
        "abuse, not to cap a partner."));
      lim.appendChild(lt);
      lim.appendChild(el("a", {
        class: "btn btn-primary btn-sm",
        href: "mailto:hello@algosize.com?subject=" + encodeURIComponent("Raise our referral limit"),
      }, "Request a higher limit"));
      linkCard.body.appendChild(lim);
    } else if (r.link) {
      linkCard.body.appendChild(copyRow(r.link));
      if (r.usage) {
        linkCard.body.appendChild(el("span", { class: "mono acct-dim" },
          r.usage.used + " of " + r.usage.limit + " signups used" +
          (r.usage.windowEndsAt ? " · resets " + fmtDate(r.usage.windowEndsAt) : "")));
      }
    } else {
      linkCard.body.appendChild(core.errorState(r.message || "No referral link is available right now."));
    }

    // Record an address you shared it with.
    if (r.link && !(r.usage && r.usage.limitReached)) {
      var iMsg = msgSlot("acct-ref-msg");
      var iRow = el("div", { class: "acct-inline-form" });
      var iF = field("Note someone you shared it with", "acct-ref-email", "", {
        type: "email", mono: true, placeholder: "name@partnerfirm.com",
        help: "Bookkeeping only — this does not send anything and does not use up your signup allowance.",
      });
      iRow.appendChild(iF.wrap);
      iRow.appendChild(button("Add to list", "btn-ghost", function (btn) {
        var v = iF.input.value.trim();
        if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          showMsg(iMsg, "Enter a valid email address.", true); return;
        }
        setBusy(btn, true, "Adding…");
        callApi("/api/referrals/invite", { email: v })
          .then(function () { iF.input.value = ""; return loadReferrals().then(function () { paint(); }); })
          .catch(function (e) { showMsg(iMsg, e.message || "Could not add.", true); })
          .then(function () { setBusy(btn, false); });
      }));
      linkCard.body.appendChild(iRow);
      linkCard.body.appendChild(iMsg);
    }
    body.appendChild(linkCard.panel);

    // --- funnel ---
    if (!r.referrals || !r.referrals.length) {
      body.appendChild(richEmpty(
        "Share your link and start earning credit",
        (terms.creditPerReferral || "Credit") +
        " off your bill for each organisation that becomes a paying customer. Most referrals come from a " +
        "partner firm you already share audits with.",
        r.link ? copyRow(r.link, { emphasis: true }) : null));
    } else {
      var credited = r.referrals.filter(function (x) { return x.stage === "credited"; }).length;
      var fCard = panel("Referrals",
        r.referrals.length + " shared · " + credited + " credited");
      r.referrals.forEach(function (x) {
        var row = el("div", { class: "acct-referral" });
        row.appendChild(el("span", { class: "acct-referral-org" }, x.label));
        row.appendChild(chip(x.stage.replace("_", " "), stageTone(x.stage)));
        row.appendChild(el("span", { class: "mono acct-dim" }, fmtDate(x.at)));
        row.appendChild(el("span", {
          class: "mono " + (x.credit ? "acct-referral-credit" : "acct-dim"),
        }, x.credit || "not yet"));
        fCard.body.appendChild(row);
      });
      body.appendChild(fCard.panel);
    }

    // --- credit history ---
    if (credit.events && credit.events.length) {
      var hist = el("details", { class: "panel acct-details" });
      var sum = el("summary", { class: "acct-details-summary" });
      var st = el("span", { class: "acct-details-title" });
      st.appendChild(el("strong", null, "Credit history"));
      st.appendChild(el("span", { class: "acct-dim" },
        credit.events.length + " events · earned, applied and expired"));
      sum.appendChild(st);
      sum.appendChild(el("span", { class: "mono acct-dim", "aria-hidden": "true" }, "expand"));
      hist.appendChild(sum);
      var hb = el("div", { class: "acct-details-body" });
      credit.events.forEach(function (e) {
        var row = el("div", { class: "acct-credit-row" });
        row.appendChild(el("span", { class: "mono acct-dim" }, fmtDate(e.at)));
        row.appendChild(el("span", null, e.description));
        row.appendChild(el("span", {
          class: "mono acct-credit-delta " +
            (e.amountCents > 0 ? "acct-credit-plus" : e.kind === "expired" ? "acct-credit-expired" : ""),
        }, e.amount));
        hb.appendChild(row);
      });
      hist.appendChild(hb);
      body.appendChild(hist);
    }
  }

  function stageTone(stage) {
    if (stage === "credited") return "chip-ok";
    if (stage === "converted") return "chip-mark";
    return "chip-muted";
  }

  // ---------------------------------------------------------------------
  // TEAM
  // ---------------------------------------------------------------------

  function renderTeam(body) {
    var org = state.org;
    if (!org) { body.appendChild(el("div", { class: "panel-empty" }, "Loading team…")); return; }
    var manage = org.role === "owner" || org.role === "admin";
    var used = org.org.seatsUsed, total = org.org.seatsPurchased;
    var full = used >= total;

    // --- seats ---
    var seatCard = panel("Seats", null);
    var sh = el("div", { class: "acct-usage-head" });
    sh.appendChild(el("span", { class: "panel-input-label" }, "Seats"));
    sh.appendChild(el("span", { class: "mono" + (full ? " acct-stat-warn" : "") },
      used + " of " + total + (full ? " · full" : "")));
    seatCard.body.appendChild(sh);
    seatCard.body.appendChild(meter(used, total, full));
    seatCard.body.appendChild(el("p", { class: "panel-input-help" },
      org.members.length + " active " + (org.members.length === 1 ? "member" : "members") + " and " +
      org.pendingInvites.length + " outstanding " +
      (org.pendingInvites.length === 1 ? "invite" : "invites") +
      ". An invite holds its seat until accepted or revoked."));

    if (full) {
      var fullBox = el("div", { class: "acct-domain-state acct-domain-pending", role: "status" });
      var ft = el("div", null);
      ft.appendChild(el("strong", null, "All " + total + " seats are taken — inviting is paused, not broken"));
      ft.appendChild(el("p", null,
        "Add seats in the Stripe portal and the invite goes out immediately. Or revoke one of the " +
        org.pendingInvites.length + " outstanding invites below — those hold a seat exactly like a member does."));
      fullBox.appendChild(ft);
      if (org.role === "owner") {
        fullBox.appendChild(button("Add seats ↗", "btn-amber btn-sm",
          function (btn) { core.openBillingPortal(btn); }));
      }
      seatCard.body.appendChild(fullBox);
    }
    body.appendChild(seatCard.panel);

    // --- members ---
    var mCard = panel("Members",
      org.members.length + " active · " + org.pendingInvites.length + " pending");
    org.members.forEach(function (m) {
      mCard.body.appendChild(memberRow(m, manage, org));
    });
    org.pendingInvites.forEach(function (i) {
      mCard.body.appendChild(inviteRow(i, manage));
    });
    body.appendChild(mCard.panel);

    // --- invite ---
    if (manage) {
      var iCard = panel("Invite a member",
        "The invite holds a seat from the moment you send it. Only the owner can invite an admin.");
      var iMsg = msgSlot("acct-invite-msg");
      var iRow = el("div", { class: "acct-inline-form" });
      var emailF = field("Email", "acct-invite-email", "", { type: "email", mono: true });
      iRow.appendChild(emailF.wrap);

      var roleWrap = el("div", { class: "acct-field acct-field-narrow" });
      roleWrap.appendChild(el("label", { class: "panel-input-label", for: "acct-invite-role" }, "Role"));
      var roleSel = el("select", { id: "acct-invite-role", class: "panel-input acct-input" });
      roleSel.appendChild(el("option", { value: "member" }, "Member"));
      if (org.role === "owner") roleSel.appendChild(el("option", { value: "admin" }, "Admin"));
      roleWrap.appendChild(roleSel);
      iRow.appendChild(roleWrap);

      iRow.appendChild(button(full ? "Send anyway" : "Send invite", "btn-primary", function (btn) {
        var v = emailF.input.value.trim();
        if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          showMsg(iMsg, "Enter a valid email address.", true); return;
        }
        setBusy(btn, true, "Sending…");
        callApi("/api/org/invite", { email: v, role: roleSel.value })
          .then(function () {
            emailF.input.value = "";
            return loadOrg().then(function () { paint(); });
          })
          .catch(function (e) {
            // 402 is a purchase, not a refusal — say so rather than showing
            // a bare error.
            showMsg(iMsg, e.code === "seat_limit_reached"
              ? "No seats free. Add seats in the Stripe portal, or revoke an outstanding invite below."
              : (e.message || "Could not send the invite."), true);
          })
          .then(function () { setBusy(btn, false); });
      }));
      iCard.body.appendChild(iRow);
      iCard.body.appendChild(iMsg);
      iCard.body.appendChild(el("span", { class: "mono acct-dim" },
        full ? "No seats free — this will be refused until you add one or revoke an invite."
             : (total - used) + " seats remaining after this invite."));
      body.appendChild(iCard.panel);
    }
  }

  function memberRow(m, manage, org) {
    var row = el("div", { class: "acct-member" });
    row.appendChild(el("span", { class: "acct-avatar acct-avatar-sm", "aria-hidden": "true" },
      initials(m.email || "?")));
    var mid = el("div", { class: "acct-member-mid" });
    mid.appendChild(el("span", null, m.email || m.userId));
    mid.appendChild(el("span", { class: "mono acct-dim" }, "joined " + fmtDate(m.joinedAt)));
    row.appendChild(mid);
    row.appendChild(chip(m.role, "chip-role-" + m.role));
    row.appendChild(chip("Active", "chip-ok", true));

    if (m.role === "owner") {
      row.appendChild(el("span", { class: "acct-dim acct-session-lock" }, "Cannot remove the owner"));
    } else if (manage && !(org.role === "admin" && m.role === "admin")) {
      row.appendChild(button("Remove", "btn-ghost btn-sm btn-danger-ghost", function (btn) {
        if (!window.confirm("Remove " + (m.email || m.userId) + " from the organisation? Their seat frees up immediately.")) return;
        setBusy(btn, true, "Removing…");
        callApi("/api/org/members/" + encodeURIComponent(m.userId), null, "DELETE")
          .then(function () { return loadOrg().then(function () { paint(); }); })
          .catch(function (e) { window.alert(e.message || "Could not remove."); })
          .then(function () { setBusy(btn, false); });
      }));
    }
    return row;
  }

  function inviteRow(i, manage) {
    var row = el("div", { class: "acct-member acct-member-pending" });
    row.appendChild(el("span", { class: "acct-avatar acct-avatar-sm acct-avatar-pending", "aria-hidden": "true" },
      initials(i.email)));
    var mid = el("div", { class: "acct-member-mid" });
    mid.appendChild(el("span", null, i.email));
    mid.appendChild(el("span", { class: "mono acct-dim" },
      "invited " + fmtDate(i.sentAt) + " · holds a seat until accepted or revoked"));
    row.appendChild(mid);
    row.appendChild(chip("invited", "chip-muted"));
    row.appendChild(chip("Pending", "chip-warn", true));
    if (manage) {
      row.appendChild(button("Revoke", "btn-ghost btn-sm btn-danger-ghost", function (btn) {
        setBusy(btn, true, "Revoking…");
        callApi("/api/org/invite/revoke", { email: i.email })
          .then(function () { return loadOrg().then(function () { paint(); }); })
          .catch(function (e) { window.alert(e.message || "Could not revoke."); })
          .then(function () { setBusy(btn, false); });
      }));
    }
    return row;
  }

  // ---------------------------------------------------------------------
  // API KEYS
  // ---------------------------------------------------------------------

  function renderKeys(body) {
    var a = state.account;
    if (!(a.capabilities && a.capabilities.apiKeys.canManage)) {
      var ro = panel("API keys", "Only an owner or admin can see or manage API keys.");
      body.appendChild(ro.panel);
      return;
    }
    var keys = state.keys;
    if (!keys) { body.appendChild(el("div", { class: "panel-empty" }, "Loading keys…")); return; }
    var live = keys.filter(function (k) { return !k.revokedAt; });

    var createBtn = button("Create key", "btn-primary btn-sm", function (btn) {
      createKey(btn, body);
    });
    var card = panel(live.length ? live.length + (live.length === 1 ? " active key" : " active keys") : "No keys",
      "Keys authenticate CI ingestion for the whole organisation. A key cannot manage keys — this screen needs a signed-in session.",
      live.length ? [createBtn] : []);

    if (!live.length) {
      card.body.appendChild(richEmpty(
        "No API keys yet",
        "A key lets your CI pipeline submit scans on every push, so findings arrive before review rather than after deploy.",
        button("Create your first key", "btn-primary", function (btn) { createKey(btn, body); })));
    } else {
      live.forEach(function (k) {
        var row = el("div", { class: "acct-key" });
        var mid = el("div", { class: "acct-key-mid" });
        mid.appendChild(el("strong", null, k.name));
        mid.appendChild(el("span", { class: "mono acct-key-prefix" }, k.prefix + "…"));
        row.appendChild(mid);
        var meta = el("div", { class: "acct-key-meta" });
        meta.appendChild(el("span", { class: "mono acct-dim" },
          "created " + fmtDate(k.createdAt) + (k.createdBy ? " · " + k.createdBy : "")));
        meta.appendChild(el("span", { class: "mono acct-dim" },
          k.lastUsedAt ? "last used " + core.formatRelativeTime(k.lastUsedAt * 1000) : "never used"));
        row.appendChild(meta);
        row.appendChild(button("Revoke", "btn-ghost btn-sm btn-danger-ghost", function (btn) {
          if (!window.confirm("Revoke “" + k.name + "”? Any CI pipeline using it starts failing on the next push. This cannot be undone.")) return;
          setBusy(btn, true, "Revoking…");
          callApi("/api/keys/" + encodeURIComponent(k.keyId), null, "DELETE")
            .then(function () { return loadKeys().then(function () { paint(); }); })
            .catch(function (e) { window.alert(e.message || "Could not revoke."); })
            .then(function () { setBusy(btn, false); });
        }));
        card.body.appendChild(row);
      });
    }
    body.appendChild(card.panel);

    var rot = el("div", { class: "acct-inert" });
    var rt = el("div", null);
    rt.appendChild(el("strong", null, "Rotating a key"));
    rt.appendChild(el("p", null,
      "There is no in-place rotation, because a key's value only ever exists at creation. To rotate: create " +
      "the new key, update ALGOSIZE_API_KEY in your repository secrets, confirm a CI run succeeds, then " +
      "revoke the old one. In that order there is no window where CI has no working key."));
    rot.appendChild(rt);
    body.appendChild(rot);
  }

  function createKey(btn, body) {
    var name = window.prompt("Name this key — something that says where it runs, like “GitHub Actions · api-gateway”.");
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    setBusy(btn, true, "Creating…");
    callApi("/api/keys", { name: name })
      .then(function (res) {
        return loadKeys().then(function () {
          paint();
          showKeySecret(res);
        });
      })
      .catch(function (e) { window.alert(e.message || "Could not create the key."); })
      .then(function () { setBusy(btn, false); });
  }

  function showKeySecret(res) {
    var host = document.getElementById("acct-body");
    if (!host) return;
    var box = el("div", { class: "acct-reveal", role: "alert" });
    var t = el("div", null);
    t.appendChild(el("strong", null, "Key created — copy it now"));
    t.appendChild(el("p", null, res.message));
    box.appendChild(t);
    box.appendChild(copyRow(res.key, { emphasis: true }));
    var next = el("div", { class: "acct-reveal-next" });
    next.appendChild(el("span", { class: "panel-input-label" }, "Next step"));
    next.appendChild(el("span", null, "Store it as ALGOSIZE_API_KEY in your repository secrets."));
    next.appendChild(el("code", { class: "acct-code" },
      'gh secret set ALGOSIZE_API_KEY --body "' + res.prefix + '…"'));
    box.appendChild(next);
    box.appendChild(button("I've stored it", "btn-ghost", function () {
      // Don't leave the secret sitting in the DOM once it has been read.
      box.remove();
    }));
    host.insertBefore(box, host.firstChild);
    box.scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------------
  // NOTIFICATIONS
  // ---------------------------------------------------------------------

  function renderNotifications(body) {
    var n = state.notifications;
    if (!n) { body.appendChild(el("div", { class: "panel-empty" }, "Loading preferences…")); return; }

    state.notifDirty = {};

    n.groups.forEach(function (g) {
      var card = panel(g.title, g.description);
      var header = el("div", { class: "acct-notif-head" });
      header.appendChild(el("span", null, ""));
      ["Email", "In-app", "Slack"].forEach(function (label) {
        header.appendChild(el("span", { class: "panel-input-label acct-notif-col" }, label));
      });
      card.body.appendChild(header);

      g.rows.forEach(function (r) {
        var row = el("div", { class: "acct-notif-row" });
        var mid = el("div", { class: "acct-notif-mid" });
        mid.appendChild(el("span", null, r.label));
        mid.appendChild(el("span", { class: "acct-dim" }, r.hint));
        row.appendChild(mid);
        ["email", "inapp", "slack"].forEach(function (ch) {
          row.appendChild(toggle(r, ch, r.channels[ch]));
        });
        card.body.appendChild(row);
      });
      body.appendChild(card.panel);
    });

    var sMsg = msgSlot("acct-notif-msg");
    var acts = el("div", { class: "form-actions acct-actions-right" });
    acts.appendChild(button("Save preferences", "btn-primary", function (btn) {
      var prefs = {};
      n.groups.forEach(function (g) {
        g.rows.forEach(function (r) {
          ["email", "inapp", "slack"].forEach(function (ch) {
            var key = r.id + ":" + ch;
            prefs[key] = key in state.notifDirty ? state.notifDirty[key] : r.channels[ch].on;
          });
        });
      });
      setBusy(btn, true, "Saving…");
      callApi("/api/account/notifications", { prefs: prefs }, "PUT")
        .then(function (res) {
          state.notifications = { groups: res.groups, slack: n.slack, stored: true };
          showMsg(sMsg, "Saved.", false);
        })
        .catch(function (e) { showMsg(sMsg, e.message || "Could not save.", true); })
        .then(function () { setBusy(btn, false); });
    }));
    body.appendChild(acts);
    body.appendChild(sMsg);

    var why = el("div", { class: "acct-inert" });
    var wt = el("div", null);
    wt.appendChild(el("strong", null, "Why email cannot be switched off for billing"));
    wt.appendChild(el("p", null,
      "Email is the only channel guaranteed to exist for every account — in-app needs someone signed in, and " +
      "Slack needs a webhook that can be removed without telling us. A failed payment that nobody hears about " +
      "becomes a lapsed account, so those two rows are locked on. Everything else is yours to silence."));
    if (n.slack && !n.slack.configured) {
      wt.appendChild(el("p", { class: "mono acct-dim" }, n.slack.note));
    }
    why.appendChild(wt);
    body.appendChild(why);

    if (!n.stored) {
      body.appendChild(el("p", { class: "panel-input-help" },
        "These are the defaults — nothing has been saved for this account yet."));
    }
  }

  function toggle(row, channel, chState) {
    var wrap = el("span", { class: "acct-toggle-cell" });
    var b = el("button", {
      type: "button", role: "switch",
      "aria-checked": chState.on ? "true" : "false",
      "aria-label": row.label + " via " + channel + (chState.locked ? ", always on" : ""),
      class: "acct-toggle" + (chState.on ? " acct-toggle-on" : "") + (chState.locked ? " acct-toggle-locked" : ""),
    });
    b.appendChild(el("span", { class: "acct-toggle-knob", "aria-hidden": "true" }));
    if (chState.locked) {
      b.disabled = true;
      b.title = "Always on — a missed payment notice becomes a lapsed account.";
    } else {
      b.addEventListener("click", function () {
        var next = b.getAttribute("aria-checked") !== "true";
        b.setAttribute("aria-checked", next ? "true" : "false");
        b.classList.toggle("acct-toggle-on", next);
        state.notifDirty[row.id + ":" + channel] = next;
      });
    }
    wrap.appendChild(b);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // DANGER ZONE
  // ---------------------------------------------------------------------

  function renderDanger(body) {
    var a = state.account;
    var canDelete = a.capabilities && a.capabilities.dangerZone.canDeleteOrg;

    var zone = el("div", { class: "acct-danger" });
    var head = el("div", { class: "acct-confirm-head" });
    head.appendChild(el("span", { class: "acct-confirm-glyph", "aria-hidden": "true" }, "!"));
    var ht = el("div", { class: "acct-confirm-text" });
    ht.appendChild(el("strong", null, "Danger zone"));
    ht.appendChild(el("p", null,
      "Operations that change or end the account. Each states what it does before it will run."));
    head.appendChild(ht);
    zone.appendChild(head);

    // Export — safe, and listed first because it is what you do before the
    // other two.
    zone.appendChild(dangerRow(
      "Export account data",
      "Every report's metadata, findings, members, credit ledger and audit record as JSON. Reversible and " +
      "safe — do this before deleting anything.",
      el("a", {
        class: "btn btn-ghost", href: core.apiUrl("/api/account/export"), download: "",
      }, "Download ↓"),
      false));

    if (a.entitlement && a.entitlement.active && a.capabilities.billing.canManage) {
      zone.appendChild(dangerRow(
        "Cancel subscription",
        "Keeps the account and its reports, and drops it to the free tier at the end of the current period.",
        el("a", { class: "btn btn-ghost acct-btn-warn", href: "#/account/billing" }, "Go to cancellation"),
        true));
    }

    if (canDelete) {
      var deleteHost = el("div", { class: "acct-danger-delete" });
      var trigger = dangerRow(
        "Delete organisation",
        "Removes " + ((a.org && a.org.name) || "this organisation") + ", its members and every report. Not reversible.",
        button("Delete organisation", "btn-ghost btn-danger-ghost", function (btn) {
          openDeleteConfirm(deleteHost, btn);
        }),
        true);
      deleteHost.appendChild(trigger);
      zone.appendChild(deleteHost);
    } else {
      zone.appendChild(el("p", { class: "panel-input-help" },
        "Only the owner of this organisation can delete it."));
    }

    body.appendChild(zone);
  }

  function dangerRow(title, desc, action, warn) {
    var row = el("div", { class: "acct-danger-row" + (warn ? " acct-danger-row-warn" : "") });
    var t = el("div", null);
    t.appendChild(el("strong", null, title));
    t.appendChild(el("p", null, desc));
    row.appendChild(t);
    row.appendChild(action);
    return row;
  }

  function openDeleteConfirm(host, trigger) {
    if (host.querySelector(".acct-confirm")) return;
    setBusy(trigger, true, "Checking…");
    callApi("/api/account/delete-preview", null, "GET")
      .then(function (preview) {
        var typed = { value: "" };
        var input = el("input", {
          type: "text", class: "panel-input acct-input mono",
          placeholder: "Organisation name", autocomplete: "off",
          id: "acct-delete-confirm",
        });
        var hint = el("span", { class: "field-msg mono" }, "Case-sensitive, exactly as shown.");
        var extra = el("div", { class: "acct-delete-confirm" });
        var lbl = el("label", { for: "acct-delete-confirm" });
        lbl.appendChild(el("span", null, "Type "));
        lbl.appendChild(el("strong", { class: "mono acct-delete-phrase" }, preview.confirmPhrase));
        lbl.appendChild(el("span", null, " to enable the button."));
        extra.appendChild(lbl);
        extra.appendChild(input);
        extra.appendChild(hint);

        var box = confirmBox({
          danger: true,
          confirmDisabled: true,
          title: "Delete " + preview.confirmPhrase + "?",
          body: "This is not reversible. There is no restore, no grace window, and support cannot undo it. " +
                "Here is exactly what happens:",
          items: preview.consequences,
          extra: extra,
          cancelLabel: "Keep the organisation",
          confirmLabel: "Delete permanently",
          note: preview.note,
          onCancel: function () { box.remove(); },
          onConfirm: function (btn) {
            setBusy(btn, true, "Deleting…");
            callApi("/api/account/org", { confirm: typed.value.trim() }, "DELETE")
              .then(function () {
                // The account is gone; there is nothing left to render.
                window.location.assign("/");
              })
              .catch(function (e) {
                window.alert(e.message || "Could not delete the organisation.");
                setBusy(btn, false);
              });
          },
        });

        input.addEventListener("input", function () {
          typed.value = input.value;
          var ok = input.value.trim() === preview.confirmPhrase;
          box.confirmButton.disabled = !ok;
          hint.textContent = ok
            ? "Match confirmed — the button below is now live."
            : input.value
              ? "Does not match yet."
              : "Case-sensitive, exactly as shown.";
          hint.classList.toggle("field-msg-ok", ok);
          hint.classList.toggle("field-msg-error", !!input.value && !ok);
          input.classList.toggle("acct-input-bad", !!input.value && !ok);
        });

        host.appendChild(box);
        input.focus();
      })
      .catch(function (e) { window.alert(e.message || "Could not load the deletion preview."); })
      .then(function () { setBusy(trigger, false); });
  }

  // ---------------------------------------------------------------------
  // loading
  // ---------------------------------------------------------------------

  function loadAccount() {
    return callApi("/api/account", null, "GET").then(function (d) { state.account = d; });
  }
  function loadOrg() {
    return callApi("/api/org", null, "GET")
      .then(function (d) { state.org = d; })
      .catch(function () { state.org = null; });
  }
  function loadBilling() {
    return callApi("/api/billing/summary", null, "GET")
      .then(function (d) { state.billing = d; })
      .catch(function () { state.billing = null; });
  }
  function loadInvoices() {
    return callApi("/api/billing/invoices", null, "GET")
      .then(function (d) { state.invoices = d; })
      // A member (not owner) gets a 403 here. That is not an error worth
      // showing as one — the section simply reports who can see invoices.
      .catch(function (e) { state.invoices = { invoices: null, reason: e.code || "error", message: e.message }; });
  }
  function loadReferrals() {
    return callApi("/api/referrals", null, "GET")
      .then(function (d) { state.referrals = d; })
      .catch(function (e) { state.referrals = { referrals: [], credit: {}, terms: {}, message: e.message }; });
  }
  function loadSessions() {
    return callApi("/api/account/sessions", null, "GET")
      .then(function (d) { state.sessions = d; })
      .catch(function () { state.sessions = { sessions: [], complete: false, indexedOnly: true }; });
  }
  function loadLogins() {
    return callApi("/api/account/logins", null, "GET")
      .then(function (d) { state.logins = d; })
      .catch(function () { state.logins = { logins: [], since: "" }; });
  }
  function loadNotifications() {
    return callApi("/api/account/notifications", null, "GET")
      .then(function (d) { state.notifications = d; })
      .catch(function () { state.notifications = null; });
  }
  function loadKeys() {
    return callApi("/api/keys", null, "GET")
      .then(function (d) { state.keys = d.keys || []; })
      // Members get 403; render as "no keys visible to you" rather than an error.
      .catch(function () { state.keys = []; });
  }

  /** Extra data a section needs, fetched the first time it is opened. */
  function loadForSection(id) {
    switch (id) {
      case "security":      return Promise.all([loadSessions(), loadLogins()]);
      case "billing":       return loadBilling();
      case "invoices":      return state.billing ? loadInvoices() : Promise.all([loadBilling(), loadInvoices()]);
      case "branding":      return loadOrg();
      case "referrals":     return loadReferrals();
      case "team":          return loadOrg();
      case "keys":          return loadKeys();
      case "notifications": return loadNotifications();
      default:              return Promise.resolve();
    }
  }

  function reload() {
    return loadAccount().then(function () { paint(); });
  }

  // ---------------------------------------------------------------------
  // paint
  // ---------------------------------------------------------------------

  function paint() {
    var body = document.getElementById("acct-body");
    if (!body || !state.account) return;
    var sec = sectionById(state.section);

    var titleEl = document.getElementById("acct-sec-title");
    var descEl  = document.getElementById("acct-sec-desc");
    if (titleEl) titleEl.textContent = sec.title;
    if (descEl)  descEl.textContent  = sec.desc;

    renderSummary();
    renderNav();

    clear(body);
    try {
      sec.render(body);
    } catch (err) {
      // A section that throws must not take the whole settings area with it —
      // the nav has to stay usable so someone can get to Billing even if
      // Branding is broken.
      clear(body);
      body.appendChild(core.errorState(
        "This section could not be displayed: " + (err && err.message ? err.message : "unknown error")));
    }
  }

  /**
   * Entry point from the router. `section` is null for a bare #/account.
   *
   * Idempotent per section: the account summary is fetched once, each
   * section's own data the first time that section is opened. Re-opening a
   * section repaints from what is already in memory rather than refetching,
   * so clicking between sections is instant; every mutation explicitly
   * reloads what it changed.
   */
  function open(section) {
    var target = section && sectionById(section).id === section ? section : "profile";
    state.section = target;

    var body = document.getElementById("acct-body");
    var first = !state.loaded;
    if (first) {
      state.loaded = true;
      if (body) { clear(body); body.appendChild(el("div", { class: "panel-empty" }, "Loading your account…")); }
    }

    var base = state.account ? Promise.resolve() : loadAccount();
    return base
      .then(function () {
        renderSummary();
        renderNav();
        return loadForSection(target);
      })
      .then(function () { paint(); })
      .catch(function (e) {
        if (!body) return;
        clear(body);
        body.appendChild(core.errorState(e.message || "Could not load your account."));
      });
  }

  function attach() {
    // The confirm-email redirect lands on #/account?email=<status>. Report
    // the outcome once, then clean the query out of the hash so a refresh
    // does not repeat it.
    var h = window.location.hash || "";
    var q = h.indexOf("?");
    if (q !== -1 && h.indexOf("#/account") === 0) {
      var params = new URLSearchParams(h.slice(q + 1));
      var status = params.get("email");
      if (status) {
        window.setTimeout(function () { reportEmailOutcome(status); }, 0);
        window.location.replace(h.slice(0, q));
      }
    }
  }

  function reportEmailOutcome(status) {
    var messages = {
      changed: "Your login email has been changed. Every session was signed out — sign in again with the new address.",
      expired_or_invalid: "That confirmation link has expired or was already used. Start the change again from Profile.",
      email_in_use: "That address was claimed by another Algosize account before you confirmed. Your email is unchanged.",
      missing_token: "That confirmation link was incomplete. Start the change again from Profile.",
      server_error: "Something went wrong confirming that address. Your email is unchanged — try again.",
    };
    var text = messages[status];
    if (text) window.alert(text);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  window.DashAccount = { open: open, load: function () { return open(state.section); } };
})();
