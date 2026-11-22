import { describe, expect, it } from "vitest";

import { accounts, mrrSnapshots } from "~/db";
import { getMrrSnapshotSeries } from "~/lib/intelligence/trends.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

describe("getMrrSnapshotSeries", () => {
  const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

  async function seed(rows: { monthsAgo: number; nrrBps: number | null }[]) {
    const { db } = createInMemoryDb();
    const now = new Date(NOW);
    await db
      .insert(accounts)
      .values({ id: "acc_1", name: "Acme", currency: "usd", createdAt: now });
    let n = 0;
    for (const r of rows) {
      const snapshotDate = new Date(NOW);
      snapshotDate.setUTCMonth(snapshotDate.getUTCMonth() - r.monthsAgo);
      await db.insert(mrrSnapshots).values({
        id: "mrr_" + n++,
        accountId: "acc_1",
        snapshotDate,
        totalMrrCents: 100_000,
        newMrrCents: 1_000,
        expansionMrrCents: 2_000,
        contractionMrrCents: 3_000,
        churnMrrCents: 4_000,
        reactivationMrrCents: 5_000,
        activeCustomersCount: 10,
        newCustomersCount: 1,
        churnedCustomersCount: 1,
        perPlanBreakdown: [],
        perCohortBreakdown: [],
        perChannelBreakdown: [],
        netRevenueRetentionBps: r.nrrBps,
        currency: "usd",
        createdAt: now,
      });
    }
    return db;
  }

  it("converts bps to percent and keeps null as null", async () => {
    // A null must not become 0: it would read as total churn on the 100% chart.
    const db = await seed([
      { monthsAgo: 2, nrrBps: 10_250 },
      { monthsAgo: 1, nrrBps: null },
    ]);
    const points = await getMrrSnapshotSeries(db, "acc_1", NOW);
    expect(points.map((p) => p.nrrPct)).toEqual([102.5, null]);
  });

  it("drops snapshots outside the chart window and returns oldest first", async () => {
    const db = await seed([
      { monthsAgo: 4, nrrBps: 9_000 },
      { monthsAgo: 2, nrrBps: 10_000 },
      { monthsAgo: 1, nrrBps: 11_000 },
    ]);
    const points = await getMrrSnapshotSeries(db, "acc_1", NOW);
    expect(points.map((p) => p.nrrPct)).toEqual([100, 110]);
  });
});
