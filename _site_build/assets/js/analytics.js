/* Algosize analytics shim (Task #26).
 *
 * Plausible's tagged-events.js fires automatic clicks on any element
 * with `class="plausible-event-…"`, but we already have semantic data-*
 * attributes on the buttons that matter (data-cta on the marketing
 * page, data-action="run" data-target="…" on the dashboard, and an id
 * on the billing portal button). Rather than mutate every template,
 * this script:
 *
 *   1. translates those existing hooks into Plausible custom events,
 *   2. exposes window.algosizeTrack(name, props) for any future
 *      ad-hoc events,
 *   3. no-ops if Plausible is disabled (window.plausible undefined),
 *      so this file is safe to include from local dev / CI.
 *
 * Privacy stance: NO user IDs / emails are forwarded — events carry
 * only the analyzer name (cost/vuln/algo) or the CTA bucket. Matches
 * the "anonymous only" rule in the task spec.
 */
(function () {
  "use strict";

  function track(name, props) {
    if (typeof window.plausible !== "function") return;  // analytics off
    try {
      window.plausible(name, props ? { props: props } : undefined);
    } catch (_e) {
      // Never let an analytics failure break the page.
    }
  }
  window.algosizeTrack = track;

  // ---- Marketing CTAs (index.html) -------------------------------------
  // Both forms (`signup-free`, `checkout`) submit and navigate, so we
  // hook the submit event — capture-phase so the event fires even when
  // the form's own submit handler calls preventDefault() on errors.
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.tagName || form.tagName !== "FORM") return;
    var btn = form.querySelector("button[data-cta]");
    if (!btn) return;
    track("CTA Click", { cta: btn.getAttribute("data-cta") });
  }, true);

  // ---- Dashboard analyzer runs (dashboard.html) ------------------------
  document.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest("button[data-action]");
    if (!t) return;
    var action = t.getAttribute("data-action");
    var target = t.getAttribute("data-target");
    if (action === "run" && target) {
      // "Run analyzer" → split by analyzer so the dashboard shows
      // which tool is actually used.
      track("Run Analyzer", { analyzer: target });
    }
  });

  // ---- Manage billing (Task #18) ---------------------------------------
  var billingBtn = document.getElementById("billing-portal-btn");
  if (billingBtn) {
    billingBtn.addEventListener("click", function () {
      track("Manage Billing");
    });
  }

  // ---- Quota-gate upgrade prompt ---------------------------------------
  var upgradeBtn = document.getElementById("quota-upgrade-btn");
  if (upgradeBtn) {
    upgradeBtn.addEventListener("click", function () {
      track("CTA Click", { cta: "quota-upgrade" });
    });
  }
})();
