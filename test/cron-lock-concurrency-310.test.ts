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

type LockCalls = { acquired: number; released: number };

/** A fake CRON_LOCK namespace whose stub grants the first claim and denies every
 *  later one, which is what a genuinely overlapping firing looks like from the
 *  second runner's side. */
function lockNamespace(grants: boolean[], calls: LockCalls) {
  let i = 0;
  const stub = {
    acquire: async (leaseMs: number) => {
      calls.acquired += 1;
      expect(leaseMs, "the runner must pass the lease, never an unbounded hold").toBe(
        CRON_LOCK_LEASE_MS,
      );
      return grants[i++] ?? false;
    },
    release: async () => {
      calls.released += 1;
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
    const calls: LockCalls = { acquired: 0, released: 0 };
    const env = envWith([false], calls);
    const handler = vi.fn(async () => ({ rowsProcessed: 99 }));

    const outcome = await runCronJob(env, "recovery-tick", handler);

    expect(handler).not.toHaveBeenCalled();
    expect(outcome.status).toBe("skipped");
    expect(outcome.message).toBe("locked");
    expect(outcome.rowsProcessed).toBe(0);
  });

  it("a granted lock runs the handler exactly once and releases", async () => {
    const calls: LockCalls = { acquired: 0, released: 0 };
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
    const calls: LockCalls = { acquired: 0, released: 0 };
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
    const calls: LockCalls = { acquired: 0, released: 0 };
    const env = envWith([true], calls);
    const handler = vi.fn(async () => {
      throw new Error("handler blew up");
    });

    const outcome = await runCronJob(env, "recovery-tick", handler);

    expect(outcome.status).toBe("failed");
    expect(calls.released, "a thrown handler must not wedge the cron").toBe(1);
  });

  it("the lease is bounded, so a crashed run cannot hold the lock forever", async () => {
    // The self-expiry 310 required of a new lock is already the shape here: the
    // lease is finite and matches the tick interval, so even a run that dies
    // without releasing frees the job within one period. The acquire assertion
    // inside the fake pins that the runner passes exactly this value.
    expect(CRON_LOCK_LEASE_MS).toBe(5 * 60 * 1000);
    expect(CRON_LOCK_LEASE_MS).toBeGreaterThan(0);
  });
});
