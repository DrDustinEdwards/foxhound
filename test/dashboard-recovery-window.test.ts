import { describe, expect, it } from "vitest";

import {
  bestCategory,
  categorySparklineWindow,
  classifyWebhookHealth,
  countByDay,
  countByDayAndCategory,
  cumulativeRecoveryRateDaily,
  dayKey,
  formatRelativeTime,
  recoveryTimingBuckets,
  resolveRangeCutoff,
  sumCentsByDayWindow,
} from "~/lib/dashboard/recovery-window";

// TASK-foxhound-recovery-surface-parity.md Phase 1: unit tests on the
// aggregation math, per the task's explicit requirement. Every function here
// is pure (no DB), so these are precise, edge-case-driven tests rather than
// integration smoke tests.

const NOW = new Date("2026-07-21T12:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveRangeCutoff", () => {
  it("7d: cutoff 7 days back, spans 7 days", () => {
    const r = resolveRangeCutoff("7d", NOW);
    expect(r.cutoffMs).toBe(NOW - 7 * DAY_MS);
    expect(r.rangeDays).toBe(7);
    expect(r.rangeLabel).toBe("7d");
  });

  it("90d: cutoff 90 days back, spans 90 days", () => {
    const r = resolveRangeCutoff("90d", NOW);
    expect(r.cutoffMs).toBe(NOW - 90 * DAY_MS);
    expect(r.rangeDays).toBe(90);
    expect(r.rangeLabel).toBe("90d");
  });

  it("all: no cutoff, spans 90 days of chart, labeled 'all time'", () => {
    const r = resolveRangeCutoff("all", NOW);
    expect(r.cutoffMs).toBeNull();
    expect(r.rangeDays).toBe(90);
    expect(r.rangeLabel).toBe("all time");
  });
});

describe("dayKey / countByDay", () => {

  it("counts occurrences per day", () => {
    const counts = countByDay([
      new Date("2026-07-20T01:00:00.000Z"),
      new Date("2026-07-20T02:00:00.000Z"),
      new Date("2026-07-21T01:00:00.000Z"),
    ]);
    expect(counts.get("2026-07-20")).toBe(2);
    expect(counts.get("2026-07-21")).toBe(1);
    expect(counts.get("2026-07-19")).toBeUndefined();
  });
});

describe("countByDayAndCategory", () => {
  it("splits counts per category per day", () => {
    const byCat = countByDayAndCategory([
      { detectedAt: new Date("2026-07-20T00:00:00.000Z"), declineCategory: "soft" },
      { detectedAt: new Date("2026-07-20T00:00:00.000Z"), declineCategory: "soft" },
      { detectedAt: new Date("2026-07-20T00:00:00.000Z"), declineCategory: "fraud" },
    ]);
    expect(byCat.soft.get("2026-07-20")).toBe(2);
    expect(byCat.fraud.get("2026-07-20")).toBe(1);
    expect(byCat.network).toBeUndefined();
  });
});

describe("cumulativeRecoveryRateDaily", () => {

  it("is cumulative, not same-day: a recovery on day 2 for a day-0 failure never exceeds 100%", () => {
    const today = dayKey(new Date(NOW));
    const yesterday = dayKey(new Date(NOW - DAY_MS));
    const twoDaysAgo = dayKey(new Date(NOW - 2 * DAY_MS));
    // 1 failure on day -2, 1 recovery on day -1 (for that same failure).
    // A same-day rate would show day -1 as 100% recovered of 0 failures
    // that day (undefined/infinite); the cumulative version tracks the
    // running totals instead.
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

  it("picks the highest rate among qualifying categories", () => {
    const winner = bestCategory({
      soft: { total: 4, recovered: 2 }, // 50%
      fraud: { total: 3, recovered: 3 }, // 100%
    });
    expect(winner?.cat).toBe("fraud");
    expect(winner?.rate).toBe(100);
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

describe("sumCentsByDayWindow", () => {
  it("sums same-day amounts and zero-fills days with nothing", () => {
    const points = sumCentsByDayWindow(
      [
        { date: new Date(NOW), cents: 500 },
        { date: new Date(NOW), cents: 250 },
      ],
      3,
      NOW,
    );
    expect(points).toHaveLength(3);
    expect(points[2].cents).toBe(750); // today
    expect(points[0].cents).toBe(0);
    expect(points[1].cents).toBe(0);
  });
});

describe("formatRelativeTime", () => {

  it("1 day back -> Yesterday", () => {
    expect(formatRelativeTime(new Date(NOW - DAY_MS - 60_000), NOW)).toBe("Yesterday");
  });

  it("30+ days -> Nmo ago", () => {
    expect(formatRelativeTime(new Date(NOW - 31 * DAY_MS), NOW)).toBe("1mo ago");
    expect(formatRelativeTime(new Date(NOW - 65 * DAY_MS), NOW)).toBe("2mo ago");
  });
});
