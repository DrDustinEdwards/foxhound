import { describe, expect, it } from "vitest";

import { recoveryRateTone } from "~/lib/dashboard/recovery-rate";

describe("recoveryRateTone", () => {
  it("bands per DESIGN.md thresholds (0-20 red, 21-35 teal brand accent, 36+ green)", () => {
    expect(recoveryRateTone(0)).toBe("red");
    expect(recoveryRateTone(20)).toBe("red");
    expect(recoveryRateTone(21)).toBe("brand");
    expect(recoveryRateTone(35)).toBe("brand");
    expect(recoveryRateTone(36)).toBe("green");
    expect(recoveryRateTone(100)).toBe("green");
  });
});
