// Deterministic per-customer health scoring (PRICING.md universal-coverage
// precondition: every customer must score, never "unknown"). Pure math only,
// no AI call: the AI narrative (narrative.ts) PHRASES this score, it never
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
// PRICING.md holds the AI narrative to; extending signals.ts to capture
// direction is outside this slice's boundary (READ the deterministic
// signals, never change how they're derived).

import { DAY_MS } from "~/lib/constants";
import type { EngagementSignals, RecoverySignals } from "./signals";

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
}

const BASELINE_SCORE = 70;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scoreLatencyDrift(driftDays: number | null): HealthFactor | null {
  if (driftDays === null) return null; // not enough invoice history: honest unknown, no factor
  const deltaPoints = clamp(Math.round(-driftDays * 3), -25, 10);
  if (deltaPoints === 0) return null;
  const direction = driftDays > 0 ? "later" : "earlier";
  return {
    signal: "payment_latency",
    deltaPoints,
    detail: `payments trending ${Math.abs(driftDays)} day(s) ${direction} against the due date`,
  };
}

function scoreBillingVolatility(
  planChangeCount: number,
  intervalSwitchCount: number,
  seatChangeCount: number,
): HealthFactor | null {
  const changeCount = planChangeCount + intervalSwitchCount;
  const deltaPoints = -clamp(changeCount * 4 + seatChangeCount * 2, 0, 25);
  if (deltaPoints === 0) return null;
  return {
    signal: "billing_volatility",
    deltaPoints,
    detail: `${changeCount} plan/interval change(s) and ${seatChangeCount} seat change(s) on record`,
  };
}

function scoreRefundsDisputes(refundCount: number, disputeCount: number): HealthFactor | null {
  const deltaPoints = -clamp((refundCount + disputeCount) * 8, 0, 30);
  if (deltaPoints === 0) return null;
  return {
    signal: "refunds_disputes",
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
      signal: "recovery_engagement",
      deltaPoints: -10,
      detail: `no engagement with ${failedPaymentCount} recovery communication(s) sent`,
    };
  }
  const daysSinceEngaged = Math.floor((nowMs - lastEngagedAtMs) / DAY_MS);
  if (daysSinceEngaged > 180) {
    return {
      signal: "recovery_engagement",
      deltaPoints: -5,
      detail: `last engaged with a recovery communication ${daysSinceEngaged} days ago`,
    };
  }
  return null;
}

function scoreTenure(subscriptionAgeDays: number | null): HealthFactor | null {
  if (!subscriptionAgeDays || subscriptionAgeDays < 90) return null;
  const deltaPoints = clamp(Math.floor(subscriptionAgeDays / 90) * 2, 0, 15);
  if (deltaPoints === 0) return null;
  return {
    signal: "tenure",
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
    ),
    scoreRefundsDisputes(input.refundCount ?? 0, input.disputeCount ?? 0),
    scoreEngagement(input.recoverySignals, input.engagementSignals, input.nowMs),
    scoreTenure(input.subscriptionAgeDays),
  ].filter((f): f is HealthFactor => f !== null);

  const score = clamp(
    Math.round(BASELINE_SCORE + factors.reduce((sum, f) => sum + f.deltaPoints, 0)),
    0,
    100,
  );
  return { score, factors };
}
