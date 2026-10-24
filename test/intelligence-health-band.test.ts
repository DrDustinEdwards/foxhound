import { describe, expect, it } from "vitest";

import { healthScoreMeterTone } from "~/lib/intelligence/health-band";

describe("healthScoreMeterTone", () => {
  it("maps bands to meter tones", () => {
    expect(healthScoreMeterTone(10)).toBe("negative");
    expect(healthScoreMeterTone(50)).toBe("caution");
    expect(healthScoreMeterTone(90)).toBe("positive");
  });
});
