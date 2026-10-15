import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import IntelligenceOverviewPage from "~/routes/app/intelligence/index";
import { CRON_SCHEDULE_MONTHLY } from "~/lib/constants";
import {
  firstSnapshotSentence,
  monthLabel,
  narrativeErrorMessage,
  nextScheduledRun,
  planBreakdownRows,
  shiftMonth,
} from "~/lib/intelligence/dashboard";
import type {
  HealthDistributionDay,
  IntelligenceOverview,
  MrrSnapshotPoint,
} from "~/lib/intelligence/views.server";

// J67, row S16: the Intelligence dashboard toward Recova's real page,
// app/(app)/intelligence/dashboard/page.tsx at blob cbe7e8fe, and its seven
// components (MRRStatCards 2920fa3b, MRRTrendChart c7a0da3f, NRRChart
// b07e9de3, MRRMovementChart 3c94525e, PlanBreakdown 65b5674f,
// HealthDistributionChart cd7dd675, MonthlyNarrative 791e2f5f), all read whole.
//
// Recova's order inside a 1280px column: the head ("Dashboard", "MRR trends and
// customer health"), four stat cards, MRR trend, NRR, MRR movement, MRR by
// plan, customer health distribution, then the monthly summary with its month
// pager and Generate/Regenerate button. Charts are Enarratio's (Q1), parts are
// Capsomer's (Q10), teal throughout (Q11). Foxhound's own at-risk table is held
// for Dustin and stays exactly as it was, after the summary.
//
// Two of Recova's four stats are numbers Foxhound's engine does not compute
// (RULES.md 2.1 and the job's stop rule): "Day-over-day" needs a daily
// snapshot and "New MRR (MTD)" a month-to-date one, and intelligence-sync
// snapshots once a month. Those cards say so instead of showing a number.

const Page = IntelligenceOverviewPage as unknown as (props: { loaderData: unknown }) => ReactElement;

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15

const overview: IntelligenceOverview = {
  currency: "usd",
  scoredCustomerCount: 3,
  scoreDistribution: { healthy: 1, watch: 1, atRisk: 1 },
  mrrAtRiskCents: 4_900,
  atRiskCustomerCount: 1,
  topAtRisk: [
    { stripeCustomerId: "cus_risky", customerName: "Risky Co", healthScore: 22, mrrContributionCents: 4_900 },
  ],
  narrative: null,
  narrativeGeneratedAt: null,
};

function point(month: number, over: Partial<MrrSnapshotPoint> = {}): MrrSnapshotPoint {
  return {
    at: new Date(Date.UTC(2026, month, 1, 4, 0, 0)),
    nrrPct: 101.5,
    totalMrrCents: 1_000_000 + month * 10_000,
    activeCustomersCount: 120 + month,
    newMrrCents: 30_000,
    expansionMrrCents: 12_000,
    reactivationMrrCents: 3_000,
    contractionMrrCents: 5_000,
    churnMrrCents: 9_000,
    perPlanBreakdown: { Starter: 200_000, Scale: 600_000, unknown: 50_000, Growth: 300_000 },
    currency: "usd",
    ...over,
  };
}

const series = [point(6), point(7), point(8), point(9, { totalMrrCents: 1_234_567, activeCustomersCount: 1_204 })];

const healthDistribution: HealthDistributionDay[] = [
  { date: "2026-09-01", atRisk: 2, watch: 3, healthy: 10 },
  { date: "2026-09-08", atRisk: 3, watch: 2, healthy: 11 },
  { date: "2026-10-15", atRisk: 1, watch: 4, healthy: 12 },
];

interface Opts {
  mrrSeries?: MrrSnapshotPoint[];
  reports?: { month: string; narrative: string }[];
  isDemo?: boolean;
  health?: HealthDistributionDay[];
}

