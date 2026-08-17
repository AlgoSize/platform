// Pricing-section display logic: the monthly/annual toggle and the Practice
// seat stepper. Display only — it never talks to the API. The actual purchase
// is assembled at submit time by checkout.js, which reads the toggle and the
// seat input directly rather than trusting state this file left behind.
//
// No framework, no build step. The page renders correct and complete with
// JavaScript off: every price starts on its monthly value in the markup, and
// the seat stepper's number input works on its own.

(function () {
  "use strict";

  // Practice is the only tier with a per-seat component. Kept here as numbers
  // because the markup carries formatted strings ("1,490") that can't be
  // multiplied. Annual is ten months of the monthly figure — that is what
  // "two months free" means, and deriving it means the two can't drift.
  var PRACTICE_BASE_MONTHLY = 149;
  var PRACTICE_SEAT_MONTHLY = 39;
  var ANNUAL_MONTHS = 10;

  var MIN_SEATS = 1;
  var MAX_SEATS = 100;

  function money(n) {
    return "$" + n.toLocaleString("en-US");
  }

  function currentInterval() {
    var checked = document.querySelector('input[name="billing"]:checked');
    return checked && checked.value === "annual" ? "annual" : "monthly";
  }

  /** Swap every element carrying both variants over to the chosen one. */
  function applyInterval(interval) {
    var nodes = document.querySelectorAll("#pricing [data-monthly][data-annual]");
    Array.prototype.forEach.call(nodes, function (el) {
      var next = el.getAttribute("data-" + interval);
      if (next !== null) el.textContent = next;
    });
  }

  function readSeats(input) {
    var n = parseInt(input.value, 10);
    if (!isFinite(n)) n = MIN_SEATS;
    return Math.min(MAX_SEATS, Math.max(MIN_SEATS, n));
  }

  function renderPracticeTotal(input, totalEl, interval) {
    var seats = readSeats(input);
    var months = interval === "annual" ? ANNUAL_MONTHS : 1;
    var total = (PRACTICE_BASE_MONTHLY + PRACTICE_SEAT_MONTHLY * seats) * months;
    totalEl.textContent = money(total) + (interval === "annual" ? " / year" : " / month");
  }

  function attach() {
    var pricing = document.getElementById("pricing");
    if (!pricing) return;

    var seatInput = document.getElementById("practice-seats");
    var totalEl = document.getElementById("practice-total");

    function refresh() {
      var interval = currentInterval();
      applyInterval(interval);
      if (seatInput && totalEl) renderPracticeTotal(seatInput, totalEl, interval);
    }

    var radios = pricing.querySelectorAll('input[name="billing"]');
    Array.prototype.forEach.call(radios, function (radio) {
      radio.addEventListener("change", refresh);
    });

    if (seatInput && totalEl) {
      // Clamp on the way out, not on every keystroke — rewriting the value
      // mid-typing makes the field impossible to edit (type "1", "2" for 12
      // and the clamp turns it into "1" again).
      seatInput.addEventListener("input", function () {
        renderPracticeTotal(seatInput, totalEl, currentInterval());
      });
      seatInput.addEventListener("blur", function () {
        seatInput.value = readSeats(seatInput);
        renderPracticeTotal(seatInput, totalEl, currentInterval());
      });

      var steppers = pricing.querySelectorAll("[data-seat-step]");

      // Disable a stepper button at the end of its range rather than letting
      // it click with no effect.
      function syncStepperState() {
        var seats = readSeats(seatInput);
        Array.prototype.forEach.call(steppers, function (btn) {
          var step = parseInt(btn.getAttribute("data-seat-step"), 10) || 0;
          btn.disabled = (step < 0 && seats <= MIN_SEATS) || (step > 0 && seats >= MAX_SEATS);
        });
      }

      Array.prototype.forEach.call(steppers, function (btn) {
        btn.addEventListener("click", function () {
          var step = parseInt(btn.getAttribute("data-seat-step"), 10) || 0;
          seatInput.value = Math.min(MAX_SEATS, Math.max(MIN_SEATS, readSeats(seatInput) + step));
          renderPracticeTotal(seatInput, totalEl, currentInterval());
          syncStepperState();
        });
      });

      seatInput.addEventListener("input", syncStepperState);
      syncStepperState();
    }

    // The browser can restore a checked radio on back-navigation without
    // firing `change`, so reconcile once on load.
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
