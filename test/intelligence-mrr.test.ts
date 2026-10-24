import { describe, expect, it } from "vitest";

import {
  buildPlanBreakdown,
  computeMrrMovements,
  type CustomerMrrPoint,
} from "~/lib/intelligence/mrr";

const point = (over: Partial<CustomerMrrPoint>): CustomerMrrPoint => ({
  stripeCustomerId: "cus_1",
  mrrCents: 0,
  planName: null,
  cohortKey: "2026-01",
  ...over,
});

describe("computeMrrMovements: subsequent sync with a prior baseline", () => {
  it("classifies a brand-new customer (no prior row at all) as new, not reactivation", () => {
    const prior = new Map<string, number>();
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 1000 })]);
    expect(result.newMrrCents).toBe(1000);
    expect(result.newCustomersCount).toBe(1);
    expect(result.reactivationMrrCents).toBe(0);
  });

  it("counts a prior customer entirely absent from this run's current set as churned too", () => {
    const prior = new Map([["a", 1000], ["b", 500]]);
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 1000 })]);
    expect(result.churnMrrCents).toBe(500);
    expect(result.churnedCustomersCount).toBe(1);
  });

  it("no double-counts across a mixed batch: each customer lands in exactly one bucket", () => {
    const prior = new Map([
      ["expanding", 1000],
      ["contracting", 2000],
      ["churning", 1500],
      ["reactivating", 0],
      ["unchanged", 800],
    ]);

    const current = [
      point({ stripeCustomerId: "brand_new", mrrCents: 500 }),
      point({ stripeCustomerId: "expanding", mrrCents: 1800 }),
      point({ stripeCustomerId: "contracting", mrrCents: 500 }),
      point({ stripeCustomerId: "churning", mrrCents: 0 }),
      point({ stripeCustomerId: "reactivating", mrrCents: 300 }),
      point({ stripeCustomerId: "unchanged", mrrCents: 800 }),
    ];
    const result = computeMrrMovements(prior, current);

    expect(result.newMrrCents).toBe(500);
    expect(result.expansionMrrCents).toBe(800); // 1800 - 1000
    expect(result.contractionMrrCents).toBe(1500); // 2000 - 500
    expect(result.churnMrrCents).toBe(1500);
    expect(result.reactivationMrrCents).toBe(300);
    expect(result.totalMrrCents).toBe(500 + 1800 + 500 + 0 + 300 + 800);
  });

  it("splits churn into voluntary/involuntary when a reason is known, leaving unknown-reason churn out of both", () => {
    const prior = new Map([["a", 1000], ["b", 2000], ["c", 500]]);
    const result = computeMrrMovements(prior, [
      point({ stripeCustomerId: "a", mrrCents: 0, churnReason: "voluntary" }),
      point({ stripeCustomerId: "b", mrrCents: 0, churnReason: "involuntary" }),
      point({ stripeCustomerId: "c", mrrCents: 0 }), // reason unknown
    ]);
    const priorTotal = 1000 + 2000 + 500;
    expect(result.churnMrrCents).toBe(3500);
    expect(result.voluntaryChurnRateBps).toBe(Math.round((1000 / priorTotal) * 10000));
    expect(result.involuntaryChurnRateBps).toBe(Math.round((2000 / priorTotal) * 10000));
  });

  it("computes NRR/GRR by the standard formulas relative to the prior total", () => {
    const prior = new Map([["a", 1000], ["b", 1000]]);
    // a expands by 500, b contracts by 300: net = 1000+500-300 = 1200 (excludes new)
    const result = computeMrrMovements(prior, [
      point({ stripeCustomerId: "a", mrrCents: 1500 }),
      point({ stripeCustomerId: "b", mrrCents: 700 }),
    ]);
    const priorTotal = 2000;
    expect(result.netRevenueRetentionBps).toBe(bps(priorTotal + 500 - 300 - 0, priorTotal));
    expect(result.grossRevenueRetentionBps).toBe(bps(priorTotal - 300 - 0, priorTotal));
  });
});

function bps(part: number, whole: number): number {
  return Math.round((part / whole) * 10000);
}

describe("buildPlanBreakdown", () => {

  it("buckets a null plan name as unknown rather than dropping it", () => {
    const result = buildPlanBreakdown([point({ mrrCents: 100, planName: null })]);
    expect(result).toEqual({ unknown: 100 });
  });
});
