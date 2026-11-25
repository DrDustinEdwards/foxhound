import { describe, expect, it } from "vitest";

import { recoveryRateBand } from "~/lib/dashboard/recovery-rate";

describe("recoveryRateBand", () => {
  it("names the band at and around each boundary", () => {
    expect(recoveryRateBand(0)).toBe("Below target");
    expect(recoveryRateBand(20)).toBe("Below target");
    expect(recoveryRateBand(21)).toBe("Near target");
    expect(recoveryRateBand(35)).toBe("Near target");
    expect(recoveryRateBand(36)).toBe("Above target");
    expect(recoveryRateBand(100)).toBe("Above target");
  });

  it("distinguishes no-history from a genuine zero", () => {
    expect(recoveryRateBand(null)).toBe("No failures yet");
  });
});
