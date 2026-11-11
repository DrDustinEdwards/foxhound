-- Two uniqueness guarantees the code already assumed. Hand-written.
--
-- ADDITIVE: two new unique indexes, no table, column or row touched. Production held no duplicates for either on
-- 2026-11-11 (198 mrr_snapshots rows, 1 api_keys row), so both build.
--
-- api_keys_key_hash_uq: a bearer token's hash names one key. The plain api_keys_key_hash_idx it makes redundant stays
-- until a contract migration drops it.
-- mrr_snapshots_account_day_uq: one snapshot per account per UTC day (snapshot_date is epoch ms); the daily sync
-- replaces the day's row in one batch.
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_key_hash_uq` ON `api_keys` (`key_hash`);
CREATE UNIQUE INDEX IF NOT EXISTS `mrr_snapshots_account_day_uq` ON `mrr_snapshots` (`account_id`, ("snapshot_date" / 86400000));
