import { describe, expect, it } from "vitest";

import {
  firstSnapshotSentence,
  narrativeErrorMessage,
  nextScheduledRun,
  planBreakdownRows,
} from "~/lib/intelligence/dashboard";

// J67, row S16: the Intelligence dashboard toward Recova's real page,
// app/(app)/intelligence/dashboard/page.tsx at blob cbe7e8fe, and its seven
// components (MRRStatCards 2920fa3b, MRRTrendChart c7a0da3f, NRRChart
// b07e9de3, MRRMovementChart 3c94525e, PlanBreakdown 65b5674f,
// HealthDistributionChart cd7dd675, MonthlyNarrative 791e2f5f), all read whole.
//
// Recova's order inside a 1280px column: the head ("Dashboard", "MRR trends and
// customer health"), four stat cards, MRR trend, NRR, MRR movement, MRR by
// plan, customer health distribution, then the monthly summary with its month
// pager and Generate/Regenerate button. Charts are Enarratio's (Q1), parts are
// Capsomer's (Q10), amber throughout. Foxhound's own at-risk table is held
// for Dustin and stays exactly as it was, after the summary.
//
// Two of Recova's four stats are numbers Foxhound's engine does not compute
// (RULES.md 2.1 and the job's stop rule): "Day-over-day" needs a daily
// snapshot and "New MRR (MTD)" a month-to-date one, and intelligence-sync
// snapshots once a month. Those cards say so instead of showing a number.














describe("S16 charts: Enarratio, with Recova's legends and a text equivalent, no tooltips", () => {

  it("sorts plans by MRR, largest first, with no engine placeholder shown raw", () => {
    const rows = planBreakdownRows({ Starter: 200_000, Scale: 600_000, unknown: 50_000, Growth: 300_000, Free: 0 });
    expect(rows).toEqual([
      { plan: "Scale", mrrCents: 600_000 },
      { plan: "Growth", mrrCents: 300_000 },
      { plan: "Starter", mrrCents: 200_000 },
      { plan: "Unknown plan", mrrCents: 50_000 },
    ]);
    expect(planBreakdownRows([])).toEqual([]);
    expect(planBreakdownRows(null)).toEqual([]);
  });
});

describe("S16 empty state: Recova's syncing card, with Foxhound's real schedule", () => {

  it("derives the next run from the cron schedule, not a typed date", () => {
    expect(nextScheduledRun("0 4 1 * *", Date.UTC(2026, 9, 15)).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(nextScheduledRun("0 4 1 * *", Date.UTC(2026, 9, 1, 3, 59)).toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(nextScheduledRun("0 4 1 * *", Date.UTC(2026, 11, 1, 4, 1)).toISOString()).toBe("2027-01-01T04:00:00.000Z");
    expect(firstSnapshotSentence(Date.UTC(2026, 9, 15))).toBe(
      "The first snapshot runs on November 1 at 04:00 UTC. Check back after it runs.",
    );
    expect(() => nextScheduledRun("*/5 * * * *", 0)).toThrow();
  });
});

describe("S16 monthly summary: Recova's pager and Generate/Regenerate button", () => {

  it("speaks every failure, including a missing or unfunded AI key, never silently", () => {
    expect(narrativeErrorMessage("rate_limited")).toBe("You hit the hourly generation limit. Try again later.");
    expect(narrativeErrorMessage("invalid_month")).toBe("Invalid month.");
    expect(narrativeErrorMessage("generation_failed")).toBe("Generation failed. Please try again.");
    // Recova's server-500 sentence for an error thrown on the server; its
    // "Network error." was for a request that never got an answer.
    expect(narrativeErrorMessage("server_error")).toBe("Could not generate the report. Try again or contact support.");
    expect(narrativeErrorMessage("server_error")).not.toMatch(/Network error/);
    expect(narrativeErrorMessage("limiter_unavailable")).toBe("Reports cannot be generated right now. Try again shortly.");
    expect(narrativeErrorMessage("ai_not_configured")).toMatch(/AI analyst is not set up/);
    expect(narrativeErrorMessage("ai_no_credit")).toMatch(/out of credit/);
    expect(narrativeErrorMessage(undefined)).toBe("Could not generate the report. Try again or contact support.");
  });
});
