import { describe, expect, it } from "vitest";

import { DECLINE_CATEGORIES } from "~/lib/constants";

// These cover the display arithmetic the /recovery dashboard was missing: the
// share-of-MRR figure, the per-category recovery rate and its minimum-sample
// gate, and the fixed category ordering. The formulas live inline in the route's
// small presentational helpers, so they are restated here as the contract those
// helpers must satisfy; each one is a number that was previously either absent
// from the page or computed from a population that changed shape between ranges.

/** Mirrors atRiskSubtext's share-of-MRR arithmetic. */
function atRiskSharePct(atRiskCents: number, mrrEstimateCents: number): number | null {
  if (mrrEstimateCents <= 0) return null;
  return Math.round((atRiskCents / mrrEstimateCents) * 1000) / 10;
}

/** Mirrors the per-category recovery rate and its two-failure gate. */
function categoryRatePct(stats: { total: number; recovered: number } | undefined): number | null {
  if (!stats || stats.total < 2) return null;
  return Math.round((stats.recovered / stats.total) * 100);
}

describe("at-risk share of MRR", () => {
  it("expresses the amount at risk as a share of the MRR estimate", () => {
    expect(atRiskSharePct(400_000, 2_000_000)).toBe(20);
  });

  it("keeps one decimal, so a small share does not round away to zero", () => {
    expect(atRiskSharePct(1_000, 2_000_000)).toBe(0.1);
  });

  // An account with no MRR estimate must render no share rather than divide by
  // zero and print Infinity or NaN.
  it("returns null when there is no MRR estimate", () => {
    expect(atRiskSharePct(400_000, 0)).toBeNull();
    expect(atRiskSharePct(400_000, -1)).toBeNull();
  });
});

describe("per-category recovery rate", () => {
  it("reports the rate once there are at least two failures", () => {
    expect(categoryRatePct({ total: 4, recovered: 3 })).toBe(75);
    expect(categoryRatePct({ total: 2, recovered: 1 })).toBe(50);
  });

  // "100% recovered" off a single payment is noise dressed as a statistic.
  it("withholds a rate below two failures", () => {
    expect(categoryRatePct({ total: 1, recovered: 1 })).toBeNull();
    expect(categoryRatePct({ total: 0, recovered: 0 })).toBeNull();
    expect(categoryRatePct(undefined)).toBeNull();
  });

  it("reports zero rather than nothing when a category recovered none of several", () => {
    expect(categoryRatePct({ total: 5, recovered: 0 })).toBe(0);
  });
});

describe("decline breakdown ordering", () => {
  // Iterating the breakdown's own keys dropped any category with no rows this
  // range, so the list changed shape between ranges and a zero could not be told
  // apart from a category that does not exist.
  it("covers every engine category in a fixed order regardless of the data", () => {
    expect(DECLINE_CATEGORIES).toEqual(["soft", "network", "expired", "fraud", "revoked", "unknown"]);
    const sparse: Partial<Record<string, number>> = { soft: 3 };
    const rendered = DECLINE_CATEGORIES.map((c) => ({ cat: c, count: sparse[c] ?? 0 }));
    expect(rendered).toHaveLength(6);
    expect(rendered.filter((r) => r.count === 0)).toHaveLength(5);
  });
});
