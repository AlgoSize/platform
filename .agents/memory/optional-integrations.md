---
name: Optional integrations
description: Product decision about optional OpenAI and Google service-account capabilities
---

OpenAI summarization and the Google service-account flow are intentionally deferred. The application should continue operating without `OPENAI_API_KEY` and `GOOGLE_SERVICE_ACCOUNT_JSON`.

**Why:** The user confirmed these are optional product features, not launch blockers, and accepted graceful degradation.

**How to apply:** Do not request or configure these secrets unless the user explicitly revisits the decision.