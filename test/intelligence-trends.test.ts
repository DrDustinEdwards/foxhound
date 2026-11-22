import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { accounts, customerContext, healthScoreHistory, mrrSnapshots } from "~/db";
import { percent } from "capsomer/behavior/meter";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { churnRateAlt } from "~/lib/intelligence/churn";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import {
  getChurnView,
  getHealthDistribution,
  type ChurnView,
} from "~/lib/intelligence/trends.server";
import IntelligenceChurn from "~/routes/app/intelligence/churn";

import { createInMemoryDb } from "./helpers/inmemory-db";

const ACCOUNT_ID = "acct_churn";
const NOW = Date.parse("2026-07-25T00:00:00.000Z");

async function setup(
  opts: {
    scored?: { score: number | null; mrrCents: number; name?: string }[];
    snapshots?: { monthsAgo: number; vol: number | null; invol: number | null }[];
  } = {},
) {
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
    const shares = view.bands.map((b) => percent(b.mrrCents, view.scoredMrrCents));
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("reports zero across the board for an account with no scored customers", async () => {
    const db = await setup({ scored: [{ score: null, mrrCents: 1000 }] });
    const view = await getChurnView(db, ACCOUNT_ID, NOW);
    expect(view.scoredCustomerCount).toBe(0);
    expect(view.topHighRisk).toEqual([]);
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

describe("churnRateAlt", () => {
  const at = (d: string) => new Date(`${d}T00:00:00Z`);

  it("names the month of each series' first and last value, skipping gaps", () => {
    expect(
      churnRateAlt([
        { at: at("2025-09-01"), involuntaryPct: 2, voluntaryPct: null },
        { at: at("2025-10-01"), involuntaryPct: 2.5, voluntaryPct: 1 },
        { at: at("2025-11-01"), involuntaryPct: 3.25, voluntaryPct: 1.5 },
        { at: at("2025-12-01"), involuntaryPct: null, voluntaryPct: 1.25 },
      ]),
    ).toBe(
      "Monthly churn rate, Sep 2025 to Dec 2025. Involuntary churn went from 2% in Sep 2025 to 3.25% in Nov 2025; voluntary churn went from 1% in Oct 2025 to 1.25% in Dec 2025.",
    );
  });

  it("says a series has no rate rather than inventing one", () => {
    expect(churnRateAlt([{ at: at("2026-01-01"), involuntaryPct: 4, voluntaryPct: null }])).toBe(
      "Monthly churn rate, Jan 2026. Involuntary churn was 4% in Jan 2026; voluntary churn has no rate yet.",
    );
  });
});

describe("the churn page", () => {
  it("leaves the rate chart out when no snapshot has a rate", () => {
    const Page = IntelligenceChurn as unknown as (props: {
      loaderData: { entitled: true; view: ChurnView };
    }) => ReactElement;
    const view: ChurnView = {
      bands: [],
      scoredMrrCents: 0,
      scoredCustomerCount: 0,
      topHighRisk: [],
      ratePoints: [{ at: new Date("2026-01-01T00:00:00Z"), voluntaryPct: 0, involuntaryPct: null }],
    };
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(Page, { loaderData: { entitled: true, view } }),
      ),
    );
    expect(html).not.toContain("Churn rate over time");
    expect(html).not.toContain("data-enarratio");
  });
});

describe("getHealthDistribution", () => {
  const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

  async function seed(scores: { score: number; daysAgo: number }[]) {
    const { db } = createInMemoryDb();
    const now = new Date(NOW);
    await db
      .insert(accounts)
      .values({ id: "acc_1", name: "Acme", currency: "usd", createdAt: now });
    await db.insert(customerContext).values({
      id: "cc_1",
      accountId: "acc_1",
      stripeCustomerId: "cus_1",
      createdAt: now,
      updatedAt: now,
    });
    let n = 0;
    for (const s of scores) {
      await db.insert(healthScoreHistory).values({
        id: "hsh_" + n++,
        accountId: "acc_1",
        customerContextId: "cc_1",
        stripeCustomerId: "cus_1",
        recordedAt: new Date(NOW - s.daysAgo * 86_400_000),
        healthScore: s.score,
        healthFactors: [],
        scoreSource: "test",
      });
    }
    return db;
  }

  it("buckets per UTC day and counts by Foxhound's bands", async () => {
    // 35 is the discriminating score: a 34-66 medium band would call it medium,
    // Foxhound's at-risk threshold of 40 calls it at risk.
    expect(HEALTH_SCORE_AT_RISK_THRESHOLD).toBe(40);
    const db = await seed([
      { score: 35, daysAgo: 1 },
      { score: 50, daysAgo: 1 },
      { score: WATCH_CEILING, daysAgo: 1 },
    ]);
    const days = await getHealthDistribution(db, "acc_1", NOW);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ atRisk: 1, watch: 1, healthy: 1 });
  });

  it("excludes history older than the 90 day window", async () => {
    const db = await seed([
      { score: 10, daysAgo: 5 },
      { score: 10, daysAgo: 120 },
    ]);
    const days = await getHealthDistribution(db, "acc_1", NOW);
    expect(days).toHaveLength(1);
    expect(days[0].atRisk).toBe(1);
  });

  it("samples every 7th day and always keeps the last", async () => {
    const db = await seed(Array.from({ length: 15 }, (_, i) => ({ score: 90, daysAgo: 14 - i })));
    const days = await getHealthDistribution(db, "acc_1", NOW);
    expect(days.map((d) => d.date)).toEqual(["2026-08-15", "2026-08-22", "2026-08-29"]);
  });
});
