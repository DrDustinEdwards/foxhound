import type Stripe from "stripe";

import {
  CAU_EVENT_RETENTION_DAYS,
  DAY_MS,
  type DeclineCategory,
  MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY,
} from "~/lib/constants";
import { groupSumByCurrency, type CurrencyAmount } from "~/lib/money/totals";
import { byCurrencyCode } from "~/lib/money-format";
import { classifyDecline } from "~/lib/recovery/decline";

// The audit engine, phase (a) of the port ruled by 362. Legacy's
// `lib/audit-engine.ts` (blob `040912f895b556163d1a08d8af1974bd6af9b2ed`,
// 24,280 bytes), walked whole in parity/ENGINE-AUDIT.md, which is this module's
// spec.
//
// PURE. No Stripe client, no database, no AI, no clock of its own. Every read is
// an INJECTED INPUT and every derived number is returned. That is 337 binding 4's
// seam: a plant drives the real assembly rather than a reproduction of it, and
// the Stripe half is phase (b)'s to fail on its own.
//
// PER-SCOPE STATUS, WHICH IS 362 RULING 2 AND THE ONE DELIBERATE DIVERGENCE.
// Legacy wraps its five reads in `Promise.allSettled` and each compute section in
// a `try` that degrades to ZEROES. A merchant then cannot tell "no open disputes"
// from "the disputes call failed", because both render as 0. Every scope here
// answers `{ ok: true, data }` or `{ ok: false, reason }`, so a zero always means
// zero. A zero that means unknown is a lie with digits.
//
// EVERY MONEY FIGURE IS KEPT PER CURRENCY (job_ed1c41e4bd95). Legacy adds every
// amount into one number and labels it with whichever currency it met first, so
// $1,240 and EUR 310 read "$1,550". Each figure here carries its totals per
// currency through groupSumByCurrency (RULES.md 3.20), ordered by currency
// code as /intelligence orders its totals (byCurrencyCode), and the surfaces
// show one line per currency (Dustin, 2026-10-25,
// parity/APPROVED-DIFFERENCES.md). The plain `...Cents` numbers beside them are
// the figure IN THE RUN'S CURRENCY only (meta.currency), never a sum across
// currencies: they fill the single-number columns, which a run stored before
// money_by_currency falls back to. A single-currency account gets the same
// number either way.

/** One scope's answer. Never a bare value, so a caller cannot read a failure as
 *  data (339 binding 5, one subsystem over). */
export type ScopeOutcome<T> = { ok: true; data: T } | { ok: false; reason: string };

/** A read that phase (b) performs, in the shape this module consumes. */
export type ReadOutcome<T> = ScopeOutcome<T[]>;

export interface AuditInputs {
  uncollectibleInvoices: ReadOutcome<Stripe.Invoice>;
  openInvoices: ReadOutcome<Stripe.Invoice>;
  subscriptions: ReadOutcome<Stripe.Subscription>;
  disputes: ReadOutcome<Stripe.Dispute>;
  cardUpdaterEvents: ReadOutcome<Stripe.Event>;
}

/** Per-currency totals from groupSumByCurrency, in currency-code order, zeroes left out.
 *  Empty when there is no money at all. */
export type MoneyTotals = CurrencyAmount[];

