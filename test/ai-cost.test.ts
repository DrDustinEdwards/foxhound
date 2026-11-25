import { describe, expect, it } from "vitest";

import { computeAiCallCostCents } from "~/lib/ai/cost";
import * as constants from "~/lib/constants";

describe("every model Foxhound calls has a price", () => {
  it("prices each MODEL_* constant from site-runtime's table and throws on an unpriced model", () => {
    const models = Object.entries(constants).filter(([name]) => name.startsWith("MODEL_"));
    expect(models.length).toBeGreaterThan(0);
    for (const [, id] of models)
      expect(() => computeAiCallCostCents(String(id), 1, 1)).not.toThrow();
    expect(() => computeAiCallCostCents("claude-unknown-9", 1, 1)).toThrow(/no ai_calls price/);
  });
});
