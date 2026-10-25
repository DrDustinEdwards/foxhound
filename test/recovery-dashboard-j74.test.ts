import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import {
  atRiskPctOfMrr,
  dailyRecoveredRows,
  declineRows,
  declineRowText,
  emailCategoryRows,
  formatShortDate,
  onboardingNeeded,
  recoveryRateAlt,
  recoveryTimingAlt,
  roiColumn,
  withoutHoverTitles,
} from "~/lib/dashboard/recovery-dashboard";
import type { RecoveryDashboardWindow } from "~/lib/dashboard/recovery-window.server";
import RecoveryDashboard from "~/routes/app/recovery/index";

// J74 (job_a0ac216a43ae), row S5: /recovery/dashboard is Recova's page
// (app/(app)/recovery/dashboard/page.tsx at blob 208b0066 and its components,
// each read whole at the blob the job names) built from Capsomer 0.9.0's parts
// with its charts drawn by Enarratio 0.3.1, amber throughout. Recova stays the
// spec for every section, label and their order; the numbers are Foxhound's
// engine. Every assertion here was seen failing before the rebuild (red output
// in the PR).

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function day(offset: number): string {
  return new Date(NOW - offset * DAY).toISOString().slice(0, 10);
}

function makeWindow(over: Partial<RecoveryDashboardWindow> = {}): RecoveryDashboardWindow {
  const rateDaily = Array.from({ length: 30 }, (_, i) => ({
    date: day(29 - i),
    rate: i < 3 ? null : 20 + i,
  }));
  return {
    rangeLabel: "30d",
    rangeDays: 30,
    totalFailedCount: 12,
    recoveredCount: 5,
    recoveryRatePct: 42,
    recoveredRevenue: [{ currency: "usd", cents: 125_000 }],
    recoveryDaysCount: 5,
    avgDaysToRecovery: 2.4,
    recoveryTimingBuckets: [
      { dayBucket: "Day 1", count: 2, percentage: 40 },
      { dayBucket: "Day 3", count: 1, percentage: 20 },
      { dayBucket: "Day 7", count: 1, percentage: 20 },
      { dayBucket: "Day 8+", count: 1, percentage: 20 },
    ],
    activePaymentsCount: 4,
    atRiskRevenue: [{ currency: "usd", cents: 50_000 }],
    activeWinbacksCount: 2,
    expiringCardsCount: 1,
    connection: {
      name: "Sample Bakery",
      stripeUserId: "acct_sample",
      connectedAt: new Date(NOW - 40 * DAY),
      lastWebhookAt: new Date(NOW - 60_000),
      mrrEstimateCents: 400_000,
    },
    webhookHealth: { tone: "success", label: "Receiving webhooks" },
    lastRecoveryAgo: "Today",
    upcomingSteps: [
      {
        id: "step_a",
        stepType: "email_day3",
        scheduledAt: new Date(NOW + 5 * 60 * 60 * 1000),
        customerName: "Ada Sample",
        customerEmail: "ada@example.com",
        amountCents: 4_900,
        currency: "usd",
      },
    ],
    categoryBreakdown: { soft: 6, expired: 4, fraud: 2 },
    categoryStats: {
      soft: { total: 6, recovered: 3 },
      expired: { total: 4, recovered: 2 },
      fraud: { total: 2, recovered: 0 },
    },
    bestCategory: { cat: "soft", rate: 50 },
    categorySparkline: {
      soft: Array.from({ length: 30 }, (_, i) => ({ date: day(29 - i), count: i % 5 === 0 ? 1 : 0 })),
    },
    recoveryRateDaily: rateDaily,
    emailCategoryPerformance: [
      { category: "soft", openRatePct: 55, clickRatePct: 12, emailCount: 20 },
      { category: "expired", openRatePct: 40, clickRatePct: 8, emailCount: 10 },
    ],
    totalEmailsSent: 30,
    emailsSentInRange: { sent: 30, openRatePct: 50, clickRatePct: 11 },
    openRatePct: 50,
    clickRatePct: 11,
    reactivatedCount: 0,
    reactivatedRevenue: [],
    recentPayments: [
      {
        id: "fp_a",
        stripeCustomerId: "cus_a",
        customerEmail: "ada@example.com",
        customerName: "Ada Sample",
        amountCents: 4_900,
        currency: "usd",
        declineCode: "insufficient_funds",
        declineCategory: "soft",
        planName: "Growth monthly",
        status: "active",
        detectedAt: new Date(NOW - 2 * DAY),
      } as RecoveryDashboardWindow["recentPayments"][number],
    ],
    previousFailureCounts: { cus_a: 2 },
    recoveredPayments: [
      { recoveredAt: new Date(NOW - 1 * DAY), amountCents: 100_000, currency: "usd" },
      { recoveredAt: new Date(NOW - 3 * DAY), amountCents: 25_000, currency: "usd" },
    ],
    ...over,
  };
}

interface LoaderData {
  data: RecoveryDashboardWindow;
  data30d: RecoveryDashboardWindow;
  roi: ReturnType<typeof makeRoi> | null;
  onboarding: { needed: boolean; connected: boolean; senderNameSet: boolean; alertAddressSet: boolean };
  watchingForFailures: boolean;
  range: "7d" | "30d" | "90d" | "all";
  nowMs: number;
  queueHours: number;
  paymentSteps: Record<string, { completed: number; total: number; next: string | null }>;
  deliverability: { sent: number; bounced: number; complaints: number };
}

function makeRoi() {
  return {
    thisMonth: roiColumn([{ amountCents: 10_000, currency: "usd" }]),
    allTime: roiColumn([
      { amountCents: 10_000, currency: "usd" },
      { amountCents: 40_000, currency: "usd" },
    ]),
  };
}

