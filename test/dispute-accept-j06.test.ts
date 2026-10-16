import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J06 (job_4f4c9c2f5383): Accept dispute. Recova's spec is
// app/api/disputes/accept/route.ts (blob d85b5761): refuse a closed dispute,
// call stripe.disputes.close on the connected account, then mark the dispute
// lost with no fee ("submitted_by stays null: no Recova fee on accepted
// disputes") and record the dispute_accepted outcome with outcome "accepted".
// Foxhound's state is the existing resolution writer's resolved_lost, written
// through the money-write Durable Object with the outcome in the same batch.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  seen: new Set<string>(),
  writes: 0,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { idempotencyKey: string; build: (db: unknown) => unknown[] }) => {
    harness.writes++;
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    const sqlite = harness.sqlite as Database.Database;
    sqlite.exec("BEGIN");
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }
    harness.seen.add(write.idempotencyKey);
    return { applied: true };
  },
}));

const { acceptDispute } = await import("~/lib/disputes/accept.server");

const ACCOUNT = "acct_1";
const NOW = new Date("2026-11-10T12:00:00Z");
const env = { ENCRYPTION_KEY: "ab".repeat(32) } as unknown as Env;

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sqlite = made.sqlite;
  harness.seen = new Set();
  harness.writes = 0;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(ACCOUNT);
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_other', 'Other', 1000)").run();
  sqlite
    .prepare(
      "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, state, created_at) VALUES ('d1', ?, 'dp_1', 'ch_1', 5000, 'usd', 'fraudulent', 'needs_response', 'pending_review', 1000)",
    )
    .run(ACCOUNT);
});

function fakeStripe(behaviour: "ok" | "fail") {
  const closed: string[] = [];
  const stripe = {
    disputes: {
      close: async (id: string) => {
        if (behaviour === "fail") throw new Error("This dispute is already closed");
        closed.push(id);
        return { id, status: "lost" };
      },
    },
  } as unknown as Stripe;
  return { stripe, closed };
}

function input(overrides: Partial<Parameters<typeof acceptDispute>[1]> = {}) {
  return {
    accountId: ACCOUNT,
    disputeId: "d1",
    stripeDisputeId: "dp_1",
    state: "pending_review",
    amountCents: 5000,
    currency: "usd",
    connectionAccessToken: "cipher",
    acceptedAt: NOW,
    ...overrides,
  };
}

function dispute() {
  return sqlite
    .prepare("SELECT state, resolved_at AS resolvedAt, resolved_fee_cents AS fee, submitted_at AS submittedAt FROM disputes WHERE id = 'd1'")
    .get() as { state: string; resolvedAt: number | null; fee: number | null; submittedAt: number | null };
}

function outcomes() {
  return sqlite
    .prepare("SELECT account_id AS accountId, product, event_type AS type, outcome, event_data AS data FROM outcomes")
    .all() as { accountId: string; product: string; type: string; outcome: string; data: string }[];
}

describe("ACCEPT: Stripe first, then the accepted state and its outcome together", () => {
  it("closes the dispute at Stripe, resolves it lost with no fee, and records dispute_accepted", async () => {
    const { stripe, closed } = fakeStripe("ok");
    const result = await acceptDispute(env, input(), { stripe });

    expect(result).toEqual({ status: "accepted" });
    expect(closed).toEqual(["dp_1"]);
    const row = dispute();
    expect(row.state).toBe("resolved_lost");
    expect(row.resolvedAt).toBe(NOW.getTime());
    // No Foxhound fee on an accepted dispute, ever.
    expect(row.fee).toBeNull();
    expect(row.submittedAt).toBeNull();
    const rows = outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: ACCOUNT, product: "disputes", type: "dispute_accepted", outcome: "accepted" });
    expect(JSON.parse(rows[0].data)).toEqual({ dispute_id: "dp_1" });
  });

  it("Stripe refuses: nothing is written and the merchant is told why", async () => {
    const { stripe } = fakeStripe("fail");
    const result = await acceptDispute(env, input(), { stripe });

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toContain("This dispute is already closed");
    expect(dispute().state).toBe("pending_review");
    expect(outcomes()).toHaveLength(0);
    expect(harness.writes).toBe(0);
  });

  it("a submitted or resolved dispute is refused before Stripe is called", async () => {
    for (const state of ["submitted", "resolved_won", "resolved_lost"]) {
      const { stripe, closed } = fakeStripe("ok");
      const result = await acceptDispute(env, input({ state }), { stripe });
      expect(result.status).toBe("error");
      expect(closed).toEqual([]);
    }
    expect(outcomes()).toHaveLength(0);
  });

  it("a second accept of the same dispute records nothing twice", async () => {
    await acceptDispute(env, input(), { stripe: fakeStripe("ok").stripe });
    await acceptDispute(env, input(), { stripe: fakeStripe("ok").stripe });
    expect(outcomes()).toHaveLength(1);
  });

  it("the write is pinned to the account: another account's id changes nothing", async () => {
    const { stripe } = fakeStripe("ok");
    await acceptDispute(env, input({ accountId: "acct_other" }), { stripe });
    expect(dispute().state).toBe("pending_review");
    expect(outcomes()).toHaveLength(0);
  });
});
