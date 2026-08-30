# Deploy note — migration 0025 (`ai_usage` + `margin_config`)

**Symptom this fixes:** the admin panel's *AI spend & margin* section shows
`Could not load this section / internal_error` (before the schema-gap handling
landed) or, now, **"This database is missing 0025_ai_usage"**.

Migrations in this platform are applied **by hand**. There is no ledger table and
the deploy pipeline does not run `wrangler d1 execute`, so shipping the Worker
never creates these tables. A database that has never had 0025 applied has no
`ai_usage` table, and every read the panel makes fails.

## What is missing without it

- `ai_usage` — one row per LLM call: Neurons, tokens, raw cost, the 25% platform
  margin and the customer price. **Nothing meters without it**, so
  `GET /api/admin/ai-usage` cannot answer at all.
- `margin_config` — the versioned margin rate, seeded with `mc_default_v1` at
  25%. Without the seed row `resolveMargin()` falls back to the compiled-in
  default; the layer still works but the rate is not operator-changeable.
- `organisations.is_internal` — the column that exempts internal orgs from the
  margin. Without it every org is billed with margin.

Note that `recordAiUsage()` is best-effort by construction: a missing table costs
the *history*, not the request. Calls still run and still succeed — they are
simply never recorded, which is why this can go unnoticed until somebody opens
the spend panel.

## Apply it

```bash
cd worker
npx wrangler d1 execute algosize \
  --file=migrations/0025_ai_usage.sql \
  --remote --env production --config wrangler.toml
```

Note `--env production`. Without it wrangler resolves the placeholder database
id in the top-level block and fails with "database not found".

The migration is written to be re-runnable — every table and index uses
`IF NOT EXISTS` and the seed row is `INSERT OR IGNORE`. The one exception is the
final `ALTER TABLE organisations ADD COLUMN is_internal`, which errors with
"duplicate column name" if it has already been applied. That error is safe to
ignore; it means the column is already there.

## Verify

With an admin session: `GET /api/admin/schema-check` should report `0025` as
present, and the *AI spend & margin* panel should load. Until any AI call has
actually been metered it will read **"Nothing has ever been recorded"** — which
is the correct answer for a table that exists and is empty, and a different one
from the missing-table state above.

## Related

- The panel's contract and its honesty rules: [docs/ai-ops/ADMIN-AI-SPEND.md](../docs/ai-ops/ADMIN-AI-SPEND.md)
- The same procedure for snapshots: [DEPLOY-arch-snapshots.md](./DEPLOY-arch-snapshots.md)