function makeLoaderData(over: Partial<LoaderData> = {}): LoaderData {
  const w = makeWindow();
  return {
    data: w,
    data30d: w,
    roi: makeRoi(),
    onboarding: { needed: false, connected: true, senderNameSet: true, alertAddressSet: true },
    watchingForFailures: false,
    range: "30d",
    nowMs: NOW,
    queueHours: 48,
    paymentSteps: { fp_a: { completed: 1, total: 3, next: "Email (day 3)" } },
    deliverability: { sent: 0, bounced: 0, complaints: 0 },
    ...over,
  };
}

const Page = RecoveryDashboard as unknown as (props: { loaderData: LoaderData }) => ReactElement;

// A render that throws is reported as its message, so every assertion below
// fails on what the page shows rather than on an exception.
function render(data: LoaderData = makeLoaderData()): string {
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page, { loaderData: data })));
  } catch (err) {
    return `render failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}


function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}


describe("J74: the ROI widget is Recova's layout on Foxhound's billable figures", () => {

  it("never claims fees were paid, and never names Recova", () => {
    const html = render();
    expect(textOf(html)).toContain("Foxhound-attributed revenue");
    const text = textOf(html);
    expect(text).not.toContain("fees paid");
    expect(text).not.toContain("Recova");
  });
});

describe("J74: display arithmetic", () => {
  it("at-risk share of MRR, one decimal, single currency only", () => {
    expect(atRiskPctOfMrr([{ currency: "usd", cents: 50_000 }], 400_000)).toBe(12.5);
    expect(atRiskPctOfMrr([{ currency: "usd", cents: 50_000 }], null)).toBeNull();
    expect(
      atRiskPctOfMrr(
        [
          { currency: "usd", cents: 1 },
          { currency: "eur", cents: 1 },
        ],
        400_000,
      ),
    ).toBeNull();
  });

  it("ROI fees per recovery, summed per currency", () => {
    const col = roiColumn([
      { amountCents: 1_001, currency: "usd" },
      { amountCents: 1_001, currency: "usd" },
      { amountCents: 500, currency: "eur" },
    ]);
    expect(col.recovered).toEqual([
      { currency: "usd", cents: 2_002 },
      { currency: "eur", cents: 500 },
    ]);
    expect(col.fee).toEqual([
      { currency: "usd", cents: 400 },
      { currency: "eur", cents: 100 },
    ]);
    expect(col.kept[0]).toEqual({ currency: "usd", cents: 1_602 });
  });

  it("daily recovered rows are zero-filled and never mix currencies", () => {
    const { rows, currencies } = dailyRecoveredRows(
      [
        { recoveredAt: new Date(NOW), amountCents: 1_000, currency: "usd" },
        { recoveredAt: new Date(NOW), amountCents: 2_000, currency: "eur" },
      ],
      7,
      NOW,
    );
    expect(currencies).toEqual(["USD", "EUR"]);
    expect(rows).toHaveLength(14);
    expect(rows.at(-2)).toEqual({ Day: day(0), currency: "USD", amount: 10 });
    expect(rows.at(-1)).toEqual({ Day: day(0), currency: "EUR", amount: 20 });
  });

  it("email rows cover every engine category, zero where nothing was sent", () => {
    const { rows, totalSent } = emailCategoryRows([{ category: "soft", openRatePct: 50, clickRatePct: 10, emailCount: 4 }]);
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.Category === "Expired card" && r.series === "Open rate")?.rate).toBe(0);
    expect(totalSent).toBe(4);
  });

  it("decline rows: a rate only from two failures, Recova's text", () => {
    const rows = declineRows({
      totalFailedCount: 3,
      categoryBreakdown: { soft: 2, fraud: 1 },
      categoryStats: { soft: { total: 2, recovered: 1 }, fraud: { total: 1, recovered: 1 } },
      categorySparkline: {},
    });
    expect(declineRowText(rows.find((r) => r.category === "soft")!)).toBe("2 · 67% · 50% recovered");
    expect(declineRowText(rows.find((r) => r.category === "fraud")!)).toBe("1 · 33%");
  });

  it("alt sentences carry the numbers", () => {
    expect(recoveryRateAlt([{ date: "2026-10-01", rate: null }, { date: "2026-10-02", rate: 20 }, { date: "2026-10-03", rate: 30 }], "30d")).toBe(
      "Running recovery rate, 30d: 20% on Oct 2 and 30% on Oct 3.",
    );
    expect(
      recoveryTimingAlt([
        { dayBucket: "Day 1", count: 1, percentage: 50 },
        { dayBucket: "Day 3", count: 1, percentage: 50 },
      ]),
    ).toContain("Day 1 50% (1)");
    expect(formatShortDate("2026-10-03")).toBe("Oct 3");
  });

  it("onboarding: Recova's gate", () => {
    expect(onboardingNeeded({ connected: false, senderName: null, notificationEmail: null, onboardingCompleted: false })).toBe(true);
    expect(onboardingNeeded({ connected: true, senderName: "A", notificationEmail: "a@example.com", onboardingCompleted: false })).toBe(false);
    expect(onboardingNeeded({ connected: false, senderName: null, notificationEmail: null, onboardingCompleted: true })).toBe(false);
  });

  it("strips hover titles and keeps the accessible name", () => {
    expect(withoutHoverTitles('<svg aria-label="x"><rect><title>x a: 1</title></rect></svg>')).toBe(
      '<svg aria-label="x"><rect></rect></svg>',
    );
  });
});
