import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool, json } from "./columns";
import { accountRef, optionalAccountRef } from "./tenancy";

type CurrencyTotals = { currency: string; cents: number }[];

/** One run's money figures per currency, in currency-code order. A
 *  scope that could not be read is null here as its count column is. */
export interface AuditMoneyByCurrency {
  failedInvoices: CurrencyTotals | null;
  declineBreakdown: Record<string, CurrencyTotals> | null;
  expiringCardsMrr: CurrencyTotals | null;
  pastDueSubscriptions: CurrencyTotals | null;
  openDisputes: CurrencyTotals | null;
  disputesAccepted: CurrencyTotals | null;
  mrr: CurrencyTotals | null;
  arr: CurrencyTotals | null;
}

export const auditRuns = sqliteTable(
  "audit_runs",
  {
    id: id(),
    accountId: optionalAccountRef(),
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
    stripeBaselineRecoveredCents: integer("stripe_baseline_recovered_cents"),
    stillDyingCents: integer("still_dying_cents"),
    foxhoundAddsCents: integer("foxhound_adds_cents"),
    // Every money figure per currency; the single-number columns above hold the figure in `currency` only. NULL on an older run, which renders its one total.
    moneyByCurrency: json<AuditMoneyByCurrency>("money_by_currency"),
  },
  (t) => [index("audit_runs_account_idx").on(t.accountId)],
);

// The monthly audit digest's per-account-per-month record: both the idempotency claim and the comparison's memory.
// IDEMPOTENCY IS THE DATABASE'S: the unique index on (account_id, period_month) refuses a second insert, so two concurrent monthly runs cannot both send one merchant the same month's digest (a read-then-write in application code can interleave, an index cannot).
// THE COMPARISON reads the PRIOR month's row. `totals` is the CUMULATIVE attributed-recovery snapshot at run time, so a month-over-month change is the difference between two snapshots, per currency and never summed across currencies.
export const auditDigestRuns = sqliteTable(
  "audit_digest_runs",
  {
    id: id(),
    accountId: accountRef(),
    /** The month the digest COVERS, "YYYY-MM" in UTC. The dedupe key's other half. */
    periodMonth: text("period_month").notNull(),
    /** CurrencyCents[]: the cumulative attributed-recovery total per currency. */
    totals: json<CurrencyTotals>("totals"),
    /** "sent" | "no_recipient" | "failed" */
    status: text("status").notNull(),
    error: text("error"),
    sentAt: ts("sent_at"),
    /** The cron run that produced this row (cronRunId: its job and start, the
     *  key of its cron_run_log row). Provenance, not a foreign key: these rows
     *  outlive the log's retention. Mirrors email_sends.cron_run_id. */
    cronRunId: text("cron_run_id"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("audit_digest_runs_account_period_uq").on(t.accountId, t.periodMonth)],
);
