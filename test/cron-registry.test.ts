import { describe, expect, it } from "vitest";

import { CRON_JOBS, jobsForSchedule } from "~/lib/cron/registry";
import { readFileSync } from "node:fs";

import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_RECOVERY_TICK,
} from "~/lib/constants";

// The schedules wired into wrangler.jsonc triggers.crons. A job on any other
// schedule would never fire, so this list is the contract the registry must honor.
//
// DERIVED FROM wrangler.jsonc, not transcribed from it. It was a hardcoded
// array until session 55, which is the shape capsid/conventions.md warns about:
// a list mirroring filesystem state that a change has to remember to update, so
// it went stale the moment a fourth trigger was added and the guard reported
// the config as missing an entry the config actually had. Reading the file
// makes the assertion about the real contract and fails in BOTH directions.
const WRANGLER_CRONS: string[] = (() => {
  const raw = readFileSync("wrangler.jsonc", "utf8");
  // JSONC: drop whole-line comments only. A blanket "//" strip would eat the
  // scheme separator inside every https:// value in this file.
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

  it("AND EVERY WIRED TRIGGER HAS A JOB, so a dead cron expression is caught too", () => {
    const scheduled = new Set(CRON_JOBS.map((j) => j.schedule));
    for (const cron of WRANGLER_CRONS) {
      expect(scheduled, `${cron} wakes the Worker and dispatches nothing`).toContain(cron);
    }
  });

  it("the derived list is non-empty, so a parse failure cannot read as a pass", () => {
    expect(WRANGLER_CRONS.length).toBeGreaterThanOrEqual(4);
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
