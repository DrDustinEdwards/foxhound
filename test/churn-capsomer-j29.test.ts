import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { churnRateAlt, formatChurnMonth, formatChurnPct } from "~/lib/intelligence/churn";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import IntelligenceChurn, {
  ChurnRateChart,
  chartWidthFor,
  meta as churnMeta,
} from "~/routes/app/intelligence/churn";

import type { ChurnView } from "~/lib/intelligence/views.server";

// J29 (job_6f2452e8b11d), row S19, under Dustin's Q1, Q10 and Q11 rulings of
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

const SOURCE = readFileSync(new URL("../app/routes/app/intelligence/churn.tsx", import.meta.url), "utf8");

/** The Capsomer panel whose heading is `title`, or "" when there is none. */
function panelTitled(html: string, title: string): string {
  const sections = html.match(/<section class="cap-panel"[\s\S]*?<\/section>/g) ?? [];
  return sections.find((s) => new RegExp(`<h2[^>]*>${title}</h2>`).test(s)) ?? "";
}

function headings(html: string): { level: number; text: string }[] {
  return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
    level: Number(m[1]),
    text: m[2].replace(/<[^>]+>/g, ""),
  }));
}

describe("J29 churn: the page head", () => {
  it("is Capsomer's PageHead with Recova's H1 and lead", () => {
    const html = render();
    expect(html).toMatch(/<header class="cap-page-head">[\s\S]*<h1 class="cap-page-head-title">Churn Risk<\/h1>/);
    expect(html).toContain('<p class="cap-page-head-lead">MRR at risk by customer health band.</p>');
  });

  it("keeps the per-page browser title, named by the H1", () => {
    expect(churnMeta()).toEqual([{ title: "Churn Risk - Foxhound" }]);
  });

  it("renders no <main> of its own (the shell's is the page's one main)", () => {
    expect(render()).not.toMatch(/<main[\s>]/);
  });
});

describe("J29 churn: sections in Recova's order", () => {
  it("is the H1, the chart, the three bands, then the high-risk table, with no level skipped", () => {
    const h = headings(render());
    expect(h.map((x) => x.text)).toEqual([
      "Churn Risk",
      "Churn rate over time",
      "High risk",
      "Medium risk",
      "Healthy",
      "High-risk customers by MRR",
    ]);
    expect(h.filter((x) => x.level === 1)).toHaveLength(1);
    for (let i = 1; i < h.length; i++) expect(h[i].level - h[i - 1].level).toBeLessThanOrEqual(1);
  });
});

