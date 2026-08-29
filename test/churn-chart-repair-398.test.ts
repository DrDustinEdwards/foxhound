import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import IntelligenceChurn from "~/routes/app/intelligence/churn";

import type { ChurnView } from "~/lib/intelligence/views.server";

// Ruling 398, session 89b job 1. The 2026-08-28 walk called this chart a
// Foxhound ADDITION under corollary 112 and 396 ordered it out of the page. Both
// rested on the demo twin: legacy's REAL churn page renders it, at
// app/(app)/intelligence/churn/page.tsx:7 (`<ChurnRateChart data={churnSnapshots} />`,
// directly above the band cards), from
// app/(app)/intelligence/churn/components/ChurnRateChart.tsx. So the chart is a
// PORT and the owed work is REPAIR toward legacy, which needs no ratification.
//
// Legacy's chart, read whole at that component:
//   shell    bg-surface border border-border rounded-[12px] px-6 py-5 mb-6
//   eyebrow  "Churn rate over time"
//   sub      "Involuntary churn (payment failures) vs voluntary churn
//            (cancellations), last 90 days"
//   plot     recharts ResponsiveContainer width="100%" height={180}
//   series   Involuntary solid var(--red), Voluntary dashed "4 2"
//   axes     XAxis interval="preserveStartEnd", YAxis tickFormatter `${v}%`,
//            both axisLine={false} tickLine={false}, and NO CartesianGrid
//   legend   <Legend /> at its default verticalAlign "bottom"
//
// TWO THINGS ARE DELIBERATELY NOT LEGACY'S, both data rather than treatment,
// both 78/79 truth-over-treatment as the brief directs:
//   * the window is twelve months, not ninety days. Foxhound's MRR snapshot cron
//     is monthly (views.server.ts CHURN_CHART_MONTHS), so legacy's sentence is
//     ported with our own real window in it.
//   * a null rate stays a gap. Legacy coerces null to 0 and draws it.
//
// These assertions render the route rather than reading its source, because
// every one of the three breakages was in the RENDER and none of them was
// visible as a wrong class name.

const ChurnPage = IntelligenceChurn as unknown as (props: {
  loaderData: { entitled: true; view: ChurnView };
}) => ReactElement;

const MONTHS = [
  "2025-09-01",
  "2025-10-01",
  "2025-11-01",
  "2025-12-01",
  "2026-01-01",
  "2026-02-01",
  "2026-03-01",
  "2026-04-01",
  "2026-05-01",
  "2026-06-01",
  "2026-07-01",
  "2026-08-01",
];

const view: ChurnView = {
  bands: [
    { band: "at_risk", customerCount: 3, mrrCents: 49500 },
    { band: "watch", customerCount: 5, mrrCents: 30000 },
    { band: "healthy", customerCount: 12, mrrCents: 120000 },
  ],
  scoredMrrCents: 199500,
  scoredCustomerCount: 20,
  topHighRisk: [],
  ratePoints: MONTHS.map((d, i) => ({
    at: new Date(`${d}T00:00:00Z`),
    voluntaryPct: 1 + (i % 3) * 0.5,
    involuntaryPct: 2 + (i % 4) * 0.25,
  })),
};

function renderPage(): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(ChurnPage, { loaderData: { entitled: true, view } })),
  );
}

/**
 * The chart card's contents, from its eyebrow to the band grid that follows it.
 *
 * Anchored on the eyebrow COPY rather than on the shell's class string on
 * purpose: with the shell as the anchor, a wrong shell would take every
 * breakage assertion below down with it and each would then be red for a reason
 * that is not its own. The shell has its own assertion, once.
 */