function render(opts: Opts = {}): string {
  const loaderData = {
    entitled: true,
    overview,
    healthDistribution: opts.health ?? healthDistribution,
    mrrSeries: opts.mrrSeries ?? series,
    reports: opts.reports ?? [],
    currentMonth: "2026-10",
    nowMs: NOW,
    isDemo: opts.isDemo ?? false,
  };
  const Stub = createRoutesStub([
    { path: "/intelligence/dashboard", Component: () => createElement(Page, { loaderData }) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/intelligence/dashboard"] }));
}

/** What a reader sees: tags out, entities decoded, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
}

const headings = (html: string, level: 1 | 2) =>
  [...html.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, "g"))].map((m) =>
    text(m[1]!),
  );

/** The markup of the panel whose h2 reads `title`, up to the next h2. */
function panel(html: string, title: string): string {
  const all = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)];
  const i = all.findIndex((m) => text(m[1]!) === title);
  if (i < 0) throw new Error(`no panel titled ${title}`);
  const start = all[i]!.index!;
  const end = i + 1 < all.length ? all[i + 1]!.index! : html.length;
  return html.slice(start, end);
}

const SRC = readFileSync("app/routes/app/intelligence/index.tsx", "utf8");

describe("S16 /intelligence/dashboard: Recova's head, width and order", () => {
  it("heads the page 'Dashboard' with Recova's lead", () => {
    const html = render();
    expect(headings(html, 1)).toEqual(["Dashboard"]);
    expect(text(html)).toContain("MRR trends and customer health");
  });

  it("sits in Recova's 1280px column with its padding", () => {
    // Recova: max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10. The shell
    // owns the one <main>, so this is a plain wrapper.
    expect(render()).toContain('class="mx-auto max-w-[1280px] px-4 py-8 md:px-8 md:py-10"');
  });

  it("lays the sections out in Recova's order, the held table last", () => {
    expect(headings(render({ reports: [{ month: "2026-10", narrative: "Steady month." }] }), 2)).toEqual([
      "MRR",
      "Day-over-day",
      "Active customers",
      "New MRR (MTD)",
      "MRR trend (12 months)",
      "Net Revenue Retention",
      "MRR movement",
      "MRR by plan",
      "Customer health distribution",
      "Monthly summary",
    ]);
    const html = render();
    expect(html.indexOf("Monthly summary")).toBeLessThan(html.indexOf("Most at-risk customers"));
  });
});

describe("S16 stat cards: Recova's four, each from Foxhound's engine or saying it has none", () => {
  it("shows the latest snapshot's MRR and active customers as Recova formats them", () => {
    const html = render();
    expect(text(panel(html, "MRR"))).toContain("$12,346");
    expect(text(panel(html, "Active customers"))).toContain("1,204");
  });

  it("says Day-over-day and New MRR (MTD) are not computed, never a zero or another field", () => {
    const html = render();
    const dod = text(panel(html, "Day-over-day"));
    const mtd = text(panel(html, "New MRR (MTD)"));
    expect(dod).toContain("Not computed");
    expect(mtd).toContain("Not computed");
    expect(dod).toContain("monthly");
    expect(mtd).toContain("monthly");
    // Not the month-over-month delta, not the latest snapshot's new MRR, not $0.
    expect(dod).not.toMatch(/\$/);
    expect(mtd).not.toMatch(/\$/);
  });

  it("ties the 'monthly' claim to the schedule the snapshot cron really runs on", () => {
    expect(CRON_SCHEDULE_MONTHLY).toMatch(/^\d+ \d+ 1 \* \*$/);
    expect(read("app/lib/cron/registry.ts")).toContain(
      '{ name: "intelligence-sync", schedule: CRON_SCHEDULE_MONTHLY',
    );
  });
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("S16 charts: Enarratio, with Recova's legends and a text equivalent, no tooltips", () => {
  it("draws every chart with Enarratio and none with the hand-built SVG", () => {
    const html = render();
    expect(panel(html, "MRR trend (12 months)")).toContain('data-enarratio="area"');
    expect(panel(html, "Net Revenue Retention")).toContain('data-enarratio="line"');
    expect(panel(html, "MRR movement")).toContain('data-enarratio="bar"');
    expect(panel(html, "MRR by plan")).toContain('data-enarratio="bar"');
    expect(panel(html, "Customer health distribution")).toContain('data-enarratio="bar"');
    // Only the held table's Meter still comes from the old chart file.
    expect(SRC).toMatch(/import \{ Meter \} from "~\/components\/charts";/);
    expect(SRC).not.toMatch(/MultiLine|StackedBars/);
  });

  it("adds no hover tooltips", () => {
    expect(render()).not.toContain("<title>");
  });

  it("names each chart with a sentence carrying its numbers", () => {
    const html = render();
    expect(panel(html, "MRR trend (12 months)")).toMatch(/aria-label="MRR[^"]*\$10,600[^"]*\$12,346/);
    expect(panel(html, "Net Revenue Retention")).toMatch(/aria-label="Net revenue retention[^"]*101\.5%/);
    expect(panel(html, "MRR by plan")).toMatch(/aria-label="MRR by plan[^"]*Scale \$6,000/);
  });

  it("keeps Recova's legends: five movement series and three health bands, in Recova's order", () => {
    const html = render();
    const legend = (h: string) =>
      [...h.matchAll(/<li data-enarratio-series="([^"]+)"/g)].map((m) => m[1]);
    expect(legend(panel(html, "MRR movement"))).toEqual([
      "New",
      "Expansion",
      "Reactivation",
      "Contraction",
      "Churn",
    ]);
    expect(legend(panel(html, "Customer health distribution"))).toEqual([
      "High risk",
      "Medium risk",
      "Healthy",
    ]);
    // Recova draws no legend on its single-series charts.
    expect(panel(html, "Net Revenue Retention")).not.toContain("enarratio-legend");
    expect(panel(html, "MRR trend (12 months)")).not.toContain("enarratio-legend");
  });

  it("draws contraction and churn below the baseline, as Recova does", () => {
    const html = panel(render(), "MRR movement");
    expect(html).toMatch(/data-enarratio-series="Churn"[^>]*>/);
    // The value axis reaches below zero.
    expect(html).toMatch(/>−\d/);
  });

  it("marks NRR's 100% line, Recova's ReferenceLine", () => {
    // Enarratio's labelled rule at y=100, dashed as Recova's was.
    const p = panel(render(), "Net Revenue Retention");
    expect(p).toMatch(/data-enarratio-mark="rule"[^>]*stroke-dasharray/);
    expect(p).toMatch(/<text[^>]*>100%<\/text>/);
  });

  it("sorts plans by MRR, largest first, with no engine placeholder shown raw", () => {
    const rows = planBreakdownRows({ Starter: 200_000, Scale: 600_000, unknown: 50_000, Growth: 300_000, Free: 0 });
    expect(rows).toEqual([
      { plan: "Scale", mrrCents: 600_000 },
      { plan: "Growth", mrrCents: 300_000 },
      { plan: "Starter", mrrCents: 200_000 },
      { plan: "Unknown plan", mrrCents: 50_000 },
    ]);
    expect(planBreakdownRows([])).toEqual([]);
    expect(planBreakdownRows(null)).toEqual([]);
  });

  it("withholds each chart Recova withholds when it has nothing to draw", () => {
    const flat = series.map((p) => ({
      ...p,
      nrrPct: null,
      newMrrCents: 0,
      expansionMrrCents: 0,
      reactivationMrrCents: 0,
      contractionMrrCents: 0,
      churnMrrCents: 0,
      perPlanBreakdown: {},
    }));
    const html = render({ mrrSeries: flat, health: [] });
    const h2 = headings(html, 2);
    expect(h2).toContain("MRR trend (12 months)");
    expect(h2).not.toContain("Net Revenue Retention");
    expect(h2).not.toContain("MRR movement");
    expect(h2).not.toContain("MRR by plan");
    expect(h2).not.toContain("Customer health distribution");
  });

  it("has no amber anywhere on the page (Q11)", () => {
    expect(render()).not.toMatch(/amber/i);
    expect(SRC).not.toMatch(/amber/i);
  });
});

describe("S16 empty state: Recova's syncing card, with Foxhound's real schedule", () => {
  it("shows the syncing card instead of every section when there is no snapshot", () => {
    const html = render({ mrrSeries: [] });
    const t = text(html);
    expect(t).toContain("Syncing your MRR data");
    expect(t).toContain("The first snapshot runs on November 1 at 04:00 UTC. Check back after it runs.");
    expect(t).toContain("While you wait, walk through your recovery sequences or review any open disputes.");
    expect(t).not.toContain("tonight at 2:15am");
    expect(headings(html, 2)).not.toContain("Monthly summary");
  });

  it("derives the next run from the cron schedule, not a typed date", () => {
    expect(nextScheduledRun("0 4 1 * *", Date.UTC(2026, 9, 15)).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(nextScheduledRun("0 4 1 * *", Date.UTC(2026, 9, 1, 3, 59)).toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(nextScheduledRun("0 4 1 * *", Date.UTC(2026, 11, 1, 4, 1)).toISOString()).toBe("2027-01-01T04:00:00.000Z");
    expect(firstSnapshotSentence(Date.UTC(2026, 9, 15))).toBe(
      "The first snapshot runs on November 1 at 04:00 UTC. Check back after it runs.",
    );
    expect(() => nextScheduledRun("*/5 * * * *", 0)).toThrow();
  });
});

describe("S16 monthly summary: Recova's pager and Generate/Regenerate button", () => {
  it("labels the month and offers Regenerate over a stored report", () => {
    const html = render({ reports: [{ month: "2026-10", narrative: "Steady month.\nChurn eased." }] });
    const p = panel(html, "Monthly summary");
    expect(p).toContain('aria-label="Previous month"');
    expect(p).toContain('aria-label="Next month"');
    expect(text(p)).toContain("October 2026");
    expect(text(p)).toContain("Regenerate report");
    expect(text(p)).toContain("Steady month.");
    // Recova keeps the model's line breaks.
    expect(p).toContain("whitespace-pre-wrap");
  });

  it("offers Generate with Recova's empty line when the month has no report", () => {
    const p = text(panel(render(), "Monthly summary"));
    expect(p).toContain("Generate report");
    expect(p).not.toContain("Regenerate report");
    expect(p).toContain("No report yet for October 2026. Click Generate report to create one.");
  });

  it("pages months as Recova does", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-10")).toBe("October 2026");
  });

  it("speaks every failure, including a missing or unfunded AI key, never silently", () => {
    expect(narrativeErrorMessage("rate_limited")).toBe("You hit the hourly generation limit. Try again later.");
    expect(narrativeErrorMessage("invalid_month")).toBe("Invalid month.");
    expect(narrativeErrorMessage("generation_failed")).toBe("Generation failed. Please try again.");
    expect(narrativeErrorMessage("ai_not_configured")).toMatch(/AI analyst is not set up/);
    expect(narrativeErrorMessage("ai_no_credit")).toMatch(/out of credit/);
    expect(narrativeErrorMessage(undefined)).toBe("Could not generate the report. Try again or contact support.");
  });
});

describe("S16 held: the most at-risk table is exactly as it was", () => {
  it("keeps its shell, columns and Meter", () => {
    expect(SRC).toContain('className="mt-3 overflow-x-auto rounded-lg border border-border"');
    expect(SRC).toContain("Most at-risk customers");
    const html = render();
    expect(html).toContain("Risky Co");
    expect(html).toContain('aria-label="Health score 22 of 100"');
  });
});
