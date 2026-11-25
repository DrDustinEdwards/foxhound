import { dayKey } from "@dustinedwards/site-runtime/time";
import { describe, expect, it } from "vitest";

import {
  bestCategory,
  categorySparklineWindow,
  classifyWebhookHealth,
  countByDayAndCategory,
  cumulativeRecoveryRateDaily,
  recoveryTimingBuckets,
  resolveRangeCutoff,
} from "~/lib/dashboard/recovery-window";

const NOW = new Date("2026-07-21T12:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveRangeCutoff", () => {
  it("all: no cutoff, spans 90 days of chart", () => {
    const r = resolveRangeCutoff("all", NOW);
    expect(r.cutoffMs).toBeNull();
    expect(r.rangeDays).toBe(90);
  });
});

describe("cumulativeRecoveryRateDaily", () => {
  it("is cumulative, not same-day: a recovery on day 2 for a day-0 failure never exceeds 100%", () => {
    const today = dayKey(new Date(NOW));
    const yesterday = dayKey(new Date(NOW - DAY_MS));
    const twoDaysAgo = dayKey(new Date(NOW - 2 * DAY_MS));
    const failedByDay = new Map([[twoDaysAgo, 1]]);
    const recoveredByDay = new Map([[yesterday, 1]]);
    const points = cumulativeRecoveryRateDaily(failedByDay, recoveredByDay, 3, NOW);
    const byDate = Object.fromEntries(points.map((p) => [p.date, p.rate]));
    expect(byDate[twoDaysAgo]).toBe(0); // 0 recovered / 1 failed so far
    expect(byDate[yesterday]).toBe(100); // 1 recovered / 1 failed cumulative
    expect(byDate[today]).toBe(100); // unchanged, still 1/1
    for (const rate of Object.values(byDate)) {
      expect(rate).toBeLessThanOrEqual(100);
    }
  });
});

describe("categorySparklineWindow", () => {
  it("a failure inside the window shows up on its exact day", () => {
    const target = new Date(NOW - 5 * DAY_MS);
    const byCat = countByDayAndCategory([{ detectedAt: target, declineCategory: "fraud" }]);
    const sparkline = categorySparklineWindow(byCat, NOW);
    const point = sparkline.fraud.find((p) => p.date === dayKey(target));
    expect(point?.count).toBe(1);
  });
});

describe("recoveryTimingBuckets", () => {
  it("buckets Day 1 / Day 3 / Day 7 / Day 8+ with percentages summing to 100", () => {
    const buckets = recoveryTimingBuckets([0.5, 1, 2, 3, 5, 7, 10, 30]);
    const byName = Object.fromEntries(buckets.map((b) => [b.dayBucket, b]));
    expect(byName["Day 1"].count).toBe(2); // 0.5, 1
    expect(byName["Day 3"].count).toBe(2); // 2, 3
    expect(byName["Day 7"].count).toBe(2); // 5, 7
    expect(byName["Day 8+"].count).toBe(2); // 10, 30
    expect(buckets.reduce((s, b) => s + b.percentage, 0)).toBe(100);
  });

  it("all buckets are 0% for an empty input, never NaN", () => {
    const buckets = recoveryTimingBuckets([]);
    expect(buckets.every((b) => b.percentage === 0)).toBe(true);
  });
});

describe("bestCategory", () => {
  it("prefers a category clearing the strict threshold (>=3 total, >=2 recovered)", () => {
    const winner = bestCategory({
      soft: { total: 3, recovered: 2 }, // 67%
      network: { total: 5, recovered: 1 }, // fails strict recovered>=2? no, recovered=1 fails
    });
    expect(winner).toEqual({ cat: "soft", rate: 67 });
  });

  it("falls back to >=2 total when nothing clears the strict threshold", () => {
    const winner = bestCategory({
      soft: { total: 2, recovered: 1 }, // 50%, fails strict (needs recovered>=2)
    });
    expect(winner).toEqual({ cat: "soft", rate: 50 });
  });

  it("returns null when nothing clears even the fallback threshold", () => {
    expect(bestCategory({ soft: { total: 1, recovered: 1 } })).toBeNull();
    expect(bestCategory({})).toBeNull();
  });
});

describe("classifyWebhookHealth", () => {
  it("never received: neutral, waiting", () => {
    expect(classifyWebhookHealth(null, NOW).tone).toBe("neutral");
  });

  it("between 1 and 3 days: neutral", () => {
    expect(classifyWebhookHealth(new Date(NOW - 48 * 60 * 60 * 1000), NOW).tone).toBe("neutral");
  });

  it("over 3 days: failure", () => {
    expect(classifyWebhookHealth(new Date(NOW - 100 * 60 * 60 * 1000), NOW).tone).toBe("failure");
  });
});
