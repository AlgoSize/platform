-- White-label report branding.
--
-- A consultancy on the top tier hands our HTML report to THEIR client, so the
-- header has to be able to say who wrote it. Two nullable columns on the org:
--
--   brand_company_name  Replaces "Algosize" in the report header.
--   brand_logo_url      An absolute https:// image URL rendered beside it.
--
-- Both are nullable and both default to NULL, so every existing org keeps
-- Algosize branding until someone deliberately sets otherwise.
--
-- STORED, NOT ENFORCED, HERE. Whether an org is ALLOWED to use these is a
-- billing question that changes when a subscription changes, so it is resolved
-- at render time from the live entitlement and price id (see brandingFor in
-- src/reports/branding.js) rather than being baked into a column that would go
-- stale the moment someone downgrades. Writing the columns is gated on the
-- same check at the API, but a lapsed subscription must stop applying the
-- branding it already saved — which only a render-time check can do.
--
-- brand_logo_url is validated to be an absolute https:// URL before it is
-- written AND again before it is rendered. It ends up in an <img src>, so
-- accepting `javascript:` or `data:` here would be a stored XSS in a document
-- whose whole purpose is to be forwarded to someone else.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0008_org_branding.sql --remote

ALTER TABLE organisations ADD COLUMN brand_company_name TEXT;
ALTER TABLE organisations ADD COLUMN brand_logo_url     TEXT;
