---
name: Durable Object migration format — sqlite classes
description: Cloudflare dropped KV-backed DO namespaces; wrangler.toml must use new_sqlite_classes
---

## Rule
Use `new_sqlite_classes` (not `new_classes`) in `[[env.*.migrations]]` blocks for Durable Objects.

**Why:** Cloudflare API returns error 10099 ("Creating new key-value backed Durable Object namespaces is no longer supported on this account") when `new_classes` is used. This breaks every `wrangler deploy` call until fixed.

**How to apply:** Any time a new Durable Object class is added to wrangler.toml migrations, always use `new_sqlite_classes = ["ClassName"]`. This applies to all environments (production, staging, default).
