import { describe, expect, it } from "vitest";

import { accounts, customerContext, mrrSnapshots } from "~/db";
import { churnBandSharePct } from "~/lib/intelligence/churn";
import { getChurnView } from "~/lib/intelligence/trends.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

const ACCOUNT_ID = "acct_churn";
const NOW = Date.parse("2026-07-25T00:00:00.000Z");

async function setup(opts: { scored?: { score: number | null; mrrCents: number; name?: string }[]; snapshots?: { monthsAgo: number; vol: number | null; invol: number | null }[] } = {}) {
  const { db } = createInMemoryDb();
  const now = new Date(NOW);
  await db.insert(accounts).values({ id: ACCOUNT_ID, name: "Churn Co", createdAt: now });

  const rows = opts.scored ?? [];
  if (rows.length > 0) {
    await db.insert(customerContext).values(
      rows.map((r, i) => ({
        id: `cc_${i}`,
        accountId: ACCOUNT_ID,
        stripeCustomerId: `cus_${i}`,
        customerName: r.name ?? `Customer ${i}`,
        healthScore: r.score,
        mrrContributionCents: r.mrrCents,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  for (const [i, s] of (opts.snapshots ?? []).entries()) {
    const at = new Date(NOW);
    at.setUTCMonth(at.getUTCMonth() - s.monthsAgo);
    await db.insert(mrrSnapshots).values({
      id: `snap_${i}`,
      accountId: ACCOUNT_ID,
      snapshotDate: at,
      totalMrrCents: 100_000,
      newMrrCents: 0,
      expansionMrrCents: 0,
      contractionMrrCents: 0,
      churnMrrCents: 0,
      reactivationMrrCents: 0,
      activeCustomersCount: 1,
      newCustomersCount: 0,
      churnedCustomersCount: 0,
      perPlanBreakdown: {},
      perCohortBreakdown: {},
      perChannelBreakdown: {},
      voluntaryChurnRateBps: s.vol,
      involuntaryChurnRateBps: s.invol,
      currency: "usd",
      createdAt: now,
    });
  }
  return db;
}

describe("getChurnView bands", () => {

  // Legacy's numerators counted only scored customers but its denominator
  // counted every customer, so the three shares silently failed to sum to 100%
  // with nothing on screen explaining the shortfall.
  it("excludes unscored customers from the share denominator", async () => {
    const db = await setup({
      scored: [
        { score: 20, mrrCents: 5000 },
        { score: 90, mrrCents: 5000 },
        { score: null, mrrCents: 90_000 }, // unscored, huge MRR
      ],
    });
    const view = await getChurnView(db, ACCOUNT_ID, NOW);
    expect(view.scoredMrrCents).toBe(10_000);
    expect(view.scoredCustomerCount).toBe(2);
    const shares = view.bands.map((b) => churnBandSharePct(b.mrrCents, view.scoredMrrCents));
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("reports zero across the board for an account with no scored customers", async () => {
    const db = await setup({ scored: [{ score: null, mrrCents: 1000 }] });
    const view = await getChurnView(db, ACCOUNT_ID, NOW);
    expect(view.scoredCustomerCount).toBe(0);
    expect(view.topHighRisk).toEqual([]);
    expect(churnBandSharePct(0, 0)).toBe(0);
  });
});

describe("getChurnView rate series", () => {
  it("converts basis points to percent", async () => {
    const db = await setup({
      snapshots: [
        { monthsAgo: 2, vol: 150, invol: 320 },
        { monthsAgo: 1, vol: 100, invol: 250 },
      ],
    });
    const view = await getChurnView(db, ACCOUNT_ID, NOW);
    expect(view.ratePoints.map((p) => p.voluntaryPct)).toEqual([1.5, 1]);
    expect(view.ratePoints.map((p) => p.involuntaryPct)).toEqual([3.2, 2.5]);
  });

  // A first-ever sync has no prior state to diff against, so the rate is null.
  // Coercing that to 0 would draw a line claiming zero churn.
  it("preserves a null rate rather than coercing it to zero", async () => {
    const db = await setup({ snapshots: [{ monthsAgo: 1, vol: null, invol: null }] });
    const view = await getChurnView(db, ACCOUNT_ID, NOW);
    expect(view.ratePoints[0].voluntaryPct).toBeNull();
    expect(view.ratePoints[0].involuntaryPct).toBeNull();
  });

  it("orders oldest first and excludes snapshots outside the window", async () => {
    const db = await setup({
      snapshots: [
        { monthsAgo: 4, vol: 900, invol: 900 }, // outside the 90-day window
        { monthsAgo: 2, vol: 300, invol: 300 },
        { monthsAgo: 1, vol: 100, invol: 100 },
      ],
    });
    const view = await getChurnView(db, ACCOUNT_ID, NOW);
    expect(view.ratePoints).toHaveLength(2);
    expect(view.ratePoints[0].at.getTime()).toBeLessThan(view.ratePoints[1].at.getTime());
    expect(view.ratePoints.map((p) => p.voluntaryPct)).toEqual([3, 1]);
  });
});
