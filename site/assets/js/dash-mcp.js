// MCP Connections (#/mcp) — connect an AI assistant to Algosize.
//
// Endpoints this reads:
//   GET /api/mcp/manifest   the tool catalog. PUBLIC and cacheable, because it
//                           describes what the tools ARE and carries no
//                           customer data — so the catalog renders even before
//                           anything is connected, which is the whole point of
//                           the page for someone deciding whether to bother.
//   GET /api/mcp/clients    OAuth grants on this org, including revoked ones
//   GET /api/mcp/usage      recent tool calls and the month's totals
//   GET /api/keys           existing API keys, to pick one for the config block
//
// The page has two readers and no mode switch between them. A developer wants
// a command to paste and nothing else, so the setup card is first and complete
// on its own. A firm owner has to satisfy themselves that connecting an
// assistant to client audit data is safe, reversible and auditable — so the
// clients list, the activity feed and the security block are all reachable in
// one scroll, never behind a tab they would not think to open.
//
// A real secret is NEVER rendered. Every config block uses an environment
// variable placeholder; key rows show the stored prefix only. There is no
// key-creation flow here — keys are made in Team → API Keys and this links
// there, so the "shown once" moment lives in exactly one place.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi;

  var loaded = false;
  var state = {
    manifest: null, clients: null, usage: null, keys: null,
    client: "claude-code",     // which client's config block is showing
    keyPrefix: null,           // the key row picked, for display only
    filter: "",
  };

  // The four clients the config block can be written for, plus an escape
  // hatch. Each carries its own shape of configuration, which is the reason
  // this is a picker rather than one generic snippet: a Claude Code user needs
  // a shell command, a Claude Desktop user needs a JSON file, and showing both
  // to everyone is how a setup page becomes something people skim past.
  var CLIENTS = [
    { id: "claude-code",    name: "Claude Code",    kind: "shell" },
    { id: "claude-desktop", name: "Claude Desktop", kind: "json", file: "claude_desktop_config.json" },
    { id: "claude-ai",      name: "Claude.ai",      kind: "remote" },
    { id: "cursor",         name: "Cursor",         kind: "json", file: ".cursor/mcp.json" },
    { id: "other",          name: "Other",          kind: "remote" },
  ];

  function endpoint() {
    return (window.location.origin.indexOf("localhost") !== -1
      ? window.location.origin
      : "https://algosize.com") + "/api/mcp";
  }

  // ------------------------------------------------------------------ load

  function load() {
    if (loaded) return;
    loaded = true;
    render();
    fetchAll();
  }

  function fetchAll() {
    // Each read is independent and each failure is local: the catalog failing
    // must not blank the clients list, because they answer different questions
    // and a reader may only care about one of them.
    callApi("/api/mcp/manifest").then(function (r) {
      state.manifest = r && r.ok ? r.data : { error: true };
      render();
    }).catch(function () { state.manifest = { error: true }; render(); });

    callApi("/api/mcp/clients").then(function (r) {
      state.clients = r && r.ok ? (r.data.connections || []) : { error: true };
      render();
    }).catch(function () { state.clients = { error: true }; render(); });

    callApi("/api/mcp/usage").then(function (r) {
      state.usage = r && r.ok ? r.data : { error: true };
      render();
    }).catch(function () { state.usage = { error: true }; render(); });

    callApi("/api/keys").then(function (r) {
      state.keys = r && r.ok ? (r.data.keys || []) : [];
      render();
    }).catch(function () { state.keys = []; render(); });
  }

  // ---------------------------------------------------------------- render

  function render() {
    var body = document.getElementById("mcp-body");
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    body.appendChild(statusPanel());
    body.appendChild(setupPanel());
    body.appendChild(catalogPanel());
    body.appendChild(clientsPanel());
    body.appendChild(activityPanel());
    body.appendChild(securityPanel());
  }

  function panel(tag, title, desc, actions) {
    var p = el("section", { class: "panel mcp-panel" });
    var head = el("header", { class: "panel-head" });
    var heading = el("div", { class: "panel-heading" });
    heading.appendChild(el("span", { class: "panel-tag" }, tag));
    heading.appendChild(el("h2", {}, title));
    if (desc) heading.appendChild(el("p", { class: "panel-desc" }, desc));
    head.appendChild(heading);
    if (actions) {
      var a = el("div", { class: "panel-actions" });
      actions.forEach(function (n) { a.appendChild(n); });
      head.appendChild(a);
    }
    p.appendChild(head);
    var b = el("div", { class: "panel-body" });
    p.appendChild(b);
    p.body = b;
    return p;
  }

  /**
   * A copy button with an explicit copied state.
   *
   * A silent copy reads as broken — the reader has no way to tell the click
   * registered, so they click again and paste twice.
   */
  function copyButton(getText, label) {
    var btn = el("button", { type: "button", class: "btn btn-ghost btn-sm mcp-copy" }, label || "Copy");
    btn.addEventListener("click", function () {
      var text = getText();
      var done = function () {
        btn.textContent = "Copied";
        btn.classList.add("mcp-copied");
        setTimeout(function () {
          btn.textContent = label || "Copy";
          btn.classList.remove("mcp-copied");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
      } else {
        fallbackCopy(text, done);
      }
    });
    return btn;
  }

  function fallbackCopy(text, done) {
    var ta = el("textarea", { class: "mcp-offscreen" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* nothing to do */ }
    document.body.removeChild(ta);
  }

  // ------------------------------------------------------- status

  function statusPanel() {
    var connections = Array.isArray(state.clients) ? state.clients : [];
    var live = connections.filter(function (c) { return c.active; });
    var usage = state.usage && !state.usage.error ? state.usage : null;
    var lastCall = usage && usage.calls && usage.calls.length ? usage.calls[0] : null;

    var p = panel("Connection", "MCP endpoint",
      "One address, spoken by every client below.");

    var statusLine = el("div", { class: "mcp-status" });
    // Status never depends on colour alone: the dot is paired with a word.
    var connected = live.length > 0;
    statusLine.appendChild(el("span", {
      class: "mcp-dot " + (connected ? "mcp-dot-on" : "mcp-dot-off"), "aria-hidden": "true",
    }));
    statusLine.appendChild(el("span", { class: "mcp-status-text" },
      state.clients === null ? "Checking…"
        : state.clients.error ? "Could not read connections"
        : connected
          ? live.length + (live.length === 1 ? " client connected" : " clients connected")
          : "No client connected yet"));
    if (lastCall) {
      statusLine.appendChild(el("span", { class: "acct-dim" },
        "· last call " + core.formatRelativeTime(lastCall.at * 1000)));
    }
    p.body.appendChild(statusLine);

    var row = el("div", { class: "mcp-endpoint" });
    row.appendChild(el("code", { class: "mono mcp-url" }, endpoint()));
    row.appendChild(copyButton(endpoint));
    p.body.appendChild(row);

    var version = state.manifest && !state.manifest.error ? state.manifest.version : null;
    var protocols = state.manifest && !state.manifest.error ? state.manifest.protocolVersions : null;
    if (version) {
      p.body.appendChild(el("p", { class: "panel-input-help mono" },
        "server " + version + (protocols ? " · protocol " + protocols.join(", ") : "")));
    }
    return p;
  }

  // ------------------------------------------------------- setup

  function setupPanel() {
    var p = panel("Setup", "Connect a client",
      "Pick a client, choose how it authenticates, then paste the configuration.");

    // Step 1 — client.
    p.body.appendChild(stepHead(1, "Choose a client"));
    var picker = el("div", { class: "mcp-clients" });
    CLIENTS.forEach(function (c) {
      var on = state.client === c.id;
      var b = el("button", {
        type: "button",
        class: "mcp-client" + (on ? " mcp-client-on" : ""),
        "aria-pressed": on ? "true" : "false",
      });
      b.appendChild(el("span", { class: "mcp-client-name" }, c.name));
      b.appendChild(el("span", { class: "mcp-client-kind acct-dim" },
        c.kind === "remote" ? "Remote" : c.kind === "shell" ? "Command" : "Config file"));
      b.addEventListener("click", function () { state.client = c.id; render(); });
      picker.appendChild(b);
    });
    p.body.appendChild(picker);

    // Step 2 — credential.
    p.body.appendChild(stepHead(2, "Choose a credential"));
    var chosen = CLIENTS.filter(function (c) { return c.id === state.client; })[0] || CLIENTS[0];
    if (chosen.kind === "remote") {
      p.body.appendChild(el("p", { class: "panel-input-help" },
        "This client authenticates with an approval screen — you will be asked to " +
        "confirm which organisation it may reach. No key is pasted anywhere."));
    } else {
      p.body.appendChild(keyPicker());
    }

    // Step 3 — the config.
    p.body.appendChild(stepHead(3, "Paste the configuration"));
    var snippet = configFor(chosen);
    var block = el("div", { class: "mcp-code" });
    var blockHead = el("div", { class: "mcp-code-head" });
    blockHead.appendChild(el("span", { class: "mono acct-dim" }, snippet.label));
    blockHead.appendChild(copyButton(function () { return snippet.text; }));
    block.appendChild(blockHead);
    block.appendChild(el("pre", { class: "mono mcp-pre" }, snippet.text));
    p.body.appendChild(block);
    p.body.appendChild(el("p", { class: "panel-input-help" },
      "The key is written as an environment variable, never inline — so this " +
      "block is safe to paste into a shared config or a screenshot."));
    return p;
  }

  function stepHead(n, text) {
    var d = el("div", { class: "mcp-step" });
    d.appendChild(el("span", { class: "mcp-step-n mono", "aria-hidden": "true" }, String(n)));
    d.appendChild(el("span", { class: "mcp-step-t" }, text));
    return d;
  }

  function keyPicker() {
    var wrap = el("div", { class: "mcp-keys" });
    if (state.keys === null) {
      wrap.appendChild(el("div", { class: "panel-empty" }, "Loading keys…"));
      return wrap;
    }
    var keys = (state.keys || []).filter(function (k) { return !k.revokedAt; });
    if (!keys.length) {
      // The empty state is a real state, not an error: a new organisation has
      // no keys, and the fix is one link away.
      var empty = el("div", { class: "mcp-empty" });
      empty.appendChild(el("p", {}, "This organisation has no API keys yet."));
      empty.appendChild(el("a", { href: "#/account/keys", class: "btn btn-primary btn-sm" },
        "Create one in Team → API keys"));
      wrap.appendChild(empty);
      return wrap;
    }
    keys.forEach(function (k) {
      var on = state.keyPrefix === k.prefix;
      var row = el("button", {
        type: "button",
        class: "mcp-key" + (on ? " mcp-key-on" : ""),
        "aria-pressed": on ? "true" : "false",
      });
      row.appendChild(el("span", { class: "mcp-key-name" }, k.name || "Untitled key"));
      // The stored prefix, never the key. A key exists in full exactly once,
      // at creation, and this page is not that moment.
      row.appendChild(el("span", { class: "mono acct-dim" }, k.prefix + "…"));
      row.appendChild(el("span", { class: "acct-dim" },
        k.lastUsedAt ? "used " + core.formatRelativeTime(k.lastUsedAt * 1000) : "never used"));
      row.addEventListener("click", function () { state.keyPrefix = k.prefix; render(); });
      wrap.appendChild(row);
    });
    wrap.appendChild(el("a", { href: "#/account/keys", class: "panel-input-help mcp-link" },
      "Create a new key in Team → API keys →"));
    return wrap;
  }

  function configFor(c) {
    var url = endpoint();
    if (c.id === "claude-code") {
      return {
        label: "shell",
        text: "claude mcp add --transport http algosize " + url + " \\\n" +
              '  --header "Authorization: Bearer $ALGOSIZE_API_KEY"',
      };
    }
    if (c.kind === "remote") {
      return {
        label: "endpoint",
        text: url + "\n\n" +
              "Add this as a remote MCP server in the client's connector settings.\n" +
              "It will open an Algosize approval screen the first time.",
      };
    }
    return {
      label: c.file || "config",
      text: JSON.stringify({
        mcpServers: {
          algosize: {
            command: "npx",
            args: ["-y", "@algosize/mcp"],
            env: { ALGOSIZE_API_KEY: "${ALGOSIZE_API_KEY}" },
          },
        },
      }, null, 2),
    };
  }

  // ------------------------------------------------------- catalog

  function catalogPanel() {
    var search = el("input", {
      type: "search", class: "panel-input mcp-search",
      placeholder: "Filter tools", "aria-label": "Filter tools", value: state.filter,
    });
    search.addEventListener("input", function () {
      state.filter = search.value;
      redrawCatalog();
    });

    var p = panel("Catalog", "What an assistant can do",
      "Every tool the connection exposes. Analysis tools consume a run; everything else is free.",
      [search]);
    p.body.id = "mcp-catalog-body";
    drawCatalog(p.body);
    return p;
  }

  function redrawCatalog() {
    var b = document.getElementById("mcp-catalog-body");
    if (!b) return;
    while (b.firstChild) b.removeChild(b.firstChild);
    drawCatalog(b);
  }

  function drawCatalog(body) {
    if (state.manifest === null) {
      body.appendChild(el("div", { class: "panel-empty" }, "Loading the catalog…"));
      return;
    }
    if (state.manifest.error) {
      body.appendChild(el("div", { class: "panel-empty" },
        "The tool catalog could not be loaded."));
      return;
    }

    body.appendChild(legend());

    var q = state.filter.trim().toLowerCase();
    var tools = state.manifest.tools || [];
    var groups = state.manifest.groups || [];
    var shown = 0;

    groups.forEach(function (g) {
      var inGroup = tools.filter(function (t) {
        if (g.tools.indexOf(t.name) === -1) return false;
        if (!q) return true;
        return (t.name + " " + (t.title || "") + " " + (t.description || "")).toLowerCase().indexOf(q) !== -1;
      });
      if (!inGroup.length) return;
      shown += inGroup.length;
      body.appendChild(el("h3", { class: "mcp-group" }, g.label));
      var list = el("div", { class: "mcp-tools" });
      inGroup.forEach(function (t) { list.appendChild(toolRow(t)); });
      body.appendChild(list);
    });

    if (!shown) {
      body.appendChild(el("div", { class: "panel-empty" },
        q ? 'No tool matches "' + q + '".' : "No tools are exposed."));
    }
  }

  function legend() {
    var l = el("div", { class: "mcp-legend" });
    [["metered", "consumes one run"],
     ["read", "read-only and free"],
     ["public", "creates a public link"]].forEach(function (pair) {
      var i = el("span", { class: "mcp-legend-item" });
      i.appendChild(el("span", { class: "chip mcp-badge mcp-badge-" + pair[0] }, pair[0]));
      i.appendChild(el("span", { class: "acct-dim" }, pair[1]));
      l.appendChild(i);
    });
    return l;
  }

  function toolRow(t) {
    var meta = t._meta || {};
    var row = el("details", { class: "mcp-tool" });
    var sum = el("summary", { class: "mcp-tool-head" });
    sum.appendChild(el("span", { class: "mono mcp-tool-name" }, t.name));

    var badges = el("span", { class: "mcp-badges" });
    if (meta["algosize/metered"]) {
      badges.appendChild(el("span", { class: "chip mcp-badge mcp-badge-metered" }, "metered"));
    } else if (t.annotations && t.annotations.readOnlyHint) {
      badges.appendChild(el("span", { class: "chip mcp-badge mcp-badge-read" }, "read"));
    }
    if (t.annotations && t.annotations.openWorldHint) {
      // The share tool. Flagged in the list, not only inside the expanded
      // view, because "this one publishes a link" is exactly the property a
      // firm owner is scanning for.
      badges.appendChild(el("span", { class: "chip mcp-badge mcp-badge-public" }, "public link"));
    }
    if (t.annotations && t.annotations.destructiveHint) {
      badges.appendChild(el("span", { class: "chip mcp-badge mcp-badge-destructive" }, "deletes"));
    }
    if (meta["algosize/paidOnly"]) {
      badges.appendChild(el("span", { class: "chip mcp-badge mcp-badge-plan" }, "paid plan"));
    }
    sum.appendChild(badges);
    row.appendChild(sum);

    var d = el("div", { class: "mcp-tool-body" });
    d.appendChild(el("p", {}, t.description || ""));
    var props = (t.inputSchema && t.inputSchema.properties) || {};
    var names = Object.keys(props);
    if (names.length) {
      var dl = el("div", { class: "mcp-params" });
      names.forEach(function (n) {
        var req = (t.inputSchema.required || []).indexOf(n) !== -1;
        var pr = el("div", { class: "mcp-param" });
        pr.appendChild(el("span", { class: "mono" }, n + (req ? "" : "?")));
        pr.appendChild(el("span", { class: "acct-dim" }, props[n].description || props[n].type || ""));
        dl.appendChild(pr);
      });
      d.appendChild(dl);
    }
    d.appendChild(el("p", { class: "panel-input-help mono" },
      "scope " + (meta["algosize/scope"] || "—")));
    row.appendChild(d);
    return row;
  }

  // ------------------------------------------------------- clients

  function clientsPanel() {
    var p = panel("Clients", "Connected clients",
      "Approved grants on this organisation. Revoked entries stay listed as history.");
    if (state.clients === null) {
      p.body.appendChild(el("div", { class: "panel-empty" }, "Loading…"));
      return p;
    }
    if (state.clients.error) {
      p.body.appendChild(el("div", { class: "panel-empty" }, "Connections could not be read."));
      return p;
    }
    if (!state.clients.length) {
      p.body.appendChild(el("div", { class: "panel-empty" },
        "No client has been approved yet. " +
        "A connection made with an API key does not appear here — it authenticates " +
        "as the key, and is revoked by revoking that key in Team → API keys."));
      return p;
    }
    state.clients.forEach(function (c) { p.body.appendChild(clientRow(c)); });
    return p;
  }

  function clientRow(c) {
    var row = el("div", { class: "mcp-conn" + (c.active ? "" : " mcp-conn-off") });
    var main = el("div", { class: "mcp-conn-main" });
    main.appendChild(el("span", { class: "mcp-conn-name" }, c.clientName));
    var detail = el("span", { class: "acct-dim" },
      (c.approvedBy ? "approved by a member · " : "") +
      (c.lastUsedAt ? "last used " + core.formatRelativeTime(c.lastUsedAt * 1000) : "never used"));
    main.appendChild(detail);
    row.appendChild(main);

    var right = el("div", { class: "mcp-conn-right" });
    right.appendChild(el("span", {
      class: "chip " + (c.active ? "chip-ok" : "chip-muted"),
    }, c.active ? "● active" : "○ revoked"));

    if (c.active) {
      var btn = el("button", { type: "button", class: "btn btn-ghost btn-sm mcp-revoke" }, "Revoke");
      btn.addEventListener("click", function () { confirmRevoke(row, c, btn); });
      right.appendChild(btn);
    }
    row.appendChild(right);
    return row;
  }

  /**
   * Revocation names what will break before it happens.
   *
   * "Are you sure?" tells the reader nothing they did not already know. What
   * they need is which assistant stops working, and that the effect is
   * immediate rather than at some renewal boundary.
   */
  function confirmRevoke(row, c, btn) {
    if (row.querySelector(".mcp-confirm")) return;
    btn.disabled = true;
    var box = el("div", { class: "mcp-confirm", role: "alertdialog" });
    box.appendChild(el("p", {},
      "Revoke " + c.clientName + "? It stops being able to reach this organisation " +
      "immediately, and anyone using it will see their Algosize tools disappear " +
      "mid-conversation. They can reconnect by approving it again."));
    var actions = el("div", { class: "mcp-confirm-actions" });
    var cancel = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Keep it");
    cancel.addEventListener("click", function () { row.removeChild(box); btn.disabled = false; });
    var go = el("button", { type: "button", class: "btn btn-danger btn-sm" }, "Revoke access");
    go.addEventListener("click", function () {
      go.disabled = true; go.textContent = "Revoking…";
      callApi("/api/mcp/clients/" + encodeURIComponent(c.clientId), { method: "DELETE" })
        .then(function (r) {
          if (r && r.ok) { fetchAll(); return; }
          go.disabled = false; go.textContent = "Revoke access";
          box.appendChild(el("p", { class: "field-msg-error" },
            (r && r.data && r.data.message) || "The revoke did not go through. Try again."));
        })
        .catch(function () {
          go.disabled = false; go.textContent = "Revoke access";
          box.appendChild(el("p", { class: "field-msg-error" }, "The revoke did not go through."));
        });
    });
    actions.appendChild(cancel);
    actions.appendChild(go);
    box.appendChild(actions);
    row.appendChild(box);
  }

  // ------------------------------------------------------- activity

  function activityPanel() {
    var p = panel("Activity", "What the assistant did",
      "Every tool call on this organisation. Arguments and results are never stored.");
    if (state.usage === null) {
      p.body.appendChild(el("div", { class: "panel-empty" }, "Loading activity…"));
      return p;
    }
    if (state.usage.error) {
      p.body.appendChild(el("div", { class: "panel-empty" }, "Activity could not be read."));
      return p;
    }

    var t = state.usage.totals || {};
    var stats = el("div", { class: "mcp-stats" });
    stat(stats, "Calls", t.calls != null ? String(t.calls) : "—");
    stat(stats, "Runs consumed", t.runsStarted != null ? String(t.runsStarted) : "—");
    stat(stats, "Refused for quota", t.quotaRefused != null ? String(t.quotaRefused) : "—");
    // A null error rate is "no data", NOT zero. Rendering 0% for an unused
    // surface would be a reassuring number about something nobody has tested.
    stat(stats, "Error rate",
      t.errorRate == null ? "no calls yet" : Math.round(t.errorRate * 100) + "%");
    stat(stats, "Busiest tool", t.busiestTool || "—");
    p.body.appendChild(stats);

    var calls = state.usage.calls || [];
    if (!calls.length) {
      p.body.appendChild(el("div", { class: "panel-empty" },
        "No tool calls yet. They appear here as soon as a connected assistant uses one."));
      return p;
    }
    var list = el("div", { class: "mcp-feed" });
    calls.slice(0, 30).forEach(function (c) {
      var r = el("div", { class: "mcp-call" });
      r.appendChild(el("span", { class: "mono mcp-call-tool" }, c.tool));
      r.appendChild(el("span", { class: "chip " + statusChip(c.status) }, statusWord(c.status)));
      r.appendChild(el("span", { class: "acct-dim" },
        (c.durationMs != null ? c.durationMs + "ms · " : "") + core.formatRelativeTime(c.at * 1000)));
      if (c.runId) {
        r.appendChild(el("a", { href: "#/report/" + encodeURIComponent(c.runId), class: "mcp-link" },
          "View run →"));
      }
      list.appendChild(r);
    });
    p.body.appendChild(list);
    return p;
  }

  function statusChip(s) {
    if (s === "ok") return "chip-ok";
    if (s === "quota_exceeded") return "chip-warn";
    return "chip-danger";
  }
  function statusWord(s) {
    if (s === "ok") return "✓ ok";
    if (s === "quota_exceeded") return "◷ no runs left";
    if (s === "rate_limited") return "◷ rate limited";
    if (s === "denied") return "✗ denied";
    return "✗ error";
  }

  function stat(parent, label, value) {
    var s = el("div", { class: "mcp-stat" });
    s.appendChild(el("span", { class: "mcp-stat-label" }, label));
    s.appendChild(el("span", { class: "mcp-stat-value" }, value));
    parent.appendChild(s);
  }

  // ------------------------------------------------------- security

  function securityPanel() {
    var p = panel("Security", "What a connection can and cannot reach",
      "Written for whoever has to sign off on this.");
    var ul = el("ul", { class: "mcp-facts" });
    [
      "Credentials are scoped to the organisation, not to a person. A member leaving does not orphan a connection.",
      "Keys and tokens are stored as a SHA-256 hash and shown in full exactly once, at creation.",
      "Every tool call is recorded with its tool, outcome and duration. Arguments and results are never stored — a tool argument is your source code.",
      "Access is revocable immediately, from this page for approved clients and from Team → API keys for keys.",
      "An MCP connection cannot create API keys, change billing, add or remove members, or reach admin settings. Those endpoints have no tool at all, so no permission setting exposes them.",
      "Analysis runs made through a connection appear in your run history like any other, labelled with the credential that made them.",
    ].forEach(function (f) {
      var li = el("li", {});
      li.appendChild(el("span", { class: "mcp-fact-mark", "aria-hidden": "true" }, "—"));
      li.appendChild(el("span", {}, f));
      ul.appendChild(li);
    });
    p.body.appendChild(ul);
    return p;
  }

  window.DashMcp = { load: load };
})();
