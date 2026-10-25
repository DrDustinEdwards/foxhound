import { describe, expect, it } from "vitest";

import { CRON_SCHEDULE_RECOVERY_TICK, CRON_TICKER_INTERVAL_MS, RECOVERY_TICK_CRON_NAME } from "~/lib/constants";
import { DISPUTE_REMINDERS_CRON_NAME } from "~/lib/cron/dispute-reminders";
import { jobsForSchedule } from "~/lib/cron/registry";
import { armTickerIfIdle, runTickerAlarm, type TickerAlarmStorage } from "~/lib/cron/ticker";

// The five-minute ticker runs the "*/5 * * * *" jobs from a Durable Object
// alarm because Cloudflare stopped firing that trigger on 2026-10-23. Two
// things have to hold: the alarm re-arms BEFORE any job runs, so no failure in
// a job can end the chain, and an arm while an alarm is pending leaves it
// alone, so frequent queue batches cannot keep postponing the next tick.

function fakeStorage(log: string[], initial: number | null = null): TickerAlarmStorage {
  let alarm = initial;
  return {
    getAlarm: async () => alarm,
    setAlarm: async (t) => {
      alarm = t;
      log.push(`setAlarm:${t}`);
    },
  };
}

describe("five-minute ticker", () => {
  it("re-arms first, then runs every */5 job through runCronJob", async () => {
    const log: string[] = [];
    const env = {} as Env;
    const now = 1_000_000;
    const jobs = jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK);
    await runTickerAlarm(env, fakeStorage(log), {
      now: () => now,
      jobs: async () => jobs,
      run: async (e, name, handler) => {
        expect(e).toBe(env);
        expect(handler).toBe(jobs.find((j) => j.name === name)?.handler);
        log.push(`run:${name}`);
        return { cronName: name, status: "success", rowsProcessed: 0 };
      },
    });
    expect(log).toEqual([
      `setAlarm:${now + CRON_TICKER_INTERVAL_MS}`,
      `run:${RECOVERY_TICK_CRON_NAME}`,
      "run:winback-send",
      `run:${DISPUTE_REMINDERS_CRON_NAME}`,
    ]);
  });

  it("arms only when no alarm is pending", async () => {
    const log: string[] = [];
    expect(await armTickerIfIdle(fakeStorage(log, 42), 0)).toBe(false);
    expect(await armTickerIfIdle(fakeStorage(log), 0)).toBe(true);
    expect(log).toEqual([`setAlarm:${CRON_TICKER_INTERVAL_MS}`]);
  });
});
