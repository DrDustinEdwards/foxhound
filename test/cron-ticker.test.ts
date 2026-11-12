import { describe, expect, it } from "vitest";

import { CRON_SCHEDULE_RECOVERY_TICK, RECOVERY_TICK_CRON_NAME } from "~/lib/constants";
import { DISPUTE_REMINDERS_CRON_NAME } from "~/lib/cron/dispute-reminders";
import { jobsForSchedule } from "~/lib/cron/registry";
import { runTickerJobs } from "~/lib/cron/ticker";

// The ticker's jobs run through runScheduledJobs; the alarm itself is site-runtime's CronTicker.

describe("five-minute ticker", () => {
  it("runs every */5 job through runScheduledJobs", async () => {
    const log: string[] = [];
    const env = {} as Env;
    const jobs = jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK);
    await runTickerJobs(env, {
      jobs: async () => jobs,
      run: async (e, ran) => {
        expect(e).toBe(env);
        log.push(...ran.map((j) => `run:${j.name}`));
      },
    });
    expect(log).toEqual([
      `run:${RECOVERY_TICK_CRON_NAME}`,
      "run:winback-send",
      `run:${DISPUTE_REMINDERS_CRON_NAME}`,
      "run:alerts-evaluate",
    ]);
  });
});
