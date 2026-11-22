// Deterministic per-customer health scoring: every customer scores, never "unknown". Pure math, no AI call; the
// narrative (narrative.ts) states this score and never invents it. Reads the signals customer_context already
// carries (signals.ts). Score is 0-100, HIGHER is HEALTHIER; an all-baseline customer scores the baseline with
// an empty factors list. The change COUNT (planChangeCount / intervalSwitchCount) is scored as volatility because
// the data carries no direction; the one direction read is what Stripe states outright (a scheduled
// cancellation, a paused collection or a lower monthly amount, from the customer.subscription.updated
// webhook, subscription-change.ts).

import { formatDate } from "capsomer/behavior/time";
import { DAY_MS } from "~/lib/constants";
import type { EngagementSignals, RecoverySignals } from "./signals";
import type { SubscriptionChangeState } from "./subscription-change";

export interface HealthFactor {
  signal: string;
  deltaPoints: number;
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
  subscriptionChanges?: SubscriptionChangeState | null;
  latestFailedCardFunding?: string | null;
}

/** The score for a customer with no signal away from baseline. Exported so copy that names it reads it. */
export const HEALTH_SCORE_BASELINE = 70;
const BASELINE_SCORE = HEALTH_SCORE_BASELINE;

/** The signals the score weighs, keyed by the factor's `signal`, with the words a person reads. Marketing copy
 *  lists the signals from here, and test/product-intelligence.test.ts checks the two sets match. */
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

// Weights of a change Stripe has stated, against the baseline of 70: a scheduled cancellation -40 (churn the
// customer already chose; takes a baseline customer to 30, inside the high-risk band the alerts count, so the
// merchant hears the same day); paused collection -20 (still subscribed, often a resume date: "watch");
// a downgrade in the last quarter -10 (contraction the change count cannot see). A cancellation outweighs a
// pause on the same customer; they do not add.
const CANCELLATION_PENDING_POINTS = -40;
const PAUSE_PENDING_POINTS = -20;
const RECENT_DOWNGRADE_POINTS = -10;

function subscriptionChangePart(changes: SubscriptionChangeState | null | undefined): {
  deltaPoints: number;
  details: string[];
} {
  const details: string[] = [];
  let deltaPoints = 0;
  if (changes?.cancellationPending) {
    const at = changes.cancellationPending.at;
    deltaPoints += CANCELLATION_PENDING_POINTS;
    details.push(
      at
        ? `cancellation scheduled for ${formatDate(at, { style: "medium" }) ?? ""}`
        : "cancellation scheduled",
    );
  } else if (changes?.pausePending) {
    const until = changes.pausePending.resumesAt;
    deltaPoints += PAUSE_PENDING_POINTS;
    details.push(
      until
        ? `payment collection paused until ${formatDate(until, { style: "medium" }) ?? ""}`
        : "payment collection paused",
    );
  }
  if (changes?.recentDowngradeAt) {
    deltaPoints += RECENT_DOWNGRADE_POINTS;
    details.push(
      `downgraded on ${formatDate(changes.recentDowngradeAt, { style: "medium" }) ?? ""}`,
    );
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
    details.push(
      `${changeCount} plan/interval change(s) and ${seatChangeCount} seat change(s) on record`,
    );
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

// A prepaid card, -5: balances run out, so a recurring charge fails more often. Read off the latest failed
// payment's card (failed_payments.card_funding), so it applies only after a failure and stays small. Debit and
// credit carry no weight: nothing says which fails more for this merchant.
const PREPAID_CARD_POINTS = -5;

function scorePaymentMethod(
  latestFailedCardFunding: string | null | undefined,
): HealthFactor | null {
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

/** Score one customer. Always returns a number and a factors list of only the signals that moved the score from baseline. */
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
