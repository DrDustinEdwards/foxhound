import { describe, expect, it } from "vitest";

import { recoveryRateBand } from "~/lib/dashboard/recovery-rate";

describe("recoveryRateBand", () => {
  // Thresholds are DESIGN.md canon: 0-20 red, 21-35 caution, 36+ green.
  it("names the band at and around each boundary", () => {
    expect(recoveryRateBand(0)).toBe("Below target");
    expect(recoveryRateBand(20)).toBe("Below target");
    expect(recoveryRateBand(21)).toBe("Near target");
    expect(recoveryRateBand(35)).toBe("Near target");
    expect(recoveryRateBand(36)).toBe("Above target");
    expect(recoveryRateBand(100)).toBe("Above target");
  });

  // No failures is not the same as a 0% rate: nothing has failed, so there is
  // no rate to judge and "Below target" would be a false accusation.
  it("distinguishes no-history from a genuine zero", () => {
    expect(recoveryRateBand(null)).toBe("No failures yet");
    expect(recoveryRateBand(null)).not.toBe(recoveryRateBand(0));
  });
});
