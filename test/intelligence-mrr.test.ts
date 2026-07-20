import { describe, expect, it } from "vitest";

import {
  buildCohortBreakdown,
  buildMrrSnapshotFields,
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

describe("computeMrrMovements: first-ever sync (priorByCustomer = null)", () => {
  it("totals current MRR with all movement buckets zero and rates null (no fabricated baseline)", () => {
    const result = computeMrrMovements(null, [
      point({ stripeCustomerId: "a", mrrCents: 2000 }),
      point({ stripeCustomerId: "b", mrrCents: 3000 }),
      point({ stripeCustomerId: "c", mrrCents: 0 }),
    ]);
    expect(result.totalMrrCents).toBe(5000);
    expect(result.activeCustomersCount).toBe(2);
    expect(result.newMrrCents).toBe(0);
    expect(result.expansionMrrCents).toBe(0);
    expect(result.contractionMrrCents).toBe(0);
    expect(result.churnMrrCents).toBe(0);
    expect(result.reactivationMrrCents).toBe(0);
    expect(result.newCustomersCount).toBe(0);
    expect(result.churnedCustomersCount).toBe(0);
    expect(result.voluntaryChurnRateBps).toBeNull();
    expect(result.involuntaryChurnRateBps).toBeNull();
    expect(result.netRevenueRetentionBps).toBeNull();
    expect(result.grossRevenueRetentionBps).toBeNull();
  });
});

describe("computeMrrMovements: subsequent sync with a prior baseline", () => {
  it("classifies a brand-new customer (no prior row at all) as new, not reactivation", () => {
    const prior = new Map<string, number>();
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 1000 })]);
    expect(result.newMrrCents).toBe(1000);
    expect(result.newCustomersCount).toBe(1);
    expect(result.reactivationMrrCents).toBe(0);
  });

  it("classifies a customer whose prior row had 0 MRR, now positive, as reactivation", () => {
    const prior = new Map([["a", 0]]);
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 1500 })]);
    expect(result.reactivationMrrCents).toBe(1500);
    expect(result.newMrrCents).toBe(0);
    expect(result.newCustomersCount).toBe(0);
  });

  it("classifies an increase from a positive prior as expansion, by the delta only", () => {
    const prior = new Map([["a", 1000]]);
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 2500 })]);
    expect(result.expansionMrrCents).toBe(1500);
    expect(result.contractionMrrCents).toBe(0);
    expect(result.churnMrrCents).toBe(0);
  });

  it("classifies a decrease that stays positive as contraction, distinct from churn", () => {
    const prior = new Map([["a", 2000]]);
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 500 })]);
    expect(result.contractionMrrCents).toBe(1500);
    expect(result.churnMrrCents).toBe(0);
  });

  it("classifies a drop to exactly 0 as churn, for the full prior amount", () => {
    const prior = new Map([["a", 2000]]);
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 0 })]);
    expect(result.churnMrrCents).toBe(2000);
    expect(result.churnedCustomersCount).toBe(1);
    expect(result.contractionMrrCents).toBe(0);
  });

  it("counts a prior customer entirely absent from this run's current set as churned too", () => {
    const prior = new Map([["a", 1000], ["b", 500]]);
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 1000 })]);
    expect(result.churnMrrCents).toBe(500);
    expect(result.churnedCustomersCount).toBe(1);
  });

  it("an unchanged customer contributes to no movement bucket", () => {
    const prior = new Map([["a", 1000]]);
    const result = computeMrrMovements(prior, [point({ stripeCustomerId: "a", mrrCents: 1000 })]);
    expect(result.newMrrCents).toBe(0);
    expect(result.expansionMrrCents).toBe(0);
    expect(result.contractionMrrCents).toBe(0);
    expect(result.churnMrrCents).toBe(0);
    expect(result.reactivationMrrCents).toBe(0);
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
  it("sums MRR by plan name, excluding customers with 0 current MRR", () => {
    const result = buildPlanBreakdown([
      point({ mrrCents: 1000, planName: "Pro" }),
      point({ mrrCents: 2000, planName: "Pro" }),
      point({ mrrCents: 500, planName: "Starter" }),
      point({ mrrCents: 0, planName: "Starter" }),
    ]);
    expect(result).toEqual({ Pro: 3000, Starter: 500 });
  });

  it("buckets a null plan name as unknown rather than dropping it", () => {
    const result = buildPlanBreakdown([point({ mrrCents: 100, planName: null })]);
    expect(result).toEqual({ unknown: 100 });
  });

  it("is an honest empty object when nobody is currently paying", () => {
    expect(buildPlanBreakdown([point({ mrrCents: 0 })])).toEqual({});
  });
});

describe("buildCohortBreakdown", () => {
  it("computes retention (active / total seen) per cohort as a single-column CohortRow", () => {
    const result = buildCohortBreakdown([
      point({ stripeCustomerId: "a", cohortKey: "2026-01", mrrCents: 100 }),
      point({ stripeCustomerId: "b", cohortKey: "2026-01", mrrCents: 0 }),
      point({ stripeCustomerId: "c", cohortKey: "2026-02", mrrCents: 100 }),
    ]);
    expect(result).toEqual([
      { label: "2026-01", values: [50] },
      { label: "2026-02", values: [100] },
    ]);
  });

  it("returns an empty array when there are no customers", () => {
    expect(buildCohortBreakdown([])).toEqual([]);
  });
});

describe("buildMrrSnapshotFields", () => {
  it("composes movements + breakdowns, with an honest empty channel breakdown", () => {
    const result = buildMrrSnapshotFields(null, [point({ mrrCents: 1000, planName: "Pro" })]);
    expect(result.totalMrrCents).toBe(1000);
    expect(result.perPlanBreakdown).toEqual({ Pro: 1000 });
    expect(result.perChannelBreakdown).toEqual({});
    expect(result.perCohortBreakdown).toHaveLength(1);
  });
});
