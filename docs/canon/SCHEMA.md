# SCHEMA.md — Foxhound Canon (Phase 0)

Status: DRAFT pending Dustin lock. Rev 2 (2026-07-11): credit-note machinery removed; maturity-window billing predicate added, per PRICING.md rev 2. Designed backward from PRICING.md. Table-level mapping below is grounded in the live legacy schema probe (2026-07-11: 53 public tables, Supabase ejvulqddijapyutvkxxi). Phase 2 MUST run a verbose column-level probe before writing the Drizzle schema and the transform script; this doc governs design, the probe governs column truth. Every deviation from legacy cites its PRICING.md line or product surface.

## Design spine

1. **Attribution is first-class.** `recovered_payments` carries `attribution_kind` (`foxhound_retry` | `email_engaged` | `card_update` | `stripe_baseline`), `attribution_ref` (FK/id of the attributing action: retry step, engagement event, or card-update event), and `attributed_at`. Billing line items FK the recovered payment; the fee is computable from the row and its reference alone. Audit lift and the invoice are the same query.
2. **Baseline is stored, not skipped.** `stripe_baseline` recoveries are full rows (the pay-on-lift denominator and the free line in the merchant ledger).
3. **Billable is a predicate, not a process.** Billable recovery = attributed (non-baseline) AND recovered_at in the prior billing period (>=30 days maturity) AND refunded_at IS NULL AND not disputed AND not previously billed (unique line-item key). Refund handling is this predicate; there is NO credit-note subsystem. Post-billing events are handled by the manual `adjustment` line-item type only (PRICING.md maturity-window billing).
4. **Money writes are DO-serialized batches** (ARCHITECTURE.md). Outcomes rows carry an idempotency key (closes legacy at-most-once crash gap).
5. **Retention is in the schema**: every growth table's policy in ARCHITECTURE.md exists before the table takes production writes.
6. **SQLite-native, portably.** Enums -> CHECK constraints via Drizzle; JSON columns only where structure genuinely varies (signals, evidence payloads); one timestamp convention (INTEGER epoch ms) everywhere.

## Table-level mapping (legacy -> Foxhound)

**Identity/tenancy (carry, re-based on Better Auth):**
- users, accounts, account_members -> Better Auth core tables + `accounts`, `account_members`. Dropped legacy columns (plan, subscription_status, etc.) do not exist here.
- account_products, account_subscriptions -> carry, simplified: products are recovery|disputes|intelligence|audit; subscriptions exist for Intelligence only; `admin_granted` rows never touch Stripe (standing rule). Scale/Grow/AI Cost plumbing does not migrate (PRICING.md lineup).
- api_keys -> carry (merchant API/MCP). oauth_clients / oauth_authorization_codes / oauth_tokens -> DO NOT MIGRATE; replaced by Better Auth + Foxhound MCP token issuance (Phase 3 designs the token model; Phase 7 consumes it).
- stripe_connections -> carry; token encryption ported; never logged.

