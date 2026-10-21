import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool, json } from "./columns";
import { accounts } from "./tenancy";

// ============================================================================
// Audit product
// ============================================================================

export const auditRuns = sqliteTable(
  "audit_runs",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
    stripeAccountId: text("stripe_account_id"),
    runAt: ts("run_at").notNull(),
    lookbackDays: integer("lookback_days").notNull(),
    failedInvoicesCount: integer("failed_invoices_count"),
    failedInvoicesCents: integer("failed_invoices_cents"),
    expiringCardsCount: integer("expiring_cards_count"),
    expiringCardsMrrCents: integer("expiring_cards_mrr_cents"),
    pastDueSubscriptionsCount: integer("past_due_subscriptions_count"),
    pastDueSubscriptionsCents: integer("past_due_subscriptions_cents"),
    openDisputesCount: integer("open_disputes_count"),
    openDisputesCents: integer("open_disputes_cents"),
    disputesAcceptedCount: integer("disputes_accepted_count"),
    disputesWon: integer("disputes_won"),
    disputesLost: integer("disputes_lost"),
    mrrCents: integer("mrr_cents"),
    arrCents: integer("arr_cents"),
    activeSubscriptionsCount: integer("active_subscriptions_count"),
    voluntaryChurnRateBps: integer("voluntary_churn_rate_bps"),
    involuntaryChurnRateBps: integer("involuntary_churn_rate_bps"),
    aiSummary: text("ai_summary"),
    declineBreakdown: json("decline_breakdown"),
    isAuthenticated: bool("is_authenticated"),
    createdAt: ts("created_at").notNull(),
    disputesAcceptedCents: integer("disputes_accepted_cents"),
    currency: text("currency"),
    cardUpdaterEventsInWindow: integer("card_updater_events_in_window"),
    cardUpdaterExpiredDeclinesInWindow: integer("card_updater_expired_declines_in_window"),
    cardUpdaterAdvisory: text("card_updater_advisory"),
    expiresByMonth: json("expires_by_month"),
    // Explicit lift fields (SCHEMA.md): the audit's three bands.
    stripeBaselineRecoveredCents: integer("stripe_baseline_recovered_cents"),
    stillDyingCents: integer("still_dying_cents"),
    foxhoundAddsCents: integer("foxhound_adds_cents"),
  },
  (t) => [index("audit_runs_account_idx").on(t.accountId)],
);

// The monthly audit digest's per-account-per-month record (S30's cron, 316).
// It is BOTH the idempotency claim and the comparison's memory.
//
// IDEMPOTENCY IS THE DATABASE'S, never the application's. The unique index on
// (account_id, period_month) refuses the second insert, so two concurrent
// monthly runs cannot both send one merchant the same month's digest. Same
// shape as cron_alerts_dedupe_uq for the same reason 314 item 3 gave: a
// read-then-write in application code can interleave, an index cannot.
//
// THE COMPARISON reads the PRIOR month's row. `totals` is the CUMULATIVE
// attributed-recovery snapshot at run time, because computeFoxhoundAddsCents
// is all-time, so a month-over-month change is the difference between two
// consecutive snapshots, per currency and never summed across currencies
// (core.md records cross-currency summing as a live defect elsewhere; this
// does not repeat it).
export const auditDigestRuns = sqliteTable(
  "audit_digest_runs",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    /** The month the digest COVERS, "YYYY-MM" in UTC. The dedupe key's other half. */
    periodMonth: text("period_month").notNull(),
    /** CurrencyCents[]: the cumulative attributed-recovery total per currency. */
    totals: json<{ currency: string; cents: number }[]>("totals"),
    /** "sent" | "no_recipient" | "failed" */
    status: text("status").notNull(),
    error: text("error"),
    sentAt: ts("sent_at"),
    /** The cron run that produced this row. Deliberately NOT a foreign key, per
     *  314's FK-retention catch: cron_run_history is swept at 90 days and these
     *  rows outlive it, so an FK would fail the sweeper on exactly the
     *  legitimate rows. Mirrors email_sends.cron_run_id. */
    cronRunId: text("cron_run_id"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("audit_digest_runs_account_period_uq").on(t.accountId, t.periodMonth)],
);

// NEW: no-auth Turnstile-gated estimator; minimal PII (inputs + result only)
export const estimatorRuns = sqliteTable("estimator_runs", {
  id: id(),
  createdAt: ts("created_at").notNull(),
  mrrCents: integer("mrr_cents"),
  customerCount: integer("customer_count"),
  currency: text("currency"),
  estimatedLeakageCents: integer("estimated_leakage_cents"),
  benchmarkCohort: text("benchmark_cohort"),
  resultJson: json("result_json"),
});
