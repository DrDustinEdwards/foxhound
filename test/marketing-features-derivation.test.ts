import { describe, expect, it, vi } from "vitest";

// Every cadence word on /features is read from the schedule its job runs on, not typed.
vi.mock("~/lib/constants", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/constants")>();
  return {
    ...real,
    CRON_SCHEDULE_DAILY: "0 3 * * 2",
    CRON_SCHEDULE_MONTHLY: "0 4 * * 3",
    CRON_SCHEDULE_MONTHLY_AUDIT: "0 9 * * 4",
    CRON_SCHEDULE_EXPIRING_CARDS: "0 9 * * 5",
    HEALTH_SCORE_AT_RISK_THRESHOLD: 60,
  };
});

const { featureSections, healthBandExampleScores } =
  await import("~/lib/marketing/features-content");
const { healthScoreBand } = await import("~/lib/intelligence/health-band");

describe("/features derivation", () => {
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
