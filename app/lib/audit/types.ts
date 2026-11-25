import type Stripe from "stripe";

import type { DeclineCategory } from "~/lib/constants";
import type { CurrencyAmount } from "~/lib/money/totals";

/**
 * One scope's answer. Never a bare value, so a caller cannot read a failure as
 * data (one subsystem over).
 */
export type ScopeOutcome<T> = { ok: true; data: T } | { ok: false; reason: string };

/** A read that phase (b) performs, in the shape this module consumes. */
export type ReadOutcome<T> = ScopeOutcome<T[]>;

// THE ROWS THE ENGINE READS, AND NOTHING ELSE. reads.ts narrows each Stripe row
// to these as it pages, and a full Stripe object is assignable to each, so a
// test or caller holding the whole object passes it unchanged. Naming them
// keeps a partial row from posing as a complete Stripe type.

/**
 * An invoice as the engine reads it: amount, currency, dates and the three
 * places a decline code can sit (extractDeclineCode).
 */
export interface AuditInvoice {
  id?: string;
  amount_due: number;
  currency: string;
  due_date: number | null;
  created: number;
  last_finalization_error: { decline_code?: string } | null;
  last_payment_error?: { code?: string | null } | null;
  charge?: string | { failure_code: string | null } | null;
}

/**
 * A subscription as the engine reads it: status, currency, customer id, the
 * card's expiry, the items' prices and quantities, and the cancellation.
 */
export interface AuditSubscription {
  status: Stripe.Subscription.Status;
  currency: string;
  customer: string | { id?: string } | undefined;
  default_payment_method: string | { card?: { exp_month: number; exp_year: number } } | null;
  items: {
    data: {
      quantity?: number | null;
      price: {
        unit_amount: number | null;
        recurring: { interval: Stripe.Price.Recurring.Interval; interval_count: number } | null;
      };
    }[];
  };
  canceled_at: number | null;
  cancellation_details: { reason: Stripe.Subscription.CancellationDetails.Reason | null } | null;
}

/** A dispute as the engine reads it. */
export interface AuditDispute {
  status: Stripe.Dispute.Status;
  amount: number;
  currency: string;
  evidence_details: { submission_count: number } | null;
}

/** The engine counts Card Updater events and reads nothing inside one. */
export type AuditEvent = object;

export interface AuditInputs {
  uncollectibleInvoices: ReadOutcome<AuditInvoice>;
  openInvoices: ReadOutcome<AuditInvoice>;
  subscriptions: ReadOutcome<AuditSubscription>;
  disputes: ReadOutcome<AuditDispute>;
  cardUpdaterEvents: ReadOutcome<AuditEvent>;
}

/**
 * Per-currency totals from groupSumByCurrency, in currency-code order, zeroes
 * left out. Empty when there is no money at all.
 */
export type MoneyTotals = CurrencyAmount[];

export interface FailedInvoicesScope {
  count: number;
  /** In the run's currency only. */
  totalCents: number;
  totals: MoneyTotals;
  byCategory: Record<DeclineCategory, number>;
  byCategoryTotals: Record<DeclineCategory, MoneyTotals>;
}

export interface ExpiringCardsScope {
  count: number;
  /** In the run's currency only. */
  mrrAtRiskCents: number;
  mrrAtRiskTotals: MoneyTotals;
  /** Deduped customers per `YYYY-MM`, four months wide. */
  expiresByMonth: Record<string, number>;
}

/** A count with its money: `totalCents` in the run's currency only. */
export interface CountedMoney {
  count: number;
  totalCents: number;
  totals: MoneyTotals;
}

export type PastDueScope = CountedMoney;

export interface CardUpdaterScope {
  eventsInWindow: number;
  expiredCardDeclinesInWindow: number;
  advisory: string | null;
  windowDays: number;
}

export interface DisputesScope {
  open: CountedMoney;
  acceptedWithoutFighting: CountedMoney;
  historical: { won: number; lost: number };
}

export interface HealthScope {
  /** In the run's currency only, as is arrCents. */
  mrrCents: number;
  arrCents: number;
  mrrTotals: MoneyTotals;
  arrTotals: MoneyTotals;
  activeSubscriptionsCount: number;
  voluntaryChurnRateBps: number;
  involuntaryChurnRateBps: number;
}

export interface AuditResult {
  failedInvoices: ScopeOutcome<FailedInvoicesScope>;
  expiringCards: ScopeOutcome<ExpiringCardsScope>;
  pastDueSubscriptions: ScopeOutcome<PastDueScope>;
  cardUpdater: ScopeOutcome<CardUpdaterScope>;
  disputes: ScopeOutcome<DisputesScope>;
  health: ScopeOutcome<HealthScope>;
  meta: {
    stripeAccountId: string;
    lookbackDays: number;
    currency: string;
    ranAt: Date;
  };
}
