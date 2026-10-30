// Deterministic per-customer health scoring (PRICING.md universal-coverage
// precondition: every customer must score, never "unknown"). Pure math only,
// no AI call: the narrative (narrative.ts) states this score, it never
// invents it. Weighs the deterministic signals customer_context already
// carries (app/lib/intelligence/signals.ts); this file reads those values,
// it does not recompute them.
//
// Score convention: 0-100, HIGHER is HEALTHIER (matches the column name
// health_score, not risk_score). A customer with all-baseline signals (brand
// new, no plan changes, no refunds, no engagement history) scores an honest
// middle score with an empty factors list, not a penalty and not "unknown".
//
// One deliberate scope limit: the deterministic layer (signals.ts) counts
// billing-terms CHANGES (planChangeCount / intervalSwitchCount) but not their
// DIRECTION (upgrade vs downgrade, annual->monthly vs monthly->annual).
// Scoring change COUNT as general volatility, rather than guessing a
// direction the data does not carry, is the same non-fabrication discipline
// PRICING.md holds the narrative to. The one direction the score does
// read is the one Stripe states outright: a scheduled cancellation, a paused
// collection or a lower monthly amount, recorded as it happens from the
// customer.subscription.updated webhook (subscription-change.ts).

import { DAY_MS } from "~/lib/constants";
import { formatDateShort } from "~/lib/date-format";
import type { EngagementSignals, RecoverySignals } from "./signals";
import type { SubscriptionChangeState } from "./subscription-change";

export interface HealthFactor {
  /** Stable machine key for the signal that moved the score. */
  signal: string;
  /** Signed points contributed, relative to the baseline. */
  deltaPoints: number;
  /** Human-readable explanation; safe to surface in the UI or narrative prompt. */
  detail: string;
}

export interface HealthScoreResult {
  score: number;
  factors: HealthFactor[];
}

export interface HealthScoreInput {
  nowMs: number;
  subscriptionAgeDays: number | null;
  planChangeCount: number | null;
  seatChangeCount: number | null;
  intervalSwitchCount: number | null;
  paymentLatencyDriftDays: number | null;
  refundCount: number | null;
  disputeCount: number | null;
  recoverySignals: RecoverySignals | null;
  engagementSignals: EngagementSignals | null;
  /** Pending cancellation, pause or recent downgrade from the recorded
   *  subscription changes; absent or null when there is none. */
  subscriptionChanges?: SubscriptionChangeState | null;
  /** Stripe's card funding (credit, debit, prepaid, unknown) on the
   *  customer's latest failed payment; absent or null when unknown. */
  latestFailedCardFunding?: string | null;
}

/** The score a customer with no signal away from baseline gets. Exported so
 *  copy that names it (the /product/intelligence FAQ) reads it, never types it. */
export const HEALTH_SCORE_BASELINE = 70;
const BASELINE_SCORE = HEALTH_SCORE_BASELINE;

/**
 * The signals the score weighs, keyed by the factor's `signal`, each with the
 * words a person reads for it. Every scoring function below names its signal
 * through this map (`satisfies HealthSignal`), marketing copy lists the signals
 * from here, and test/product-intelligence-j58.test.ts
 * drives computeHealthScore to check the two sets are the same.
 */
export const HEALTH_SIGNAL_LABELS = {
  payment_latency: "payment timing",
  billing_volatility: "billing changes",
  refunds_disputes: "refunds and disputes",
  recovery_engagement: "recovery engagement",
  tenure: "tenure",
  payment_method: "card on file",
} as const;

export type HealthSignal = keyof typeof HEALTH_SIGNAL_LABELS;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scoreLatencyDrift(driftDays: number | null): HealthFactor | null {
  if (driftDays === null) return null; // not enough invoice history: honest unknown, no factor
  const deltaPoints = clamp(Math.round(-driftDays * 3), -25, 10);
  if (deltaPoints === 0) return null;
  const direction = driftDays > 0 ? "later" : "earlier";
  return {
    signal: "payment_latency" satisfies HealthSignal,
    deltaPoints,
    detail: `payments trending ${Math.abs(driftDays)} day(s) ${direction} against the due date`,
  };
}

// The weights of a change Stripe has stated, each against the baseline of 70:
// - A scheduled cancellation, -40: Stripe ends the subscription on that date
//   unless the customer takes it back, so it is churn the customer has already
//   chosen, the strongest churn evidence the score sees. On its own it takes a
//   baseline customer to 30, inside the high-risk band (CRITICAL_HEALTH_SCORE_MAX,
//   33) the alerts count, which is how the merchant hears of it the same day.
// - Paused collection, -20: no invoice is collected while paused, but the
//   customer is still subscribed and a pause often has a resume date, so it
//   takes a baseline customer to 50, "watch", not at risk.
// - A downgrade in the last quarter, -10: contraction the customer chose, the
//   direction the change count alone cannot see, but the customer stayed.
// A cancellation outweighs a pause on the same customer; they do not add.
const CANCELLATION_PENDING_POINTS = -40;
const PAUSE_PENDING_POINTS = -20;
const RECENT_DOWNGRADE_POINTS = -10;

