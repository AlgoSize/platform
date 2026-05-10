// Renders a small banner at the top of the homepage when an auth flow
// (magic-link or Google OAuth) redirects back with `?auth=<code>`. Each
// code maps to a friendly user-facing message. After rendering, the
// query param is stripped from the URL so a refresh doesn't re-show it.

(function () {
  "use strict";

  var MESSAGES = {
    // Success / info
    required:               { kind: "info",  text: "Please sign in to continue." },
    // Magic-link errors
    missing_token:          { kind: "error", text: "That sign-in link was incomplete. Please request a new one." },
    expired_or_invalid:     { kind: "error", text: "That sign-in link has expired or already been used. Request a new one below." },
    server_error:           { kind: "error", text: "Something went wrong on our side. Please try again in a moment." },
    // Google OAuth errors
    google_not_configured:  { kind: "error", text: "Google sign-in isn't set up yet. Use the email link option for now." },
    google_token_failed:    { kind: "error", text: "Google rejected the sign-in request. Please try again." },
    google_userinfo_failed: { kind: "error", text: "Couldn't read your Google profile. Please try again." },
    google_no_email:        { kind: "error", text: "Your Google account didn't share an email address." },
    email_not_verified:     { kind: "error", text: "Your Google email isn't verified. Verify it in your Google account, then try again." },
    missing_code:           { kind: "error", text: "Google didn't return an authorization code. Please try again." },
    google_access_denied:   { kind: "info",  text: "You declined Google sign-in. No problem — you can try again or use the email option." },
  };

  function show() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("auth");
    if (!code) return;

    var entry = MESSAGES[code];
    // Handle google_<error> from Google's own error param (e.g. google_access_denied above)
    if (!entry && code.indexOf("google_") === 0) {
      entry = { kind: "error", text: "Google sign-in failed: " + code.slice(7).replace(/_/g, " ") + "." };
    }
    if (!entry) return;

    var slot = document.getElementById("auth-banner-slot");
    if (!slot) return;
    var div = document.createElement("div");
    div.className = "container";
    div.innerHTML = '<div class="auth-banner ' + entry.kind + '">' +
      entry.text.replace(/[<>&]/g, function (c) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]; }) +
      "</div>";
    slot.appendChild(div);

    // Strip the param from the URL without reloading.
    params.delete("auth");
    var newSearch = params.toString();
    var newUrl = window.location.pathname + (newSearch ? "?" + newSearch : "") + window.location.hash;
    window.history.replaceState({}, "", newUrl);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", show);
  } else {
    show();
  }
})();
