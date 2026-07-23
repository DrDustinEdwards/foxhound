import { describe, expect, it } from "vitest";

import {
  buildBoltBase,
  buildTeamflowBase,
  isDayWalkEligible,
  monthlyMrrCents,
  summarize,
} from "~/lib/demo/customer-base";

// TASK-foxhound-demo-data-engine.md Phase 1: the customer base is the shared
// deterministic source of truth for the Recovery, Disputes, and Intelligence
// demo seeds. Every other seed module trusts these invariants without
// re-checking them.

const now = new Date("2026-07-21T00:00:00.000Z");

describe("buildTeamflowBase", () => {
  it("returns exactly 200 customers, split into the documented tier counts", () => {
    const base = buildTeamflowBase(now);
    const summary = summarize(base);
    expect(summary.total).toBe(200);
    expect(summary.byTier.starter).toBe(100);
    expect(summary.byTier.growth).toBe(60);
    expect(summary.byTier.scale).toBe(40);
    expect(summary.byTier.pro).toBe(0);
    expect(summary.byTier.hobby).toBe(0);
  });

  it("carries exactly the 7 scripted Teamflow narratives", () => {
    const summary = summarize(buildTeamflowBase(now));
    expect(summary.scriptedSlugs).toEqual(
      [
        "acme_industries",
        "bluewave_studios",
        "harborline_group",
        "lakeside_ventures",
        "northpoint_logistics",
        "pinecrest_software",
        "sycamore_co",
      ].sort(),
    );
  });

  it("is deterministic: two calls with the same `now` produce an identical snapshot", () => {
    const a = summarize(buildTeamflowBase(now));
    const b = summarize(buildTeamflowBase(now));
    expect(b).toEqual(a);
  });

  it("is deterministic at the row level too, not just in aggregate", () => {
    const a = buildTeamflowBase(now);
    const b = buildTeamflowBase(now);
    expect(b.map((c) => c.stripeCustomerId)).toEqual(a.map((c) => c.stripeCustomerId));
    expect(b.map((c) => c.customerName)).toEqual(a.map((c) => c.customerName));
    expect(b.map((c) => c.tier)).toEqual(a.map((c) => c.tier));
  });

  it("excludes scripted customers and Hobby tier from day-walk eligibility", () => {
    const base = buildTeamflowBase(now);
    const scripted = base.filter((c) => c.scripted !== null);
    expect(scripted.length).toBe(7);
    for (const c of scripted) expect(isDayWalkEligible(c)).toBe(false);
    // Teamflow has no Hobby tier, so every non-scripted customer is eligible.
    const anonymous = base.filter((c) => c.scripted === null);
    expect(anonymous.every(isDayWalkEligible)).toBe(true);
  });

  it("never generates an anonymous customer whose name collides with a scripted one", () => {
    const base = buildTeamflowBase(now);
    const scriptedNames = new Set(base.filter((c) => c.scripted).map((c) => c.customerName));
    const anonymousNames = base.filter((c) => !c.scripted).map((c) => c.customerName);
    for (const name of anonymousNames) expect(scriptedNames.has(name)).toBe(false);
  });

  it("churned customers contribute zero MRR", () => {
    const base = buildTeamflowBase(now);
    const churned = base.filter((c) => c.status === "churned");
    expect(churned.length).toBeGreaterThan(0);
    for (const c of churned) expect(monthlyMrrCents(c)).toBe(0);
  });
});

describe("buildBoltBase (built for parity, not seeded yet)", () => {
  it("returns exactly 200 customers, split into the documented tier counts", () => {
    const summary = summarize(buildBoltBase(now));
    expect(summary.total).toBe(200);
    expect(summary.byTier.pro).toBe(120);
    expect(summary.byTier.hobby).toBe(80);
    expect(summary.byTier.starter).toBe(0);
    expect(summary.byTier.growth).toBe(0);
    expect(summary.byTier.scale).toBe(0);
  });

  it("carries exactly the 4 scripted Bolt narratives", () => {
    const summary = summarize(buildBoltBase(now));
    expect(summary.scriptedSlugs).toEqual(
      ["corepath_devs", "driftwave_labs", "hilltop_metrics", "stillwater_engineering"].sort(),
    );
  });
});
