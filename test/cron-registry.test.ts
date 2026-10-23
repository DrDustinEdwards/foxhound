import { describe, expect, it } from "vitest";

import { CRON_JOBS, jobsForSchedule } from "~/lib/cron/registry";
import { readFileSync } from "node:fs";

import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
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

  it("the schedule constants match wrangler triggers", () => {
    expect(WRANGLER_CRONS).toContain(CRON_SCHEDULE_DAILY);
    expect(WRANGLER_CRONS).toContain(CRON_SCHEDULE_MONTHLY);
    expect(WRANGLER_CRONS).toContain(CRON_SCHEDULE_MONTHLY_AUDIT);
    expect(WRANGLER_CRONS).toContain(CRON_SCHEDULE_RECOVERY_TICK);
  });

  it("dispatches billing and intelligence sync on the monthly schedule, intelligence AI + retention on the daily one", () => {
    // THE AUDIT DIGEST LEFT THIS LIST IN PHASE (g), and this assertion catching
    // it is the guard working. 362 ruling 3 merged its send into the monthly
    // audit and moved the merged job to legacy's own 09:00 hour, so the 04:00
    // slot is back to the two jobs that were there before 316.
    const monthly = jobsForSchedule(CRON_SCHEDULE_MONTHLY);
    expect(monthly.map((j) => j.name)).toEqual(["billing-monthly", "intelligence-sync"]);
    expect(monthly.map((j) => j.name)).not.toContain("audit-digest");

    const daily = jobsForSchedule(CRON_SCHEDULE_DAILY);
    expect(daily.map((j) => j.name)).toContain("intelligence-ai");
    expect(daily.filter((j) => j.name.startsWith("retention-")).length).toBeGreaterThanOrEqual(8);
  });

  it("and the merged monthly audit has LEGACY'S HOUR to itself", () => {
    // Kept STRICT rather than relaxed to toContain: a second job arriving on
    // this expression would be a second per-account Stripe walk on the same
    // minute, which is the collision moving off 04:00 was meant to avoid.
    expect(jobsForSchedule(CRON_SCHEDULE_MONTHLY_AUDIT).map((j) => j.name)).toEqual([
      "monthly-audit",
    ]);
  });

  it("dispatches the demo reset on the daily schedule", () => {
    const daily = jobsForSchedule(CRON_SCHEDULE_DAILY);
    expect(daily.map((j) => j.name)).toContain("demo-reset");
  });

  it("dispatches the recovery tick, the win-back send and the dispute reminder on the high-cadence schedule", () => {
    // Kept STRICT rather than relaxed to toContain, so a fourth job arriving on
    // the highest-cadence schedule still trips this. win-back shares it because
    // legacy's own cron piggybacks on the recovery schedule (343, 344); the
    // dispute reminder (J06) because legacy's process-disputes ran hourly and a
    // new expression would need its own cron-health period.
    const tick = jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK);
    expect(tick.map((j) => j.name)).toEqual(["recovery-tick", "winback-send", "dispute-reminders"]);
  });

  it("an unregistered schedule dispatches nothing", () => {
    expect(jobsForSchedule("*/7 * * * *")).toEqual([]);
  });
});
