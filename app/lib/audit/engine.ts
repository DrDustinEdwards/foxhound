import { plural } from "@drdustinedwards/site-helpers/text";
import type Stripe from "stripe";

import {
  CAU_EVENT_RETENTION_DAYS,
  DAY_MS,
  type DeclineCategory,
  MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY,
} from "~/lib/constants";
import { churnReasonOf } from "~/lib/intelligence/mrr";
import { monthlyEquivalentCents, type BillingInterval } from "~/lib/intelligence/signals";
import { groupSumByCurrency, type CurrencyAmount } from "~/lib/money/totals";
import { byCurrencyCode } from "~/lib/money/totals";
import { classifyDecline } from "~/lib/recovery/decline";
import { monthKey } from "@dustinedwards/site-runtime/time";
import { stripeMs } from "~/lib/stripe/time";

// The audit engine, phase (a) of the port ruled by 362.
//
// No Stripe client, no database, no AI, no clock of its own. That is 337
// binding 4's seam: a plant drives the real assembly rather than a reproduction
// of it, and the Stripe half is phase (b)'s to fail on its own.
//
// A merchant then cannot tell "no open disputes" from "the disputes call
// failed", because both render as 0.

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

interface FailedInvoicesScope {
  count: number;
  /** In the run's currency only. */
  totalCents: number;
  totals: MoneyTotals;
  byCategory: Record<DeclineCategory, number>;
  byCategoryTotals: Record<DeclineCategory, MoneyTotals>;
}

interface ExpiringCardsScope {
  count: number;
  /** In the run's currency only. */
  mrrAtRiskCents: number;
  mrrAtRiskTotals: MoneyTotals;
  /** Deduped customers per `YYYY-MM`, four months wide. */
  expiresByMonth: Record<string, number>;
}

/** A count with its money: `totalCents` in the run's currency only. */
interface CountedMoney {
  count: number;
  totalCents: number;
  totals: MoneyTotals;
}

type PastDueScope = CountedMoney;

interface CardUpdaterScope {
  eventsInWindow: number;
  expiredCardDeclinesInWindow: number;
  advisory: string | null;
  windowDays: number;
}

interface DisputesScope {
  open: CountedMoney;
  acceptedWithoutFighting: CountedMoney;
  historical: { won: number; lost: number };
}

