import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// 394 cross-cutting finding C2, under 148/154: legacy's app section is NOT
// uniform, so each surface is resolved against ITS OWN legacy page rather than
// against a constant. Every legacy value below is read from legacy source at
// the path named beside it, not from a rendered demo.
//
// TWO SURFACES THE WALK LISTED ARE NOT HERE, and both are corrections to the
// walk rather than omissions:
//
//   S23 /help. The walk measured legacy at rounded-[12px] p-24px, from
//   app/recovery/demo/help/page.tsx. Row S23's legacy source is
//   app/(app)/help/page.tsx, which uses rounded-lg, so Foxhound's rounded-lg
//   ALREADY matched and there was no C2 divergence on that row. Since J13 the
//   page's shells are Capsomer's (Q10), and the radius is a per-site layer item.
//
//   The StatCard shells on S13, S16 and S19. That component has eleven
//   consumers, nine unwalked, and ruling 199 holds its treatment until they
//   are. Its own source comment says so. Changing it here would restyle nine
//   unwalked surfaces to match one.
//
// Shells whose legacy counterpart is a different element (the dashed empty
// states) are left to their rows as composition divergences, not geometry.

function src(path: string): string {
  return readFileSync(new URL(`../app/${path}`, import.meta.url), "utf8");
}

describe("C2: each surface carries its own legacy shell geometry", () => {
  it("S13 disputes list: the table shell is Capsomer's panel since J66 (Q10)", () => {
    // legacy app/(app)/disputes/dashboard/DisputesDashboardView.tsx:224
    //   bg-surface border border-border rounded-[12px] overflow-hidden
    // Since J66 the shell is Capsomer's panel (surface fill, border, its own
    // radius, clipped), as J13 made /help's. The radius is a per-site layer item
    // (capsomer job_ec5ec0754626), so no Foxhound radius is laid over it here.
    const s = src("routes/app/disputes/index.tsx");
    expect(s).toContain('<div className="cap-panel">');
    expect(s).not.toContain("rounded-[12px] border border-border bg-surface");
  });

  it("S14 dispute detail takes its section shells from Capsomer's panel", () => {
    // Since J77 each of legacy's section cards (DisputeDetailClient.tsx,
    // 3d56b55d) is Capsomer's Panel, as J66 made the list's and J76 the payment
    // page's. The radius is a per-site layer item (capsomer job_ec5ec0754626),
    // so no Foxhound radius is laid over it.
    const s = src("routes/app/disputes/detail.tsx");
    expect(s.split("<Panel ").length - 1).toBeGreaterThanOrEqual(5);
    expect(s).not.toContain("rounded-[12px] border border-border bg-surface");
  });

  it("S16 intelligence takes its shells from Capsomer, not from a hand-rolled radius", () => {
    // legacy app/(app)/intelligence/dashboard/components/*.tsx use
    // bg-surface border border-border rounded-[12px] px-6 py-5 for every card.
    // Since J67 (Q10, 2026-10-14) the stat cards, chart cards and the monthly
    // summary are Capsomer Panels, whose radius is Capsomer's own; legacy's
    // 12px waits for the per-site style layer rather than a Foxhound class over
    // a Capsomer component, as on S17, S19 and S23. The held at-risk table
    // below is the one shell this does not touch.
    const s = src("routes/app/intelligence/index.tsx");
    expect(s).toContain('from "capsomer/react/panel"');
    expect(s).toContain('<Panel\n      title="Monthly summary"');
    expect(s).not.toContain("rounded-[12px]");
  });

  it("S16: the ONE still-HELD shell is not touched (396 as narrowed by 399)", () => {
    // THIS ASSERTION USED TO COVER TWO SHELLS AND ONE OF THEM WAS RELEASED.
    // 396 held both the score-distribution chart and the most-at-risk table for
    // Dustin's screenshot review, on the walk's claim that legacy had neither.
    // 399 measured that claim against legacy's REAL dashboard and it was half
    // false: HealthDistributionChart is legacy's own
    // (app/(app)/intelligence/dashboard/page.tsx:12), so the chart is a PORT to
    // align and needs no ratification, while the at-risk TABLE is still the one
    // true addition and stays held. Pinning the chart's pre-port geometry here
    // would have been this suite defending the divergence it exists to catch,
    // which is 397's finding in its structural form.
    const s = src("routes/app/intelligence/index.tsx");
    expect(s).toContain('className="mt-3 overflow-x-auto rounded-lg border border-border"');
  });

  it("S16 health distribution: the ported chart sits in a Capsomer panel", () => {
    // legacy app/(app)/intelligence/dashboard/components/HealthDistributionChart.tsx:39
    //   bg-surface border border-border rounded-[12px] px-6 py-5 mb-5
    // Since J67 a Capsomer Panel (see the S16 case above), never the pre-port
    // rounded-lg p-4 card.
    const s = src("routes/app/intelligence/index.tsx");
    expect(s).toContain('<Panel title="Customer health distribution"');
    expect(s).not.toContain('<div className="mt-3 rounded-lg border border-border bg-surface p-4">');
  });

  it("S17 customers takes its shells from Capsomer, not from a hand-rolled radius", () => {
    // legacy app/(app)/intelligence/customers/page.tsx:83 and :90 use
    // rounded-[12px] for the empty card and the table shell. Since J30 (Q10,
    // 2026-10-14) both are Capsomer panels, and so is the ratified filter bar
    // (a Foxhound addition, APPROVED-DIFFERENCES 2026-08-28); legacy's 12px
    // waits for the per-site style layer rather than a Foxhound class over a
    // Capsomer component, as on S19 and S23.
    const s = src("routes/app/intelligence/customers.tsx");
    expect(s).toContain('from "capsomer/react/panel"');
    expect(s).toContain('<div className="cap-panel">');
    expect(s).toContain('<Form method="get" className="cap-panel">');
    expect(s).not.toContain("rounded-[12px]");
    expect(s).not.toContain("rounded-lg border border-border bg-surface p-4");
  });

  it("S19 churn takes its shells from Capsomer, not from a hand-rolled radius", () => {
    // legacy app/(app)/intelligence/churn/page.tsx:71, :181, :108 use
    // rounded-[12px]. Since J29 (Q10, 2026-10-14) the empty state, band cards
    // and table are Capsomer Panels, whose radius is Capsomer's own; legacy's
    // 12px waits for the per-site style layer rather than a Foxhound class over
    // a Capsomer component, as on S23.
    const s = src("routes/app/intelligence/churn.tsx");
    expect(s).toContain('from "capsomer/react/panel"');
    expect(s).not.toContain("rounded-[12px]");
  });

  it("S23 help takes its shells from Capsomer, not from a hand-rolled radius", () => {
    // legacy app/(app)/help/page.tsx:172,189,268 all use rounded-lg, and the
    // walk's 12px figure came from the demo twin, a different file. Since J13
    // (Q10, 2026-10-14) the help page's cards are all Capsomer Panels (guides
    // included), whose radius is Capsomer's own; legacy's 8px waits for the per-site
    // style layer rather than a Foxhound class over a Capsomer component. So
    // neither legacy's class string nor the walk's 12px is hand-written here.
    const s = src("routes/app/help.tsx");
    expect(s).toContain('from "capsomer/react/panel"');
    // The guide cards are Panels too, not row-list rows, whose one-line
    // detail cut legacy's descriptions short.
    expect(s).not.toContain('from "capsomer/react/row-list"');
    expect(s).not.toContain("rounded-lg");
    expect(s).not.toContain("rounded-[12px]");
  });

  it("the shared StatCard is untouched, per ruling 199", () => {
    const s = src("components/stat-card.tsx");
    expect(s).toContain('<div className="rounded-lg border border-border bg-surface p-4">');
  });
});