export interface FailedInvoicesScope {
  count: number;
  /** In the run's currency only. */
  totalCents: number;
  totals: MoneyTotals;
  /** Keyed by Foxhound's SIX categories, not legacy's four. In the run's
   *  currency only. */
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

/** Stripe's Invoice type dropped `charge` at 2026-03-25.dahlia while the JSON
 *  still carries it. Legacy shims the same way in its engine and its webhook. */
type InvoiceWithCharge = Stripe.Invoice & {
  charge?: string | Stripe.Charge | null;
  last_payment_error?: { code?: string | null } | null;
};

/**
 * Legacy's fallback chain, in legacy's order (`audit-engine.ts` extractDeclineCode).
 * The finalization error first, then the last payment error, then the charge's
 * own failure code.
 */
export function extractDeclineCode(invoice: Stripe.Invoice): string | null {
  const withCharge = invoice as InvoiceWithCharge;
  const fromFinalization = invoice.last_finalization_error?.decline_code;
  const fromLastPayment = withCharge.last_payment_error?.code;
  const fromCharge =
    typeof withCharge.charge === "object" && withCharge.charge
      ? withCharge.charge.failure_code
      : null;
  return fromFinalization ?? fromLastPayment ?? fromCharge ?? null;
}

/**
 * A subscription's recurring amount normalized to monthly cents. Legacy's
 * `monthlyPlanCents`, arithmetic for arithmetic: a day interval times 30, a week
 * times 4, a year divided by 12.
 */
export function monthlyPlanCents(subscription: Stripe.Subscription): number {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  if (!price) return 0;
  const amount = price.unit_amount ?? 0;
  const interval = price.recurring?.interval;
  const intervalCount = price.recurring?.interval_count ?? 1;
  if (!amount || !interval) return 0;
  switch (interval) {
    case "day":
      return Math.round((amount / intervalCount) * 30);
    case "week":
      return Math.round((amount / intervalCount) * 4);
    case "month":
      return Math.round(amount / intervalCount);
    case "year":
      return Math.round(amount / intervalCount / 12);
    default:
      return 0;
  }
}

/**
 * The Card Updater advisory, at legacy's three gates.
 *
 * THE WINDOW IS 30 DAYS AND NOT THE LOOKBACK, deliberately: Stripe's events API
 * retains 30 days regardless, so a 90-day denominator against a 30-day numerator
 * would inflate the trigger. Legacy documents the asymmetry and it is kept.
 */
export function buildCardUpdaterAdvisory(
  eventsInWindow: number,
  expiredCardDeclinesInWindow: number,
): string | null {
  if (eventsInWindow > 0) return null;
  if (expiredCardDeclinesInWindow < MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY) return null;
  const plural = expiredCardDeclinesInWindow === 1 ? "" : "s";
  return `Stripe Account Updater is not firing for your cards. ${expiredCardDeclinesInWindow} expired-card decline${plural} hit your account in the last ${CAU_EVENT_RETENTION_DAYS} days, and Stripe updated none of them automatically. Common causes: cards held as raw numbers rather than attached to Stripe Customers, issuers that do not participate, and regional limits.`;
}

/** An empty bucket per category, so a category with no failures reads 0 rather
 *  than being absent. */
function zeroByCategory(): Record<DeclineCategory, number> {
  return { soft: 0, network: 0, expired: 0, fraud: 0, revoked: 0, unknown: 0 };
}

/** One amount in its own currency. */
type Amount = CurrencyAmount;

/** A row Stripe sent without a currency is taken to be in the run's, which is
 *  legacy's assumption for every row. */
function amountOf(cents: number, currency: string | null | undefined, runCurrency: string): Amount {
  return { currency: (currency ?? runCurrency).toLowerCase(), cents };
}

/** Totals per currency, through the one money-total path (RULES.md 3.20), in
 *  currency-code order. A currency whose total is zero adds no line. */
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

/**
 * The failed set legacy builds: everything uncollectible in the window, plus the
 * open invoices whose due date has passed. Both reads are required, so a failure
 * in either fails the scope rather than halving it silently.
 */
function resolveFailedInvoices(
  inputs: AuditInputs,
  nowMs: number,
): ScopeOutcome<Stripe.Invoice[]> {
  if (!inputs.uncollectibleInvoices.ok) {
    return { ok: false, reason: inputs.uncollectibleInvoices.reason };
  }
  if (!inputs.openInvoices.ok) return { ok: false, reason: inputs.openInvoices.reason };
  const overdue = inputs.openInvoices.data.filter(
    (invoice) => typeof invoice.due_date === "number" && invoice.due_date * 1000 < nowMs,
  );
  return { ok: true, data: [...inputs.uncollectibleInvoices.data, ...overdue] };
}

function computeFailedInvoices(failed: Stripe.Invoice[], runCurrency: string): FailedInvoicesScope {
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
    // Legacy buckets four and pushes everything else into `soft`, which
    // misattributes a revoked mandate as a retryable decline. Foxhound's
    // classifier already returns `revoked` and `unknown`, so every code lands in
    // its own bucket and legacy's catch-all has nothing left to catch.
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
  subscriptions: Stripe.Subscription[],
  ranAt: Date,
  runCurrency: string,
): ExpiringCardsScope {
  const currentYear = ranAt.getUTCFullYear();
  const currentMonth = ranAt.getUTCMonth() + 1;
  // Legacy's explicit December boundary: month 13 does not exist, so next month
  // rolls the year.
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
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id;
    if (!customerId) continue;

    // ALREADY-EXPIRED CARDS COUNT HERE, which is the opposite of the expiring-card
    // CRON, and both are right. The cron skips them because an alert about a card
    // that has already failed is late (342 binding 1); the audit counts them
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
      const key = `${bucketDate.getUTCFullYear()}-${String(bucketDate.getUTCMonth() + 1).padStart(2, "0")}`;
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
  const { totalCents: mrrAtRiskCents, totals: mrrAtRiskTotals } = counted(count, atRisk, runCurrency);
  return { count, mrrAtRiskCents, mrrAtRiskTotals, expiresByMonth };
}

function computePastDue(subscriptions: Stripe.Subscription[], runCurrency: string): PastDueScope {
  let count = 0;
  const amounts: Amount[] = [];
  for (const subscription of subscriptions) {
    if (subscription.status !== "past_due") continue;
    count += 1;
    // RAW `unit_amount`, NOT normalized to monthly, which is legacy's own choice
    // and its own comment: this is the next cycle's value, so a render calls it
    // subscription value and never MRR.
    amounts.push(
      amountOf(subscription.items?.data?.[0]?.price?.unit_amount ?? 0, subscription.currency, runCurrency),
    );
  }
  return counted(count, amounts, runCurrency);
}

function computeDisputes(disputes: Stripe.Dispute[], runCurrency: string): DisputesScope {
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
    // count is what separates a dispute somebody fought and lost from one nobody
    // answered, and only the second is a process failure worth reporting.
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
  subscriptions: Stripe.Subscription[],
  lookbackStartSeconds: number,
  runCurrency: string,
): HealthScope {
  const mrr: Amount[] = [];
  let activeSubscriptionsCount = 0;
  let pastDueCount = 0;
  let voluntaryCanceled = 0;

  for (const subscription of subscriptions) {
    if (subscription.status === "active") {
      activeSubscriptionsCount += 1;
      mrr.push(amountOf(monthlyPlanCents(subscription), subscription.currency, runCurrency));
    } else if (subscription.status === "past_due") {
      pastDueCount += 1;
    } else if (subscription.status === "canceled") {
      const canceledAt = subscription.canceled_at ?? 0;
      if (canceledAt >= lookbackStartSeconds) {
        // A cancellation Stripe attributes to a failed payment is INVOLUNTARY and
        // is not voluntary churn. Everything else in the window is.
        if (subscription.cancellation_details?.reason !== "payment_failed") {
          voluntaryCanceled += 1;
        }
      }
    }
  }

  // Legacy's denominator is every subscription the read returned, not just the
  // active ones, and the divide-by-zero guard is its own. Ported as found: a
  // different denominator would silently move every merchant's churn figure.
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
    involuntaryChurnRateBps: Math.round((pastDueCount / denominator) * 10_000),
  };
}