interface HealthScope {
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

export function extractDeclineCode(invoice: AuditInvoice): string | null {
  const fromFinalization = invoice.last_finalization_error?.decline_code;
  const fromLastPayment = invoice.last_payment_error?.code;
  const fromCharge =
    typeof invoice.charge === "object" && invoice.charge ? invoice.charge.failure_code : null;
  return fromFinalization ?? fromLastPayment ?? fromCharge ?? null;
}

/** What `perItem` gives, summed over every item of the subscription and multiplied by its quantity. */
function sumItems(
  subscription: AuditSubscription,
  perItem: (price: AuditSubscription["items"]["data"][number]["price"]) => number,
): number {
  let total = 0;
  for (const item of subscription.items?.data ?? []) {
    total += perItem(item.price) * (item.quantity ?? 1);
  }
  return total;
}

/**
 * A subscription's recurring amount normalized to monthly cents, through the
 * same conversion Intelligence uses (signals.ts monthlyEquivalentCents), so the
 * audit's MRR and the dashboard's agree. Every item, times its quantity.
 */
export function monthlyPlanCents(subscription: AuditSubscription): number {
  return sumItems(subscription, (price) => {
    const amount = price?.unit_amount ?? 0;
    const interval = price?.recurring?.interval;
    if (!amount || !interval) return 0;
    return monthlyEquivalentCents(
      amount,
      1,
      interval as BillingInterval,
      price.recurring?.interval_count ?? 1,
    );
  });
}

/**
 * THE WINDOW IS 30 DAYS AND NOT THE LOOKBACK, deliberately: Stripe's events API
 * retains 30 days regardless, so a 90-day denominator against a 30-day
 * numerator would inflate the trigger.
 */
export function buildCardUpdaterAdvisory(
  eventsInWindow: number,
  expiredCardDeclinesInWindow: number,
): string | null {
  if (eventsInWindow > 0) return null;
  if (expiredCardDeclinesInWindow < MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY) return null;
  return `Stripe Account Updater is not firing for your cards. ${plural(expiredCardDeclinesInWindow, "expired-card decline")} hit your account in the last ${CAU_EVENT_RETENTION_DAYS} days, and Stripe updated none of them automatically. Common causes: cards held as raw numbers rather than attached to Stripe Customers, issuers that do not participate, and regional limits.`;
}

/**
 * An empty bucket per category, so a category with no failures reads 0 rather
 * than being absent.
 */
function zeroByCategory(): Record<DeclineCategory, number> {
  return { soft: 0, network: 0, expired: 0, fraud: 0, revoked: 0, unknown: 0 };
}

/** One amount in its own currency. */
type Amount = CurrencyAmount;

function amountOf(cents: number, currency: string | null | undefined, runCurrency: string): Amount {
  return { currency: (currency ?? runCurrency).toLowerCase(), cents };
}

/**
 * Totals per currency, through the one money-total path, in currency-code
 * order. A currency whose total is zero adds no line.
 */
function totalsOf(amounts: Amount[]): MoneyTotals {
  return groupSumByCurrency(amounts)
    .filter((t) => t.cents !== 0)
    .sort(byCurrencyCode);
}

/** The figure in one currency, for the single-number columns. */
function inCurrency(totals: MoneyTotals, currency: string): number {
  return totals.find((t) => t.currency === currency)?.cents ?? 0;
}

function counted(count: number, amounts: Amount[], runCurrency: string): CountedMoney {
  const totals = totalsOf(amounts);
  return { count, totalCents: inCurrency(totals, runCurrency), totals };
}

function resolveFailedInvoices(inputs: AuditInputs, nowMs: number): ScopeOutcome<AuditInvoice[]> {
  if (!inputs.uncollectibleInvoices.ok) {
    return { ok: false, reason: inputs.uncollectibleInvoices.reason };
  }
  if (!inputs.openInvoices.ok) return { ok: false, reason: inputs.openInvoices.reason };
  const overdue = inputs.openInvoices.data.filter(
    (invoice) => (stripeMs(invoice.due_date) ?? Infinity) < nowMs,
  );
  return { ok: true, data: [...inputs.uncollectibleInvoices.data, ...overdue] };
}

function computeFailedInvoices(failed: AuditInvoice[], runCurrency: string): FailedInvoicesScope {
  const amounts: Amount[] = [];
  const byCategoryAmounts: Record<DeclineCategory, Amount[]> = {
    soft: [],
    network: [],
    expired: [],
    fraud: [],
    revoked: [],
    unknown: [],
  };
  for (const invoice of failed) {
    const amount = amountOf(invoice.amount_due ?? 0, invoice.currency, runCurrency);
    amounts.push(amount);
    // SIX CATEGORIES, and the reshape is a DELETION rather than an addition.
    byCategoryAmounts[classifyDecline(extractDeclineCode(invoice))].push(amount);
  }
  const byCategory = zeroByCategory();
  const byCategoryTotals = {} as Record<DeclineCategory, MoneyTotals>;
  for (const key of Object.keys(byCategory) as DeclineCategory[]) {
    byCategoryTotals[key] = totalsOf(byCategoryAmounts[key]);
    byCategory[key] = inCurrency(byCategoryTotals[key], runCurrency);
  }
  const { totalCents, totals } = counted(failed.length, amounts, runCurrency);
  return { count: failed.length, totalCents, totals, byCategory, byCategoryTotals };
}

function computeExpiringCards(
  subscriptions: AuditSubscription[],
  ranAt: Date,
  runCurrency: string,
): ExpiringCardsScope {
  const currentYear = ranAt.getUTCFullYear();
  const currentMonth = ranAt.getUTCMonth() + 1;
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
  const nextMonthYear = currentMonth === 12 ? currentYear + 1 : currentYear;

  const seenCustomers = new Set<string>();
  const buckets = new Map<string, Set<string>>();
  let count = 0;
  const atRisk: Amount[] = [];

  for (const subscription of subscriptions) {
    if (subscription.status !== "active") continue;
    const pm = subscription.default_payment_method;
    if (!pm || typeof pm === "string") continue;
    const card = pm.card;
    if (!card) continue;
    const expYear = card.exp_year ?? 0;
    const expMonth = card.exp_month ?? 0;
    const customerId =
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
    if (!customerId) continue;

    // ALREADY-EXPIRED CARDS COUNT HERE, which is the opposite of the
    // expiring-card CRON, and both are right. The cron skips them because an
    // alert about a card that has already failed is late; the audit counts them
    // because a diagnostic of what is wrong right now must include them.
    const isExpiring =
      expYear < currentYear ||
      (expYear === currentYear && expMonth <= currentMonth) ||
      (expYear === nextMonthYear && expMonth === nextMonth);
    if (isExpiring && !seenCustomers.has(customerId)) {
      seenCustomers.add(customerId);
      count += 1;
      atRisk.push(amountOf(monthlyPlanCents(subscription), subscription.currency, runCurrency));
    }

    // The timeline is FOUR months wide against the count's two, so a merchant
    // sees the peak before it arrives. Anything already past collapses into the
    // current month rather than falling out.
    const monthsAhead = (expYear - currentYear) * 12 + (expMonth - currentMonth);
    if (monthsAhead <= 3) {
      const bucketDate = new Date(
        Date.UTC(currentYear, currentMonth - 1 + Math.max(0, monthsAhead), 1),
      );
      const key = monthKey(bucketDate);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = new Set<string>();
        buckets.set(key, bucket);
      }
      bucket.add(customerId);
    }
  }

