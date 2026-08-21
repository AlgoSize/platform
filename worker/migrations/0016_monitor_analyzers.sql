-- 0016 — multi-analyzer monitors.
--
-- Until now a monitor WAS a vulnerability re-scan: the row had no analyzer
-- column because there was only one thing it could run. This migration lets a
-- monitor also run the Architecture X-ray, the Infrastructure Cost Estimator
-- and the Algorithm optimizer on the same schedule — each reading ONLY
-- committed repository files, which is what keeps them inside the product's
-- standing rule: no cloud-account connector, no credential storage, nothing
-- contacted except GitHub raw content and our own analyzers.
--
--   arch      root-level manifests (wrangler.toml, docker-compose.yml, …)
--   estimate  the committed compose file, priced against the bundled catalog
--   algo      optimizer.config.json plus the functions it names
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0016_monitor_analyzers.sql --remote

-- Which analyzers this monitor runs, as a JSON array, e.g.
-- '["vuln","arch","estimate"]'. NULL means '["vuln"]' — the exact behaviour
-- every existing monitor already has, so no backfill is needed and nobody's
-- monitor changes what it does until they change it. "vuln" is always in the
-- set (the API enforces it): a monitor that watches nothing is a row that
-- looks like coverage and isn't.
ALTER TABLE monitors ADD COLUMN analyzers TEXT;

-- Per-analyzer diff baselines, mirroring last_advisory_ids' contract exactly:
-- NULL means "this analyzer has never completed a run here", which the diff
-- reads as a baseline — deliberately distinct from an empty result, which
-- means "ran, found nothing". A corrupt value must fall back to NULL
-- (baseline), never to empty, because a corrupt baseline that reads as empty
-- would re-alert on everything the org has already seen.

-- Architecture finding identities (target|lens|rule), sorted JSON array.
ALTER TABLE monitors ADD COLUMN last_arch_keys TEXT;

-- The previous estimate, as {"byProvider":{"<id>":<microUsd>},"at":<sec>}.
-- Totals in integer micro-USD, matching the pricing catalog's unit, so the
-- diff is integer arithmetic and can never invent a cent to rounding.
ALTER TABLE monitors ADD COLUMN last_estimate_json TEXT;

-- The previous Big-O grades, as {"byName":{"<entry>":"O(n)"},"at":<sec>}.
ALTER TABLE monitors ADD COLUMN last_algo_json TEXT;
