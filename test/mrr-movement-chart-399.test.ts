import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import IntelligenceOverviewPage from "~/routes/app/intelligence/index";
import type {
  HealthDistributionDay,
  IntelligenceOverview,
  MrrSnapshotPoint,
} from "~/lib/intelligence/views.server";

// Ruling 399, session 90 job 3. MRRMovementChart is the second of the two
// dashboard charts the 394 walk never saw, for the same reason as NRRChart:
// legacy's DEMO twin does not render it. Legacy's real page mounts it at
// app/(app)/intelligence/dashboard/page.tsx:13. Component read whole at
// app/(app)/intelligence/dashboard/components/MRRMovementChart.tsx:
//
//   gate     hasData = some bucket has a non-zero component
//   shell    bg-surface border border-border rounded-[12px] px-6 py-5 mb-5
//   eyebrow  "MRR movement"
//   sub      "New, expansion, contraction, and churn by week"
//   plot     recharts BarChart height={200}, five Bar marks on two stackIds:
//            "pos" New / Expansion / Reactivation, "neg" Contraction / Churn
//   colours  New var(--green), Expansion var(--blue), Reactivation
//            var(--purple), Contraction var(--orange), Churn var(--red)
//   values   whole dollars; contraction and churn NEGATED so they hang below
//   axes     YAxis tickFormatter `$${Math.abs(v)}`, ReferenceLine y={0}
//   legend   a Legend, in Bar order
//
// ONE DELIBERATE DIVERGENCE, 78/79, the same one the sibling NRR card carries:
// "by week" becomes "by month". Legacy's snapshot job is daily and it samples
// every 7th row, so its buckets genuinely are weeks. intelligence-sync is a
// MONTHLY cron here, so a week is not a bucket Foxhound has and legacy's
// sentence would name a cadence we do not run.
//
// PURPLE IS FLAGGED RATHER THAN ASSUMED. DESIGN.md's Charts section reserves it
// for "the win-back attribution series" and nothing else. Reactivation MRR is
// revenue from customers who churned and returned, which is what win-back
// sequences exist to produce, so the reservation and legacy's colour agree.
// Asserted below so the reading is on the record and a later reader who
// disagrees changes one class name and one test line together.

const Page = IntelligenceOverviewPage as unknown as (props: {
  loaderData: {
    entitled: true;
    overview: IntelligenceOverview;
    healthDistribution: HealthDistributionDay[];
    mrrSeries: MrrSnapshotPoint[];
  };
}) => ReactElement;

const overview: IntelligenceOverview = {
  currency: "usd",
  scoredCustomerCount: 2,
  scoreDistribution: { healthy: 2, watch: 0, atRisk: 0 },
  mrrAtRiskCents: 0,
  atRiskCustomerCount: 0,
  topAtRisk: [],
  narrative: null,
  narrativeGeneratedAt: null,
};

function point(month: number, cents: Partial<MrrSnapshotPoint> = {}): MrrSnapshotPoint {
  return {
    at: new Date(Date.UTC(2026, month, 1)),
    nrrPct: null,
    newMrrCents: 0,
    expansionMrrCents: 0,
    reactivationMrrCents: 0,
    contractionMrrCents: 0,
    churnMrrCents: 0,
    ...cents,
  };
}

const series = [
  point(0, { newMrrCents: 120_000, expansionMrrCents: 40_000, churnMrrCents: 30_000 }),
  point(1, {
    newMrrCents: 90_000,
    reactivationMrrCents: 25_000,
    contractionMrrCents: 15_000,
    churnMrrCents: 50_000,
  }),
  point(2, { newMrrCents: 150_000, expansionMrrCents: 60_000, churnMrrCents: 20_000 }),
];

function render(mrrSeries: MrrSnapshotPoint[]): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(Page, {
        loaderData: { entitled: true, overview, healthDistribution: [], mrrSeries },
      }),
    ),
  );
}

function card(html: string): string {
  const start = html.indexOf("MRR movement");
  return html.slice(start, html.indexOf("</section>", start));
}

describe("S16 MRR movement chart, built toward legacy (399)", () => {
  it("renders legacy's card copy with Foxhound's real bucket", () => {
    const html = render(series);
    expect(html).toContain("MRR movement");
    expect(html).toContain("New, expansion, contraction, and churn by month");
    expect(html).not.toContain("and churn by week");
  });

  it("carries legacy's five series in legacy's order", () => {
    const c = card(render(series));
    const order = ["New", "Expansion", "Reactivation", "Contraction", "Churn"].map((n) =>
      c.indexOf(">" + n + "<"),
    );
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("gives each series legacy's colour, purple on Reactivation only", () => {
    const c = card(render(series));
    // Each legend entry is a swatch carrying the series colour class, followed
    // by the series name. Pairing the two is what makes this an assertion about
    // WHICH series is purple rather than about purple being present somewhere.
    const pairs: [string, string][] = [
      ["New", "text-green"],
      ["Expansion", "text-blue"],
      ["Reactivation", "text-purple"],
      ["Contraction", "text-orange"],
      ["Churn", "text-red"],
    ];
    for (const [name, cls] of pairs) {
      const at = c.indexOf(">" + name + "<");
      expect(at).toBeGreaterThan(-1);
      expect(c.slice(Math.max(0, at - 200), at)).toContain('class="' + cls + '"');
    }
    // The reservation is what makes purple mean something, so no other series
    // may borrow it. One swatch plus one bar run for Reactivation, which is
    // present in exactly one bucket of this fixture.
    expect((c.match(/text-purple/g) ?? []).length).toBe(2);
  });

  it("hangs contraction and churn below the baseline", () => {
    // Month 2 has contraction and churn against new and reactivation, so the
    // plot must cross zero and draw the baseline rule legacy's ReferenceLine
    // puts there. StackedBars only draws it when the data actually goes
    // negative, which is the discriminating condition.
    const c = card(render(series));
    expect(c).toContain("stroke-border");
  });

  it("formats the y ticks as whole dollars", () => {
    const c = card(render(series));
    expect(c).toMatch(/\$\d/);
    // Legacy takes the absolute value, so the axis never renders a minus below
    // the baseline.
    expect(c).not.toContain("$-");
  });

  it("is withheld when every bucket is flat", () => {
    // Legacy's own gate. An account with snapshots but no movement gets no
    // empty frame.
    expect(render([point(0), point(1)])).not.toContain("MRR movement");
  });

  it("is withheld when there are no snapshots at all", () => {
    expect(render([])).not.toContain("MRR movement");
  });
});