function subscriptionChangePart(
  changes: SubscriptionChangeState | null | undefined,
): { deltaPoints: number; details: string[] } {
  const details: string[] = [];
  let deltaPoints = 0;
  if (changes?.cancellationPending) {
    const at = changes.cancellationPending.at;
    deltaPoints += CANCELLATION_PENDING_POINTS;
    details.push(at ? `cancellation scheduled for ${formatDateShort(at)}` : "cancellation scheduled");
  } else if (changes?.pausePending) {
    const until = changes.pausePending.resumesAt;
    deltaPoints += PAUSE_PENDING_POINTS;
    details.push(until ? `payment collection paused until ${formatDateShort(until)}` : "payment collection paused");
  }
  if (changes?.recentDowngradeAt) {
    deltaPoints += RECENT_DOWNGRADE_POINTS;
    details.push(`downgraded on ${formatDateShort(changes.recentDowngradeAt)}`);
  }
  return { deltaPoints, details };
}

function scoreBillingVolatility(
  planChangeCount: number,
  intervalSwitchCount: number,
  seatChangeCount: number,
  changes: SubscriptionChangeState | null | undefined,
): HealthFactor | null {
  const changeCount = planChangeCount + intervalSwitchCount;
  const volatility = -clamp(changeCount * 4 + seatChangeCount * 2, 0, 25);
  const stated = subscriptionChangePart(changes);
  const deltaPoints = volatility + stated.deltaPoints;
  if (deltaPoints === 0) return null;
  const details = [...stated.details];
  if (volatility !== 0) {
    details.push(`${changeCount} plan/interval change(s) and ${seatChangeCount} seat change(s) on record`);
  }
  return {
    signal: "billing_volatility" satisfies HealthSignal,
    deltaPoints,
    detail: details.join("; "),
  };
}

function scoreRefundsDisputes(refundCount: number, disputeCount: number): HealthFactor | null {
  const deltaPoints = -clamp((refundCount + disputeCount) * 8, 0, 30);
  if (deltaPoints === 0) return null;
  return {
    signal: "refunds_disputes" satisfies HealthSignal,
    deltaPoints,
    detail: `${refundCount} refund(s) and ${disputeCount} dispute(s) on record`,
  };
}

function scoreEngagement(
  recovery: RecoverySignals | null,
  engagement: EngagementSignals | null,
  nowMs: number,
): HealthFactor | null {
  const failedPaymentCount = recovery?.failedPaymentCount ?? 0;
  if (failedPaymentCount === 0) return null; // nothing to have engaged with yet
  const lastEngagedAtMs = engagement?.lastEngagedAtMs ?? null;
  if (lastEngagedAtMs === null) {
    return {
      signal: "recovery_engagement" satisfies HealthSignal,
      deltaPoints: -10,
      detail: `no engagement with ${failedPaymentCount} recovery communication(s) sent`,
    };
  }
  const daysSinceEngaged = Math.floor((nowMs - lastEngagedAtMs) / DAY_MS);
  if (daysSinceEngaged > 180) {
    return {
      signal: "recovery_engagement" satisfies HealthSignal,
      deltaPoints: -5,
      detail: `last engaged with a recovery communication ${daysSinceEngaged} days ago`,
    };
  }
  return null;
}

// A prepaid card, -5: prepaid balances run out and are often not topped up,
// so a recurring charge on one fails for insufficient funds more often than on
// a credit or debit card. Read off the card on the customer's latest failed
// payment (failed_payments.card_funding, filled at intake), so it only ever
// applies to a customer whose payment has already failed once, and it is kept
// small for that reason. Debit and credit carry no weight: nothing here says
// which of the two fails more for this merchant.
const PREPAID_CARD_POINTS = -5;

function scorePaymentMethod(latestFailedCardFunding: string | null | undefined): HealthFactor | null {
  if (latestFailedCardFunding !== "prepaid") return null;
  return {
    signal: "payment_method" satisfies HealthSignal,
    deltaPoints: PREPAID_CARD_POINTS,
    detail: "latest failed payment was on a prepaid card",
  };
}

function scoreTenure(subscriptionAgeDays: number | null): HealthFactor | null {
  if (!subscriptionAgeDays || subscriptionAgeDays < 90) return null;
  const deltaPoints = clamp(Math.floor(subscriptionAgeDays / 90) * 2, 0, 15);
  if (deltaPoints === 0) return null;
  return {
    signal: "tenure" satisfies HealthSignal,
    deltaPoints,
    detail: `subscribed ${subscriptionAgeDays} days`,
  };
}

/**
 * Score one customer from their deterministic signals. Always returns a
 * number (never "unknown") and a factors list of only the signals that
 * actually moved the score away from the baseline.
 */
export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  const factors = [
    scoreLatencyDrift(input.paymentLatencyDriftDays),
    scoreBillingVolatility(
      input.planChangeCount ?? 0,
      input.intervalSwitchCount ?? 0,
      input.seatChangeCount ?? 0,
      input.subscriptionChanges,
    ),
    scoreRefundsDisputes(input.refundCount ?? 0, input.disputeCount ?? 0),
    scoreEngagement(input.recoverySignals, input.engagementSignals, input.nowMs),
    scoreTenure(input.subscriptionAgeDays),
    scorePaymentMethod(input.latestFailedCardFunding),
  ].filter((f): f is HealthFactor => f !== null);

  const score = clamp(
    Math.round(BASELINE_SCORE + factors.reduce((sum, f) => sum + f.deltaPoints, 0)),
    0,
    100,
  );
  return { score, factors };
}
