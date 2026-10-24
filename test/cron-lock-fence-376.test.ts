import { describe, expect, it } from "vitest";

import {
  decideAcquire,
  decideRelease,
  type CronLockRecord,
  type CronLockState,
} from "~/lib/cron/lock-state";

// 376 ITEM 14: THE CRON LOCK IS FENCED.
//
// THE DEFECT. `release` deleted the lease regardless of who called it, and the
// lease was five minutes, which is EXACTLY the recovery tick's period. So:
//
//   A acquires at t=0, lease to t=5m.
//   A overruns. At t=5m the lease has lapsed.
//   B fires at t=5m, finds the lease expired, acquires, lease to t=10m.
//   A finishes at t=6m and calls release. B's lease is deleted.
//   C fires at t=10m... and so does anything else, because nothing is held.
//
// B is inside the money path with no lock. That is the sequence this file
// drives, step by step, on the clock.
//
// WHY THIS FILE CAN EXIST NOW. The arithmetic moved out of the Durable Object
// into ~/lib/cron/lock-state.ts, which imports nothing. The DO itself still
// cannot be loaded here: `workers/cron-lock.ts` imports "cloudflare:workers",
// which does not resolve in the node test environment, and session 62's pin
// recorded that as its coverage bound. So this proves the DECISIONS, and the
// stub below stands in for `ctx.storage` exactly as the DO uses it.

/** A stand-in for `ctx.storage`, holding the two keys the DO reads and writes.
 *  Deliberately a plain map: the DO does read-decide-write and nothing else, so
 *  a map is the whole of the state it has. */
class StorageStub {
  private lock: CronLockRecord | null = null;
  private legacyHeldUntil: number | null = null;

  state(): CronLockState {
    return { lock: this.lock, legacyHeldUntil: this.legacyHeldUntil };
  }

  /** The DO's acquire, transcribed: read, decide, write on a grant. */
  acquire(now: number, leaseMs: number, token: string): string | null {
    const decision = decideAcquire(this.state(), now, leaseMs, token);
    if (!decision.granted) return null;
    this.lock = decision.record;
    this.legacyHeldUntil = null;
    return decision.record.token;
  }

  /** The DO's release, transcribed: read, decide, delete only if the token holds. */
  release(token: string): void {
    if (!decideRelease(this.state(), token)) return;
    this.lock = null;
  }

  seedLegacy(heldUntil: number): void {
    this.legacyHeldUntil = heldUntil;
  }

  held(): boolean {
    return this.lock !== null;
  }
}

const MINUTE = 60 * 1000;
const LEASE = 16 * MINUTE;

describe("PLANT 1: the overrun sequence, which is the defect", () => {
  it("A OVERRUNS, B ACQUIRES, AND A'S RELEASE DOES NOT FREE B'S LEASE", async () => {
    const storage = new StorageStub();

    // t=0: A takes the lock.
    const tokenA = storage.acquire(0, LEASE, "A");
    expect(tokenA).toBe("A");

    // t=16m: A is still running but its lease has lapsed. B fires and gets in.
    // This is not the bug; a lapsed lease is SUPPOSED to be reclaimable, which
    // is what stops a dead run wedging the job forever.
    const tokenB = storage.acquire(16 * MINUTE, LEASE, "B");
    expect(tokenB).toBe("B");

    // t=17m: A finally finishes and releases. THIS is the bug, and this is the
    // assertion: A no longer holds anything, so A frees nothing.
    storage.release("A");

    expect(storage.held(), "A's stale release freed B's lease").toBe(true);

    // And the proof that it is still B's, not merely "a" lock: C cannot get in.
    expect(storage.acquire(17 * MINUTE, LEASE, "C")).toBeNull();
  });
});

describe("PLANT 4: the one-deploy compatibility read", () => {
  it("a PRE-FENCE hold is still honoured, so the fence deploy cannot double-run a job", () => {
    // At the deploy that ships the fence, a run started by the old code may be
    // in flight holding the old bare-expiry key. New code reading only the new
    // key would see no lock and start a second concurrent run of a job that
    // moves money.
    const storage = new StorageStub();
    storage.seedLegacy(10 * MINUTE);

    expect(storage.acquire(MINUTE, LEASE, "B")).toBeNull();
  });

  it("and an EXPIRED pre-fence hold does not block forever", () => {
    const storage = new StorageStub();
    storage.seedLegacy(10 * MINUTE);

    expect(storage.acquire(11 * MINUTE, LEASE, "B")).toBe("B");
  });
});

describe("PLANT 5: the decisions are pure, asserted directly", () => {

  it("decideRelease is token equality and nothing else", () => {
    const held: CronLockState = {
      lock: { heldUntil: 99 * MINUTE, token: "A" },
      legacyHeldUntil: null,
    };
    expect(decideRelease(held, "A")).toBe(true);
    expect(decideRelease(held, "B")).toBe(false);
    // An expired lease is still the holder's to release: expiry governs who may
    // ACQUIRE, never who may release.
    expect(decideRelease({ lock: { heldUntil: 0, token: "A" }, legacyHeldUntil: null }, "A")).toBe(
      true,
    );
    expect(decideRelease({ lock: null, legacyHeldUntil: 99 }, "A")).toBe(false);
  });
});
