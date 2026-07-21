import { describe, expect, it } from "vitest";

import { buildPredictionFields, hashFactorBands } from "~/lib/intelligence/predictions";
import type { HealthFactor } from "~/lib/intelligence/risk";

const FACTORS: HealthFactor[] = [
  { signal: "payment_latency", deltaPoints: -10, detail: "later" },
  { signal: "tenure", deltaPoints: 5, detail: "long tenure" },
];

describe("hashFactorBands", () => {
  it("is deterministic for the same factors", () => {
    expect(hashFactorBands(FACTORS)).toBe(hashFactorBands(FACTORS));
  });

  it("is order-independent (sorts by signal first)", () => {
    const reversed = [...FACTORS].reverse();
    expect(hashFactorBands(FACTORS)).toBe(hashFactorBands(reversed));
  });

  it("differs when the factors differ", () => {
    const other: HealthFactor[] = [{ signal: "tenure", deltaPoints: 999, detail: "x" }];
    expect(hashFactorBands(FACTORS)).not.toBe(hashFactorBands(other));
  });

  it("is stable for no factors (the honest-baseline case)", () => {
    expect(hashFactorBands([])).toBe(hashFactorBands([]));
  });
});

describe("buildPredictionFields", () => {
  it("carries the score and horizon through, leaving realizedOutcome unset", () => {
    const predictedAt = new Date("2026-07-20T00:00:00.000Z");
    const fields = buildPredictionFields({
      accountId: "acct_1",
      stripeCustomerId: "cus_1",
      score: 42,
      factors: FACTORS,
      horizonDays: 30,
      predictedAt,
    });
    expect(fields).toEqual({
      accountId: "acct_1",
      stripeCustomerId: "cus_1",
      score: 42,
      bandEvidenceHash: hashFactorBands(FACTORS),
      horizonDays: 30,
      predictedAt,
    });
    expect(fields).not.toHaveProperty("realizedOutcome");
  });
});
