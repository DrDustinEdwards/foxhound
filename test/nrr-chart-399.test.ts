import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import IntelligenceOverviewPage from "~/routes/app/intelligence/index";
import { accounts, mrrSnapshots } from "~/db";
import { type IntelligenceOverview } from "~/lib/intelligence/views.server";
import { getMrrSnapshotSeries, type HealthDistributionDay, type MrrSnapshotPoint } from "~/lib/intelligence/trends.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Ruling 399, session 90 job 2. NRRChart is one of the four legacy elements the
// 394 walk never saw: legacy's DEMO twin does not render it, so the walk could
// not have found it, and the row recorded absences it did not have. Legacy's
// real dashboard mounts it at app/(app)/intelligence/dashboard/page.tsx:11,
// between MRRTrendChart and MRRMovementChart. Component read whole at
// app/(app)/intelligence/dashboard/components/NRRChart.tsx:
//
//   gate     hasData = data.some(d => (d.net_revenue_retention_bps ?? 0) > 0)
//   shell    bg-surface border border-border rounded-[12px] px-6 py-5 mb-5
//   eyebrow  "Net Revenue Retention"
//   sub      "Above 100% means expansion exceeds churn (90 days)"
//   plot     recharts LineChart height={140}, one Line, stroke var(--blue),
//            strokeWidth 2, dot={false}
//   axes     YAxis tickFormatter `${v}%`, XAxis interval="preserveStartEnd",
//            both axisLine={false} tickLine={false}
//   marker   ReferenceLine y={100}, stroke var(--border-i), dasharray "3 3"
//   legend   none. It is a single-series chart.
//
// ONE DELIBERATE DIVERGENCE, 78/79 truth-over-treatment, the same one ruling 399
// ratified on the churn chart: the window is TWELVE MONTHS, not ninety days.
// Legacy's snapshot job is daily, so "(90 days)" is true there and it samples
// every 7th row to thin the axis. Foxhound's intelligence-sync is a MONTHLY cron
// (app/lib/cron/registry.ts:203), so ninety days is three points, the weekly
// sampling has nothing to thin, and legacy's sentence would be a false claim
// about our own data. The card says twelve months and means it.

// J67 (Q1, Dustin "yes", 2026-10-14) moved this chart from the hand-built SVG
// to Enarratio, so the assertions below read Enarratio's figure: its legend,
// its labelled rule, its data table. What each one guards is unchanged. The
// J67 suite (test/intelligence-dashboard-j67.test.ts) pins the page around it.

const Page = IntelligenceOverviewPage as unknown as (props: { loaderData: unknown }) => ReactElement;

const overview: IntelligenceOverview = {
  currency: "usd",
  scoredCustomerCount: 2,
  scoreDistribution: { healthy: 1, watch: 1, atRisk: 0 },
  mrrAtRiskCents: 0,
  atRiskCustomerCount: 0,
  topAtRisk: [],
  narrative: null,
  narrativeGeneratedAt: null,
};

function point(month: number, nrrPct: number | null): MrrSnapshotPoint {
  return {
    at: new Date(Date.UTC(2026, month, 1)),
    totalMrrCents: 100_000,
    activeCustomersCount: 10,
    perPlanBreakdown: {},
    currency: "usd",
    nrrPct,
    newMrrCents: 0,
    expansionMrrCents: 0,
    reactivationMrrCents: 0,
    contractionMrrCents: 0,
    churnMrrCents: 0,
  };
}


function render(mrrSeries: MrrSnapshotPoint[]): string {
  const loaderData = {
    entitled: true,
    overview,
    healthDistribution: [] as HealthDistributionDay[],
    mrrSeries,
    reports: [],
    currentMonth: "2026-10",
    nowMs: Date.UTC(2026, 9, 15),
    isDemo: false,
  };
  const Stub = createRoutesStub([
    { path: "/intelligence/dashboard", Component: () => createElement(Page, { loaderData }) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/intelligence/dashboard"] }));
}


describe("S16 NRR chart, built toward legacy (399)", () => {

  it("is withheld entirely when no snapshot carries a retention figure", () => {
    // Legacy's own gate. An account whose first sync has no prior period gets
    // no empty frame.
    expect(render([point(0, null), point(1, null)])).not.toContain("Net Revenue Retention");
    expect(render([point(0, 0), point(1, 0)])).not.toContain("Net Revenue Retention");
  });
});

describe("getMrrSnapshotSeries", () => {
  const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

  async function seed(rows: { monthsAgo: number; nrrBps: number | null }[]) {
    const { db } = createInMemoryDb();
    const now = new Date(NOW);
    await db.insert(accounts).values({ id: "acc_1", name: "Acme", currency: "usd", createdAt: now });
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
    // 10250 bps is 102.5%. Legacy coerces a null to 0 and draws it, which reads
    // as total churn on a chart whose whole subject is the 100 line.
    const db = await seed([
      { monthsAgo: 2, nrrBps: 10_250 },
      { monthsAgo: 1, nrrBps: null },
    ]);
    const points = await getMrrSnapshotSeries(db, "acc_1", NOW);
    expect(points.map((p) => p.nrrPct)).toEqual([102.5, null]);
  });

  it("windows to twelve months and returns oldest first", async () => {
    const db = await seed([
      { monthsAgo: 14, nrrBps: 9_000 },
      { monthsAgo: 3, nrrBps: 10_000 },
      { monthsAgo: 1, nrrBps: 11_000 },
    ]);
    const points = await getMrrSnapshotSeries(db, "acc_1", NOW);
    expect(points.map((p) => p.nrrPct)).toEqual([100, 110]);
  });
});
