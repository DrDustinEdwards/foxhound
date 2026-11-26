import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { CRON_JOBS, jobsForSchedule } from "~/lib/cron/registry";

import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  CRON_SCHEDULE_RECOVERY_TICK,
} from "~/lib/constants";

// Schedules are read from wrangler.jsonc triggers.crons, so the check fails in both directions.
const WRANGLER_CRONS: string[] = (() => {
  const raw = readFileSync("wrangler.jsonc", "utf8");
  // JSONC: drop whole-line comments only (a blanket "//" strip would eat https://).
  const stripped = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return (JSON.parse(stripped) as { triggers?: { crons?: string[] } }).triggers?.crons ?? [];
})();

describe("cron registry", () => {
  it("job names are unique", () => {
    const names = CRON_JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every job schedule is wired in wrangler triggers.crons", () => {
    for (const job of CRON_JOBS) {
      expect(WRANGLER_CRONS, `${job.name} would never fire`).toContain(job.schedule);
    }
  });

  it("every wired trigger has a job, so a dead cron expression is caught", () => {
    const scheduled = new Set(CRON_JOBS.map((j) => j.schedule));
    for (const cron of WRANGLER_CRONS) {
      expect(scheduled, `${cron} wakes the Worker and dispatches nothing`).toContain(cron);
    }
  });

  it("dispatches billing on the monthly schedule, intelligence sync, AI + retention on the daily one", () => {
    const monthly = jobsForSchedule(CRON_SCHEDULE_MONTHLY);
    expect(monthly.map((j) => j.name)).toEqual(["billing-monthly"]);

    const daily = jobsForSchedule(CRON_SCHEDULE_DAILY);
    // The sync writes today's snapshot before the AI run reads it.
    const names = daily.map((j) => j.name);
    expect(names.indexOf("intelligence-sync")).toBeGreaterThan(-1);
    expect(names.indexOf("intelligence-sync")).toBeLessThan(names.indexOf("intelligence-ai"));
    expect(names).toContain("retention");
    expect(names).toContain("backup");
  });

  it("the monthly audit has its schedule to itself", () => {
    expect(jobsForSchedule(CRON_SCHEDULE_MONTHLY_AUDIT).map((j) => j.name)).toEqual([
      "monthly-audit",
    ]);
  });

  it("dispatches the recovery tick, the win-back send, alerts and the dispute reminder on the high-cadence schedule", () => {
    const tick = jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK);
    expect(tick.map((j) => j.name)).toEqual([
      "recovery-tick",
      "winback-send",
      "dispute-reminders",
      "alerts-evaluate",
    ]);
  });
});
