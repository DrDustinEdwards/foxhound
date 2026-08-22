import { describe, expect, it } from "vitest";

import { CRON_JOBS, jobsForSchedule } from "~/lib/cron/registry";
import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_RECOVERY_TICK,
} from "~/lib/constants";

// The schedules wired into wrangler.jsonc triggers.crons. A job on any other
// schedule would never fire, so this list is the contract the registry must honor.
const WRANGLER_CRONS = ["*/5 * * * *", "0 3 * * *", "0 4 1 * *"];

describe("cron registry", () => {
  it("job names are unique", () => {
    const names = CRON_JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every job schedule is wired in wrangler triggers.crons", () => {
    for (const job of CRON_JOBS) {
      expect(WRANGLER_CRONS).toContain(job.schedule);
    }
  });

  it("the schedule constants match wrangler triggers", () => {
    expect(WRANGLER_CRONS).toContain(CRON_SCHEDULE_DAILY);
    expect(WRANGLER_CRONS).toContain(CRON_SCHEDULE_MONTHLY);
    expect(WRANGLER_CRONS).toContain(CRON_SCHEDULE_RECOVERY_TICK);
  });

  it("dispatches billing, intelligence sync and the audit digest on the monthly schedule, intelligence AI + retention on the daily one", () => {
    const monthly = jobsForSchedule(CRON_SCHEDULE_MONTHLY);
    expect(monthly.map((j) => j.name)).toEqual([
      "billing-monthly",
      "intelligence-sync",
      "audit-digest",
    ]);

    const daily = jobsForSchedule(CRON_SCHEDULE_DAILY);
    expect(daily.map((j) => j.name)).toContain("intelligence-ai");
    expect(daily.filter((j) => j.name.startsWith("retention-")).length).toBeGreaterThanOrEqual(8);
  });

  it("dispatches the demo reset on the daily schedule", () => {
    const daily = jobsForSchedule(CRON_SCHEDULE_DAILY);
    expect(daily.map((j) => j.name)).toContain("demo-reset");
  });

  it("dispatches the recovery tick and the win-back send on the high-cadence schedule", () => {
    // Kept STRICT rather than relaxed to toContain, so a third job arriving on
    // the highest-cadence schedule still trips this. win-back shares it because
    // legacy's own cron piggybacks on the recovery schedule (343, 344).
    const tick = jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK);
    expect(tick.map((j) => j.name)).toEqual(["recovery-tick", "winback-send"]);
  });

  it("an unregistered schedule dispatches nothing", () => {
    expect(jobsForSchedule("*/7 * * * *")).toEqual([]);
  });
});