  const expiresByMonth: Record<string, number> = {};
  for (const [key, customers] of buckets) expiresByMonth[key] = customers.size;
  const { totalCents: mrrAtRiskCents, totals: mrrAtRiskTotals } = counted(
    count,
    atRisk,
    runCurrency,
  );
  return { count, mrrAtRiskCents, mrrAtRiskTotals, expiresByMonth };
}

function computePastDue(subscriptions: AuditSubscription[], runCurrency: string): PastDueScope {
  let count = 0;
  const amounts: Amount[] = [];
  for (const subscription of subscriptions) {
    if (subscription.status !== "past_due") continue;
    count += 1;
    amounts.push(
      amountOf(
        sumItems(subscription, (price) => price?.unit_amount ?? 0),
        subscription.currency,
        runCurrency,
      ),
    );
  }
  return counted(count, amounts, runCurrency);
}

function computeDisputes(disputes: AuditDispute[], runCurrency: string): DisputesScope {
  const open: Amount[] = [];
  const accepted: Amount[] = [];
  let won = 0;
  let lost = 0;
  for (const dispute of disputes) {
    const amount = amountOf(dispute.amount ?? 0, dispute.currency, runCurrency);
    if (dispute.status === "needs_response" || dispute.status === "under_review") {
      open.push(amount);
    }
    // ACCEPTED WITHOUT FIGHTING is lost AND never submitted. The submission
    // count is what separates a dispute somebody fought and lost from one
    // nobody answered, and only the second is a process failure worth
    // reporting.
    if (dispute.status === "lost" && dispute.evidence_details?.submission_count === 0) {
      accepted.push(amount);
    }
    if (dispute.status === "won") won += 1;
    if (dispute.status === "lost") lost += 1;
  }
  return {
    open: counted(open.length, open, runCurrency),
    acceptedWithoutFighting: counted(accepted.length, accepted, runCurrency),
    historical: { won, lost },
  };
}

function computeHealth(
  subscriptions: AuditSubscription[],
  lookbackStartSeconds: number,
  runCurrency: string,
): HealthScope {
  const mrr: Amount[] = [];
  let activeSubscriptionsCount = 0;
  let voluntaryCanceled = 0;
  let involuntaryCanceled = 0;

  for (const subscription of subscriptions) {
    if (subscription.status === "active") {
      activeSubscriptionsCount += 1;
      mrr.push(amountOf(monthlyPlanCents(subscription), subscription.currency, runCurrency));
    } else if (subscription.status === "canceled") {
      const canceledAt = subscription.canceled_at ?? 0;
      if (canceledAt >= lookbackStartSeconds) {
        // One definition with Intelligence's churn (mrr.ts churnReasonOf): a payment-failed or
        // disputed cancellation is involuntary, any other reason voluntary. A past-due
        // subscription has not churned and is its own scope (pastDueSubscriptions).
        if (churnReasonOf(subscription.cancellation_details?.reason) === "involuntary") {
          involuntaryCanceled += 1;
        } else {
          voluntaryCanceled += 1;
        }
      }
    }
  }

  const denominator = subscriptions.length > 0 ? subscriptions.length : 1;
  const mrrTotals = totalsOf(mrr);
  const arrTotals = mrrTotals.map((t) => ({ currency: t.currency, cents: t.cents * 12 }));
  const mrrCents = inCurrency(mrrTotals, runCurrency);
  return {
    mrrCents,
    arrCents: mrrCents * 12,
    mrrTotals,
    arrTotals,
    activeSubscriptionsCount,
    voluntaryChurnRateBps: Math.round((voluntaryCanceled / denominator) * 10_000),
    involuntaryChurnRateBps: Math.round((involuntaryCanceled / denominator) * 10_000),
  };
}

