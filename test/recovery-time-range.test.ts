import { describe, expect, it } from "vitest";

import { isPaymentTimeRange, resolvePaymentTimeRangeCutoff } from "~/lib/recovery/time-range";

const NOW = new Date("2026-07-24T15:30:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolvePaymentTimeRangeCutoff", () => {
  it("'all' has no cutoff", () => {
    expect(resolvePaymentTimeRangeCutoff("all", NOW)).toBeNull();
  });

  it("'today' is the start of the current UTC day", () => {
    expect(resolvePaymentTimeRangeCutoff("today", NOW)).toBe(Date.UTC(2026, 6, 24));
  });

  it("'7d' / '30d' / '90d' are N days back from now", () => {
    expect(resolvePaymentTimeRangeCutoff("7d", NOW)).toBe(NOW - 7 * DAY_MS);
    expect(resolvePaymentTimeRangeCutoff("30d", NOW)).toBe(NOW - 30 * DAY_MS);
    expect(resolvePaymentTimeRangeCutoff("90d", NOW)).toBe(NOW - 90 * DAY_MS);
  });
});

describe("isPaymentTimeRange", () => {
  it("accepts every real range and rejects garbage", () => {
    expect(isPaymentTimeRange("all")).toBe(true);
    expect(isPaymentTimeRange("today")).toBe(true);
    expect(isPaymentTimeRange("7d")).toBe(true);
    expect(isPaymentTimeRange("nonsense")).toBe(false);
    expect(isPaymentTimeRange("")).toBe(false);
  });
});
