import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { churnRateAlt } from "~/lib/intelligence/churn";
import IntelligenceChurn from "~/routes/app/intelligence/churn";

import type { ChurnView } from "~/lib/intelligence/trends.server";

// J29, row S19, under Dustin's Q1, Q10 and Q11 rulings of
// 2026-10-14: /intelligence/churn is Recova's page (app/(app)/intelligence/churn/
// page.tsx at blob 718cd7f5, ChurnRateChart.tsx at blob f4b9d3e5) built from
// Capsomer 0.9.0's components, with its chart drawn by Enarratio 0.3.1. Recova
// stays the spec for every section, label and their order; the band cutoffs
// are Foxhound's engine (40/70, rulings 78/79), never Recova's 33/66.
//
// Every assertion here was seen failing against the page before the rebuild
// (red output kept in the J29 notes).

const Page = IntelligenceChurn as unknown as (props: {
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

function makeView(over: Partial<ChurnView> = {}): ChurnView {
  return {
    bands: [
      { band: "at_risk", customerCount: 3, mrrCents: 49_550 },
      { band: "watch", customerCount: 1, mrrCents: 30_000 },
      { band: "healthy", customerCount: 12, mrrCents: 120_450 },
    ],
    scoredMrrCents: 200_000,
    scoredCustomerCount: 16,
    topHighRisk: [
      {
        stripeCustomerId: "cus_sample_a",
        customerName: "Sample Bakery",
        currentPlanName: "Growth monthly",
        healthScore: 12,
        mrrContributionCents: 29_950,
      },
      {
        stripeCustomerId: "cus_sample_b",
        customerName: null,
        currentPlanName: null,
        healthScore: 31,
        mrrContributionCents: 0,
      },
    ],
    ratePoints: MONTHS.map((d, i) => ({
      at: new Date(`${d}T00:00:00Z`),
      voluntaryPct: i === 4 ? null : 1 + (i % 3) * 0.5,
      involuntaryPct: 2 + (i % 4) * 0.25,
    })),
    ...over,
  };
}

function render(view: ChurnView = makeView()): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(Page, { loaderData: { entitled: true, view } })),
  );
}




describe("J29 churn: the chart is Enarratio's line chart", () => {

  it("is left out when no snapshot has a rate, as Recova's chart returns null", () => {
    const html = render(
      makeView({ ratePoints: MONTHS.map((d) => ({ at: new Date(`${d}T00:00:00Z`), voluntaryPct: 0, involuntaryPct: null })) }),
    );
    expect(html).not.toContain("Churn rate over time");
    expect(html).not.toContain("data-enarratio");
  });
});

describe("churnRateAlt", () => {
  it("names the month of each series' first and last value, skipping gaps", () => {
    const at = (d: string) => new Date(`${d}T00:00:00Z`);
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
    const at = (d: string) => new Date(`${d}T00:00:00Z`);
    expect(churnRateAlt([{ at: at("2026-01-01"), involuntaryPct: 4, voluntaryPct: null }])).toBe(
      "Monthly churn rate, Jan 2026. Involuntary churn was 4% in Jan 2026; voluntary churn has no rate yet.",
    );
  });
});