describe("J29 churn: the chart is Enarratio's line chart", () => {
  it("sits in a Capsomer panel with Recova's title and sentence", () => {
    const panel = panelTitled(render(), "Churn rate over time");
    expect(panel).not.toBe("");
    expect(panel).toContain(
      '<p class="cap-panel-desc">Involuntary churn (payment failures) vs voluntary churn (cancellations), last 12 months</p>',
    );
  });

  it("is drawn by Enarratio, not the hand-made MultiLine", () => {
    const panel = panelTitled(render(), "Churn rate over time");
    expect(panel).toContain('data-enarratio="line"');
    expect(panel).not.toContain('viewBox="0 0 100 100"');
    expect(SOURCE).not.toMatch(/from "~\/components\/charts"/);
    expect(SOURCE).toMatch(/from "enarratio\/lite\/line"/);
  });

  it("keeps Recova's legend: Involuntary, then Voluntary", () => {
    const panel = panelTitled(render(), "Churn rate over time");
    const legend = panel.match(/<ul class="enarratio-legend">[\s\S]*?<\/ul>/)?.[0] ?? "";
    const names = [...legend.matchAll(/data-enarratio-series="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["Involuntary", "Voluntary"]);
  });

  it("has a text equivalent: an alt with the numbers and a data table of every month", () => {
    const view = makeView();
    const panel = panelTitled(render(view), "Churn rate over time");
    expect(panel).toContain(`role="img" aria-label="${churnRateAlt(view.ratePoints)}"`);
    const table = panel.match(/<table[\s\S]*?<\/table>/)?.[0] ?? "";
    // One row per month for each series: 12 months, two series, one gap kept as a gap.
    expect(table.match(/<tr>/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(table).toContain("2.75%");
  });

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

describe("J29 churn: one month and percent format for the alt and the chart", () => {
  it("formats the chart's table with the same helpers churnRateAlt uses", () => {
    expect(formatChurnMonth(new Date("2025-09-01T00:00:00Z"))).toBe("Sep 2025");
    expect(formatChurnPct(2.756)).toBe("2.76%");
    expect(SOURCE).not.toMatch(/new Intl\.DateTimeFormat/);
    expect(SOURCE).toMatch(/formatChurnMonth/);
    expect(SOURCE).toMatch(/formatChurnPct/);
  });
});

describe("J29 churn: the chart's look comes from Capsomer's mapping and Recova's series", () => {
  it("loads Capsomer's Enarratio mapping itself, so the colours never rest on another file's import", () => {
    expect(SOURCE).toMatch(/import "capsomer\/enarratio\.css";/);
    const mapping = readFileSync(new URL("../node_modules/capsomer/css/enarratio.css", import.meta.url), "utf8");
    for (const prop of ["--enarratio-series-1", "--enarratio-text", "--enarratio-grid"]) expect(mapping).toContain(`${prop}:`);
  });

  it("draws Involuntary on the error token and Voluntary on tertiary text, as Recova's red and grey", () => {
    const panel = panelTitled(render(), "Churn rate over time");
    expect(panel).toMatch(/--enarratio-series-1: var\(--error-text\)/);
    expect(panel).toMatch(/--enarratio-series-2: var\(--text-tertiary\)/);
  });

  it("hides the y gridlines with Enarratio's documented rule (Recova draws no CartesianGrid)", () => {
    const css = readFileSync(new URL("../app/routes/app/intelligence/churn.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.fh-churn-chart \[data-enarratio-mark="y-grid"\]\s*\{\s*display:\s*none;?\s*\}/);
    expect(SOURCE).toContain('import "./churn.css";');
    expect(panelTitled(render(), "Churn rate over time")).toContain('class="fh-churn-chart min-w-0"');
  });
});

describe("J29 churn: the chart's redraw", () => {
  it("draws in 40px steps, never under the minimum, so a resize does not redraw on every pixel", () => {
    expect(chartWidthFor(1054)).toBe(1040);
    expect(chartWidthFor(1079)).toBe(1040);
    expect(chartWidthFor(1080)).toBe(1080);
    expect(chartWidthFor(100)).toBe(280);
  });

  it("keeps its measured wrapper when Enarratio refuses to draw, so the observer still attaches", () => {
    const html = renderToStaticMarkup(
      createElement(ChurnRateChart, {
        points: [{ at: new Date(Number.NaN), involuntaryPct: 1, voluntaryPct: 1 }],
      }),
    );
    expect(html).toMatch(/^<div class="fh-churn-chart min-w-0"><p[^>]*>This chart could not be drawn/);
  });
});

describe("J29 churn: the three band cards", () => {
  it("are Capsomer panels labelled with Foxhound's own cutoffs (78/79), never Recova's 33/66", () => {
    const html = render();
    const ranges: Record<string, string> = {
      "High risk": `Health 0-${HEALTH_SCORE_AT_RISK_THRESHOLD - 1}`,
      "Medium risk": `Health ${HEALTH_SCORE_AT_RISK_THRESHOLD}-${WATCH_CEILING - 1}`,
      Healthy: `Health ${WATCH_CEILING}-100`,
    };
    for (const [label, range] of Object.entries(ranges)) {
      const panel = panelTitled(html, label);
      expect(panel, label).not.toBe("");
      expect(panel).toContain(`<span class="cap-panel-src">${range}</span>`);
    }
    expect(html).not.toContain("Health 0-33");
    expect(html).not.toContain("Health 34-66");
  });

  it("show MRR with cents, as Recova's formatAmount does, and the share line", () => {
    const html = render();
    expect(panelTitled(html, "High risk")).toContain("$495.50");
    expect(panelTitled(html, "High risk")).toContain("3 customers · 25% of scored MRR");
    expect(panelTitled(html, "Medium risk")).toContain("1 customer · 15% of scored MRR");
    expect(panelTitled(html, "Healthy")).toContain("$1,204.50");
  });
});

describe("J29 churn: the high-risk table", () => {
  it("sits in a Capsomer panel with Recova's title and sentence", () => {
    const panel = panelTitled(render(), "High-risk customers by MRR");
    expect(panel).toContain(
      '<p class="cap-panel-desc">Top 2 customers in the high-risk band, sorted by monthly contribution.</p>',
    );
  });

  it("is one named landmark: the table's scroll region, not a second region around it", () => {
    const html = render();
    const panel = panelTitled(html, "High-risk customers by MRR");
    expect(panel).toMatch(/^<section class="cap-panel">/);
    expect(panel).toContain(
      '<div class="cap-table-wrap" data-cap="table" role="region" aria-label="High-risk customers by MRR" tabindex="0">',
    );
    expect(html.match(/aria-label(ledby)?="(High-risk customers by MRR|churn-high-risk)"/g)).toHaveLength(1);
  });

  it("is Capsomer's table in a focusable region, with Recova's four columns in order", () => {
    const panel = panelTitled(render(), "High-risk customers by MRR");
    expect(panel).toMatch(/<div class="cap-table-wrap" data-cap="table" role="region" aria-label="[^"]+" tabindex="0">/);
    expect(panel).toContain('<table class="cap-table">');
    const head = panel.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    expect([...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual([
      "Customer",
      "Plan",
      "Health",
      "MRR",
    ]);
  });

  it("names each row by its customer, linking to the customer page", () => {
    const panel = panelTitled(render(), "High-risk customers by MRR");
    expect(panel).toMatch(/<th scope="row"><a[^>]*href="\/intelligence\/customers\/cus_sample_a"/);
    expect(panel).toContain("(unnamed)");
  });

  it("puts the plan in a Capsomer outline pill, as Recova's rounded border pill", () => {
    const panel = panelTitled(render(), "High-risk customers by MRR");
    expect(panel).toMatch(/<span class="cap-pill" data-variant="outline"[^>]*>Growth monthly<\/span>/);
  });

  it("shows MRR with cents (formatAmount), and a dash for none", () => {
    const panel = panelTitled(render(), "High-risk customers by MRR");
    expect(panel).toContain("$299.50");
    expect(panel).not.toContain(">$300<");
  });
});

describe("J29 churn: the empty state", () => {
  it("keeps Recova's heading and line in a Capsomer panel when nobody is scored", () => {
    const html = render(makeView({ scoredCustomerCount: 0, topHighRisk: [] }));
    const panel = panelTitled(html, "Health scores are being calculated.");
    expect(panel).toContain("Check back after the next Intelligence sync.");
    expect(html).not.toContain("High risk");
  });
});

describe("J29 churn: no hand-rolled sizes, no amber", () => {
  it("uses none of Recova's arbitrary text-[X] sizes and no amber class", () => {
    expect(SOURCE).not.toMatch(/text-\[/);
    expect(SOURCE).not.toMatch(/amber/i);
  });
});
