import { describe, expect, it } from "vitest";

import { computeAiCallCostCents } from "~/lib/ai/cost";
import * as constants from "~/lib/constants";

describe("R-49: every model Foxhound calls has a price", () => {
  it("prices each MODEL_* constant from site-runtime's table and throws on an unpriced model", () => {
    const models = Object.entries(constants).filter(([name]) => name.startsWith("MODEL_"));
    expect(models.length).toBeGreaterThan(0);
    for (const [, id] of models)
      expect(() => computeAiCallCostCents(String(id), 1, 1)).not.toThrow();
    expect(() => computeAiCallCostCents("claude-unknown-9", 1, 1)).toThrow(/no ai_calls price/);
  });

  it("uses the list price: Sonnet 5 is $2 in and $10 out per million tokens", () => {
    expect(computeAiCallCostCents("claude-sonnet-5", 1_000_000, 1_000_000)).toBe(1_200);
  });
});
