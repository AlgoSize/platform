// Workspace (D-8) — the pulse strip, the service scorecard, and the tool grid.
//
// The tab strip collapsed to two entries, so this view has to carry what the
// other five tabs used to advertise. It does that in three passes, each with
// a different job:
//
//   PULSE      five numbers, each a link into the thing it counts. Derived
//              from data already on the page — there is no pulse endpoint,
//              because a summary computed server-side would be a second
//              source of truth for numbers the scorecard and the runs feed
//              are already showing.
//   SCORECARD  GET /api/scorecard: one row per watched repo, one column per
//              analyzer, straight from stored monitor baselines.
//   TOOLS      one card per analyzer: what it answers, what it last found,
//              and one control that starts a run. The full bench lives on
//              the tool's own view; the card is the doorway, not a copy.
//
// The rule every cell here obeys: a thing that was never measured renders as
// "not measured". Not as a zero, not as a dash that reads like a pass. The
// backend keeps null and empty distinct all the way from the migration up,
// and this file is the last place that distinction can be thrown away.

(function () {
  "use strict";

  var core = window.DashCore;
  if (!core) return;
  var el = core.el, callApi = core.callApi;

  var loaded = false;
  var state = { scorecard: null, monitors: null, sort: "repo" };

  // The five tools, in the order the grid renders them. `route` is the hash
  // the card's own view answers on; `analyzer` is the monitor analyzer key
  // that feeds this tool's scorecard column, or null when the tool has no
  // scheduled counterpart.
  var TOOLS = [
    { id: "scanner",   name: "Vulnerability scanner", short: "the scanner",
      glyph: "!", route: "#/scanner",   analyzer: "vuln",
      answers: "Which published advisories affect the dependencies you actually ship.",
      cta: "Scan a lockfile" },
    { id: "arch",      name: "Architecture X-ray",    short: "the X-ray",
      glyph: "◫", route: "#/arch", analyzer: "arch",
      answers: "How the modules cluster, and which couplings will hurt first.",
      cta: "Map a codebase" },
    { id: "optimizer", name: "Algorithm optimizer",   short: "the optimizer",
      glyph: "ƒ", route: "#/optimizer", analyzer: "algo",
      answers: "The measured Big-O of a function, and whether it grew past its ceiling.",
      cta: "Measure a function" },
    { id: "estimate",  name: "Infrastructure cost estimator", short: "the estimator",
      glyph: "$", route: "#/estimate", analyzer: "estimate",
      answers: "What a compose file would cost per month across providers, before you deploy it.",
      cta: "Estimate a stack" },
    { id: "cost",      name: "Cloud cost analyzer",   short: "the analyzer",
      glyph: "◴", route: "#/cost", analyzer: null,
      answers: "Where an existing AWS bill is going, and the savings ranked by size.",
      cta: "Read a CUR file" },
    // Not an analyzer, and deliberately in the same grid anyway: connecting an
    // assistant is something you do to the whole workspace, and burying it in
    // settings is how an integration nobody discovers gets built.
    { id: "mcp",       name: "MCP connections",      short: "MCP",
      glyph: "⇄", route: "#/mcp", analyzer: null,
      answers: "Run every tool on this page from Claude Code, Claude Desktop, Claude.ai or Cursor.",
      cta: "Connect an assistant" },
    { id: "pipeline",  name: "Fix pipeline",         short: "the pipeline",
      glyph: "⚙", route: "#/pipeline", analyzer: null,
      answers: "Pick a model for each fix stage, see the per-finding cost, or route the fix to your own agent.",
      cta: "Tune the pipeline" },
    { id: "models",    name: "Model explorer",       short: "the models",
      glyph: "◎", route: "#/models", analyzer: null,
      answers: "Which model this platform routes each job to, what it costs per million tokens, and why.",
      cta: "Compare the models" },
  ];

  // ------------------------------------------------------------------ load

  function load() {
    if (loaded) return;
    loaded = true;
    renderTools();
    loadScorecard();
  }

  function loadScorecard() {
    var body = document.getElementById("scorecard-body");
    if (!body) return;

    Promise.all([
      callApi("/api/scorecard", null, "GET").catch(function () { return null; }),
      callApi("/api/monitors", null, "GET").catch(function () { return null; }),
    ]).then(function (results) {
      state.scorecard = results[0];
      state.monitors  = results[1];
      renderSortControls();
      renderScorecard();
      renderPulse();
      renderTools();
    });
  }

  // ----------------------------------------------------------------- pulse

  function renderPulse() {
    var wrap = document.getElementById("ws-pulse");
    if (!wrap) return;
    var rows = (state.scorecard && state.scorecard.rows) || [];
    var monitors = (state.monitors && state.monitors.monitors) || [];

    // Nothing under watch means every number below would be a zero, and five
    // zeroes read as "everything is fine" rather than "nothing is set up".
    // So the strip does not render at all until there is something to count.
    if (!rows.length) { wrap.hidden = true; return; }

    var graded = 0, pending = 0, stale = 0;
    rows.forEach(function (r) {
      var cells = r.cells || {};
      Object.keys(cells).forEach(function (k) {
        if (cells[k].kind === "grade")   graded++;
        if (cells[k].kind === "pending") pending++;
        if (cells[k].kind === "stale")   stale++;
        // Counted with pending, not with graded: nothing was measured, so
        // rolling it into the graded total would inflate the one number a
        // reader uses to judge how much of the grid is real.
        if (cells[k].kind === "unmeasured") pending++;
      });
    });

    var worst = worstSecurity(rows);
    var lastSweep = monitors.reduce(function (acc, m) {
      return m.lastRunAt && (!acc || m.lastRunAt > acc) ? m.lastRunAt : acc;
    }, null);

    var items = [
      { label: "Under watch", value: String(rows.length),
        note: rows.length === 1 ? "repository" : "repositories", href: "#/monitors" },
      { label: "Worst grade", value: worst ? worst.value : "—",
        note: worst ? worst.repo : "nothing graded yet",
        tone: worst && /^[DF]/.test(worst.value) ? "bad" : "ok", href: "#/monitors" },
      { label: "Measured", value: String(graded),
        note: "cells with a result", href: "#/monitors" },
      { label: "Awaiting a first run", value: String(pending),
        note: "cells never measured", tone: pending ? "warn" : null, href: "#/monitors" },
      { label: "Last sweep", value: lastSweep ? core.formatRelativeTime(lastSweep * 1000) : "never",
        note: stale ? stale + " cell" + (stale === 1 ? "" : "s") + " stale" : "all current",
        tone: stale ? "warn" : null, href: "#/monitors" },
    ];

    wrap.textContent = "";
    items.forEach(function (it) {
      var a = el("a", { class: "ws-pulse-item", href: it.href });
      a.appendChild(el("span", { class: "ws-pulse-label mono" }, it.label));
      a.appendChild(el("span", {
        class: "ws-pulse-value mono" + (it.tone ? " ws-pulse-" + it.tone : ""),
      }, it.value));
      a.appendChild(el("span", { class: "ws-pulse-note" }, it.note));
      wrap.appendChild(a);
    });
    wrap.hidden = false;
  }

  /** The lowest security grade on the board, with the repo that earned it. */
  function worstSecurity(rows) {
    var worst = null;
    rows.forEach(function (r) {
      var cell = r.cells && r.cells.security;
      if (!cell || (cell.kind !== "grade" && cell.kind !== "stale")) return;
      if (worst === null || cell.rank > worst.rank) {
        worst = { value: cell.value, repo: r.repo, rank: cell.rank };
      }
    });
    return worst;
  }

  // ------------------------------------------------------------- scorecard

  function renderSortControls() {
    var wrap = document.getElementById("scorecard-sort");
    if (!wrap) return;
    var cols = (state.scorecard && state.scorecard.columns) || [];
    if (!cols.length) { wrap.textContent = ""; return; }

    var opts = [{ id: "repo", label: "Repo" }].concat(cols);
    wrap.textContent = "";
    opts.forEach(function (o) {
      var b = el("button", {
        type: "button",
        class: "seg-btn" + (state.sort === o.id ? " is-active" : ""),
        "aria-pressed": state.sort === o.id ? "true" : "false",
      }, o.label);
      b.addEventListener("click", function () {
        state.sort = o.id;
        renderSortControls();
        renderScorecard();
      });
      wrap.appendChild(b);
    });
  }

  function renderScorecard() {
    var body = document.getElementById("scorecard-body");
    if (!body) return;
    body.textContent = "";

    var data = state.scorecard;
    if (!data) {
      body.appendChild(core.errorState(
        "The scorecard could not be read. Everything else on this page still works."));
      return;
    }

    var rows = (data.rows || []).slice();
    if (!rows.length) {
      var empty = el("div", { class: "panel-empty-rich" });
      empty.appendChild(el("strong", null, "No repositories under watch"));
      empty.appendChild(el("p", null,
        "A monitor is a repository and a branch the analyzers re-read on a schedule without you. " +
        "That scheduled result is what fills this table — a one-off run from a tool below is not graded here."));
      empty.appendChild(el("a", { class: "btn btn-primary btn-sm", href: "#/monitors" },
        "Create a monitor →"));
      body.appendChild(empty);
      return;
    }

    sortRows(rows);

    var scroll = el("div", { class: "scorecard-scroll" });
    var table = el("div", { class: "scorecard" });

    var head = el("div", { class: "scorecard-row scorecard-head" });
    head.appendChild(el("span", { class: "scorecard-repo mono" }, "Repository"));
    // Each header carries the unit its column is measured in. Six columns of
    // letters, dollars and Big-O sitting side by side invite a reader to
    // average them into an overall score; naming the idiom under each one is
    // how the grid says there is no such number without a paragraph saying so.
    (data.columns || []).forEach(function (c) {
      var th = el("span", { class: "scorecard-cell scorecard-th mono" });
      var top = el("span", { class: "scorecard-th-label" });
      if (c.glyph) {
        top.appendChild(el("span", { class: "scorecard-th-glyph", "aria-hidden": "true" }, c.glyph));
      }
      top.appendChild(el("span", null, c.label));
      th.appendChild(top);
      // The API sends the idiom; an older Worker that does not is a missing
      // caption, not a broken header.
      if (c.idiom) th.appendChild(el("span", { class: "scorecard-th-idiom" }, c.idiom));
      head.appendChild(th);
    });
    table.appendChild(head);

    rows.forEach(function (r) {
      table.appendChild(scorecardRow(r, data.columns || []));
    });

    scroll.appendChild(table);
    body.appendChild(scroll);

    var legend = el("p", { class: "scorecard-legend mono" },
      data.basis || "Rows come from scheduled monitors.");
    body.appendChild(legend);
  }

  function sortRows(rows) {
    var key = state.sort;
    if (key === "repo") {
      rows.sort(function (a, b) { return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0; });
      return;
    }
    // Unmeasured rows sort last rather than reading as best-in-class — a
    // repo with no cost baseline is not the cheapest repo you own.
    rows.sort(function (a, b) {
      var av = cellRank(a, key), bv = cellRank(b, key);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }

  function cellRank(row, key) {
    var cell = row.cells && row.cells[key];
    if (!cell || cell.rank === null || cell.rank === undefined) return null;
    return cell.rank;
  }

  function scorecardRow(r, columns) {
    var row = el("div", { class: "scorecard-row" });

    var repo = el("div", { class: "scorecard-repo" });
    repo.appendChild(el("span", { class: "scorecard-repo-name mono" }, r.repo));
    repo.appendChild(el("span", { class: "scorecard-repo-meta mono" }, rowMeta(r)));
    row.appendChild(repo);

    columns.forEach(function (c) {
      row.appendChild(scorecardCell(r, c));
    });
    return row;
  }

  function rowMeta(r) {
    var parts = [r.branch || "default branch"];
    if (r.paused) parts.push("paused");
    else if (r.gradedAt) parts.push("graded " + core.formatRelativeTime(r.gradedAt * 1000));
    else parts.push("never swept");
    return parts.join(" · ");
  }

  function scorecardCell(r, col) {
    var cell = (r.cells && r.cells[col.id]) || { kind: "off" };
    var wrap = el("div", { class: "scorecard-cell scorecard-cell-" + cell.kind });

    if (cell.kind === "grade" || cell.kind === "stale") {
      var line = el("div", { class: "scorecard-value-row" });
      line.appendChild(el("span", { class: "scorecard-value mono" }, cell.value));
      appendTrend(line, r, col);
      if (cell.kind === "stale") {
        // The number is real but old. Saying so beside it is the difference
        // between a stale grade and a wrong one.
        line.appendChild(el("span", { class: "chip chip-warn" }, "stale"));
      }
      wrap.appendChild(line);
      wrap.appendChild(note(cell.kind === "stale" ? staleNote(r) : (cell.note || "")));
      return wrap;
    }

    if (cell.kind === "pending") {
      wrap.appendChild(el("span", { class: "scorecard-pending mono" }, "first run pending"));
      wrap.appendChild(note(cell.note || ""));
      appendFix(wrap, cell);
      return wrap;
    }

    // The sweep ran and this analyzer produced nothing — no manifests, no
    // compose file, no runnable config. Distinct from "pending", which means
    // no sweep has happened yet, and emphatically distinct from a zero: this
    // column previously rendered a skipped X-ray's empty baseline as
    // "0 · No findings in the last sweep", which is a clean bill of health
    // for a repository nothing ever read.
    if (cell.kind === "unmeasured") {
      wrap.appendChild(el("span", { class: "scorecard-unmeasured mono" }, "not measured"));
      wrap.appendChild(note(cell.note || ""));
      appendFix(wrap, cell);
      return wrap;
    }

    // off — the analyzer is not switched on for this monitor. Deliberately
    // distinct from pending: "you have not enabled this" and "this is
    // enabled and has not produced a result" have different fixes.
    wrap.appendChild(el("span", { class: "scorecard-off mono" }, "not watched"));
    var link = el("a", { class: "scorecard-enable mono", href: "#/monitors" }, "enable →");
    wrap.appendChild(link);
    return wrap;
  }

  /**
   * The one change that would turn this empty cell into a number.
   *
   * Rendered only when the API sends one. Some reasons — a GitHub throttle, a
   * sandbox that is briefly unreachable — clear on their own, and those cells
   * deliberately carry no fix: inventing an instruction for a condition the
   * reader cannot act on is how a grid teaches people to ignore it.
   */
  /**
   * A cell note, which is one line wide and usually longer than one line.
   *
   * The title is not decoration: the column is 128px and the sentence is a
   * paragraph, so without it "No compose file was found in this reposi…" is
   * the whole of what a reader can ever learn from this cell.
   */
  function note(text) {
    // el() setAttribute()s whatever it is handed, so an empty title would
    // become title="" — or worse, title="null" — on every cell that has no
    // note. Only pass the attribute when there is something to reveal.
    var attrs = { class: "scorecard-note mono" };
    if (text) attrs.title = text;
    return el("span", attrs, text);
  }

  var TREND = {
    up:   { cls: "scorecard-trend-up",   glyph: "\u2191" },
    flat: { cls: "scorecard-trend-flat", glyph: "\u2013" },
  };

  /**
   * Movement since the previous sweep, on the one column that has any.
   *
   * The Worker sends `trends` keyed by column id and it holds exactly one
   * entry, because the dependency sweep is the only one that stores its own
   * delta — the rest keep a current baseline and nothing to compare it with.
   * So five of the six columns show no trend at all, and that is the correct
   * rendering rather than a gap to fill: a flat "=" beside a number nobody
   * compared would be the grid asserting stability it never measured.
   *
   * A null trend on the deps column itself is the same statement — either the
   * monitor has not completed a sweep since the delta column existed, or the
   * analyzer is off. Unknown, not zero.
   */
  function appendTrend(line, r, col) {
    var t = r.trends && r.trends[col.id];
    if (!t) return;
    var tone = TREND[t.direction];
    if (!tone) return;
    var chip = el("span", { class: "scorecard-trend mono " + tone.cls });
    // The arrow is decoration on a label that already reads as a direction,
    // so a screen reader gets "+2 crit" and not "up arrow plus two crit".
    chip.appendChild(el("span", { "aria-hidden": "true" }, tone.glyph));
    chip.appendChild(el("span", null, t.label));
    line.appendChild(chip);
  }

  function appendFix(wrap, cell) {
    if (!cell.fix) return;
    wrap.appendChild(el("span", { class: "scorecard-fix mono", title: cell.fix }, cell.fix));
  }

  function staleNote(r) {
    if (r.status === "failed") {
      return r.error ? "last sweep failed: " + r.error : "last sweep failed";
    }
    if (r.status === "skipped") {
      return r.error ? "last sweep skipped: " + r.error : "last sweep skipped";
    }
    return "from an earlier sweep";
  }

  // ----------------------------------------------------------------- tools

  function renderTools() {
    var grid = document.getElementById("ws-tools");
    if (!grid) return;
    grid.textContent = "";
    TOOLS.forEach(function (t) {
      grid.appendChild(toolCard(t));
    });
  }

  function toolCard(t) {
    var card = el("section", { class: "ws-tool" });

    var head = el("div", { class: "ws-tool-head" });
    head.appendChild(el("span", { class: "ws-tool-glyph mono", "aria-hidden": "true" }, t.glyph));
    var heading = el("div", { class: "ws-tool-heading" });
    heading.appendChild(el("h3", null, t.name));
    heading.appendChild(el("p", null, t.answers));
    head.appendChild(heading);
    card.appendChild(head);

    card.appendChild(toolResult(t));

    var foot = el("div", { class: "ws-tool-foot" });
    var open = el("a", { class: "ws-tool-open", href: t.route });
    open.appendChild(el("span", null, "Open " + t.short));
    open.appendChild(el("span", { class: "mono", "aria-hidden": "true" }, "→"));
    foot.appendChild(open);
    card.appendChild(foot);

    return card;
  }

  /**
   * What this tool last produced, read off the scorecard.
   *
   * Only monitored repos have a stored result, so a tool with no scheduled
   * counterpart (the CUR analyzer, which reads a file you upload and stores
   * nothing) says exactly that rather than showing an empty slot that reads
   * as "never used".
   */
  function toolResult(t) {
    var box = el("div", { class: "ws-tool-result" });

    if (!t.analyzer) {
      box.appendChild(el("span", { class: "ws-tool-label mono" }, "Not scheduled"));
      box.appendChild(el("p", { class: "ws-tool-empty" },
        "This one reads a file you upload and keeps nothing, so there is no standing result to show."));
      return box;
    }

    var rows = (state.scorecard && state.scorecard.rows) || [];
    var col = columnFor(t.analyzer);
    var graded = rows.filter(function (r) {
      var c = r.cells && r.cells[col];
      return c && (c.kind === "grade" || c.kind === "stale");
    });

    if (!state.scorecard) {
      box.appendChild(el("span", { class: "ws-tool-label mono" }, "Latest"));
      box.appendChild(el("p", { class: "ws-tool-empty" }, "Reading the last scheduled result…"));
      return box;
    }

    if (!graded.length) {
      box.appendChild(el("span", { class: "ws-tool-label mono" }, "Never run on a schedule"));
      box.appendChild(el("p", { class: "ws-tool-empty" },
        "Run it below on anything you like — or put a repository under watch and this fills itself in nightly."));
      return box;
    }

    // Show the worst, because the worst is the one that needs a decision.
    graded.sort(function (a, b) { return b.cells[col].rank - a.cells[col].rank; });
    var top = graded[0];
    var cell = top.cells[col];

    box.appendChild(el("span", { class: "ws-tool-label mono" },
      graded.length === 1 ? "Last scheduled result" : "Worst of " + graded.length + " watched"));
    var line = el("div", { class: "ws-tool-headline-row" });
    line.appendChild(el("span", { class: "ws-tool-headline mono" }, cell.value));
    if (cell.kind === "stale") line.appendChild(el("span", { class: "chip chip-warn" }, "stale"));
    box.appendChild(line);
    box.appendChild(el("p", { class: "ws-tool-note" }, cell.note || ""));
    box.appendChild(el("span", { class: "ws-tool-meta mono" },
      top.repo + (top.gradedAt ? " · " + core.formatRelativeTime(top.gradedAt * 1000) : "")));
    return box;
  }

  function columnFor(analyzer) {
    if (analyzer === "vuln")     return "security";
    if (analyzer === "arch")     return "architecture";
    if (analyzer === "algo")     return "complexity";
    if (analyzer === "estimate") return "cost";
    return analyzer;
  }

  window.DashWorkspace = {
    load: load,
    // Re-read after something elsewhere changed a monitor, so the scorecard
    // does not keep showing a repo that was just removed.
    refresh: function () { loaded = false; load(); },
  };
})();
