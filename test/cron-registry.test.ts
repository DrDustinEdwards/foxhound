import { describe, expect, it } from "vitest";

import { CRON_JOBS, jobsForSchedule } from "~/lib/cron/registry";
import { CRON_SCHEDULE_DAILY, CRON_SCHEDULE_MONTHLY } from "~/lib/constants";

// The schedules wired into wrangler.jsonc triggers.crons. A job on any other
// schedule would never fire, so this list is the contract the registry must honor.
const WRANGLER_CRONS = ["0 3 * * *", "0 4 1 * *"];

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
  });

  it("dispatches billing on the monthly schedule and retention on the daily one", () => {
    const monthly = jobsForSchedule(CRON_SCHEDULE_MONTHLY);
    expect(monthly.map((j) => j.name)).toEqual(["billing-monthly"]);

    const daily = jobsForSchedule(CRON_SCHEDULE_DAILY);
    expect(daily.every((j) => j.name.startsWith("retention-"))).toBe(true);
    expect(daily.length).toBeGreaterThanOrEqual(8);
  });

  it("an unregistered schedule dispatches nothing", () => {
    expect(jobsForSchedule("*/5 * * * *")).toEqual([]);
  });
});