function resolveCurrency(inputs: AuditInputs): string {
  const first =
    (inputs.subscriptions.ok ? inputs.subscriptions.data[0]?.currency : null) ??
    (inputs.uncollectibleInvoices.ok ? inputs.uncollectibleInvoices.data[0]?.currency : null) ??
    (inputs.openInvoices.ok ? inputs.openInvoices.data[0]?.currency : null) ??
    (inputs.disputes.ok ? inputs.disputes.data[0]?.currency : null) ??
    "usd";
  return first.toLowerCase();
}

export interface RunAuditInput {
  stripeAccountId: string;
  lookbackDays: number;
  ranAt: Date;
  reads: AuditInputs;
}

export function auditWindows(ranAt: Date, lookbackDays: number) {
  const nowMs = ranAt.getTime();
  const cauWindowDays = Math.min(lookbackDays, CAU_EVENT_RETENTION_DAYS);
  return {
    lookbackStartSeconds: Math.floor((nowMs - lookbackDays * DAY_MS) / 1000),
    cauWindowDays,
    cauWindowStartSeconds: Math.floor((nowMs - cauWindowDays * DAY_MS) / 1000),
  };
}

/**
 * The whole audit, from injected reads. Pure: same inputs, same output, no
 * clock and no network.
 */
export function runAudit(input: RunAuditInput): AuditResult {
  const { stripeAccountId, lookbackDays, ranAt, reads } = input;
  const { lookbackStartSeconds, cauWindowDays, cauWindowStartSeconds } = auditWindows(
    ranAt,
    lookbackDays,
  );

  const currency = resolveCurrency(reads);
  const failed = resolveFailedInvoices(reads, ranAt.getTime());

  const failedInvoices: ScopeOutcome<FailedInvoicesScope> = failed.ok
    ? { ok: true, data: computeFailedInvoices(failed.data, currency) }
    : { ok: false, reason: failed.reason };

  const expiringCards: ScopeOutcome<ExpiringCardsScope> = reads.subscriptions.ok
    ? { ok: true, data: computeExpiringCards(reads.subscriptions.data, ranAt, currency) }
    : { ok: false, reason: reads.subscriptions.reason };

  const pastDueSubscriptions: ScopeOutcome<PastDueScope> = reads.subscriptions.ok
    ? { ok: true, data: computePastDue(reads.subscriptions.data, currency) }
    : { ok: false, reason: reads.subscriptions.reason };

  // THE ADVISORY NEEDS BOTH READS, and the denominator is counted inside the
  // CAU window rather than the lookback, so numerator and denominator cover the
  // same days.
  let cardUpdater: ScopeOutcome<CardUpdaterScope>;
  if (!reads.cardUpdaterEvents.ok) {
    cardUpdater = { ok: false, reason: reads.cardUpdaterEvents.reason };
  } else if (!failed.ok) {
    cardUpdater = { ok: false, reason: failed.reason };
  } else {
    let expiredCardDeclinesInWindow = 0;
    for (const invoice of failed.data) {
      const created = invoice.created;
      if (typeof created !== "number" || created < cauWindowStartSeconds) continue;
      if (classifyDecline(extractDeclineCode(invoice)) === "expired") {
        expiredCardDeclinesInWindow += 1;
      }
    }
    const eventsInWindow = reads.cardUpdaterEvents.data.length;
    cardUpdater = {
      ok: true,
      data: {
        eventsInWindow,
        expiredCardDeclinesInWindow,
        advisory: buildCardUpdaterAdvisory(eventsInWindow, expiredCardDeclinesInWindow),
        windowDays: cauWindowDays,
      },
    };
  }

  const disputes: ScopeOutcome<DisputesScope> = reads.disputes.ok
    ? { ok: true, data: computeDisputes(reads.disputes.data, currency) }
    : { ok: false, reason: reads.disputes.reason };

  const health: ScopeOutcome<HealthScope> = reads.subscriptions.ok
    ? { ok: true, data: computeHealth(reads.subscriptions.data, lookbackStartSeconds, currency) }
    : { ok: false, reason: reads.subscriptions.reason };

  return {
    failedInvoices,
    expiringCards,
    pastDueSubscriptions,
    cardUpdater,
    disputes,
    health,
    meta: { stripeAccountId, lookbackDays, currency, ranAt },
  };
}
