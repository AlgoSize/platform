-- Migration 0022: which analyzers did NOT produce a result in the last sweep.
--
-- The scorecard graded a repository's architecture "0 · No findings in the
-- last sweep" for a sweep in which the X-ray never ran: on `no_manifests` the
-- run records an EMPTY baseline (monitors/run.js) so a repository that later
-- gains a manifest baselines from nothing, and an empty array is
-- indistinguishable from "we analysed it and found zero". Same shape for the
-- estimator's no_compose and the optimizer's no_config.
--
-- The sweep already computes this — `skips`, one {analyzer, reason} per
-- analyzer that declined — and then threw it away. Storing it lets a reader
-- be told "not measured, and here is why" instead of a zero that reads as a
-- clean bill of health.
--
-- NULL means no sweep has recorded skips yet, which is not the same as "no
-- analyzer was skipped" (an empty array). Readers must keep the two apart.

ALTER TABLE monitors ADD COLUMN last_skips_json TEXT;
