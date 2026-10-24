import { describe, expect, it } from "vitest";

import {
  breachesThreshold,
} from "~/lib/intelligence/alerts";

describe("breachesThreshold", () => {
  it("breaches 'above' when actual exceeds threshold", () => {
    expect(breachesThreshold("above", 51, 50)).toBe(true);
    expect(breachesThreshold("above", 50, 50)).toBe(false);
    expect(breachesThreshold("above", 49, 50)).toBe(false);
  });

  it("breaches 'below' when actual is under threshold", () => {
    expect(breachesThreshold("below", 39, 40)).toBe(true);
    expect(breachesThreshold("below", 40, 40)).toBe(false);
    expect(breachesThreshold("below", 41, 40)).toBe(false);
  });
});
