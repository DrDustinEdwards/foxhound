import { describe, expect, it, vi } from "vitest";

import { runJobTool } from "@dustinedwards/site-runtime/cron";
import { cronConfig, cronRunHistory } from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 85, 376's verify-first list: PER-JOB ISOLATION IN scheduled().
//
// THE PREMISE, VERIFIED AT afb4334 BEFORE ANY OF THIS WAS WRITTEN. runCronJob's
// try/catch wraps the HANDLER and nothing else. Read the order: the cron_config
// select, the cron_run_history select and `lock.acquire` all run BEFORE the try,
// and `recordRun` runs inside it but `lock.release` runs in the finally. So a
// throw from D1 or from the lock did not fail the job, it threw out of
// runCronJob. workers/app.ts's scheduled() loops the schedule's jobs with no
// guard, so that one throw skipped every remaining job on that schedule with no
// history row and no alert: nothing afterwards said they had not run.
//
// THE DAILY SCHEDULE CARRIES SEVEN JOBS, four of them retention sweeps, so the
// blast radius of one lock hiccup on the first job was the other six.
//
// WHAT IS DRIVEN HERE. The real runCronJob against a real in-memory SQLite with
// the committed migrations, with the failure injected at the lock boundary,
// which is a genuine preamble throw rather than a simulated one.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { runCronJob } = await import("~/lib/cron/run");

/** A lock namespace whose acquire THROWS, which is what a Durable Object hiccup
 *  looks like from the runner's side: not a denied claim, an exception. */
function throwingLock() {
  return {
    get: () => ({
      acquire: async () => {
        throw new Error("DO unavailable");
      },
      release: async () => undefined,
    }),
    idFromName: (name: string) => name,
  };
}

/** A lock that grants normally. */
function workingLock() {
  return {
    get: () => ({
      acquire: async () => "tok",
      release: async () => undefined,
    }),
    idFromName: (name: string) => name,
  };
}

/** A lock that grants, but whose RELEASE throws: the postamble case. */
function releaseThrowingLock() {
  return {
    get: () => ({
      acquire: async () => "tok",
      release: async () => {
        throw new Error("release failed");
      },
    }),
    idFromName: (name: string) => name,
  };
}

function envWith(lock: unknown): Env {
  return { DB: {}, CRON_LOCK: lock } as unknown as Env;
}

function freshDb() {
  const made = createInMemoryDb();
  harness.db = made.db;
  return made;
}

// ============================================================================

describe("PLANT 1: one job's infrastructure throw does not take the schedule with it", () => {
  it("A JOB THAT THROWS IN THE PREAMBLE FAILS, AND THE NEXT JOB STILL RUNS", async () => {
    const { db } = freshDb();
    const secondHandler = vi.fn(async () => ({ rowsProcessed: 7 }));

    // The first job's lock throws. Before the fix this rejected, and in
    // scheduled() that rejection abandoned the loop.
    const first = await runCronJob(envWith(throwingLock()), "recovery-tick", async () => ({
      rowsProcessed: 1,
    }));
    // The successor, exactly as scheduled() would reach it on the next iteration.
    const second = await runCronJob(envWith(workingLock()), "expiring-cards", secondHandler);

    expect(first.status).toBe("failed");
    expect(first.message).toBe("DO unavailable");
    expect(second.status).toBe("success");
    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(second.rowsProcessed).toBe(7);

    // AND THE FAILURE IS ON THE RECORD, which is the half that makes it
    // debuggable rather than merely survivable.
    const rows = await db.select().from(cronRunHistory);
    const failed = rows.filter((r) => r.cronName === "recovery-tick");
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("failed");
    expect(failed[0].message).toBe("DO unavailable");
  });
});

describe("PLANT 2: the postamble, where a release failure must not rewrite the outcome", () => {
  it("a run that SUCCEEDED stays successful when its lock release throws", async () => {
    const { db } = freshDb();

    const outcome = await runCronJob(envWith(releaseThrowingLock()), "recovery-tick", async () => ({
      rowsProcessed: 4,
    }));

    // The history row already says success. An outcome of "failed" here would
    // contradict the database, and the lease lapsing is the real backstop for an
    // unreleased lock.
    expect(outcome.status).toBe("success");
    expect(outcome.rowsProcessed).toBe(4);
    const rows = await db.select().from(cronRunHistory);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
  });
});

describe("PLANT 3: the handler path is unchanged", () => {
  it("a throwing HANDLER still fails the job the way it always did", async () => {
    // The isolation added here is for infrastructure. The handler's own guard
    // predates it and must still be the thing that catches a handler.
    const { db } = freshDb();

    const outcome = await runCronJob(envWith(workingLock()), "recovery-tick", async () => {
      throw new Error("handler blew up");
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toBe("handler blew up");
    const rows = await db.select().from(cronRunHistory);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
  });
});

// Capsid Admin's run a job now (the operator API's run_job, app/lib/operator.server.ts). A run now is asked for on
// purpose, so the min-interval gate is off; cron_config's enabled gate and the CRON_LOCK lease still hold, the run is
// recorded in cron_run_history, and only the allowlisted jobs are offered: none that moves money or mails anyone.
const { runJobNowList } = await import("~/lib/cron/run");
const { RUN_NOW_JOBS } = await import("~/lib/cron/registry");

describe("run a job now", () => {
  it("runs a job its interval says is not due, skips a disabled one, and offers no money or mail job", async () => {
    const { db } = freshDb();
    const now = new Date();
    const handler = vi.fn(async () => ({ rowsProcessed: 3 }));
    await db.insert(cronConfig).values([
      { cronName: "retention-page-404", minIntervalMinutes: 1440, updatedAt: now },
      { cronName: "retention-ai-calls", enabled: false, updatedAt: now },
    ]);
    await db.insert(cronRunHistory).values({
      cronName: "retention-page-404",
      finishedAt: now,
      status: "success",
      createdAt: now,
    });
    const tool = runJobTool(
      null,
      runJobNowList(envWith(workingLock()), [
        { name: "retention-page-404", schedule: "0 3 * * *", handler },
        { name: "retention-ai-calls", schedule: "0 3 * * *", handler },
      ]),
    );

    const ran = (await tool.run({ job: "retention-page-404" })) as { runs: { status: string }[] };
    expect(ran.runs.map((r) => r.status)).toEqual(["ok"]);
    expect(handler).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(cronRunHistory);
    expect(rows.filter((r) => r.cronName === "retention-page-404")).toHaveLength(2);

    const disabled = (await tool.run({ job: "retention-ai-calls" })) as {
      runs: { status: string }[];
    };
    expect(disabled.runs.map((r) => r.status)).toEqual(["skipped"]);
    expect(handler).toHaveBeenCalledTimes(1);

    const names = RUN_NOW_JOBS.map((j) => j.name);
    for (const money of [
      "recovery-tick",
      "billing-monthly",
      "winback-send",
      "credit-note-retry",
      "stripe-deauthorize-retry",
      "dispute-fee-pricing",
      "weekly-digest",
      "expiring-cards",
    ])
      expect(names).not.toContain(money);
    expect(RUN_NOW_JOBS.filter((j) => j.backup).map((j) => j.name)).toEqual([
      "d1-backup",
      "media-backup",
      "evidence-backup",
    ]);
  });
});
