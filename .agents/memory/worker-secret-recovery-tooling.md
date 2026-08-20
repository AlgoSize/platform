---
name: Worker secret recovery tooling
description: Which Wrangler executable safely respects the API Worker's production configuration.
---

Use the project's local Wrangler installation for `algosize` production secret operations. The globally installed Wrangler can be an obsolete 1.x release that ignores modern `--config` usage and attempts a legacy local-login flow.

**Why:** A production secret recovery was blocked before reaching Cloudflare because the global executable looked for a legacy `~/.wrangler` configuration rather than reading the Worker config.

**How to apply:** Invoke the Worker dependency's `wrangler` binary with the production config for future secret restores; do not replace the global binary merely to perform an operational recovery.

After every production API deployment, run a production `secret list` before declaring recovery complete; recent recoveries have repeatedly found an empty list immediately after deployment.

**Why:** A successful code deploy and a healthy route do not prove the runtime secret bindings survived. `/api/me` then fails with `internal_error` until the required secrets are restored.

**How to apply:** Treat the seven-secret restore and several spaced unauthenticated `/api/me` checks as the mandatory post-deploy recovery sequence whenever the list is empty.