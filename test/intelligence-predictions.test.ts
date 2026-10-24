import { describe, expect, it } from "vitest";

import { hashFactorBands } from "~/lib/intelligence/predictions";
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
