// Pure per-customer signal derivation: every customer on the connected account gets a customer_context row, not
// just failed-payment ones. healthScore / aiAssessment / aiRecommendedActions belong to the AI half and are
// never touched here. Everything takes a normalized shape (not raw Stripe.* objects) so it is unit-testable;
// sync.server.ts builds the shapes from real API responses.

import { DAY_MS } from "~/lib/constants";

export type BillingInterval = "day" | "week" | "month" | "year";

export interface ActiveSubscriptionSnapshot {
  priceId: string;
  productName: string | null;
  quantity: number;
  interval: BillingInterval;
  intervalCount: number;
  unitAmountCents: number;
}

/** One historical billing-terms observation, reconstructed from a subscription's creation state plus each invoice
 *  line since. Exactly one per distinct instant (collapseBillingObservations guarantees it). */
export interface BillingObservation {
  at: number; // unix ms
  priceId: string;
  quantity: number;
  interval: BillingInterval;
}

/** A raw billing line before collapsing. `valueCents` is only a ranking signal for collapseBillingObservations
 *  (a subscription item's monthly-equivalent amount or an invoice line's signed amount); never in the collapsed shape. */
export interface RawBillingLineObservation extends BillingObservation {
  valueCents: number;
}

/**
 * Collapses every raw line at the SAME instant into one BillingObservation: the highest-`valueCents` line.
 * Otherwise a multi-item subscription or a multi-line invoice would push simultaneous unrelated lines that
 * countBillingChanges (which compares consecutive entries) would misread as sequential changes, with tie
 * order depending on insertion order. On an upgrade invoice a proration credit is negative, so the new charge wins.
 */
export function collapseBillingObservations(
  raw: RawBillingLineObservation[],
): BillingObservation[] {
  const byInstant = new Map<number, RawBillingLineObservation>();
  for (const line of raw) {
    const top = byInstant.get(line.at);
    if (!top || line.valueCents > top.valueCents) byInstant.set(line.at, line);
  }
  return [...byInstant.values()].map(({ at, priceId, quantity, interval }) => ({
    at,
    priceId,
    quantity,
    interval,
  }));
}

export interface InvoicePaymentObservation {
  dueAt: number | null;
  paidAt: number | null;
}

const INTERVAL_MONTHLY_FACTOR: Record<BillingInterval, number> = {
  day: 30,
  week: 52 / 12,
  month: 1,
  year: 1 / 12,
};

/** One subscription item's price as a monthly-equivalent amount (a quarterly price counts a third a month). The one
 *  conversion: the audit, the daily sync and the downgrade check all read MRR through it. */
export function monthlyEquivalentCents(
  unitAmountCents: number,
  quantity: number,
  interval: BillingInterval,
  intervalCount: number,
): number {
  const every = intervalCount > 0 ? intervalCount : 1;
  return Math.round((unitAmountCents * quantity * INTERVAL_MONTHLY_FACTOR[interval]) / every);
}

interface ActiveSubscriptionSummary {
  mrrContributionCents: number;
  activeSubscriptionsCount: number;
  currentPlanName: string | null;
}

/** Sums a customer's active subscriptions into an MRR contribution and a current plan label. An empty list is a
 *  real zero (no subscription), not an unknown. */
function summarizeActiveSubscriptions(
  subs: ActiveSubscriptionSnapshot[],
): ActiveSubscriptionSummary {
  if (subs.length === 0) {
    return { mrrContributionCents: 0, activeSubscriptionsCount: 0, currentPlanName: null };
  }
  let total = 0;
  let top: { name: string | null; cents: number } | null = null;
  for (const s of subs) {
    const cents = monthlyEquivalentCents(
      s.unitAmountCents,
      s.quantity,
      s.interval,
      s.intervalCount,
    );
    total += cents;
    if (!top || cents > top.cents) top = { name: s.productName, cents };
  }
  return {
    mrrContributionCents: total,
    activeSubscriptionsCount: subs.length,
    currentPlanName: top?.name ?? null,
  };
}

/** Days since the customer's Stripe `created`, clamped to >= 0 against clock skew. */
function computeSubscriptionAgeDays(customerSinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - customerSinceMs) / DAY_MS));
}

export interface BillingChangeCounts {
  planChangeCount: number;
  seatChangeCount: number;
  intervalSwitchCount: number;
}

/** Counts transitions across a customer's billing-terms history, sorted chronologically. The earliest observation
 *  is a baseline, not a change. Plan identity is the Stripe price id. */
export function countBillingChanges(observations: BillingObservation[]): BillingChangeCounts {
  const sorted = [...observations].sort((a, b) => a.at - b.at);
  let planChangeCount = 0;
  let seatChangeCount = 0;
  let intervalSwitchCount = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.priceId !== prev.priceId) planChangeCount += 1;
    if (cur.quantity !== prev.quantity) seatChangeCount += 1;
    if (cur.interval !== prev.interval) intervalSwitchCount += 1;
  }
  return { planChangeCount, seatChangeCount, intervalSwitchCount };
}

