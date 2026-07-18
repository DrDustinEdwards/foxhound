import { describe, expect, it } from "vitest";

import { summarizeSequence } from "~/lib/recovery/sequence-summary";

const at = (h: number) => new Date(2026, 0, 1, h);

describe("summarizeSequence", () => {
  it("counts completed steps and finds the next due step in order", () => {
    const summary = summarizeSequence([
      { stepNumber: 2, stepType: "email_day1", scheduledAt: at(2), executedAt: null },
      { stepNumber: 1, stepType: "retry_early", scheduledAt: at(1), executedAt: at(1) },
      { stepNumber: 3, stepType: "email_day3", scheduledAt: at(3), executedAt: null },
    ]);
    expect(summary.completedCount).toBe(1);
    expect(summary.totalCount).toBe(3);
    expect(summary.nextStep?.stepNumber).toBe(2);
  });

  it("nextStep is null once every step has executed", () => {
    const summary = summarizeSequence([
      { stepNumber: 1, stepType: "retry_early", scheduledAt: at(1), executedAt: at(1) },
      { stepNumber: 2, stepType: "email_day1", scheduledAt: at(2), executedAt: at(2) },
    ]);
    expect(summary.nextStep).toBeNull();
  });

  it("handles an empty sequence", () => {
    const summary = summarizeSequence([]);
    expect(summary).toEqual({ completedCount: 0, totalCount: 0, nextStep: null });
  });
});
