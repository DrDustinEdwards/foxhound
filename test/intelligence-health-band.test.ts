import { describe, expect, it } from "vitest";

import { healthScoreBand, healthScoreMeterTone } from "~/lib/intelligence/health-band";

describe("healthScoreBand", () => {
  it("bands at-risk below the threshold", () => {
    expect(healthScoreBand(0)).toBe("at_risk");
    expect(healthScoreBand(39)).toBe("at_risk");
  });

  it("bands watch between at-risk and healthy", () => {
    expect(healthScoreBand(40)).toBe("watch");
    expect(healthScoreBand(69)).toBe("watch");
  });

  it("bands healthy at and above the ceiling", () => {
    expect(healthScoreBand(70)).toBe("healthy");
    expect(healthScoreBand(100)).toBe("healthy");
  });
});

describe("healthScoreMeterTone", () => {
  it("maps bands to meter tones", () => {
    expect(healthScoreMeterTone(10)).toBe("negative");
    expect(healthScoreMeterTone(50)).toBe("caution");
    expect(healthScoreMeterTone(90)).toBe("positive");
  });
});
