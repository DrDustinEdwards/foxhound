import { describe, expect, it } from "vitest";

import { CRON_SCHEDULE_RECOVERY_TICK, RECOVERY_TICK_CRON_NAME } from "~/lib/constants";
import { DISPUTE_REMINDERS_CRON_NAME } from "~/lib/cron/dispute-reminders";
import { jobsForSchedule, type CronJob } from "~/lib/cron/registry";
import { runScheduledJobs } from "~/lib/cron/run";
import { runTickerJobs } from "~/lib/cron/ticker";

// The ticker's jobs run through runCronJob; the alarm itself is site-runtime's CronTicker.

describe("five-minute ticker", () => {
  it("runs every */5 job through runCronJob", async () => {
    const log: string[] = [];
    const env = {} as Env;
    const jobs = jobsForSchedule(CRON_SCHEDULE_RECOVERY_TICK);
    await runTickerJobs(env, {
      jobs: async () => jobs,
      run: async (e, name, handler) => {
        expect(e).toBe(env);
        expect(typeof handler).toBe("function");
        log.push(`run:${name}`);
        return { cronName: name, status: "success", rowsProcessed: 0 };
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

// cron_runs is what /health's cronCheck reads. A job the gates skip (disabled,
// not due, locked) used to be recorded there as a success it never had, so a
// disabled job looked healthy forever. Only a run that executes is recorded;
// a skip writes nothing, and a failure before the handler is recorded failed.

function fakeDb() {
  const writes: Array<{ sql: string; name: unknown }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          writes.push({ sql, name: values[0] });
        },
        all: async () => ({ results: [] }),
      }),
    }),
  };
  return { env: { DB: db } as unknown as Env, writes };
}

const job = (name: string): CronJob => ({
  name,
  schedule: "0 3 * * *",
  handler: async () => ({ rowsProcessed: 1 }),
});

const kinds = (writes: Array<{ sql: string; name: unknown }>) =>
  writes.map(
    (w) =>
      `${String(w.name)}:${w.sql.includes("last_ok_at)") ? "ok" : w.sql.includes("last_failed_at") ? "failed" : "started"}`,
  );

describe("runScheduledJobs records only runs that execute", () => {
  it("writes nothing for a skip, ok for a run, failed for an infrastructure failure", async () => {
    const { env, writes } = fakeDb();
    await expect(
      runScheduledJobs(env, [job("off"), job("ran"), job("broke")], async (e, name, handler) => {
        if (name === "off")
          return { cronName: name, status: "skipped", rowsProcessed: 0, message: "disabled" };
        if (name === "broke")
          return { cronName: name, status: "failed", rowsProcessed: 0, message: "lock rpc failed" };
        const result = await handler(e, { runId: "r1" });
        return { cronName: name, status: "success", rowsProcessed: result.rowsProcessed };
      }),
    ).rejects.toThrow("cron jobs failed: broke");
    expect(kinds(writes)).toEqual(["ran:started", "ran:ok", "broke:started", "broke:failed"]);
  });
});
