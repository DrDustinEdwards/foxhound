import { describe, expect, it } from "vitest";

import {
  customerValueBand,
  engagementBand,
  lookupRecommendation,
  recoveryHistoryBand,
  type EngagementBand,
  type RecoveryBand,
  type ValueBand,
} from "~/lib/intelligence/recommend";

// Recova's recommendation table (lib/intelligence/recommend.ts, blob b753ab76)
// and its three bands (lib/intelligence/bands.ts, blob 119bec74), ported as
// rules. Every one of the 48 cells is listed, because one wrong branch in a
// nested table is the mistake this is easy to make and hard to see.

const E: EngagementBand[] = ["green", "yellow", "red", "unknown"];
const H: RecoveryBand[] = ["green", "yellow", "red", "unknown"];

const P = "personal_outreach";
const C = "continue_automated";
const W = "continue_automated_priority";
const D = "continue_automated_deprioritize";

// [engagement][history] -> [high value, medium value, low value]
const TABLE: Record<EngagementBand, Record<RecoveryBand, [string, string, string]>> = {
  green: { green: [C, C, C], yellow: [C, C, C], red: [P, D, D], unknown: [W, C, C] },
  yellow: { green: [P, C, C], yellow: [P, C, C], red: [P, D, D], unknown: [P, C, C] },
  red: { green: [P, P, P], yellow: [P, D, D], red: [P, D, D], unknown: [P, C, C] },
  unknown: { green: [W, C, C], yellow: [W, C, C], red: [W, C, C], unknown: [W, C, C] },
};

describe("Recova's recommendation table", () => {
  it("gives Recova's action for every band combination", () => {
    const values: ValueBand[] = ["high", "medium", "low"];
    for (const e of E) {
      for (const h of H) {
        values.forEach((v, i) => {
          expect([e, h, v, lookupRecommendation(e, h, v, 10_000).action]).toEqual([e, h, v, TABLE[e][h][i]]);
        });
      }
    }
  });

  it("uses Recova's confidence rule", () => {
    expect(lookupRecommendation("unknown", "unknown", "high", 1).confidence).toBe("low");
    expect(lookupRecommendation("green", "green", "low", 1).confidence).toBe("low");
    expect(lookupRecommendation("green", "unknown", "high", 1).confidence).toBe("medium");
    expect(lookupRecommendation("green", "green", "medium", 1).confidence).toBe("medium");
    expect(lookupRecommendation("green", "green", "high", 1).confidence).toBe("high");
  });

  it("annualises MRR at risk only for the two actions that ask for attention", () => {
    expect(lookupRecommendation("red", "red", "high", 5_000).annualizedMrrAtRiskCents).toBe(60_000);
    expect(lookupRecommendation("unknown", "unknown", "high", 5_000).annualizedMrrAtRiskCents).toBe(60_000);
    expect(lookupRecommendation("red", "red", "low", 5_000).annualizedMrrAtRiskCents).toBeNull();
  });

  it("keeps Recova's rationale except where it claimed more than the data shows", () => {
    expect(lookupRecommendation("green", "green", "high", 1).rationale).toBe(
      "Automated recovery is highly effective for this customer (engaged, 60%+ historical recovery rate). No intervention needed.",
    );
    expect(lookupRecommendation("red", "green", "high", 1).rationale).toBe(
      "High-value customer who used to recover well but has no tracked email opens in the last 30 days. Reach out directly.",
    );
  });
});

describe("Recova's bands, on Foxhound's inputs", () => {
  const NOW = Date.parse("2026-10-25T00:00:00.000Z");
  const DAY = 86_400_000;

  it("engagement: unknown under 3 sends, red with no opens, green within 14 days, else yellow", () => {
    expect(engagementBand({ sent30d: 2, opened30d: 5, lastOpenAtMs: NOW, nowMs: NOW }).band).toBe("unknown");
    expect(engagementBand({ sent30d: 3, opened30d: 0, lastOpenAtMs: null, nowMs: NOW }).band).toBe("red");
    expect(engagementBand({ sent30d: 3, opened30d: 1, lastOpenAtMs: NOW - 14 * DAY, nowMs: NOW }).band).toBe("green");
    expect(engagementBand({ sent30d: 3, opened30d: 1, lastOpenAtMs: NOW - 15 * DAY, nowMs: NOW }).band).toBe("yellow");
    expect(engagementBand({ sent30d: 3, opened30d: 1, lastOpenAtMs: NOW - 90 * DAY, nowMs: NOW }).band).toBe("yellow");
  });

  it("recovery history: unknown under 3 failures, then 60% and 30% cut points", () => {
    expect(recoveryHistoryBand({ failedPaymentCount: 2, recoveredCount: 2 }).band).toBe("unknown");
    expect(recoveryHistoryBand({ failedPaymentCount: 5, recoveredCount: 3 }).band).toBe("green");
    expect(recoveryHistoryBand({ failedPaymentCount: 10, recoveredCount: 3 }).band).toBe("yellow");
    expect(recoveryHistoryBand({ failedPaymentCount: 10, recoveredCount: 2 }).band).toBe("red");
  });

  it("value: percentile within the account, 75 and up high, 25 and under or no MRR low", () => {
    const dist = [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000];
    expect(customerValueBand({ mrrContributionCents: 6_000, accountMrrAscending: dist }).band).toBe("high");
    expect(customerValueBand({ mrrContributionCents: 3_000, accountMrrAscending: dist }).band).toBe("medium");
    expect(customerValueBand({ mrrContributionCents: 1_000, accountMrrAscending: dist }).band).toBe("low");
    expect(customerValueBand({ mrrContributionCents: 0, accountMrrAscending: dist }).band).toBe("low");
  });
});
