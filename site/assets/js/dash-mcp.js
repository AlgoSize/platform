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
    activity: "all",           // "all" | "errors" — the activity feed's filter
    openSessions: {},          // session ref -> true, survives re-renders
    test: null,                // null | {state, note} — the connection test
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

  // The ONE tool name this module contains. Everything else in the catalog is
  // rendered from /api/mcp/manifest, because a second copy of the tool list
  // here would drift the moment a tool shipped.
  //
  // This one is different in kind: it is not a listing, it is the specific
  // call the connection test makes — read-only, unmetered, and the cheapest
  // possible proof that a credential reaches an organisation. It is still
  // checked against the manifest before the button is offered, so renaming
  // the tool disables the test rather than wiring it to a call that will come
  // back "no tool named that".
  var PROBE_TOOL = "algosize_whoami";

  function probeAvailable() {
    var m = state.manifest;
    if (!m || m.error || !Array.isArray(m.tools)) return null;   // not known yet
    return m.tools.some(function (t) { return t.name === PROBE_TOOL; });
  }

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
    body.appendChild(quotaPanel());
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

    p.body.appendChild(testBlock());
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

  // One table, read by both the legend and the rows.
  //
  // Two things go wrong when these are written twice. A legend that covers
  // three of the five badges is worse than no legend: the reader learns it is
  // complete, meets "deletes" on a row, and has no way to know they were not
  // told. And a legend whose chip says "destructive" beside a row whose chip
  // says "deletes" is a second vocabulary to learn for no gain.
  //
  // There is deliberately no entry for "no badge": an unbadged tool is free
  // and changes state, and a "free" badge would mark nineteen of them.
  var BADGES = [
    { key: "metered",     label: "metered",     means: "consumes one run" },
    { key: "read",        label: "read",        means: "read-only and free" },
    { key: "public",      label: "public link", means: "creates a public link" },
    { key: "destructive", label: "deletes",     means: "deletes something" },
    { key: "plan",        label: "paid plan",   means: "needs a paid plan" },
  ];

  function badgeChip(key) {
    var b = BADGES.filter(function (x) { return x.key === key; })[0];
    return el("span", { class: "chip mcp-badge mcp-badge-" + key }, b.label);
  }

  function legend() {
    var l = el("div", { class: "mcp-legend" });
    BADGES.forEach(function (b) {
      var i = el("span", { class: "mcp-legend-item" });
      i.appendChild(badgeChip(b.key));
      i.appendChild(el("span", { class: "acct-dim" }, b.means));
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
      badges.appendChild(badgeChip("metered"));
    } else if (t.annotations && t.annotations.readOnlyHint) {
      badges.appendChild(badgeChip("read"));
    }
    if (t.annotations && t.annotations.openWorldHint) {
      // The share tool. Flagged in the list, not only inside the expanded
      // view, because "this one publishes a link" is exactly the property a
      // firm owner is scanning for.
      badges.appendChild(badgeChip("public"));
    }
    if (t.annotations && t.annotations.destructiveHint) {
      badges.appendChild(badgeChip("destructive"));
    }
    if (meta["algosize/paidOnly"]) {
      badges.appendChild(badgeChip("plan"));
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
    // The filter lives in the header, built before the early returns so a
    // loading or failed panel still shows the control that caused the state —
    // a filter that vanishes while its own request is in flight looks like the
    // page lost it.
    var modes = el("div", { class: "seg-group", role: "group", "aria-label": "Filter tool calls" });
    [["all", "All"], ["errors", "Problems only"]].forEach(function (m) {
      var on = state.activity === m[0];
      var b = el("button", {
        type: "button", class: "seg-btn", "aria-pressed": on ? "true" : "false",
      }, m[1]);
      b.addEventListener("click", function () { state.activity = m[0]; render(); });
      modes.appendChild(b);
    });

    var p = panel("Activity", "What the assistant did",
      "Every tool call on this organisation. Arguments and results are never stored.",
      [modes]);
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
    stat(stats, "Sessions", t.sessions != null ? String(t.sessions) : "—");
    stat(stats, "Runs consumed", t.runsStarted != null ? String(t.runsStarted) : "—");
    stat(stats, "Refused for quota", t.quotaRefused != null ? String(t.quotaRefused) : "—");
    // A null error rate is "no data", NOT zero. Rendering 0% for an unused
    // surface would be a reassuring number about something nobody has tested.
    stat(stats, "Error rate",
      t.errorRate == null ? "no calls yet" : Math.round(t.errorRate * 100) + "%");
    stat(stats, "Busiest tool", t.busiestTool || "—");
    p.body.appendChild(stats);

    if (Array.isArray(state.usage.daily) && state.usage.daily.length) {
      p.body.appendChild(sparkline(state.usage.daily));
    }

    var all = state.usage.calls || [];
    if (!all.length) {
      p.body.appendChild(el("div", { class: "panel-empty" },
        "No tool calls yet. They appear here as soon as a connected assistant uses one. " +
        "Ask yours to run " + PROBE_TOOL + " — it is read-only, unmetered, and proves " +
        "the credential end to end."));
      return p;
    }

    // The feed is a list of WORKING SESSIONS, newest first — "what did this
    // assistant actually do" answered as a narrative, not reconstructed from
    // timestamps. "Problems only" selects the SESSIONS that had a refusal or
    // failure and keeps each one's clean calls visible: a denial reads
    // differently depending on what came before it, and stripping the context
    // would hide exactly that.
    var sessions = state.usage.sessions || [];
    var troubledOnly = state.activity === "errors";
    var shown = troubledOnly
      ? sessions.filter(function (sess) {
          return sess.totals && sess.totals.calls > sess.totals.ok;
        })
      : sessions;

    if (troubledOnly) {
      p.body.appendChild(el("p", { class: "acct-dim mcp-filter-note" },
        shown.length
          ? "Sessions with at least one refused or failed call. Their successful calls stay visible for context."
          : ""));
    }
    if (troubledOnly && !shown.length && !preTroubled().length) {
      p.body.appendChild(el("div", { class: "panel-empty" },
        "No refused or failed calls in this period — every call succeeded."));
      return p;
    }

    var list = el("div", { class: "mcp-feed" });
    shown.slice(0, 20).forEach(function (sess) { list.appendChild(sessionCard(sess)); });
    p.body.appendChild(list);

    // The seam: rows written before migration 0021 have no session to belong
    // to — a finite set that ages out of the window. Quiet, factual, and
    // unmistakably NOT a broken session.
    var pre = troubledOnly ? preTroubled() : ((state.usage.preGrouping || {}).calls || []);
    var preTotal = (state.usage.preGrouping || {}).total || 0;
    if (pre.length || (!troubledOnly && preTotal > 0)) {
      var seam = el("div", { class: "mcp-pre-seam" });
      seam.appendChild(el("p", { class: "acct-dim" },
        preTotal + " earlier call" + (preTotal === 1 ? "" : "s") +
        " recorded before session grouping existed — shown individually."));
      pre.slice(0, 15).forEach(function (c) { seam.appendChild(callRow(c)); });
      p.body.appendChild(seam);
    }
    return p;
  }

  function preTroubled() {
    return (((state.usage || {}).preGrouping || {}).calls || [])
      .filter(function (c) { return c.status !== "ok"; });
  }

  /**
   * One working session, collapsed to a scannable row, expandable to its
   * calls in CHRONOLOGICAL order — the one place oldest-first is right,
   * because within a session the list is a story.
   *
   * The header never invents a name: a live session is labelled by what the
   * client itself reported at initialize; once that 24-hour pointer has
   * expired the session is identified by its time span and credential, which
   * is a designed state, not a failure. The raw ref is never shown — a short
   * monospace prefix is enough for "this one, not that one".
   */
  function sessionCard(sess) {
    var totals = sess.totals || {};
    var bad = Math.max(0, (totals.calls || 0) - (totals.ok || 0));
    var open = Boolean(state.openSessions[sess.ref]);

    var card = el("div", { class: "mcp-session" + (bad ? " mcp-session-trouble" : "") });
    var head = el("button", {
      type: "button", class: "mcp-session-head",
      "aria-expanded": open ? "true" : "false",
    });
    head.addEventListener("click", function () {
      if (state.openSessions[sess.ref]) delete state.openSessions[sess.ref];
      else state.openSessions[sess.ref] = true;
      render();
    });

    var who = sess.client && sess.client.name
      ? sess.client.name + (sess.client.version ? " " + sess.client.version : "")
      : sessionSpanLabel(sess);
    head.appendChild(el("span", { class: "mcp-session-who" }, who));
    var auth = (sess.calls && sess.calls[0] && sess.calls[0].authMethod) || null;
    if (auth) head.appendChild(el("span", { class: "chip" }, authWord(auth)));
    head.appendChild(el("span", { class: "chip " + (bad ? "chip-danger" : "chip-ok") },
      bad ? "✗ " + bad + " of " + totals.calls + " refused or failed"
          : "✓ all " + totals.calls + " ok"));
    head.appendChild(el("span", { class: "acct-dim" }, core.formatRelativeTime(sess.lastAt * 1000)));
    head.appendChild(el("span", { class: "mono acct-dim mcp-session-ref" },
      String(sess.ref || "").slice(0, 6)));
    head.appendChild(el("span", { class: "mcp-session-chev", "aria-hidden": "true" },
      open ? "▾" : "▸"));
    card.appendChild(head);

    if (open) {
      var body = el("div", { class: "mcp-session-body" });
      (sess.calls || []).forEach(function (c) { body.appendChild(callRow(c)); });
      // Per-session totals come from the whole window; the attached calls are
      // the capped recent subset. When they differ, say so — a list that
      // reads as complete while it is not would be lying by omission.
      if ((sess.calls || []).length < (totals.calls || 0)) {
        body.appendChild(el("p", { class: "acct-dim mcp-session-more" },
          "Showing the latest " + sess.calls.length + " of " + totals.calls +
          " calls in this session."));
      }
      card.appendChild(body);
    }
    return card;
  }

  function sessionSpanLabel(sess) {
    // No durable client name — the label pointer expires with the session.
    // Identify by span; never guess a purpose the data does not support.
    var from = new Date(sess.firstAt * 1000);
    var to = new Date(sess.lastAt * 1000);
    var sameDay = from.toDateString() === to.toDateString();
    var d = function (x) { return x.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
    var tm = function (x) { return x.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
    return sameDay
      ? "Session · " + d(from) + " " + tm(from) + "–" + tm(to)
      : "Session · " + d(from) + " – " + d(to);
  }

  function authWord(a) {
    if (a === "api_key") return "API key";
    if (a === "mcp_oauth") return "OAuth";
    if (a === "session") return "dashboard";
    return a;
  }

  function callRow(c) {
    var r = el("div", { class: "mcp-call" });
    r.appendChild(el("span", { class: "mono mcp-call-tool" }, c.tool));
    r.appendChild(el("span", { class: "chip " + statusChip(c.status) }, statusWord(c.status, c.errorCode)));
    r.appendChild(el("span", { class: "acct-dim" },
      (c.durationMs != null ? c.durationMs + "ms · " : "") + core.formatRelativeTime(c.at * 1000)));
    if (c.runId) {
      r.appendChild(el("a", { href: "#/report/" + encodeURIComponent(c.runId), class: "mcp-link" },
        "View run →"));
    }
    return r;
  }

  function statusChip(s) {
    if (s === "ok") return "chip-ok";
    if (s === "quota_exceeded") return "chip-warn";
    return "chip-danger";
  }
  function statusWord(s, errorCode) {
    if (s === "ok") return "✓ ok";
    if (s === "quota_exceeded") return "◷ no runs left";
    if (s === "rate_limited") return "◷ rate limited";
    if (s === "denied") {
      // The three denials are different stories: a grant that does not cover
      // the ask, a plan that does not include the tool, and a probe for a
      // tool that does not exist (a host on a stale tool list, or worse).
      if (errorCode === "unknown_tool") return "✗ no such tool";
      if (errorCode === "plan_required") return "✗ needs paid plan";
      if (errorCode === "insufficient_scope") return "✗ outside its grant";
      return "✗ denied";
    }
    return "✗ error";
  }

  function stat(parent, label, value) {
    var s = el("div", { class: "mcp-stat" });
    s.appendChild(el("span", { class: "mcp-stat-label" }, label));
    s.appendChild(el("span", { class: "mcp-stat-value" }, value));
    parent.appendChild(s);
  }

  // ------------------------------------------------------- connection test

  /**
   * Prove the server end works, and be precise about what that does and does
   * not cover.
   *
   * The test speaks to /api/mcp over the reader's DASHBOARD SESSION, not over
   * the key they are about to paste — the key's value only ever exists in
   * their client's environment and this page has never seen it. So a green
   * result means the endpoint, the organisation and the tool surface are all
   * working; it cannot mean "your key is correct".
   *
   * That distinction is the entire value of the button. Someone whose client
   * says "failed to connect" is looking at two possible worlds — Algosize is
   * down, or their ALGOSIZE_API_KEY is empty in the shell that launched the
   * client — and has no way to tell them apart. This settles the first one.
   * Claiming it settled the second would send them to debug the wrong half.
   */
  function runConnectionTest() {
    state.test = { state: "testing", note: "Calling " + PROBE_TOOL + "…" };
    render();

    var started = Date.now();
    var rpc = function (body, sessionId) {
      var headers = { "content-type": "application/json" };
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      return fetch(endpoint(), {
        method: "POST", credentials: "include", headers, body: JSON.stringify(body),
      });
    };

    rpc({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "algosize-dashboard", version: "1" },
        capabilities: {},
      },
    }).then(function (res) {
      if (res.status === 404) {
        throw new Error("The MCP endpoint is not enabled for this organisation yet.");
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error("Your dashboard session was refused. Sign in again and retry.");
      }
      if (!res.ok) throw new Error("The endpoint answered HTTP " + res.status + ".");
      var sid = res.headers.get("Mcp-Session-Id");
      if (!sid) throw new Error("The endpoint answered without a session id.");
      return rpc({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: PROBE_TOOL, arguments: {} },
      }, sid).then(function (r) { return r.json(); });
    }).then(function (body) {
      var ms = Date.now() - started;
      if (body && body.error) {
        throw new Error(body.error.message || "The server refused the call.");
      }
      var result = body && body.result;
      if (result && result.isError) {
        throw new Error((result.content && result.content[0] && result.content[0].text) ||
          PROBE_TOOL + " reported an error.");
      }
      var who = (result && result.content && result.content[0] && result.content[0].text) || "";
      state.test = {
        state: "ok",
        note: "Responded in " + ms + " ms. " + firstLine(who) +
          " This confirms the endpoint and your organisation — it does not check the " +
          "key your client will send, which only exists in that client's environment.",
      };
      render();
    }).catch(function (err) {
      state.test = {
        state: "failed",
        note: (err && err.message ? err.message : "The request did not complete.") +
          " This is the server end only; a client that still cannot connect after a " +
          "green result here has a problem in its own configuration or environment.",
      };
      render();
    });
  }

  function firstLine(text) {
    var line = String(text || "").split("\n")[0];
    return line.length > 160 ? line.slice(0, 157) + "…" : line;
  }

  function testBlock() {
    var wrap = el("div", { class: "mcp-test" });
    var available = probeAvailable();
    if (available === false) {
      // The catalog loaded and does not contain the probe. Saying so beats a
      // button that reports a failure the reader would spend the afternoon
      // blaming on their own configuration.
      wrap.appendChild(el("span", { class: "acct-dim" },
        "The connection test is unavailable — this server's catalog no longer offers " +
        PROBE_TOOL + ". Everything else on this page still works."));
      return wrap;
    }
    var btn = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Test connection");
    btn.addEventListener("click", runConnectionTest);
    if (state.test && state.test.state === "testing") btn.disabled = true;
    wrap.appendChild(btn);

    var t = state.test;
    var word = !t ? "not tested" : t.state === "testing" ? "testing" : t.state === "ok" ? "reachable" : "failed";
    var cls = !t ? "mcp-test-idle"
      : t.state === "testing" ? "mcp-test-idle"
      : t.state === "ok" ? "mcp-test-ok" : "mcp-test-fail";
    var status = el("div", { class: "mcp-test-state " + cls });
    status.appendChild(el("span", { class: "chip " + cls }, word));
    status.appendChild(el("span", { class: "acct-dim" },
      t ? t.note
        : "Runs algosize_whoami once over your dashboard session. It is read-only and " +
          "unmetered, so testing costs nothing."));
    wrap.appendChild(status);
    return wrap;
  }

  // ------------------------------------------------------- quota

  /**
   * What an assistant is allowed to spend.
   *
   * The five metered tools draw on the same monthly allowance as the
   * dashboard's own analyzers, and this is the only screen where somebody is
   * deciding to hand that allowance to a program that will use it without
   * asking each time. Leaving them to find the number on another page is how
   * "why did my analyses stop working" becomes a support conversation.
   *
   * Reads the cached /api/me rather than fetching again: the header already
   * has this number and two fetches could disagree on screen.
   */
  function quotaPanel() {
    var me = core.me && core.me();
    var p = panel("Usage", "Monthly run allowance",
      "Shared with the dashboard — an assistant's analysis and your own cost the same.");

    if (!me) {
      p.body.appendChild(el("div", { class: "panel-empty" }, "Loading your plan…"));
      return p;
    }
    // A paid plan has no monthly ceiling to draw, and drawing an empty meter
    // for one would invent a limit that does not exist.
    if (me.plan !== "free" || me.monthlyRunsLimit == null) {
      p.body.appendChild(el("p", {},
        "This organisation is on a paid plan — metered tools are not capped by a " +
        "monthly run count."));
      p.body.appendChild(el("p", { class: "panel-input-help" },
        "The five metered tools are the four analyzers and the estimator. Everything " +
        "else in the catalog is free to call."));
      return p;
    }

    var used  = me.monthlyRunsUsed || 0;
    var limit = me.monthlyRunsLimit;
    var left  = Math.max(0, limit - used);

    var head = el("div", { class: "mcp-quota-head" });
    head.appendChild(el("span", { class: "mcp-quota-count mono" }, used + " / " + limit));
    head.appendChild(el("span", { class: "acct-dim" }, "runs used this month"));
    p.body.appendChild(head);

    // Segments rather than a bar: five runs is a countable quantity, and a
    // 40%-filled bar is a worse answer to "how many do I have left" than two
    // filled boxes out of five.
    var meter = el("div", {
      class: "mcp-quota-meter", role: "img",
      "aria-label": used + " of " + limit + " monthly runs used",
    });
    for (var i = 0; i < limit; i++) {
      meter.appendChild(el("span", {
        class: "mcp-quota-seg" + (i < used ? (left === 0 ? " mcp-quota-seg-out" :
          left <= 1 ? " mcp-quota-seg-low" : " mcp-quota-seg-on") : ""),
      }));
    }
    p.body.appendChild(meter);

    var note = el("div", { class: "mcp-quota-note" + (left <= 1 ? " mcp-quota-warn" : "") });
    note.appendChild(el("strong", {},
      left === 0 ? "No runs left this month"
        : left === 1 ? "One run left this month"
        : "Five metered tools share this allowance"));
    note.appendChild(el("span", { class: "acct-dim" },
      left === 0
        ? "Metered tools now refuse before running, so nothing is consumed by a refused " +
          "call — the assistant is told it is out of runs and the read-only tools keep working."
        : left === 1
        ? "The next metered call from anywhere — a chat window or this dashboard — is the " +
          "last one. Read-only tools are unaffected."
        : "An assistant calling a metered tool spends a run exactly as this dashboard does. " +
          "The rest of the catalog reads history, scorecards and monitors for free."));
    p.body.appendChild(note);

    var foot = el("p", { class: "panel-input-help" });
    foot.appendChild(el("a", { href: "#pricing", class: "mcp-link" }, "See plans →"));
    p.body.appendChild(foot);
    return p;
  }

  // ------------------------------------------------------- sparkline

  /**
   * Calls per day over the window the server defines.
   *
   * Bars, not a line: the series is a count per day, and a line between two
   * daily totals implies values in between that were never measured.
   *
   * A day with no calls is drawn as a visible baseline tick rather than
   * nothing at all — an empty column and a missing column look identical, and
   * only one of them means "the connection was quiet that day".
   */
  function sparkline(daily) {
    var max = daily.reduce(function (m, d) { return Math.max(m, d.calls); }, 0);
    var wrap = el("div", { class: "mcp-spark-wrap" });
    wrap.appendChild(el("span", { class: "mcp-spark-label acct-dim" },
      "Calls per day · last " + daily.length));

    var total = daily.reduce(function (t, d) { return t + d.calls; }, 0);
    var chart = el("div", {
      class: "mcp-spark", role: "img",
      "aria-label": total === 0
        ? "No calls on any of the last " + daily.length + " days"
        : total + " calls over " + daily.length + " days, peaking at " + max + " in one day",
    });
    daily.forEach(function (d) {
      var bar = el("span", {
        class: "mcp-spark-bar" + (d.calls === 0 ? " mcp-spark-zero" : ""),
        title: new Date(d.day * 1000).toISOString().slice(0, 10) + " · " +
          (d.calls === 0 ? "no calls" : d.calls + (d.calls === 1 ? " call" : " calls")),
      });
      bar.style.height = d.calls === 0 ? "2px" : Math.max(3, Math.round((d.calls / max) * 40)) + "px";
      chart.appendChild(bar);
    });
    wrap.appendChild(chart);
    return wrap;
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
