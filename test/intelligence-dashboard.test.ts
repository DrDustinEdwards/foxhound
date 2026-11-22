import { describe, expect, it } from "vitest";

import {
  dayOverDayCents,
  newMrrMonthToDateCents,
  signedMoney,
  weeklyMovements,
  planBreakdownRows,
} from "~/lib/intelligence/dashboard";
import { rollUpByMonth } from "~/lib/intelligence/mrr";

describe("planBreakdownRows", () => {
  it("sorts plans by MRR, largest first, with no engine placeholder shown raw", () => {
    const rows = planBreakdownRows({
      Starter: 200_000,
      Scale: 600_000,
      unknown: 50_000,
      Growth: 300_000,
      Free: 0,
    });
    expect(rows).toEqual([
      { plan: "Scale", mrrCents: 600_000 },
      { plan: "Growth", mrrCents: 300_000 },
      { plan: "Starter", mrrCents: 200_000 },
      { plan: "Unknown plan", mrrCents: 50_000 },
    ]);
    expect(planBreakdownRows([])).toEqual([]);
    expect(planBreakdownRows(null)).toEqual([]);
  });
});

describe("daily series", () => {
  const day = (d: number, total: number, newMrr = 0, churn = 0) => ({
    at: new Date(Date.UTC(2026, 9, d, 3)),
    totalMrrCents: total,
    newMrrCents: newMrr,
    expansionMrrCents: 0,
    reactivationMrrCents: 0,
    contractionMrrCents: 0,
    churnMrrCents: churn,
  });

  it("reads day-over-day with its sign, month-to-date new MRR, and sums movement by Monday week", () => {
    // Oct 2026: the 25th is a Sunday, the 26th a Monday.
    const points = [day(24, 10_000, 500), day(25, 10_400, 400), day(26, 10_100, 0, 300)];
    expect(dayOverDayCents(points)).toBe(-300);
    expect(dayOverDayCents(points.slice(0, 1))).toBeNull();
    expect(signedMoney(-300, "usd")).toBe("-$3");
    expect(newMrrMonthToDateCents([day(1, 0, 100), ...points], Date.UTC(2026, 9, 28))).toBe(1000);
    const weeks = weeklyMovements(points);
    expect(
      weeks.map((w) => [w.at.toISOString().slice(0, 10), w.newMrrCents, w.churnMrrCents]),
    ).toEqual([
      ["2026-10-19", 900, 0],
      ["2026-10-26", 0, 300],
    ]);
  });
});

describe("console MRR by month: daily snapshots rolled up", () => {
  const row = (month: number, d: number, total: number, churn: number, volBps: number | null) => ({
    snapshotDate: new Date(Date.UTC(2026, month, d)),
    totalMrrCents: total,
    newMrrCents: 0,
    expansionMrrCents: 0,
    contractionMrrCents: 0,
    churnMrrCents: churn,
    reactivationMrrCents: 0,
    newCustomersCount: 0,
    churnedCustomersCount: churn > 0 ? 1 : 0,
    voluntaryChurnRateBps: volBps,
    involuntaryChurnRateBps: volBps === null ? null : 0,
    netRevenueRetentionBps: null,
    grossRevenueRetentionBps: null,
  });

  it("sums a month's movement and measures its rates against the month's starting MRR", () => {
    const months = rollUpByMonth([
      row(8, 30, 10_000, 0, null),
      // October: 100 churned off 10,000, then 99 off 9,900, each 1% of its day.
      row(9, 1, 9_900, 100, 100),
      row(9, 2, 9_801, 99, 100),
    ]);
    expect(months).toHaveLength(2);
    expect(months[0].voluntaryChurnRateBps).toBeNull();
    const october = months[1];
    expect(october.totalMrrCents).toBe(9_801);
    expect(october.churnMrrCents).toBe(199);
    expect(october.churnedCustomersCount).toBe(2);
    expect(october.voluntaryChurnRateBps).toBe(199);
    expect(october.netRevenueRetentionBps).toBe(9_801);
  });
});
