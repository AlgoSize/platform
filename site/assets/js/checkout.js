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

    // ---- Free signup (Task #19) — POST /api/signup, then redirect ---------
    // Same pattern as checkout: intercept submit, post JSON, redirect to the
    // dashboard on success. The signup form is rendered inside a `.plan-free`
    // card and never targets a backend `action=`, so we look it up by id.
    var signupForm = document.getElementById("signup-free-form");
    if (signupForm) {
      signupForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var input  = document.getElementById("signup-email");
        var msgEl  = document.getElementById("signup-message");
        var button = signupForm.querySelector('button[type="submit"]');
        var email  = input ? input.value.trim() : "";

        // Lightweight client-side guard — the Worker re-validates with the
        // same EMAIL_RE and returns 400 invalid_email if we get it wrong.
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          if (msgEl) {
            msgEl.textContent = "Please enter a valid email address.";
            msgEl.style.color = "#c62828";
          }
          if (input) input.focus();
          return;
        }

        if (msgEl) { msgEl.textContent = "Sending your sign-in link…"; msgEl.style.color = ""; }
        if (button) {
          button.dataset.originalText = button.textContent;
          button.textContent = "Sending…";
          button.disabled = true;
        }

        // Magic-link flow: POST /api/auth/request-link instead of /api/signup.
        // The Worker emails a one-time verification URL; clicking it issues
        // the session cookie and redirects to /dashboard/. The marketing page
        // never sees the cookie itself.
        fetch(apiUrl("/api/auth/request-link"), {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email: email }),
        }).then(function (res) {
          return res.json().then(function (body) { return { res: res, body: body }; });
        }).then(function (result) {
          var res = result.res, body = result.body;
          if (res.ok) {
            if (msgEl) {
              msgEl.style.color = "";
              msgEl.textContent = "Check your inbox — we just emailed " + email +
                " a sign-in link. It expires in " + (body.ttlMinutes || 15) + " minutes.";
            }
            if (button) {
              button.textContent = "Link sent ✓";
              // Leave disabled to discourage repeat-clicks (rate-limited anyway).
            }
            return;
          }
          if (msgEl) {
            msgEl.style.color = "#c62828";
            msgEl.textContent = (body && body.message) || ("Could not send link (HTTP " + res.status + ")");
          }
          if (button) {
            button.textContent = button.dataset.originalText || "Email me a sign-in link →";
            button.disabled = false;
          }
        }).catch(function (err) {
          console.error("magic-link error", err);
          if (msgEl) {
            msgEl.style.color = "#c62828";
            msgEl.textContent = "Could not reach the sign-in service. Please try again.";
          }
          if (button) {
            button.textContent = button.dataset.originalText || "Email me a sign-in link →";
            button.disabled = false;
          }
        });
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
