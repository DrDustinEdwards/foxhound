import { describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 310 item 1. The premise was that overlapping cron runs are possible with
// no mutex. REFUTED: CronLockDurableObject (workers/cron-lock.ts) is a per-cron
// lease mutex and app/lib/cron/run.ts acquires it before the handler and releases
// it in a `finally`. 310 said pin it and stop, so this file is the pin, and it
// pins the thing that actually prevents overlap: not that a lock EXISTS, but that
// the runner refuses to do work when the claim is denied.
//
// runCronJob had NO test at all before this. The lock's caller contract was the
// gap, which is why the pin is worth writing rather than being a formality.
//
// COVERAGE BOUND, stated per 246. The Durable Object CLASS is not exercised here.
// `workers/cron-lock.ts` imports "cloudflare:workers", which does not resolve in
// this repo's node test environment (measured: "Cannot find package
// 'cloudflare:workers'"), so its acquire/release/lease arithmetic cannot be
// driven from vitest. What IS driven is the real runCronJob against a real
// in-memory SQLite with the committed migrations, with the lock faked at the
// boundary. So this proves the RUNNER honours a denied claim; it does not prove
// the DO's own lease arithmetic. That half rests on source review and is said
// plainly rather than implied.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { runCronJob } = await import("~/lib/cron/run");
const { CRON_LOCK_LEASE_MS } = await import("~/lib/constants");

/** The recovery tick's period, written as the number rather than derived from
 *  the schedule string, so the lease assertion below does not move when the
 *  thing it is compared against moves. */
const RECOVERY_TICK_PERIOD_MS = 5 * 60 * 1000;
/** Cloudflare's documented Cron Trigger wall-time cap, the second bar the lease
 *  has to clear. developers.cloudflare.com/workers/platform/limits/ */
const CRON_TRIGGER_WALL_TIME_CAP_MS = 15 * 60 * 1000;

type LockCalls = {
  acquired: number;
  released: number;
  /** Tokens the stub handed out, in order. */
  granted: string[];
  /** Tokens the runner handed back, in order. */
  releasedWith: string[];
};

/** A fake CRON_LOCK namespace whose stub grants the first claim and denies every
 *  later one, which is what a genuinely overlapping firing looks like from the
 *  second runner's side.
 *
 *  FENCED SINCE 376 ITEM 14: a granted acquire returns a TOKEN and release takes
 *  one, so the stub records which token each release carried. That is what lets
 *  the plant below assert the runner hands back its own. */
function lockNamespace(grants: boolean[], calls: LockCalls) {
  let i = 0;
  let minted = 0;
  const stub = {
    acquire: async (leaseMs: number) => {
      calls.acquired += 1;
      expect(leaseMs, "the runner must pass the lease, never an unbounded hold").toBe(
        CRON_LOCK_LEASE_MS,
      );
      const granted = grants[i++] ?? false;
      if (!granted) return null;
      const token = `tok_${++minted}`;
      calls.granted.push(token);
      return token;
    },
    release: async (token: string) => {
      calls.released += 1;
      calls.releasedWith.push(token);
    },
  };
  return { get: () => stub, idFromName: (name: string) => name };
}

function envWith(grants: boolean[], calls: LockCalls) {
  harness.db = createInMemoryDb().db;
  return { DB: {}, CRON_LOCK: lockNamespace(grants, calls) } as unknown as Env;
}

describe("310 item 1: the cron runner honours the lock", () => {
  it("THE CONCURRENT CLAIM: a denied lock skips WITHOUT running the handler", async () => {
    // The decisive assertion. A runner that acquired, was denied, and ran anyway
    // would still report "locked" while doing the work twice, so the handler
    // spy is what makes this a real proof rather than a status check.
    const calls: LockCalls = { acquired: 0, released: 0, granted: [], releasedWith: [] };
    const env = envWith([false], calls);
    const handler = vi.fn(async () => ({ rowsProcessed: 99 }));

    const outcome = await runCronJob(env, "recovery-tick", handler);

    expect(handler).not.toHaveBeenCalled();
    expect(outcome.status).toBe("skipped");
    expect(outcome.message).toBe("locked");
    expect(outcome.rowsProcessed).toBe(0);
  });

  it("a granted lock runs the handler exactly once and releases", async () => {
    const calls: LockCalls = { acquired: 0, released: 0, granted: [], releasedWith: [] };
    const env = envWith([true], calls);
    const handler = vi.fn(async () => ({ rowsProcessed: 3 }));

    const outcome = await runCronJob(env, "recovery-tick", handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("success");
    expect(calls.released).toBe(1);
  });

  it("TWO OVERLAPPING FIRINGS: the work happens once, not twice", async () => {
    // The same lock instance across both runs, which is what idFromName(cronName)
    // guarantees in production: one instance per cron, so the second firing sees
    // the first one's claim.
    const calls: LockCalls = { acquired: 0, released: 0, granted: [], releasedWith: [] };
    const env = envWith([true, false], calls);
    const handler = vi.fn(async () => ({ rowsProcessed: 1 }));

    const first = await runCronJob(env, "recovery-tick", handler);
    const second = await runCronJob(env, "recovery-tick", handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect([first.status, second.status]).toEqual(["success", "skipped"]);
    expect(second.message).toBe("locked");
    expect(calls.acquired).toBe(2);
  });

  it("REGRESSION GUARD: a THROWING handler still releases the lock", async () => {
    // Without the `finally`, one exception wedges the cron until the lease
    // lapses. Proven non-vacuous by its own plant per 296.
    const calls: LockCalls = { acquired: 0, released: 0, granted: [], releasedWith: [] };
    const env = envWith([true], calls);
    const handler = vi.fn(async () => {
      throw new Error("handler blew up");
    });

    const outcome = await runCronJob(env, "recovery-tick", handler);

    expect(outcome.status).toBe("failed");
    expect(calls.released, "a thrown handler must not wedge the cron").toBe(1);
  });

  it("the lease is bounded, so a crashed run cannot hold the lock forever", async () => {
    // 376 item 14 MOVED THIS NUMBER, and the old assertion is why it is worth
    // restating rather than editing quietly: the lease used to be five minutes,
    // which is EXACTLY the recovery tick's period, so this test's own comment
    // ("matches the tick interval") described the defect approvingly.
    //
    // Sixteen clears both bars: longer than the tick period, so a slow run does
    // not hand its lock to its successor, and longer than Cloudflare's 15-minute
    // Cron Trigger wall-time cap, so an expired lease means the holder is dead
    // rather than slow.
    expect(CRON_LOCK_LEASE_MS).toBe(16 * 60 * 1000);
    expect(CRON_LOCK_LEASE_MS).toBeGreaterThan(RECOVERY_TICK_PERIOD_MS);
    expect(CRON_LOCK_LEASE_MS).toBeGreaterThan(CRON_TRIGGER_WALL_TIME_CAP_MS);
  });
});
