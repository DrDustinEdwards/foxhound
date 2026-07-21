import { describe, expect, it } from "vitest";

import { computeHealthScore, type HealthScoreInput } from "~/lib/intelligence/risk";

const NOW_MS = new Date("2026-07-20T00:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

const BASELINE_INPUT: HealthScoreInput = {
  nowMs: NOW_MS,
  subscriptionAgeDays: 0,
  planChangeCount: 0,
  seatChangeCount: 0,
  intervalSwitchCount: 0,
  paymentLatencyDriftDays: null,
  refundCount: 0,
  disputeCount: 0,
  recoverySignals: { failedPaymentCount: 0, recoveredCount: 0, avgDaysToRecover: null },
  engagementSignals: { openCount: 0, clickCount: 0, lastEngagedAtMs: null },
};

describe("computeHealthScore (universal coverage, never unknown)", () => {
  it("scores an honest middle score with no factors for an all-baseline customer", () => {
    const result = computeHealthScore(BASELINE_INPUT);
    expect(result.score).toBe(70);
    expect(result.factors).toEqual([]);
  });

  it("penalizes rising payment latency drift", () => {
    const result = computeHealthScore({ ...BASELINE_INPUT, paymentLatencyDriftDays: 10 });
    expect(result.score).toBeLessThan(70);
    expect(result.factors.map((f) => f.signal)).toContain("payment_latency");
  });

  it("rewards improving (earlier) payment latency drift, capped", () => {
    const result = computeHealthScore({ ...BASELINE_INPUT, paymentLatencyDriftDays: -20 });
    expect(result.score).toBeGreaterThan(70);
    const factor = result.factors.find((f) => f.signal === "payment_latency");
    expect(factor?.deltaPoints).toBe(10); // clamped
  });

  it("treats plan/interval changes as general volatility, not a guessed direction", () => {
    const result = computeHealthScore({ ...BASELINE_INPUT, planChangeCount: 3, intervalSwitchCount: 1 });
    expect(result.score).toBeLessThan(70);
    const factor = result.factors.find((f) => f.signal === "billing_volatility");
    expect(factor?.detail).not.toMatch(/downgrade|upgrade|annual|monthly/i);
  });

  it("penalizes refunds and disputes, capped", () => {
    const result = computeHealthScore({ ...BASELINE_INPUT, refundCount: 10, disputeCount: 10 });
    const factor = result.factors.find((f) => f.signal === "refunds_disputes");
    expect(factor?.deltaPoints).toBe(-30); // clamped
  });

  it("does not penalize engagement when the customer never had a failed payment", () => {
    const result = computeHealthScore(BASELINE_INPUT);
    expect(result.factors.some((f) => f.signal === "recovery_engagement")).toBe(false);
  });

  it("penalizes zero engagement when recovery communications were sent", () => {
    const result = computeHealthScore({
      ...BASELINE_INPUT,
      recoverySignals: { failedPaymentCount: 2, recoveredCount: 0, avgDaysToRecover: null },
    });
    const factor = result.factors.find((f) => f.signal === "recovery_engagement");
    expect(factor?.deltaPoints).toBe(-10);
  });

  it("penalizes stale engagement less than zero engagement", () => {
    const result = computeHealthScore({
      ...BASELINE_INPUT,
      recoverySignals: { failedPaymentCount: 1, recoveredCount: 1, avgDaysToRecover: 2 },
      engagementSignals: { openCount: 1, clickCount: 1, lastEngagedAtMs: NOW_MS - 200 * DAY_MS },
    });
    const factor = result.factors.find((f) => f.signal === "recovery_engagement");
    expect(factor?.deltaPoints).toBe(-5);
  });

  it("does not penalize recent engagement", () => {
    const result = computeHealthScore({
      ...BASELINE_INPUT,
      recoverySignals: { failedPaymentCount: 1, recoveredCount: 1, avgDaysToRecover: 1 },
      engagementSignals: { openCount: 1, clickCount: 1, lastEngagedAtMs: NOW_MS - 10 * DAY_MS },
    });
    expect(result.factors.some((f) => f.signal === "recovery_engagement")).toBe(false);
  });

  it("rewards tenure, capped", () => {
    const result = computeHealthScore({ ...BASELINE_INPUT, subscriptionAgeDays: 900 });
    const factor = result.factors.find((f) => f.signal === "tenure");
    expect(factor?.deltaPoints).toBe(15); // clamped
  });

  it("clamps the final score to [0, 100]", () => {
    const worst = computeHealthScore({
      ...BASELINE_INPUT,
      paymentLatencyDriftDays: 60,
      planChangeCount: 10,
      intervalSwitchCount: 10,
      refundCount: 10,
      disputeCount: 10,
      recoverySignals: { failedPaymentCount: 5, recoveredCount: 0, avgDaysToRecover: null },
    });
    expect(worst.score).toBe(0);

    const best = computeHealthScore({
      ...BASELINE_INPUT,
      paymentLatencyDriftDays: -60,
      subscriptionAgeDays: 5000,
    });
    expect(best.score).toBeLessThanOrEqual(100);
  });
});
