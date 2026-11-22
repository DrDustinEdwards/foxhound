import { describe, expect, it, vi } from "vitest";

import { runJobTool } from "@dustinedwards/site-runtime/cron";
import { cronConfig, cronRuns } from "~/db/schema";

import { loggedRuns, runJob } from "./helpers/cron";
import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// The real runner (its gates inside site-runtime's runJobs) against a real in-memory SQLite with the
// committed migrations, with the lock faked at the boundary. The Durable Object class itself cannot
// load here ("cloudflare:workers"), so its own lease arithmetic rests on source review.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { CRON_LOCK_LEASE_MS } = await import("~/lib/constants");
const { runJobNowList, runScheduledJobs } = await import("~/lib/cron/run");
const { RUN_NOW_JOBS } = await import("~/lib/cron/registry");

const DAILY = "0 3 * * *";

interface LockCalls {
  acquired: number;
  /** Tokens the stub handed out, in order. */
  granted: string[];
  /** Tokens the runner handed back, in order. */
  releasedWith: string[];
}

/** A fake CRON_LOCK namespace. `grants` answers each acquire in turn (a later one is denied, as a
 *  genuinely overlapping firing sees it); a granted acquire returns a fencing token and release
 *  takes one. `throwAcquireFor` makes one cron's acquire throw (a Durable Object hiccup, not a
 *  denied claim) and `throwOnRelease` makes every release throw. */
function lockNamespace(
  grants: boolean[],
  calls: LockCalls,
  opts: { throwAcquireFor?: string; throwOnRelease?: boolean } = {},
) {
  let i = 0;
  let minted = 0;
  return {
    get: (name: string) => ({
      acquire: async (leaseMs: number) => {
        calls.acquired += 1;
        expect(leaseMs, "the runner must pass the lease, never an unbounded hold").toBe(
          CRON_LOCK_LEASE_MS,
        );
        if (name === opts.throwAcquireFor) throw new Error("DO unavailable");
        if (!(grants[i++] ?? grants.at(-1) ?? false)) return null;
        const token = `tok_${++minted}`;
        calls.granted.push(token);
        return token;
      },
      release: async (token: string) => {
        calls.releasedWith.push(token);
        if (opts.throwOnRelease) throw new Error("release failed");
      },
    }),
    idFromName: (name: string) => name,
  };
}

function envWith(grants: boolean[], opts?: Parameters<typeof lockNamespace>[2]) {
  const calls: LockCalls = { acquired: 0, granted: [], releasedWith: [] };
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  const env = {
    DB: d1Over(sqlite),
    CRON_LOCK: lockNamespace(grants, calls, opts),
  } as unknown as Env;
  return { db, sqlite, env, calls, runs: () => loggedRuns(sqlite, "recovery-tick") };
}

describe("the cron runner honors the lock", () => {
  it("a denied claim skips without running the handler and records no run", async () => {
    const { env, runs } = envWith([false]);
    const handler = vi.fn(async () => ({ rowsProcessed: 99 }));

    await runJob(env, "recovery-tick", handler);

    expect(handler).not.toHaveBeenCalled();
    expect(runs()).toEqual([]);
  });

  it("two overlapping firings do the work once, and the holder releases its own token", async () => {
    const { env, calls, runs } = envWith([true, false]);
    const handler = vi.fn(async () => ({ rowsProcessed: 1 }));

    await runJob(env, "recovery-tick", handler);
    await runJob(env, "recovery-tick", handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(runs().map((r) => r.outcome)).toEqual(["ok"]);
    expect(calls.acquired).toBe(2);
    expect(calls.releasedWith).toEqual(calls.granted);
  });

  it("a throwing handler still releases the lock, so it cannot wedge the cron", async () => {
    const { env, calls, runs } = envWith([true]);

    await runJob(env, "recovery-tick", async () => {
      throw new Error("handler blew up");
    });

    expect(runs().map((r) => r.outcome)).toEqual(["failed"]);
    expect(calls.releasedWith).toEqual(calls.granted);
  });

  it("the lease outlasts the recovery tick's period and Cloudflare's 15-minute cron wall time", () => {
    // Shorter, a slow run would hand its lock to its successor, and an expired lease would not mean
    // the holder is dead.
    expect(CRON_LOCK_LEASE_MS).toBeGreaterThan(5 * 60 * 1000);
    expect(CRON_LOCK_LEASE_MS).toBeGreaterThan(15 * 60 * 1000);
  });
});

describe("one job's infrastructure throw does not take the schedule with it", () => {
  it("a lock that throws fails that job, on the record, and the next job still runs", async () => {
    const { env, sqlite } = envWith([true], { throwAcquireFor: "recovery-tick" });
    const secondHandler = vi.fn(async () => ({ rowsProcessed: 7 }));

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
    expect(loggedRuns(sqlite, "recovery-tick").map((r) => [r.outcome, r.reason])).toEqual([
      ["failed", "Error: DO unavailable"],
    ]);
  });

  it("a run that succeeded stays successful when its lock release throws", async () => {
    const { env, runs } = envWith([true], { throwOnRelease: true });

    await runScheduledJobs(env, [
      { name: "recovery-tick", schedule: DAILY, handler: async () => ({ rowsProcessed: 4 }) },
    ]);

    expect(runs().map((r) => r.outcome)).toEqual(["ok"]);
  });
});

// Capsid Admin's run a job now (the operator API's run_job): asked for on purpose, so the
// min-interval gate is off; cron_config's enabled gate and the lock lease still hold, the run is
// recorded, and only allowlisted jobs are offered: none that moves money or mails anyone.
describe("run a job now", () => {
  it("runs a job its interval says is not due, skips a disabled one, and offers no money or mail job", async () => {
    const { db, env, sqlite } = envWith([true]);
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
