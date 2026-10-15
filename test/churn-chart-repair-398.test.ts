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
// Since J29 (Q1, 2026-10-14) the chart is drawn by Enarratio's line chart
// inside a Capsomer panel, and these assertions are restated for that drawing.
// What 398 repaired still holds; the three breakages are re-asserted on the
// Enarratio output. Two of legacy's treatments Enarratio 0.3.1 cannot draw yet
// (percent tick labels, and the legend below the plot); both are named as
// enarratio jobs in the J29 notes rather than hand-built here.
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

/** The chart's panel: from its heading to the end of its section. */
function chartCard(html: string): string {
  const start = html.indexOf("Churn rate over time");
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** Enarratio's drawing: the chart's one role="img" SVG. */
function plot(card: string): string {
  const start = card.indexOf("<svg");
  expect(start).toBeGreaterThan(-1);
  return card.slice(start, card.indexOf("</svg>", start) + "</svg>".length);
}

describe("S19 churn-rate chart, repaired toward legacy (398)", () => {
  it("still renders, above the band cards", () => {
    // 396 ordered this card removed. 398 reversed that: removing a ported legacy
    // element would have manufactured the defect it claimed to fix.
    const html = renderPage();
    expect(html.indexOf("Churn rate over time")).toBeGreaterThan(-1);
    expect(html.indexOf("Churn rate over time")).toBeLessThan(html.indexOf("High risk"));
  });

  it("carries legacy's sentence with Foxhound's real window", () => {
    expect(chartCard(renderPage())).toContain(
      "Involuntary churn (payment failures) vs voluntary churn (cancellations), last 12 months",
    );
    expect(renderPage()).not.toContain("last 90 days");
  });

  // BREAKAGE 1, measured: "the plot is pushed into the right half of a
  // full-width card". The old fixed 480x180 surface is gone; Enarratio draws at
  // the panel's width (measured in the browser, the 1280px column's on the
  // server), so the drawing is never narrower than the card.
  it("breakage 1: the plot is drawn at the card's width, not at 480px", () => {
    const svg = plot(chartCard(renderPage()));
    const width = Number(svg.match(/<svg[^>]* width="(\d+)"/)?.[1] ?? 0);
    expect(width).toBeGreaterThan(1000);
    expect(svg).not.toContain('viewBox="0 0 480 180"');
  });

  // BREAKAGE 2, measured: "the legend sits inside the plot overlapping the top
  // gridline". Enarratio's legend is its own list outside the SVG, so it can no
  // longer overlap a gridline; it sits above the plot, where legacy's sits
  // below (enarratio gap, J29 notes).
  it("breakage 2: the legend is its own row outside the plot, naming both series", () => {
    const card = chartCard(renderPage());
    const svg = plot(card);
    const legend = card.match(/<ul class="enarratio-legend">[\s\S]*?<\/ul>/)?.[0] ?? "";
    expect(legend).toContain("Involuntary");
    expect(legend).toContain("Voluntary");
    expect(svg).not.toContain("enarratio-legend");
  });

  // BREAKAGE 3, measured: "only the two endpoint x labels render". Twelve
  // monthly points and two labels is an unlabelled axis.
  it("breakage 3: interior x labels render, with the first and last months kept", () => {
    const svg = plot(chartCard(renderPage()));
    const labels = svg.match(/data-enarratio-mark="x-axis tick label"[\s\S]*?<\/g>/)?.[0] ?? "";
    const text = labels.replace(/<[^>]+>/g, " ");
    for (const month of ["Sep", "Oct", "Mar", "Aug"]) expect(text).toContain(month);
  });

  it("keeps the rate in percent: the axis names its unit and the table prints it", () => {
    const card = chartCard(renderPage());
    expect(plot(card)).toContain(">Churn rate (%)</text>");
    expect(card).toContain("<td>2.75%</td>");
  });
});
