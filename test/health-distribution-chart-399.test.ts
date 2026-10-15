import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import IntelligenceOverviewPage from "~/routes/app/intelligence/index";
import { accounts, customerContext, healthScoreHistory } from "~/db";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import {
  getHealthDistribution,
  type HealthDistributionDay,
  type IntelligenceOverview,
  type MrrSnapshotPoint,
} from "~/lib/intelligence/views.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Ruling 399, session 90 job 1. The 2026-08-28 walk filed C4 item 3, "legacy
// has neither" a score-distribution chart nor an at-risk table, against the
// DEMO TWIN. Legacy's REAL dashboard renders the chart at
// app/(app)/intelligence/dashboard/page.tsx:12 (HealthDistributionChart with
// data={healthRows}), from
// app/(app)/intelligence/dashboard/components/HealthDistributionChart.tsx.
// So Foxhound's card is a PORT owed ALIGNMENT, not an addition owed a
// ratification, and only the at-risk TABLE stays held for Dustin.
//
// Legacy's chart, read whole at that component:
//   shell    bg-surface border border-border rounded-[12px] px-6 py-5 mb-5
//   eyebrow  "Customer health distribution"
//   sub      "Customer count per health band over 90 days"
//   data     health_score_history over 90 days, bucketed per UTC day, then
//            sampled every 7th day so the axis stays readable
//   plot     recharts BarChart height={200}, three Bar marks on stackId "a"
//   series   High risk var(--red), Medium risk var(--caution), Healthy var(--green)
//   axes     XAxis interval="preserveStartEnd", YAxis, both axisLine={false}
//            tickLine={false}, plus a Legend
//
// THE PRE-FIX CARD WAS A DIFFERENT CHART, which is why this is alignment rather
// than restyling: it plotted ONE bar per band for tonight's counts. Legacy plots
// a stacked TIME SERIES. A three-bar snapshot cannot answer the question legacy's
// chart is on the page to answer.
//
// TWO THINGS ARE DELIBERATELY NOT LEGACY'S:
//   * the BANDS are Foxhound's healthScoreBand, not legacy's hardcoded
//     0-33/34-66/67-100. 78/79 truth-over-treatment, and the same split ruling
//     399 already accepted on the S19 churn bands. Asserted below, because it is
//     the one divergence a reader is most likely to "correct" back.
//   * the top bar carries no 2px corner radius. See StackedBars' own note: an rx
//     inside a non-uniformly stretched box smears with the card width.
//
// The 90-day window IS legacy's and is true here: intelligence-ai is a DAILY
// cron, so ninety days means ninety rows. That is the opposite of the churn
// chart, whose monthly cron forced 12 months under the same rule.

// J67 (Q1, Dustin "yes", 2026-10-14) moved this chart from the hand-built SVG
// to Enarratio, so the assertions below read Enarratio's figure: its legend,
// its labelled rule, its data table. What each one guards is unchanged. The
// J67 suite (test/intelligence-dashboard-j67.test.ts) pins the page around it.

const Page = IntelligenceOverviewPage as unknown as (props: { loaderData: unknown }) => ReactElement;

// The page shows its sections once there is an MRR snapshot (legacy's gate),
// so one flat snapshot carries this render; it draws no movement, NRR or plan
// chart of its own.
const SNAPSHOT: MrrSnapshotPoint = {
  at: new Date(Date.UTC(2026, 5, 1)),
  nrrPct: null,
  totalMrrCents: 100_000,
  activeCustomersCount: 10,
  newMrrCents: 0,
  expansionMrrCents: 0,
  reactivationMrrCents: 0,
  contractionMrrCents: 0,
  churnMrrCents: 0,
  perPlanBreakdown: {},
  currency: "usd",
};

const overview: IntelligenceOverview = {
  currency: "usd",
  scoredCustomerCount: 3,
  scoreDistribution: { healthy: 1, watch: 1, atRisk: 1 },
  mrrAtRiskCents: 4200,
  atRiskCustomerCount: 1,
  topAtRisk: [],
  narrative: null,
  narrativeGeneratedAt: null,
};

const healthDistribution: HealthDistributionDay[] = [
  { date: "2026-06-01", atRisk: 2, watch: 3, healthy: 9 },
  { date: "2026-06-08", atRisk: 3, watch: 4, healthy: 7 },
  { date: "2026-06-15", atRisk: 5, watch: 2, healthy: 7 },
  { date: "2026-06-22", atRisk: 4, watch: 4, healthy: 6 },
  { date: "2026-06-29", atRisk: 6, watch: 3, healthy: 5 },
];