/** Legacy takes the currency from whichever list answered first, in this order. */
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

/**
 * The whole audit, from injected reads. Pure: same inputs, same output, no clock
 * and no network.
 *
 * SIX SCOPES, EACH WITH ITS OWN STATUS. A scope fails only when a read it needs
 * failed, and it says which read. Nothing here throws, and nothing here writes.
 */
export function runAudit(input: RunAuditInput): AuditResult {
  const { stripeAccountId, lookbackDays, ranAt, reads } = input;
  const nowMs = ranAt.getTime();
  const lookbackStartSeconds = Math.floor((nowMs - lookbackDays * DAY_MS) / 1000);
  const cauWindowDays = Math.min(lookbackDays, CAU_EVENT_RETENTION_DAYS);
  const cauWindowStartSeconds = Math.floor((nowMs - cauWindowDays * DAY_MS) / 1000);

  const currency = resolveCurrency(reads);
  const failed = resolveFailedInvoices(reads, nowMs);

  const failedInvoices: ScopeOutcome<FailedInvoicesScope> = failed.ok
    ? { ok: true, data: computeFailedInvoices(failed.data, currency) }
    : { ok: false, reason: failed.reason };

  const expiringCards: ScopeOutcome<ExpiringCardsScope> = reads.subscriptions.ok
    ? { ok: true, data: computeExpiringCards(reads.subscriptions.data, ranAt, currency) }
    : { ok: false, reason: reads.subscriptions.reason };

  const pastDueSubscriptions: ScopeOutcome<PastDueScope> = reads.subscriptions.ok
    ? { ok: true, data: computePastDue(reads.subscriptions.data, currency) }
    : { ok: false, reason: reads.subscriptions.reason };

  // THE ADVISORY NEEDS BOTH READS, and the denominator is counted inside the CAU
  // window rather than the lookback, so numerator and denominator cover the same
  // days. Either read failing fails the scope; legacy answers a null event count
  // and then advises on nothing, which reads as "no advisory" rather than "not
  // measured".
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
