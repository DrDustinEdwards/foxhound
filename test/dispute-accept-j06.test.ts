import type Database from "better-sqlite3";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J06: Accept dispute. Recova's spec is
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
  executeMoneyWrite: async (
    _env: Env,
    write: { idempotencyKey: string; build: (db: unknown) => unknown[] },
  ) => {
    harness.writes++;
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    const sqlite = harness.sqlite as Database.Database;
    sqlite.exec("BEGIN");
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(
        write.build(harness.db),
      );
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
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at) VALUES ('acct_other', 'Other', 1000)",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, state, created_at) VALUES ('d1', ?, 'dp_1', 'ch_1', 5000, 'usd', 'fraudulent', 'needs_response', 'pending_review', 1000)",
    )
    .run(ACCOUNT);
});

type StripeBehavior = "ok" | "fail" | "outage" | "network" | "conflict";

/** Errors shaped as the Stripe SDK's: a definite 4xx refusal carries its status
 *  code; a 5xx, a concurrent idempotent request (409) and a dropped connection
 *  leave the result unknown. */
function stripeError(behavior: Exclude<StripeBehavior, "ok">): Error {
  const shapes = {
    fail: {
      type: "StripeInvalidRequestError",
      statusCode: 400,
      message: "This dispute is already closed",
    },
    outage: {
      type: "StripeAPIError",
      statusCode: 500,
      message: "An unknown error occurred",
    },
    network: {
      type: "StripeConnectionError",
      statusCode: undefined,
      message: "Request was retried 2 times.",
    },
    conflict: {
      type: "StripeIdempotencyError",
      statusCode: 409,
      message:
        "There is currently another in-progress request using this Idempotent Key",
    },
  } as const;
  const shape = shapes[behavior];
  return Object.assign(new Error(shape.message), {
    type: shape.type,
    statusCode: shape.statusCode,
  });
}

function fakeStripe(behavior: StripeBehavior) {
  const closed: string[] = [];
  const keys: (string | undefined)[] = [];
  const stripe = {
    disputes: {
      close: async (
        id: string,
        _params?: unknown,
        options?: { idempotencyKey?: string },
      ) => {
        keys.push(options?.idempotencyKey);
        if (behavior !== "ok") throw stripeError(behavior);
        closed.push(id);
        return { id, status: "lost" };
      },
    },
  } as unknown as Stripe;
  return { stripe, closed, keys };
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
    hasApproval: false,
    ...overrides,
  };
}

function dispute() {
  return sqlite
    .prepare(
      "SELECT state, resolved_at AS resolvedAt, resolved_fee_cents AS fee, submitted_at AS submittedAt FROM disputes WHERE id = 'd1'",
    )
    .get() as {
    state: string;
    resolvedAt: number | null;
    fee: number | null;
    submittedAt: number | null;
  };
}

function outcomes() {
  return sqlite
    .prepare(
      "SELECT account_id AS accountId, product, event_type AS type, outcome, event_data AS data FROM outcomes",
    )
    .all() as {
    accountId: string;
    product: string;
    type: string;
    outcome: string;
    data: string;
  }[];
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
    expect(rows[0]).toMatchObject({
      accountId: ACCOUNT,
      product: "disputes",
      type: "dispute_accepted",
      outcome: "accepted",
    });
    expect(JSON.parse(rows[0].data)).toEqual({ dispute_id: "dp_1" });
  });

  it("Stripe refuses: nothing is written and the merchant is told why", async () => {
    const { stripe } = fakeStripe("fail");
    const result = await acceptDispute(env, input(), { stripe });

    expect(result.status).toBe("error");
    expect(result.status === "error" && result.message).toContain(
      "This dispute is already closed",
    );
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
});

describe("PR 149 review: an unknown Stripe result is never reported as a refusal", () => {

  it.each(["outage", "network", "conflict"] as const)(
    "%s: Stripe may have closed it, so the merchant is told to check Stripe, and nothing is written",
    async (behavior) => {
      const result = await acceptDispute(env, input(), {
        stripe: fakeStripe(behavior).stripe,
      });
      expect(result.status).toBe("error");
      const message = result.status === "error" ? result.message : "";
      expect(message).not.toContain("Stripe did not accept");
      expect(message).toContain(
        "Stripe may or may not have closed this dispute",
      );
      expect(message).toContain("check it in Stripe before trying again");
      // job_2663d92094ab: Stripe replays a stored result, a 500 included, for 24
      // hours under the same idempotency key, and the key is kept stable (one
      // close per dispute), so the message says a retry may repeat the answer.
      expect(message).toContain(
        "If Stripe returned a server error, trying again here within 24 hours gets the same answer.",
      );
      expect(dispute().state).toBe("pending_review");
      expect(harness.writes).toBe(0);
    },
  );

  it("the close carries an idempotency key from the dispute, so two tabs make one Stripe call", async () => {
    const first = fakeStripe("ok");
    const second = fakeStripe("ok");
    await acceptDispute(env, input(), { stripe: first.stripe });
    await acceptDispute(env, input(), { stripe: second.stripe });
    expect(first.keys).toEqual(["dispute-accept:d1"]);
    expect(second.keys).toEqual(["dispute-accept:d1"]);
  });
});

describe("PR 149 review: Accept is refused while an approval stands", () => {
  it("an approved dispute (its submission in flight, rejected or unconfirmed) is not accepted, and Stripe is not called", async () => {
    const { stripe, closed } = fakeStripe("ok");
    const result = await acceptDispute(env, input({ hasApproval: true }), {
      stripe,
    });
    expect(result).toEqual({
      status: "error",
      message:
        "This dispute's evidence has been approved for submission, so it cannot be accepted here.",
    });
    expect(closed).toEqual([]);
    expect(harness.writes).toBe(0);
  });
});
