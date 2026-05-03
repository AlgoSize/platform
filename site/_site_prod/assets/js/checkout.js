// Intercepts the pricing CTA form, posts to the Worker via fetch, and
// redirects the browser to the Stripe Checkout URL it returns.
//
// API base comes from window.ALGOSIZE_API_BASE (set in the layout from
// site._config.yml). Empty string means "same origin" — used in production
// where the Worker is mapped to algosize.com/api/*. In local dev it points
// at the wrangler dev server (e.g. http://127.0.0.1:8787).

(function () {
  "use strict";

  function apiUrl(path) {
    var base = (window.ALGOSIZE_API_BASE || "").replace(/\/$/, "");
    return base + path;
  }

  function setBusy(button, busy) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = "Redirecting to Stripe…";
      button.disabled = true;
    } else {
      if (button.dataset.originalText) button.textContent = button.dataset.originalText;
      button.disabled = false;
    }
  }

  function showError(form, msg) {
    var el = form.querySelector(".plan-cta-error");
    if (!el) {
      el = document.createElement("p");
      el.className = "plan-cta-error";
      el.style.color = "#c62828";
      el.style.marginTop = "0.5rem";
      el.style.fontSize = "0.9rem";
      form.appendChild(el);
    }
    el.textContent = msg;
  }

  function attach() {
    var forms = document.querySelectorAll('form[action="/api/checkout"]');
    Array.prototype.forEach.call(forms, function (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var button = form.querySelector('button[type="submit"], [data-cta="checkout"]');
        setBusy(button, true);

        fetch(apiUrl("/api/checkout"), {
          method: "POST",
          headers: { "Accept": "application/json" },
          credentials: "omit",
        })
          .then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.message || ("checkout failed: " + res.status));
              return body;
            });
          })
          .then(function (body) {
            if (!body.url) throw new Error("no checkout url returned");
            window.location.assign(body.url);
          })
          .catch(function (err) {
            console.error("checkout error", err);
            showError(form, "Couldn't start Stripe Checkout: " + (err.message || "unknown error"));
            setBusy(button, false);
          });
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
