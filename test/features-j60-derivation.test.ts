import { describe, expect, it, vi } from "vitest";

// J60 review: every cadence word on /features is read from the schedule its
// job runs on, and the health-band example scores follow the thresholds. The
// constants are moved here so a typed "Nightly" or "monthly", or a typed
// example score, has nothing to hide behind.
vi.mock("~/lib/constants", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/constants")>();
  return {
    ...real,
    CRON_SCHEDULE_DAILY: "0 3 * * 2",
    CRON_SCHEDULE_MONTHLY: "0 4 * * 3",
    CRON_SCHEDULE_MONTHLY_AUDIT: "0 9 * * 4",
    HEALTH_SCORE_AT_RISK_THRESHOLD: 60,
  };
});

const { featureSections, healthBandExampleScores } = await import("~/lib/marketing/features-content");
const { healthScoreBand } = await import("~/lib/intelligence/health-band");

describe("/features derivation (J60 review)", () => {
  it("says no cadence the schedules no longer carry", () => {
    const text = featureSections({ cronJobCount: 1, merchantMcpToolCount: 1 })
      .flatMap((s) => s.features.flatMap((f) => [f.name, f.description]))
      .join("\n");
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toMatch(/Weekly expiring card alerts/);
    expect(text).not.toMatch(/nightly|monthly|each night/i);
  });

  it("puts each example score in its own band when the thresholds move", () => {
    const scores = healthBandExampleScores();
    expect(scores.map((s) => healthScoreBand(s))).toEqual(["at_risk", "watch", "healthy"]);
    expect(scores).not.toEqual([20, 50, 82]);
  });
});
