import { describe, expect, it } from "vitest";

import {
  aiModelCost,
  computeAiCallCostCents,
} from "~/lib/ai/cost";


describe("R-49: cost map covers every model id", () => {

  it("throws loudly for an uncovered model", () => {
    expect(() => aiModelCost("claude-unknown-9")).toThrow(/no ai_calls cost entry/);
  });
});

describe("cost math", () => {
  it("computes cents from per-1M rates", () => {
    // Sonnet 5: 300 cents/1M in, 1500 cents/1M out.
    // 1,000,000 in + 1,000,000 out = 300 + 1500 = 1800 cents.
    expect(computeAiCallCostCents("claude-sonnet-5", 1_000_000, 1_000_000)).toBe(1_800);
    // Haiku (dated alias): 100 in + 500 out per 1M -> 600 cents at 1M each.
    expect(computeAiCallCostCents("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBe(600);
  });
});
