import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { RECOVERY_FEE_BPS, RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import {
  atRiskPctOfMrr,
  dailyRecoveredRows,
  deliverabilityFigures,
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
// with its charts drawn by Enarratio 0.3.1, teal throughout. Recova stays the
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

function headings(html: string): string[] {
  return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) =>
    m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  );
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

const SOURCE = readFileSync(new URL("../app/routes/app/recovery/index.tsx", import.meta.url), "utf8");

describe("J74: the page head is Recova's PageHeader", () => {
  it("is titled Dashboard, with the connection line under it", () => {
    const html = render();
    expect(html).toMatch(/<h1 class="cap-page-head-title">Dashboard<\/h1>/);
    expect(textOf(html)).toContain("Connected · Sample Bakery");
  });

  it("carries the range selector as links, the current one marked", () => {
    const html = render();
    for (const r of ["7d", "30d", "90d", "all"]) expect(html).toContain(`href="/recovery/dashboard?range=${r}"`);
    expect(html).toMatch(/aria-current="page"[^>]*>30d<|>30d<\/a>/);
  });

  it("shows the webhook health and the last recovery", () => {
    const text = textOf(render());
    expect(text).toContain("Receiving webhooks");
    expect(text).toContain("Last recovery Today");
  });
});

describe("J74: sections in Recova's order", () => {
  it("is head, primary stats, ROI, charts, decline analysis, timing and win-back, queue, secondary stats, payments", () => {
    const h = headings(render());
    const order = [
      "Dashboard",
      "Recovered (30d)",
      "Currently at risk",
      "Recovery rate",
      "Foxhound-attributed revenue",
      "Recovery rate · 30d",
      "Recovered revenue · 30d",
      "Email performance",
      "Decline breakdown",
      "Email performance by decline type",
      "When recoveries happen",
      "Win-back attribution · 30d",
      "Recovery queue · next 48h",
      "Active sequences",
      "Win-backs active",
      "Cards expiring",
      "Avg days to recovery",
      "Best category",
      "Emails sent",
      "Failed payments",
    ];
    let at = -1;
    for (const title of order) {
      const i = h.indexOf(title);
      expect(i, `${title} in ${JSON.stringify(h)}`).toBeGreaterThan(at);
      at = i;
    }
  });

  it("drops the three link cards Recova never had", () => {
    const html = render();
    expect(html).toContain('class="cap-page-head"');
    const text = textOf(html);
    expect(text).not.toContain("Recovery sequences in progress.");
    expect(text).not.toContain("Cards expiring soon, before they fail.");
  });
});

describe("J74: stat cards say what Recova's say", () => {
  it("at risk reads N% of MRR and nothing Recova did not show", () => {
    const text = textOf(render());
    expect(text).toContain("12.5% of MRR");
    expect(text).not.toContain("in recovery");
  });

  it("recovery rate's subtext is the band alone", () => {
    const text = textOf(render());
    expect(text).toContain("Above target");
    expect(text).not.toContain("5 of 12");
  });

  it("best category shows Foxhound's label, never the raw value, and Recova's subtext", () => {
    const text = textOf(render());
    expect(text).toContain("Soft decline");
    expect(text).toContain("50% recovery");
  });
});

describe("J74: the ROI widget is Recova's layout on Foxhound's billable figures", () => {
  it("has Recova's two columns and rows, the fee read from the pricing constant", () => {
    const text = textOf(render());
    expect(text).toContain("This month");
    expect(text).toContain("All time");
    expect(text).toContain(`Foxhound fee (${RECOVERY_FEE_BPS / 100}%`);
    expect(text).toContain("You keep $80.00");
    expect(text).toContain("Total recovered $500.00");
    expect(text).toContain("Net to you $400.00");
  });

  it("never claims fees were paid, and never names Recova", () => {
    const html = render();
    expect(textOf(html)).toContain("Foxhound-attributed revenue");
    const text = textOf(html);
    expect(text).not.toContain("fees paid");
    expect(text).not.toContain("Recova");
  });
});

describe("J74: charts are Enarratio's, with legends, ticks and a text equivalent, and no tooltips", () => {
  it("draws four Enarratio figures and six sparklines' worth of slots", () => {
    const html = render();
    expect((html.match(/<figure class="enarratio"/g) ?? []).length).toBe(4);
    expect(html).toContain('data-enarratio="area"');
    expect((html.match(/data-enarratio="bar"/g) ?? []).length).toBe(3);
    expect(html).toContain('data-enarratio="sparkline"');
  });

  it("gives every figure a data table and an accessible name", () => {
    const html = render();
    const figures = html.match(/<figure class="enarratio"[\s\S]*?<\/figure>/g) ?? [];
    expect(figures).toHaveLength(4);
    for (const f of figures) {
      expect(f).toMatch(/role="img" aria-label="[^"]{12,}"/);
      expect(f).toContain("Data table");
    }
  });

  it("keeps Recova's axis ticks and the email chart's legend", () => {
    const html = render();
    expect((html.match(/data-enarratio-mark="y-axis tick label"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('data-enarratio-mark="x-axis tick label"');
    const email = html.slice(html.indexOf("Email performance by decline type"));
    expect(email).toMatch(/enarratio-legend[\s\S]*Open rate[\s\S]*Click rate/);
  });

  it("adds no hover tooltip anywhere", () => {
    const html = render();
    expect(html).toContain('<figure class="enarratio"');
    expect(html).not.toContain("<title>");
  });

  it("no longer draws anything with the hand-built charts", () => {
    expect(SOURCE).not.toContain("~/components/charts");
  });
});

describe("J74: decline breakdown and email chart cover the engine's categories", () => {
  it("lists every decline category with Recova's count text", () => {
    const text = textOf(render());
    expect(text).toContain("6 · 50% · 50% recovered");
    expect(text).toContain("Revoked authorization");
    expect(text).toContain("Unclassified decline");
  });
});

describe("J74: win-back, queue and payments", () => {
  it("states the win-back attribution Foxhound actually makes", () => {
    const text = textOf(render());
    expect(text).toContain("No reactivations yet");
    expect(text).not.toContain("7 days");
    expect(text).not.toContain("90 days");
  });

  it("titles the queue with the read model's own window and shows step and amount", () => {
    const text = textOf(render());
    expect(text).toContain("Recovery queue · next 48h");
    expect(text).toContain("Email (day 3) · $49.00");
    expect(text).toContain("in 5h");
  });

  it("an empty queue is Recova's plain line, no panel", () => {
    const html = render(makeLoaderData({ data: makeWindow({ upcomingSteps: [] }) }));
    expect(textOf(html)).toContain("Nothing in the queue. All your recent payments came through clean.");
    expect(headings(html)).not.toContain("Recovery queue · next 48h");
  });

  it("has Recova's failed-payments table: columns, repeat failure, steps and next step", () => {
    const html = render();
    const text = textOf(html);
    for (const col of ["Customer", "Amount", "Decline", "Steps", "Status", "Detected"]) {
      expect(html).toMatch(new RegExp(`<th[^>]*>${col}</th>`));
    }
    expect(text).toContain("12 total · 4 active");
    expect(text).toContain("2x failure");
    expect(text).toContain("1/3");
    expect(text).toContain("Next: Email (day 3)");
    expect(text).toContain("View all payments");
  });
});

describe("J74: banners", () => {
  it("shows Recova's getting-started checklist until onboarding is done", () => {
    const html = render(
      makeLoaderData({
        data: makeWindow({ connection: null, webhookHealth: null }),
        roi: null,
        onboarding: { needed: true, connected: false, senderNameSet: false, alertAddressSet: false },
      }),
    );
    const text = textOf(html);
    expect(text).toContain("Getting started");
    expect(text).toContain("Connect Stripe");
    expect(text).toContain("Set your sender name");
    expect(text).toContain("Set your notification email");
    expect(text).toContain("You're ready");
    expect(html).toContain('href="/connect"');
    expect(text).toContain("No Stripe account connected");
  });

  it("shows the watching banner once onboarding is done and nothing has failed", () => {
    const text = textOf(render(makeLoaderData({ watchingForFailures: true })));
    expect(text).toContain("We're watching for failed payments.");
  });
});

describe("J74: look", () => {
  it("carries no amber and no arbitrary text size", () => {
    expect(SOURCE).not.toMatch(/amber/i);
    expect(SOURCE).not.toMatch(/text-\[/);
  });

  it("renders no <main> of its own", () => {
    const html = render();
    expect(html).toContain('class="cap-page-head"');
    expect(html).not.toMatch(/<main[\s>]/);
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

// ---- J74 review (PR #109, CHANGES at be5bbf7) ----

describe("J74 review: ROI This month shows this month's attributed recoveries", () => {
  it("labels this month's fee as billed after the maturity, from the engine's constants", () => {
    const text = textOf(render());
    expect(text).toContain(`Foxhound fee (${RECOVERY_FEE_BPS / 100}%, billed after ${RECOVERY_MATURITY_DAYS} days) $20.00`);
    expect(text).toContain("You keep $80.00");
    expect(text).toContain(
      `This month counts every attributed recovery since the 1st; all time counts those that have held for ${RECOVERY_MATURITY_DAYS} days, which are the ones Foxhound bills.`,
    );
  });

  it("reads this month with no maturity filter, and all time from the billable read", () => {
    expect(SOURCE).toContain("listAttributedRecoveredSince(db, accountId, firstOfMonthUtc)");
    expect(SOURCE).toContain("listBillableRecoveredForRoi(db, accountId, nowMs, null)");
    expect(SOURCE).not.toContain("listBillableRecoveredForRoi(db, accountId, nowMs, firstOfMonthUtc)");
  });
});

describe("J74 review: the Emails sent card reads the same 30 days as the other cards", () => {
  it("shows the window's sends and rates, and the side panel the range's, labelled as Recova's was", () => {
    const w30 = makeWindow({ emailsSentInRange: { sent: 7, openRatePct: 43, clickRatePct: 14 } });
    const w7 = makeWindow({ rangeLabel: "7d", emailsSentInRange: { sent: 3, openRatePct: 67, clickRatePct: 33 } });
    const text = textOf(render(makeLoaderData({ data: w7, data30d: w30, range: "7d" })));
    expect(text).toMatch(/Emails sent 7 43% open · 14% click/);
    expect(text).toContain("Emails sent (7d) 3");
    expect(text).toContain("Emails sent (7d) 3 Open rate 67% Click rate 33%");
    expect(text).not.toContain("(all time)");
  });
});

describe("J74 review: Recova's deliverability panel, on what Foxhound records", () => {
  it("sits after the secondary stats and before the payments table, with a truthful empty state", () => {
    const html = render(makeLoaderData({ deliverability: { sent: 12, bounced: 0, complaints: 0 } }));
    const h = headings(html);
    const at = h.indexOf("Email deliverability · 30d");
    expect(at, JSON.stringify(h)).toBeGreaterThan(h.indexOf("Emails sent"));
    expect(at).toBeLessThan(h.indexOf("Failed payments"));
    const text = textOf(html);
    expect(text).toContain(
      "No bounces or spam reports to show. Foxhound does not yet record them against the account that sent the email.",
    );
    expect(text).not.toContain("appear here when");
    expect(text).not.toContain("Resend");
    expect(text).not.toMatch(/delivered/i);
  });

  it("shows bounce and spam rates over the range's sends, and never a delivered rate", () => {
    const text = textOf(render(makeLoaderData({ deliverability: { sent: 200, bounced: 4, complaints: 2 } })));
    expect(text).toContain("2% bounced");
    expect(text).toContain("1% spam");
    expect(text).toContain("200 sent");
    expect(text).not.toMatch(/delivered/i);
  });

  it("figures: none until an event arrives, and no rate without a send", () => {
    expect(deliverabilityFigures({ sent: 50, bounced: 0, complaints: 0 })).toBeNull();
    expect(deliverabilityFigures({ sent: 200, bounced: 4, complaints: 2 })).toEqual({
      sent: 200,
      bounced: 4,
      complaints: 2,
      bounceRatePct: 2,
      spamRatePct: 1,
    });
    expect(deliverabilityFigures({ sent: 0, bounced: 1, complaints: 0 })).toEqual({
      sent: 0,
      bounced: 1,
      complaints: 0,
      bounceRatePct: null,
      spamRatePct: null,
    });
  });
});
