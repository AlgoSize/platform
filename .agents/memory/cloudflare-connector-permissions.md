---
name: Cloudflare connector permissions
description: Cloudflare API connection behavior for provisioning account resources through Replit.
---

The managed Cloudflare connection may successfully list accounts, R2 buckets, and queues while rejecting resource creation with a structured 403 authentication error. The connection uses an API key, so OAuth reauthorization is not applicable; the provider-side key permissions and the existing Replit connection must be updated before retrying.

**Why:** A read-only Cloudflare key made inventory checks look healthy but prevented creation of the R2 buckets and Queues required by the Worker configuration.

**How to apply:** For R2 and Queues provisioning, verify the connected key has `Workers R2 Storage Write` and `Queues Write` (or `Workers Scripts Write`) for the target account before retrying. Never request or paste the raw key in chat.