**Recovery core (carry + attribution):**
- failed_payments -> carry (one active per invoice; webhook owns 'recovered' status).
- recovery_steps -> carry with send-attempt state machine (attempt_count, last_attempt_error, next_retry_at) folded into the initial design.
- recovered_payments -> carry + attribution columns (spine #1) + refunded_at + disputed_at. Billability derives entirely from the predicate in spine #3; no billing-state columns beyond the line-item unique key.
- expiring_card_alerts -> carry (pre-dunning differentiator).
- win_back_sequences / win_back_steps -> carry; terminal-state handling designed in (legacy stuck-'active' bug becomes a state-machine constraint); one-sequence-per-subscription enforced by unique index, not check-then-act.

**Email (redesigned around Email Service + first-party tracking):**
- email_events -> `engagement_events`: first-party rows from our pixel/redirect routes; unique idempotency key per hit event; open vs click typed (click = billable engagement per PRICING.md; open feeds Intelligence only). Retention 180d -> monthly aggregates.
- NEW `email_sends`: one row per queued/sent message (queue message id, template, recipient hash, status from Email Service events). Replaces Resend-shaped logging; resend_event_id and RESEND_* secrets do not migrate.
- email_suppressions -> carry semantics (reason, suppressed_at, opt-out is an actual opt-out) + mirror of Email Service suppression list; bounce consumer writes here.

**Billing (rebuilt per PRICING.md):**
- billing_assessments -> `billing_invoices` + `billing_line_items`. Line item types: `recovery_fee` (FK recovered_payment_id, unique per recovery), `dispute_fee` (FK dispute_id, unique per dispute), `subscription`, `adjustment` (manual, signed amount, requires admin_audit_log entry). Line items carry currency and fee-math inputs; invoices are per account per currency; two-layer idempotency. No credit-note table (spine #3). No orphan charges by construction.

**Disputes (rebuilt as state machine):**
- disputes -> carry + `state` CHECK (draft|pending_review|approved|submitted|resolved_won|resolved_lost) + currency + resolved fee snapshot with cap applied at resolution (PRICING.md). Billed at the next monthly run after resolution; unique dispute_fee line item prevents double-billing on reopen.
- NEW `dispute_approvals`: who approved, when, evidence version hash. Submission requires an approval row (schema-enforced).
- dispute_evidence -> carry (R2-backed); dispute_fees -> folded into billing_line_items + resolved fee snapshot.

**Intelligence (rebuilt for grading + universal coverage):**
- customer_context -> carry + structured billing-behavior signal columns (subscription age, plan/seat deltas, interval switches, payment-latency drift, refund/dispute counts) so EVERY customer scores (PRICING.md precondition). Engagement signals read from engagement_events aggregates, not denormalized counters.
- health_score_history -> snapshot-on-change only + weekly rollups after 90d (retention provision).
- NEW `predictions`: score, band evidence hash, horizon, realized_outcome (nullable), graded_at. Backtesting is a query.
- mrr_snapshots, intelligence_reports, alerts, alert_history, intelligence_notification_preferences -> carry.
- benchmark_data -> carry (seeds the no-auth estimator). competitor_monitors -> DO NOT MIGRATE (absorbed-feature artifact, 0 rows).

**Audit product:**
- audit_runs -> carry + lift fields (stripe_baseline_recovered, still_dying, foxhound_adds). NEW `estimator_runs` (no-auth, Turnstile-gated, minimal PII: inputs + result only).

**Platform/ops:**
- outcomes -> carry + idempotency key + attribution linkage. PERMANENT retention (the moat). Semantics unchanged.
- webhook_events -> carry (claim columns; processed markers); 90d retention. Claim itself moves to the DO; the table is the audit record. charge.refunded and dispute webhooks stamp refunded_at/disputed_at on recovered_payments (feeds the billable predicate).
- cron_config -> carry. cron_locks -> DO NOT MIGRATE (DO replaces). cron_runs + cron_run_history -> ONE `cron_run_history` design, 90d retention.
- admin_audit_log -> carry, permanent. Every `adjustment` line item references an entry here.
- ai_calls -> carry; cost map keyed to every constant model ID (closes R-49); 90d raw -> monthly aggregates.
- platform_stats -> carry. customer_notes -> carry.
- page_404s -> DO NOT MIGRATE ROWS (140,428 unbounded legacy rows). NEW design: daily aggregate per path + 30d raw.

**Content/growth:**
- blog_posts -> carry + designed-in `featured` boolean and section/tag taxonomy (Blog Expansion Roadmap: 8-12 clean tags, tag archive pages, three-zone index). blog_post_links, blog_post_versions -> carry (version retention: keep last 10 per post).
- social_config, social_leads, social_posts, social_topic_log, social_blocklist, social_keywords -> carry; leads retention 180d non-actioned.

## Data transform (Phase 2)

- Checksummed export from Supabase (read-only) -> transform per this mapping -> D1 import. Row counts + per-table checksums verified both sides. Demo accounts re-seeded via the demo system, not migrated. page_404s and oauth_* rows explicitly excluded. Mapping doc records every column rename/drop with its citation.
