import { describe, expect, it } from "vitest";

import {
  SerialMoneyCommitter,
  isUniqueConstraintError,
  type CommitterDeps,
  type CompiledStatement,
} from "~/lib/money/serializer";

// Proves the money-write serialization core (ARCHITECTURE.md non-negotiable #1).
// The Durable Object is a thin adapter over this class; exercising it directly
// proves the two properties that matter without the Workers runtime:
//   1. writes to one account (one committer) run strictly one at a time;
//   2. idempotency + the DB unique-constraint backstop behave correctly.
// The real DO's D1 batch + storage adapters are exercised end-to-end on staging
// via the Stripe Connect write path.

/** A runBatch that records concurrency and can be made slow/failing. */
function instrumentedDeps(opts: {
  onRun: (stmts: CompiledStatement[]) => Promise<void>;
}): { deps: CommitterDeps; seen: Set<string>; maxConcurrent: () => number } {
  const seen = new Set<string>();
  let inFlight = 0;
  let maxConcurrent = 0;
  const deps: CommitterDeps = {
    hasSeen: async (k) => seen.has(k),
    markSeen: async (k) => {
      seen.add(k);
    },
    runBatch: async (stmts) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        await opts.onRun(stmts);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { deps, seen, maxConcurrent: () => maxConcurrent };
}

const stmt = (sql: string): CompiledStatement => ({ sql, params: [] });

describe("SerialMoneyCommitter", () => {
  it("serializes concurrent writes to the same account (never overlaps)", async () => {
    const order: string[] = [];
    const { deps, maxConcurrent } = instrumentedDeps({
      onRun: async (stmts) => {
        order.push(`start:${stmts[0].sql}`);
        // Yield across ticks so an unserialized impl would interleave here.
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${stmts[0].sql}`);
      },
    });
    const committer = new SerialMoneyCommitter(deps);

    // Fire three concurrently; they must run strictly in arrival order.
    await Promise.all([
      committer.commit({ idempotencyKey: "a", statements: [stmt("A")] }),
      committer.commit({ idempotencyKey: "b", statements: [stmt("B")] }),
      committer.commit({ idempotencyKey: "c", statements: [stmt("C")] }),
    ]);

    expect(maxConcurrent()).toBe(1);
    expect(order).toEqual([
      "start:A",
      "end:A",
      "start:B",
      "end:B",
      "start:C",
      "end:C",
    ]);
  });

  it("no-ops a duplicate idempotency key without re-running the batch", async () => {
    let runs = 0;
    const { deps } = instrumentedDeps({
      onRun: async () => {
        runs += 1;
      },
    });
    const committer = new SerialMoneyCommitter(deps);

    const first = await committer.commit({ idempotencyKey: "dup", statements: [stmt("X")] });
    const second = await committer.commit({ idempotencyKey: "dup", statements: [stmt("X")] });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(runs).toBe(1);
  });

  it("treats a UNIQUE-constraint failure as an idempotent no-op (DB backstop)", async () => {
    const { deps, seen } = instrumentedDeps({
      onRun: async () => {
        throw new Error("D1_ERROR: UNIQUE constraint failed: outcomes.idempotency_key");
      },
    });
    const committer = new SerialMoneyCommitter(deps);

    const result = await committer.commit({ idempotencyKey: "k", statements: [stmt("Y")] });
    expect(result.applied).toBe(false);
    // Not recorded (audit M8): any unique index can refuse a batch, so the key
    // stays retryable; a true replay is refused by the DB again.
    expect(seen.has("k")).toBe(false);
  });

  it("throws on a unique key that is a real conflict, not a replay key", async () => {
    const { deps, seen } = instrumentedDeps({
      onRun: async () => {
        throw new Error("D1_ERROR: UNIQUE constraint failed: stripe_connections.stripe_user_id: SQLITE_CONSTRAINT");
      },
    });
    const committer = new SerialMoneyCommitter(deps);

    await expect(
      committer.commit({ idempotencyKey: "k", statements: [stmt("C")] }),
    ).rejects.toThrow(/stripe_connections\.stripe_user_id/);
    expect(seen.has("k")).toBe(false);
  });

  it("propagates a non-constraint failure and does NOT mark the key seen (retryable)", async () => {
    const { deps, seen } = instrumentedDeps({
      onRun: async () => {
        throw new Error("D1_ERROR: network blip");
      },
    });
    const committer = new SerialMoneyCommitter(deps);

    await expect(
      committer.commit({ idempotencyKey: "k", statements: [stmt("Z")] }),
    ).rejects.toThrow(/network blip/);
    expect(seen.has("k")).toBe(false);
  });

  it("keeps serializing after a failed commit (tail survives rejection)", async () => {
    let calls = 0;
    const { deps } = instrumentedDeps({
      onRun: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
    });
    const committer = new SerialMoneyCommitter(deps);

    await expect(
      committer.commit({ idempotencyKey: "1", statements: [stmt("1")] }),
    ).rejects.toThrow(/boom/);
    // A subsequent commit still runs; the chain was not poisoned.
    const ok = await committer.commit({ idempotencyKey: "2", statements: [stmt("2")] });
    expect(ok.applied).toBe(true);
  });
});

describe("isUniqueConstraintError", () => {
  it("matches D1 unique + primary-key violations, not other errors", () => {
    expect(isUniqueConstraintError(new Error("UNIQUE constraint failed: a.b"))).toBe(true);
    expect(isUniqueConstraintError(new Error("PRIMARY KEY constraint failed"))).toBe(true);
    expect(isUniqueConstraintError(new Error("no such table"))).toBe(false);
  });
});
