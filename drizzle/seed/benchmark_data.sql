-- Seeds benchmark_data for the no-auth estimator (Phase 6 Pass 3,
-- PRICING.md: "No-auth estimator first: MRR + customer count -> benchmark
-- leakage estimate").
--
-- RETAINED AS A RECORD, NOT AS A RUNNABLE STEP. The npm script that invoked
-- this (db:seed:benchmark) was removed 2026-08-11. Its job is done: the rows
-- below are live, and the script was a hardcoded `--remote` write to the
-- database named foxhound, which IS production. Keeping a one-command
-- path to overwrite live reference data earned nothing once the seed had run.
--
-- This file stays because it is the only record of what those values are and
-- where they came from. Applying it again is a deliberate act: read it, then
-- run wrangler by hand. Idempotent, and scoped to one cohort by the DELETE
-- below, so a re-run replaces the same four rows rather than duplicating them.
--
-- SOURCING (directional, not audited, DESIGN.md flagship-surface-3
-- confidence-caveat convention applies to every number this seeds):
-- cohort_dimension = 'mrr_band', metric_name =
-- 'monthly_failed_payment_leakage_pct_of_mrr'. Values (fractions of MRR lost
-- monthly to failed/involuntary-churn payments) are a conservative,
-- directional interpolation grounded in two widely corroborated,
-- long-standing pieces of subscription-industry commentary (Recurly's State
-- of Subscriptions reporting and ProfitWell/Paddle's involuntary-churn
-- writing, both checked directionally via web search 2026-07-19): (a)
-- involuntary churn (failed payment / expired card) commonly runs a
-- fraction of a percent to a few percent of MRR per month, and (b) smaller,
-- lower-touch accounts consistently show meaningfully higher failure/churn
-- rates than larger accounts with more mature dunning already in place.
-- These are ROUNDED, DIRECTIONAL figures, not a Foxhound-run study; the
-- sample_size column is stored for schema completeness but is intentionally
-- NOT surfaced to users as a specific N (there is no controlled sample size
-- behind a directional industry range). Since 2026-10-30 the percentile
-- spread is not shown either: /audit applies p50 to the visitor's MRR and
-- names it as an assumption, never as what comparable accounts show.

DELETE FROM benchmark_data
  WHERE cohort_dimension = 'mrr_band' AND metric_name = 'monthly_failed_payment_leakage_pct_of_mrr';

INSERT INTO benchmark_data (id, computed_at, cohort_dimension, cohort_value, sample_size, metric_name, p10, p25, p50, p75, p90, mean, currency)
VALUES
  ('bench_mrr_leakage_under_10k', unixepoch() * 1000, 'mrr_band', 'under_10k', 1, 'monthly_failed_payment_leakage_pct_of_mrr', 0.010, 0.015, 0.022, 0.030, 0.040, 0.024, NULL),
  ('bench_mrr_leakage_10k_50k',   unixepoch() * 1000, 'mrr_band', '10k_50k',   1, 'monthly_failed_payment_leakage_pct_of_mrr', 0.008, 0.013, 0.018, 0.025, 0.033, 0.019, NULL),
  ('bench_mrr_leakage_50k_250k',  unixepoch() * 1000, 'mrr_band', '50k_250k',  1, 'monthly_failed_payment_leakage_pct_of_mrr', 0.006, 0.010, 0.014, 0.019, 0.026, 0.015, NULL),
  ('bench_mrr_leakage_250k_plus', unixepoch() * 1000, 'mrr_band', '250k_plus', 1, 'monthly_failed_payment_leakage_pct_of_mrr', 0.004, 0.007, 0.010, 0.014, 0.019, 0.011, NULL);
