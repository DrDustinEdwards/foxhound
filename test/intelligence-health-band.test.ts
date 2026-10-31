import { describe, expect, it } from "vitest";

import { healthScoreMeterTone } from "~/lib/intelligence/health-band";

describe("healthScoreMeterTone", () => {
  it("maps bands to meter tones", () => {
    expect(healthScoreMeterTone(10)).toBe("crit");
    expect(healthScoreMeterTone(50)).toBe("warn");
    expect(healthScoreMeterTone(90)).toBe("ok");
  });
});
