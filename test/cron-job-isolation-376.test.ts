import { describe, expect, it, vi } from "vitest";

import { runJobTool } from "@dustinedwards/site-runtime/cron";
import { cronConfig, cronRuns } from "~/db/schema";

import { loggedRuns } from "./helpers/cron";
import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// SESSION 85, 376's verify-first list: PER-JOB ISOLATION IN scheduled().
//
// THE PREMISE, VERIFIED AT afb4334. The old runner's try/catch wrapped the
// HANDLER and nothing else: the cron_config select, the history select and
// `lock.acquire` ran before it, so a throw from D1 or from the lock threw out of
// the runner, and scheduled() skipped every remaining job on that schedule with
// no record and no alert. The daily schedule carries most of the jobs, so the
// blast radius of one lock hiccup on the first was the rest.
//
// WHAT IS DRIVEN HERE. The real runner (its gates inside site-runtime's runJobs)
// against a real in-memory SQLite with the committed migrations, with the
// failure injected at the lock boundary, which is a genuine preamble throw
// rather than a simulated one.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { runJobNowList, runScheduledJobs } = await import("~/lib/cron/run");
const { RUN_NOW_JOBS } = await import("~/lib/cron/registry");

/** A lock namespace whose acquire THROWS for one cron, which is what a Durable
 *  Object hiccup looks like from the runner's side: not a denied claim, an
 *  exception. Every other cron's lock grants. */
function throwingLockFor(cronName: string) {
  return {
    get: (name: string) => ({
      acquire: async () => {
        if (name === cronName) throw new Error("DO unavailable");
        return "tok";
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

function freshEnv(lock: unknown) {
  const made = createInMemoryDb();
  harness.db = made.db;
  return { ...made, env: { DB: d1Over(made.sqlite), CRON_LOCK: lock } as unknown as Env };
}

const DAILY = "0 3 * * *";

// ============================================================================

describe("PLANT 1: one job's infrastructure throw does not take the schedule with it", () => {
  it("A JOB THAT THROWS IN THE PREAMBLE FAILS, AND THE NEXT JOB STILL RUNS", async () => {
    const { env, sqlite } = freshEnv(throwingLockFor("recovery-tick"));
    const secondHandler = vi.fn(async () => ({ rowsProcessed: 7 }));

    // The first job's lock throws; the second is the next job of the same
    // schedule, as scheduled() reaches it.
    await expect(
      runScheduledJobs(env, [
        { name: "recovery-tick", schedule: DAILY, handler: async () => ({ rowsProcessed: 1 }) },
        { name: "expiring-cards", schedule: DAILY, handler: secondHandler },
      ]),
    ).rejects.toThrow("cron jobs failed: recovery-tick");

    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(loggedRuns(sqlite, "expiring-cards").map((r) => [r.outcome, r.reason])).toEqual([
      ["ok", "7 rows"],
    ]);
    // AND THE FAILURE IS ON THE RECORD, which is the half that makes it
    // debuggable rather than merely survivable.
    expect(loggedRuns(sqlite, "recovery-tick").map((r) => [r.outcome, r.reason])).toEqual([
      ["failed", "Error: DO unavailable"],
    ]);
  });
});

describe("PLANT 2: the postamble, where a release failure must not rewrite the outcome", () => {
  it("a run that SUCCEEDED stays successful when its lock release throws", async () => {
    const { env, sqlite } = freshEnv(releaseThrowingLock());

    await runScheduledJobs(env, [
      { name: "recovery-tick", schedule: DAILY, handler: async () => ({ rowsProcessed: 4 }) },
    ]);

    // The lease lapsing is the real backstop for an unreleased lock, so the run
    // stays the success it was.
    expect(loggedRuns(sqlite, "recovery-tick").map((r) => r.outcome)).toEqual(["ok"]);
  });
});

// Capsid Admin's run a job now (the operator API's run_job, app/lib/operator.server.ts). A run now is asked for on
// purpose, so the min-interval gate is off; cron_config's enabled gate and the CRON_LOCK lease still hold, the run is
// recorded in cron_run_log, and only the allowlisted jobs are offered: none that moves money or mails anyone.
describe("run a job now", () => {
  it("runs a job its interval says is not due, skips a disabled one, and offers no money or mail job", async () => {
    const { db, env, sqlite } = freshEnv(workingLock());
    const now = new Date();
    const handler = vi.fn(async () => ({ rowsProcessed: 3 }));
    await db.insert(cronConfig).values([
      { cronName: "retention-page-404", minIntervalMinutes: 1440, updatedAt: now },
      { cronName: "retention-ai-calls", enabled: false, updatedAt: now },
    ]);
    await db
      .insert(cronRuns)
      .values({ name: "retention-page-404", everyMinutes: 1440, lastOkAt: now.getTime() });
    const tool = runJobTool(
      env.DB,
      runJobNowList(env, [
        { name: "retention-page-404", schedule: DAILY, handler },
        { name: "retention-ai-calls", schedule: DAILY, handler },
      ]),
      { history: true },
    );

    const ran = (await tool.run({ job: "retention-page-404" })) as { runs: { status: string }[] };
    expect(ran.runs.map((r) => r.status)).toEqual(["ok"]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(loggedRuns(sqlite, "retention-page-404").map((r) => r.outcome)).toEqual(["ok"]);

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
