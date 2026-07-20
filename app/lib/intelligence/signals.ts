// Pure per-customer signal derivation (SCHEMA.md customer_context; PRICING.md
// universal-coverage precondition: every customer on the connected account gets
// a row, not just failed-payment ones). healthScore / aiAssessment /
// aiRecommendedActions are the separate AI half's job and are never touched
// here (TASK-foxhound-intelligence-deterministic.md).
//
// Everything below takes a normalized shape, not raw Stripe.* objects, so
// derivation is pure and unit-testable without a live connected account. The
// live Stripe enumeration seam (app/lib/intelligence/sync.server.ts) builds
// these shapes from real API responses.

import { DAY_MS } from "~/lib/constants";

export type BillingInterval = "day" | "week" | "month" | "year";

export interface ActiveSubscriptionSnapshot {
  priceId: string;
  productName: string | null;
  quantity: number;
  interval: BillingInterval;
  unitAmountCents: number;
}

/** One historical billing-terms observation (order is the caller's responsibility;
 *  countBillingChanges sorts by `at` itself). Reconstructed from a subscription's
 *  creation state plus each invoice line item since (SCHEMA.md: Stripe has no
 *  single "plan change log" API; invoice lines are the closest first-class record
 *  of what a customer was actually billed at each point in time). */
export interface BillingObservation {
  at: number; // unix ms
  priceId: string;
  quantity: number;
  interval: BillingInterval;
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

/** Normalizes one subscription item's price to a monthly-equivalent amount. */
export function monthlyEquivalentCents(
  unitAmountCents: number,
  quantity: number,
  interval: BillingInterval,
): number {
  return Math.round(unitAmountCents * quantity * INTERVAL_MONTHLY_FACTOR[interval]);
}

export interface ActiveSubscriptionSummary {
  mrrContributionCents: number;
  activeSubscriptionsCount: number;
  /** The plan with the largest MRR contribution; null when there is none. */
  currentPlanName: string | null;
}

/** Sums a customer's active subscriptions into an MRR contribution + a current
 *  plan label. An empty list is a real, honest zero state (no subscription),
 *  not an unknown. */
export function summarizeActiveSubscriptions(
  subs: ActiveSubscriptionSnapshot[],
): ActiveSubscriptionSummary {
  if (subs.length === 0) {
    return { mrrContributionCents: 0, activeSubscriptionsCount: 0, currentPlanName: null };
  }
  let total = 0;
  let top: { name: string | null; cents: number } | null = null;
  for (const s of subs) {
    const cents = monthlyEquivalentCents(s.unitAmountCents, s.quantity, s.interval);
    total += cents;
    if (!top || cents > top.cents) top = { name: s.productName, cents };
  }
  return {
    mrrContributionCents: total,
    activeSubscriptionsCount: subs.length,
    currentPlanName: top?.name ?? null,
  };
}

/** Days since the customer's Stripe `created` timestamp. Clamped to >= 0 so a
 *  clock-skewed or synthetic future `customerSince` never produces a negative age. */
export function computeSubscriptionAgeDays(customerSinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - customerSinceMs) / DAY_MS));
}

export interface BillingChangeCounts {
  planChangeCount: number;
  seatChangeCount: number;
  intervalSwitchCount: number;
}

/** Counts transitions across a customer's billing-terms history, sorted
 *  chronologically first. The earliest observation is a baseline, not a change,
 *  so a customer with one observation (or none) has all-zero counts. Plan
 *  identity is the Stripe price id: what actually changes on an upgrade,
 *  downgrade, or interval switch. */
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

/** Average days late (paid - due) for the more recent half of a customer's
 *  datable invoice history minus the older half: positive means payments are
 *  trending later, a risk signal. Null (not zero) with fewer than two datable
 *  invoices: an honest "not enough history" state, distinct from a genuine
 *  zero-drift customer. */
export function computePaymentLatencyDriftDays(invoices: InvoicePaymentObservation[]): number | null {
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

// ---- JSON signal aggregates (recovery / dispute / engagement) ----
// Foxhound's own account-scoped history for this customer, not Stripe data.
// Most customers (never having had a failed payment, dispute, or dunning email)
// score an honest all-zero/null aggregate here; that is the correct universal
// baseline, not a gap.

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
      days.length > 0 ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
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

// ---- Top-level orchestrator: one customer's full customer_context payload ----

export interface CustomerContextInput {
  customerSinceMs: number;
  nowMs: number;
  activeSubscriptions: ActiveSubscriptionSnapshot[];
  billingHistory: BillingObservation[];
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

/** The one function that turns a customer's normalized Stripe + Foxhound
 *  history into every deterministic customer_context field this slice owns.
 *  Deliberately does not touch healthScore / healthFactors / aiAssessment /
 *  aiAssessmentGeneratedAt / aiRecommendedActions / currentPlanTier: the first
 *  five are the AI half's job (left NULL); currentPlanTier has no reliable
 *  source yet (no tier taxonomy anywhere in the schema), so it is left NULL
 *  rather than guessed from a plan name string. */
export function buildCustomerContextFields(input: CustomerContextInput): CustomerContextFields {
  const { mrrContributionCents, activeSubscriptionsCount, currentPlanName } =
    summarizeActiveSubscriptions(input.activeSubscriptions);
  const { planChangeCount, seatChangeCount, intervalSwitchCount } = countBillingChanges(
    input.billingHistory,
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
