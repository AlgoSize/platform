---
name: MCP rollout gates
description: Authentication and staged-rollout constraints for the Algosize MCP surface
---

The unauthenticated MCP transport endpoint returns a Bearer-challenge 401 before the feature gate is evaluated; it is not a reliable disabled-state probe. Verify the gate through authenticated configuration/schema checks instead.

**Why:** The deployed route uses soft authentication and MCP authentication before the MCP handler, so a bare 404 expectation in an older runbook is incorrect.

**How to apply:** Treat the public manifest and authenticated admin/schema checks as separate probes. For pilots, use the feature flag's subject override table with the global rollout percentage at zero; do not use an environment-wide switch when customer selection is pending.