function render(days: HealthDistributionDay[] = healthDistribution): string {
  const loaderData = {
    entitled: true,
    overview,
    healthDistribution: days,
    mrrSeries: [SNAPSHOT],
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

function card(html: string): string {
  const start = html.indexOf("Customer health distribution");
  return html.slice(start, html.indexOf("</section>", start));
}

describe("S16 health distribution chart, ported toward legacy (399)", () => {
  it("renders legacy's card copy", () => {
    const html = render();
    expect(html).toContain("Customer health distribution");
    expect(html).toContain("Customer count per health band over 90 days");
  });

  it("carries legacy's three band series names as a legend", () => {
    const legend = [...card(render()).matchAll(/<li data-enarratio-series="([^"]+)"/g)].map((m) => m[1]);
    expect(legend).toEqual(["High risk", "Medium risk", "Healthy"]);
  });

  it("plots a stack per sampled day, not one bar per band", () => {
    // Three series over five days, every value non-zero: fifteen bars. The
    // pre-fix card drew three bars total, so this count is what discriminates
    // the two charts.
    const rects = card(render()).match(/<rect/g) ?? [];
    expect(rects.length).toBe(15);
  });

  it("labels the x axis with dates and no year", () => {
    const html = card(render());
    expect(html).toContain("Jun 1");
    expect(html).toContain("Jun 29");
    expect(html).not.toContain("Jun 1, 2026");
  });

  it("draws at a real size, never a stretched box (384c0db's lesson)", () => {
    // The hand-built chart stretched a 100x100 viewBox with
    // preserveAspectRatio="none", which smeared any text inside it. Enarratio
    // draws at the panel's measured width with a viewBox of the same size.
    const c = card(render());
    expect(c).not.toContain('preserveAspectRatio="none"');
    expect(c).toMatch(/<svg[^>]*width="([0-9]+)"[^>]*viewBox="0 0 \1 /);
  });

  it("renders nothing when there is no history rather than an empty frame", () => {
    const html = render([]);
    expect(html).not.toContain("Customer health distribution");
  });
});

describe("getHealthDistribution", () => {
  const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

  async function seed(scores: { score: number; daysAgo: number }[], nowMs: number) {
    const { db } = createInMemoryDb();
    const now = new Date(nowMs);
    await db.insert(accounts).values({
      id: "acc_1",
      name: "Acme",
      currency: "usd",
      createdAt: now,
    });
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
        recordedAt: new Date(nowMs - s.daysAgo * 86_400_000),
        healthScore: s.score,
        healthFactors: [],
        scoreSource: "test",
      });
    }
    return db;
  }

  it("buckets per UTC day and counts by Foxhound's bands, not legacy's cutoffs", async () => {
    // 35 is the discriminating score: legacy's hardcoded split calls it MEDIUM
    // (34-66), Foxhound's threshold of 40 calls it AT RISK. Getting this wrong
    // puts a customer in a band the rest of the app does not put them in.
    expect(HEALTH_SCORE_AT_RISK_THRESHOLD).toBe(40);
    const db = await seed(
      [
        { score: 35, daysAgo: 1 },
        { score: 50, daysAgo: 1 },
        { score: WATCH_CEILING, daysAgo: 1 },
      ],
      NOW,
    );
    const days = await getHealthDistribution(db, "acc_1", NOW);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ atRisk: 1, watch: 1, healthy: 1 });
  });

  it("excludes history older than the 90 day window", async () => {
    const db = await seed(
      [
        { score: 10, daysAgo: 5 },
        { score: 10, daysAgo: 120 },
      ],
      NOW,
    );
    const days = await getHealthDistribution(db, "acc_1", NOW);
    expect(days).toHaveLength(1);
    expect(days[0].atRisk).toBe(1);
  });

  it("samples every 7th day and always keeps the last", async () => {
    // 15 consecutive days, indexes 0, 7 and 14. The last is index 14, which the
    // stride already lands on, so it must not be duplicated.
    const db = await seed(
      Array.from({ length: 15 }, (_, i) => ({ score: 90, daysAgo: 14 - i })),
      NOW,
    );
    const days = await getHealthDistribution(db, "acc_1", NOW);
    expect(days.map((d) => d.date)).toEqual(["2026-08-15", "2026-08-22", "2026-08-29"]);
  });
});
