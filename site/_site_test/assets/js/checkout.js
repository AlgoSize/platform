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

        if (msgEl) { msgEl.textContent = "Creating your free account…"; msgEl.style.color = ""; }
        if (button) {
          button.dataset.originalText = button.textContent;
          button.textContent = "Signing up…";
          button.disabled = true;
        }

        fetch(apiUrl("/api/signup"), {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json" },
          // Need credentials:'include' so the Set-Cookie response is honored
          // for the cross-origin Worker (algosize.com → algosize-worker.dev
          // in non-prod). The Worker pins SameSite=Lax + Secure in prod.
          credentials: "include",
          body: JSON.stringify({ email: email }),
        }).then(function (res) {
          return res.json().then(function (body) { return { res: res, body: body }; });
        }).then(function (result) {
          var res = result.res, body = result.body;
          if (res.status === 201 && body && body.redirectUrl) {
            window.location.assign(body.redirectUrl);
            return;  // don't restore button — we're navigating away
          }
          // 409 email_taken / 400 invalid_email surface friendly messages.
          // For 409 we steer the user toward Stripe checkout (the only
          // current login path for paid users).
          if (msgEl) {
            msgEl.style.color = "#c62828";
            if (res.status === 409) {
              msgEl.textContent = "An account with this email already exists. " +
                "If you're a Pro subscriber, sign in by clicking \"Start with Stripe\".";
            } else {
              msgEl.textContent = (body && body.message) || ("Signup failed (HTTP " + res.status + ")");
            }
          }
          if (button) {
            button.textContent = button.dataset.originalText || "Start free →";
            button.disabled = false;
          }
        }).catch(function (err) {
          console.error("signup error", err);
          if (msgEl) {
            msgEl.style.color = "#c62828";
            msgEl.textContent = "Could not reach the signup service. Please try again.";
          }
          if (button) {
            button.textContent = button.dataset.originalText || "Start free →";
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