function chartCard(html: string): string {
  const start = html.indexOf("Churn rate over time");
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('<div class="mb-6 grid', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** The stretched plot, which is the only 0-100 viewBox on the page. */
function plot(card: string): string {
  const start = card.indexOf('<svg viewBox="0 0 100 100"');
  expect(start).toBeGreaterThan(-1);
  return card.slice(start, card.indexOf("</svg>", start) + "</svg>".length);
}

describe("S19 churn-rate chart, repaired toward legacy (398)", () => {
  it("still renders, above the band cards, in legacy's own shell", () => {
    // 396 ordered this card removed. 398 reversed that: removing a ported legacy
    // element would have manufactured the defect it claimed to fix.
    const html = renderPage();
    expect(html.indexOf("Churn rate over time")).toBeGreaterThan(-1);
    expect(html.indexOf("Churn rate over time")).toBeLessThan(html.indexOf("High risk"));
    expect(html).toContain(
      '<section class="mb-6 rounded-[12px] border border-border bg-surface px-6 py-5">',
    );
  });

  it("carries legacy's sentence with Foxhound's real window", () => {
    expect(chartCard(renderPage())).toContain(
      "Involuntary churn (payment failures) vs voluntary churn (cancellations), last 12 months",
    );
    expect(renderPage()).not.toContain("last 90 days");
  });

  // BREAKAGE 1, measured: "the plot is pushed into the right half of a
  // full-width card, leaving roughly half the card empty". Cause: a fixed
  // 480x180 viewBox scaled uniformly under a pixel height, so it could never
  // widen past 480px however wide the card got.
  it("breakage 1: the plot stretches to the card instead of sitting at 480px", () => {
    const card = chartCard(renderPage());
    const svg = plot(card);
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('class="h-full w-full"');
    // The old fixed drawing surface, in either of the forms it took.
    expect(card).not.toContain('viewBox="0 0 480 180"');
    expect(card).not.toContain('width="100%" height="180"');
  });

  // BREAKAGE 2, measured: "the legend sits inside the plot overlapping the top
  // gridline". Legacy's <Legend /> defaults to verticalAlign "bottom" and legacy
  // draws no CartesianGrid at all, so both halves of that sentence go away.
  it("breakage 2: the legend is below the plot, and there is no gridline under it", () => {
    const card = chartCard(renderPage());
    // First, because it is the half of the breakage that can be asserted
    // without the repair's own structure: the gridline the legend sat on.
    expect(card).not.toContain("stroke-border");
    const svg = plot(card);
    const plotEnd = card.indexOf(svg) + svg.length;
    // The legend is its own row after the plot, not marks inside it. Searching
    // for the series names would find the card's own subtitle sentence, which
    // says "Involuntary churn ... vs voluntary churn" before the chart starts.
    const legend = card.indexOf('<div class="flex items-center justify-center gap-4"');
    expect(legend).toBeGreaterThan(plotEnd);
    expect(card.slice(legend)).toContain("Involuntary");
    expect(card.slice(legend)).toContain("Voluntary");
    expect(svg).not.toContain("<line");
    expect(svg).not.toContain("stroke-border");
  });

  // BREAKAGE 3, measured: "only the two endpoint x labels render". Twelve
  // monthly points and two labels is an unlabelled axis, not overprint
  // protection; legacy's XAxis interval="preserveStartEnd" keeps the ends and
  // every interior tick that fits.
  it("breakage 3: interior x labels render, with the first and last kept", () => {
    const card = chartCard(renderPage());
    const shown = MONTHS.map((d) =>
      new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
    ).filter((label) => card.includes(label));
    expect(shown.length).toBeGreaterThan(2);
    expect(shown[0]).toBe("Sep 1, 2025");
    expect(shown[shown.length - 1]).toBe("Aug 1, 2026");
  });

  it("keeps the y ticks as percent text beside the plot", () => {
    const card = chartCard(renderPage());
    // Closed text nodes, not bare substrings: the positioned labels carry
    // percentage `style` values, so a loose "3%" search matches "top:13%" and
    // passes while reading nothing. Five ticks over a 0 to 2.75 range.
    expect(card).toContain(">0%</span>");
    expect(card).toContain(">2.8%</span>");
    expect(card.match(/>[\d.]+%<\/span>/g)).toHaveLength(5);
  });

  // Untouched by this repair and asserted so: 5cdd4d0 put these on legacy's own
  // geometry and nothing here is a licence to move them again.
  it("leaves the band cards and the high-risk table shell where 5cdd4d0 put them", () => {
    const html = renderPage();
    expect(html).toContain('class="rounded-[12px] border bg-surface px-5 py-4 border-error-border"');
  });
});
