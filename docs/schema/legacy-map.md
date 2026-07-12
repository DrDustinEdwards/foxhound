# Legacy Schema Map (Phase 2, C1)

Column-level mapping from the legacy Recova Supabase schema to the Foxhound D1 schema.

## Method and provenance

- **Source of column truth:** legacy Supabase project `ejvulqddijapyutvkxxi`, read via the PostgREST OpenAPI spec (`GET /rest/v1/`) using the existing service-role key, strictly read-only. No write, no DDL against legacy.
- **Scope note (deliberate deviation from the task's prime directive, authorized by Dustin 2026-07-12):** the *verbose* column-level probe (distinct enum values, FK graph traversal, per-table row counts) was **skipped by explicit instruction**. This doc is built from a **light OpenAPI cross-check**: column names, Postgres types, and NOT NULL / PK / FK hints for all legacy tables, cross-referenced against SCHEMA.md. Consequences carried forward honestly:
  - Legacy text columns that look enum-like (`status`, `event_type`, `recovery_method`, `decline_category`, etc.) are mapped to plain `TEXT` with **no CHECK constraint**, because their distinct value sets were not probed. CHECK constraints are applied ONLY to the NEW canon-defined enums (attribution_kind, dispute state, billing line-item type, engagement event type), whose value sets come from SCHEMA.md/PRICING.md, not from legacy data.
  - Row counts and checksums are produced at transform time (C5), not here.
- **Tables seen:** 52 via PostgREST. SCHEMA.md cites 53 public tables (2026-07-11 probe). The one-table delta is unresolved (PostgREST omits views and PK-less tables from its OpenAPI definitions); it does not affect any KEEP table below. Flagged for the reviewer.
- **Governs design:** SCHEMA.md. Where SCHEMA.md prose and the probe disagree on what EXISTS, the probe wins; where they disagree on what we BUILD, SCHEMA.md wins. Every such reconciliation is in the Discrepancy Ledger below.

## Type conventions (D1/SQLite, per SCHEMA.md + ARCHITECTURE.md)

| Legacy Postgres type | Foxhound D1 type | Notes |
|---|---|---|
| `uuid` | `text` | store the uuid string; PKs default to a generated uuid in app code |
| `timestamp with time zone` | `integer` | epoch **milliseconds** (uniform convention) |
| `date` | `integer` | epoch ms at UTC midnight; date-only semantics documented per column |
| `boolean` | `integer` | 0/1 convention |
| `integer` (money `_cents`) | `integer` | cents; every money column has a `currency` column in its row |
| `numeric` (fee pct) | `integer` | basis points where it feeds money math; documented per column |
| `numeric` (statistical: percentiles, rates) | `real` | genuinely fractional, non-money |
| `bigint` | `integer` | SQLite INTEGER is 64-bit |
| `jsonb` | `text` | Drizzle `mode: 'json'` |
| `text[]` | `text` | Drizzle `mode: 'json'` (SQLite has no array type) |

## Disposition summary (all 52 legacy tables)

| Legacy table | Disposition | SCHEMA.md basis |
|---|---|---|
| users | **BETTER-AUTH-OWNED** (Phase 3) | "users -> Better Auth core tables" |
| accounts | CARRY+MODIFY | "accounts, account_members -> Better Auth core + accounts, account_members" (business tenant, ours) |
| account_members | CARRY | membership/invites, ours |
| account_products | CARRY | "carry, simplified" |
| account_subscriptions | CARRY | "carry, simplified; Intelligence subscriptions only; admin_granted kept" |
| api_keys | CARRY | "carry (merchant API/MCP)" |
| stripe_connections | CARRY | "carry; token encryption ported; never logged" |
| failed_payments | CARRY | "carry (one active per invoice)" |
| recovery_steps | CARRY | "carry with send-attempt state machine" (columns already present) |
| recovered_payments | CARRY+MODIFY | spine #1: + attribution columns + disputed_at |
| expiring_card_alerts | CARRY | "carry (pre-dunning differentiator)" |
| win_back_sequences | CARRY | "carry; terminal-state handling" |
| win_back_steps | CARRY | "carry" |
| email_events | **REDESIGN -> engagement_events** (rows NOT migrated) | "email_events -> engagement_events; first-party; resend_event_id does not migrate" |
| email_suppressions | CARRY | "carry semantics + mirror Email Service suppression list" |
| billing_assessments | **REDESIGN -> billing_invoices + billing_line_items** (rows NOT migrated) | "billing_assessments -> billing_invoices + billing_line_items" |
| disputes | CARRY+MODIFY | + state CHECK + resolved fee snapshot |
| dispute_evidence | CARRY | "carry (R2-backed)" |
| dispute_fees | **FOLD -> billing_line_items** (table dropped, rows NOT migrated) | "dispute_fees -> folded into billing_line_items + resolved fee snapshot" |
| customer_context | CARRY+MODIFY | + structured billing-behavior signal columns |
| health_score_history | CARRY+MODIFY | "snapshot-on-change + weekly rollups after 90d" (retention) |
| mrr_snapshots | CARRY | "carry" |
| intelligence_reports | CARRY | "carry" |
| alerts | CARRY | "carry" |
| alert_history | CARRY | "carry" |
| intelligence_notification_preferences | CARRY | "carry" |
| benchmark_data | CARRY | "carry (seeds the no-auth estimator)" |
| competitor_monitors | **DO-NOT-MIGRATE** | "absorbed-feature artifact, 0 rows" |
| audit_runs | CARRY+MODIFY | + explicit lift fields (stripe_baseline_recovered, still_dying, foxhound_adds) |
| outcomes | CARRY+MODIFY | + idempotency key + attribution linkage; PERMANENT retention |
| webhook_events | CARRY | "carry (claim columns); 90d retention" |
| cron_config | CARRY | "carry" |
| cron_locks | **DO-NOT-MIGRATE** | "DO replaces" |
| cron_runs | **MERGE -> cron_run_history** | "cron_runs + cron_run_history -> ONE cron_run_history" |
| cron_run_history | CARRY (canonical single table) | as above |
| admin_audit_log | CARRY | "carry, permanent" |
| ai_calls | CARRY | "carry; cost map keyed to every model ID; retention" |
| platform_stats | CARRY | "carry" |
| customer_notes | CARRY | "carry" |
| page_404s | **REDESIGN -> page_404_daily + raw w/ retention** (rows NOT migrated) | "daily aggregate per path + 30d raw; 140,428 legacy rows not migrated" |
| blog_posts | CARRY | "carry + designed-in featured + taxonomy" (featured already present) |
| blog_post_links | CARRY | "carry" |
| blog_post_versions | CARRY | "carry (keep last 10 per post)" |
| social_config | CARRY | "carry" |
| social_leads | CARRY | "carry; leads retention 180d" |
| social_posts | CARRY | "carry" |
| social_topic_log | CARRY | "carry" |
| social_blocklist | CARRY | "carry" |
| social_keywords | CARRY | "carry" |
| oauth_authorization_codes | **DO-NOT-MIGRATE** | "replaced by Better Auth + Foxhound MCP token issuance" |
| oauth_clients | **DO-NOT-MIGRATE** | as above |
| oauth_tokens | **DO-NOT-MIGRATE** | as above |

### NEW tables (no legacy source)

| Foxhound table | SCHEMA.md basis |
|---|---|
| billing_invoices | per account per currency; two-layer idempotency |
| billing_line_items | recovery_fee / dispute_fee / subscription / adjustment; unique per recovery, unique per dispute |
| dispute_approvals | who approved, when, evidence version hash; submission requires an approval row |
| predictions | score, band evidence hash, horizon, realized_outcome, graded_at |
| engagement_events | first-party open/click rows; unique idempotency key; open vs click typed |
| email_sends | one row per queued/sent message; replaces Resend-shaped logging |
| estimator_runs | no-auth Turnstile-gated estimator; minimal PII |
| page_404_daily | daily aggregate per path |

### Better-Auth-owned (Phase 3 creates; Phase 2 must NOT create)

`user`, `session`, `account` (singular; OAuth/credential linkage), `verification`. Our business `accounts` (plural) + `account_members` are separate and owned by Phase 2. No name collision (Better Auth uses singular `account`; ours is plural `accounts`).

## Cross-table user/account reference assumptions (Phase 3 verifies)

These columns reference a Better-Auth-owned `user.id`. In Phase 2 they are stored as `text` **without an enforced FK** (the `user` table does not exist yet). Phase 3 wires the FK/verifies:

- `account_members.user_id`
- `admin_audit_log.target_user_id`
- `intelligence_notification_preferences.user_id`

All other cross-table references (`account_id`, `stripe_connection_id`, `failed_payment_id`, `dispute_id`, etc.) are enforced FKs within the Phase 2 schema.

## Discrepancy Ledger (SCHEMA.md prose vs probe reality, with reconciliation)

1. **recovered_payments attribution.** SCHEMA.md spine #1 lists `attribution_kind`, `attribution_ref`, `attributed_at`, `refunded_at`, `disputed_at`. Probe: `refunded_at` **already exists**; the other four do not. Legacy instead has `recovery_method`, `recovery_trigger`, `recovery_step_type`, `recovered_by_step_id`. Reconciliation: ADD the four new columns (attribution_kind NOT NULL with a CHECK on the four canon values; ref/attributed_at nullable; disputed_at nullable). CARRY the legacy signal columns for transform provenance and back-compat. Transform derives `attribution_kind` from `recovery_trigger`/`recovery_method` where possible, else `stripe_baseline`. No money/id type change.

2. **billing_assessments is a flat single table**, not the invoice+line-item split. Probe: one row per account/product/period with `gross_recovered_cents`, `fee_pct`, `fee_cents`, `stripe_invoice_id`, `status`, `currency`. Reconciliation: this is a **redesign, not a carry**. Build NEW `billing_invoices` (per account per currency) + `billing_line_items` (four types, FK unique keys). Legacy `billing_assessments` **rows are not migrated** (zero paying merchants per project core; no billing history worth transforming). Flagged: if any real assessment rows exist at C5, report count and confirm exclusion.

3. **disputes is column-rich (~45 cols)** beyond SCHEMA.md's prose ("carry + state + currency + resolved fee snapshot"). Probe shows triage (`triage_recommendation/confidence/reasoning`), radar (`radar_risk_score/level`, `avs_result`, `cvv_result`, `three_d_secure`), shipping (`shipping_*`), and evidence JSON (`structured_evidence_json`, `prior_charges_json`, `subscription_json`, `recovery_emails_json`) columns. Reconciliation: CARRY all substantive legacy columns (they are real dispute-product data), ADD `state` (CHECK: draft|pending_review|approved|submitted|resolved_won|resolved_lost), `resolved_fee_cents` + `resolved_fee_currency` snapshot. Legacy `status`/`outcome` kept as plain TEXT (no CHECK; values unprobed) for transform provenance; transform derives `state` from `status`+`outcome`. `dispute_fees` table is dropped; its fee data folds into `billing_line_items` + the resolved-fee snapshot.

4. **customer_context structured signals under-specified.** SCHEMA.md names the SIGNALS (subscription age, plan/seat deltas, interval switches, payment-latency drift, refund/dispute counts) but not column names/types. Probe shows existing jsonb blobs `recovery_signals`, `dispute_signals`, `engagement_signals`, `health_factors`. Reconciliation: CARRY the jsonb blobs; ADD nullable typed columns for the named signals so EVERY customer can score without unpacking JSON: `subscription_age_days` (int), `plan_change_count` (int), `seat_change_count` (int), `interval_switch_count` (int), `payment_latency_drift_days` (int), `refund_count` (int), `dispute_count` (int). **Phase 4 owns population semantics.** Names recorded here as the single source so Phase 4 does not re-invent them. Flag for reviewer: these names are Phase-2 judgment, not canon.

5. **blog_posts.featured already exists** (SCHEMA.md said "designed-in `featured`" as if new). No action; carry as-is. Tag taxonomy: legacy `tags` is `text[]` -> JSON text; the "8-12 clean tags / tag-archive" redesign is a Phase 6 content concern, not schema.

6. **outcomes lacks an idempotency key.** Probe: `id, account_id, product, event_type, event_data, outcome, outcome_at, created_at`. SCHEMA.md spine #4 wants an idempotency key. Reconciliation: ADD `idempotency_key` (text, unique) nullable for carried rows, required in app writes (Phase 4). ADD nullable attribution linkage columns (`attribution_kind`, `attributed_ref`) per SCHEMA.md; documented, Phase 4 populates. No type change.

7. **audit_runs lift fields.** Probe has many aggregate columns but not the three named lift fields. Reconciliation: ADD `stripe_baseline_recovered_cents`, `still_dying_cents`, `foxhound_adds_cents` (+ existing `currency`). Carry the rest.

8. **cron_runs + cron_run_history both exist.** Reconciliation: canonical single `cron_run_history` (append log). `cron_runs` (latest-per-cron snapshot) is not carried as a table; latest-run is a query. `cron_locks` dropped (DO replaces).

9. **email_events is Resend-shaped.** Probe: `resend_event_id`, `recovery_step_id`, `event_type`, `occurred_at`. Reconciliation: REDESIGN to `engagement_events` (first-party: `event_type` CHECK open|click, `idempotency_key` unique, `occurred_at`, `target_url` for clicks, ref to email_send/recovery_step). `resend_event_id` dropped. Legacy rows not migrated (historical Resend opens/clicks; click billing per PRICING.md is first-party going forward).

10. **Timestamps type change (all tables).** Legacy `timestamp with time zone` -> D1 `integer` epoch ms. This is the mandated D1 design (SCHEMA.md), applied uniformly, not a discrepancy. Transform converts.

None of the above forces a money-field or id-field type change, and no CHECK is applied to any legacy-valued column, so no discrepancy trips the task's hard-STOP triggers.