/** Average days late (paid - due) of the recent half of datable invoices minus the older half; positive means
 *  trending later. Null (not zero) with fewer than two datable invoices: "not enough history". */
export function computePaymentLatencyDriftDays(
  invoices: InvoicePaymentObservation[],
): number | null {
  const dated = invoices
    .filter((i): i is { dueAt: number; paidAt: number } => i.dueAt !== null && i.paidAt !== null)
    .sort((a, b) => a.dueAt - b.dueAt);
  if (dated.length < 2) return null;
  const lateness = dated.map((i) => (i.paidAt - i.dueAt) / DAY_MS);
  const mid = Math.floor(lateness.length / 2);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const older = avg(lateness.slice(0, mid));
  const newer = avg(lateness.slice(mid));
  return Math.round((newer - older) * 10) / 10;
}

// Foxhound's own history for this customer. An all-zero/null aggregate (no failed payment, dispute or dunning
// email) is the correct universal baseline, not a gap.

export interface RecoverySignalRow {
  status: string;
  daysToRecover: number | null;
}
export interface RecoverySignals {
  failedPaymentCount: number;
  recoveredCount: number;
  avgDaysToRecover: number | null;
}
export function buildRecoverySignals(rows: RecoverySignalRow[]): RecoverySignals {
  const recovered = rows.filter((r) => r.status === "recovered");
  const days = recovered.map((r) => r.daysToRecover).filter((d): d is number => d !== null);
  return {
    failedPaymentCount: rows.length,
    recoveredCount: recovered.length,
    avgDaysToRecover:
      days.length > 0
        ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10
        : null,
  };
}

export interface DisputeSignalRow {
  state: string;
}
export interface DisputeSignals {
  disputeCount: number;
  wonCount: number;
  lostCount: number;
}
export function buildDisputeSignals(rows: DisputeSignalRow[]): DisputeSignals {
  return {
    disputeCount: rows.length,
    wonCount: rows.filter((r) => r.state === "resolved_won").length,
    lostCount: rows.filter((r) => r.state === "resolved_lost").length,
  };
}

export interface EngagementSignalRow {
  eventType: string;
  occurredAt: number; // unix ms
}
export interface EngagementSignals {
  openCount: number;
  clickCount: number;
  lastEngagedAtMs: number | null;
}
export function buildEngagementSignals(rows: EngagementSignalRow[]): EngagementSignals {
  const openCount = rows.filter((r) => r.eventType === "open").length;
  const clickCount = rows.filter((r) => r.eventType === "click").length;
  const lastEngagedAtMs = rows.reduce<number | null>(
    (max, r) => (max === null || r.occurredAt > max ? r.occurredAt : max),
    null,
  );
  return { openCount, clickCount, lastEngagedAtMs };
}

export interface CustomerContextInput {
  customerSinceMs: number;
  nowMs: number;
  activeSubscriptions: ActiveSubscriptionSnapshot[];
  /** Raw, uncollapsed lines; collapsed before diffing (see collapseBillingObservations). */
  billingHistory: RawBillingLineObservation[];
  invoiceHistory: InvoicePaymentObservation[];
  refundCount: number;
  disputeCount: number;
  recoveryRows: RecoverySignalRow[];
  disputeRows: DisputeSignalRow[];
  engagementRows: EngagementSignalRow[];
}

export interface CustomerContextFields {
  mrrContributionCents: number;
  activeSubscriptionsCount: number;
  currentPlanName: string | null;
  subscriptionAgeDays: number;
  planChangeCount: number;
  seatChangeCount: number;
  intervalSwitchCount: number;
  paymentLatencyDriftDays: number | null;
  refundCount: number;
  disputeCount: number;
  recoverySignals: RecoverySignals;
  disputeSignals: DisputeSignals;
  engagementSignals: EngagementSignals;
}

/** Turns a customer's normalized Stripe + Foxhound history into every deterministic customer_context field. Leaves
 *  healthScore / healthFactors / aiAssessment* / aiRecommendedActions to the AI half, and currentPlanTier,
 *  currency and ltvCents NULL: no source exists, so unknown beats a guess. */
export function buildCustomerContextFields(input: CustomerContextInput): CustomerContextFields {
  const { mrrContributionCents, activeSubscriptionsCount, currentPlanName } =
    summarizeActiveSubscriptions(input.activeSubscriptions);
  const { planChangeCount, seatChangeCount, intervalSwitchCount } = countBillingChanges(
    collapseBillingObservations(input.billingHistory),
  );
  return {
    mrrContributionCents,
    activeSubscriptionsCount,
    currentPlanName,
    subscriptionAgeDays: computeSubscriptionAgeDays(input.customerSinceMs, input.nowMs),
    planChangeCount,
    seatChangeCount,
    intervalSwitchCount,
    paymentLatencyDriftDays: computePaymentLatencyDriftDays(input.invoiceHistory),
    refundCount: input.refundCount,
    disputeCount: input.disputeCount,
    recoverySignals: buildRecoverySignals(input.recoveryRows),
    disputeSignals: buildDisputeSignals(input.disputeRows),
    engagementSignals: buildEngagementSignals(input.engagementRows),
  };
}
