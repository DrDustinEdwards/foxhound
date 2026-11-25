import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Creating a win-back sequence records one winback_sequence_started outcome, never a billing row.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  moneyWrites: 0,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    harness.moneyWrites += 1;
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async (_e: unknown, c: string) => `plain:${c}`,
}));

vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    customers: { retrieve: async () => ({ id: "cus_1", email: "buyer@acme.test", name: "Jane" }) },
  }),
  getStripe: () => ({}),
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");

const ACCOUNT = "acct_1";
const RECEIVED = new Date("2026-11-01T00:00:00Z");
const env = { ENCRYPTION_KEY: "ab".repeat(32) } as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.moneyWrites = 0;
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)")
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000)",
    )
    .run(ACCOUNT);
});

function deletedEvent(id = "evt_1", subscriptionId = "sub_1") {
  return {
    id,
    type: "customer.subscription.deleted",
    account: "acct_stripe",
    data: {
      object: {
        id: subscriptionId,
        customer: "cus_1",
        currency: "usd",
        cancellation_details: { reason: "cancellation_requested" },
        items: {
          data: [{ price: { unit_amount: 4900, currency: "usd", product: { name: "Pro" } } }],
        },
      },
    },
  } as never;
}

function outcomeRows() {
  return sqlite
    .prepare(
      "SELECT event_type AS eventType, outcome, event_data AS eventData, idempotency_key AS key FROM outcomes ORDER BY event_type",
    )
    .all() as { eventType: string; outcome: string; eventData: string; key: string }[];
}

describe("a started sequence records exactly one started outcome", () => {
  it("with its event_type, outcome and fields", async () => {
    const result = await processConnectedWebhook(env, deletedEvent(), RECEIVED);

    expect(result).toEqual({ status: "applied" });
    expect(sqlite.prepare("SELECT id FROM win_back_sequences").all()).toHaveLength(1);

    const rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("winback_sequence_started");
    expect(rows[0].outcome).toBe("started");
    expect(JSON.parse(rows[0].eventData)).toEqual({
      amountCents: 4900,
      currency: "usd",
      cancelReason: "cancellation_requested",
    });
    expect(rows[0].key).toBe("winback-started:sub_1");
  });

  it("no recovered_payments row, so nothing about a win-back enters the fee base", async () => {
    await processConnectedWebhook(env, deletedEvent(), RECEIVED);

    expect(sqlite.prepare("SELECT id FROM recovered_payments").all()).toEqual([]);
    expect(sqlite.prepare("SELECT id FROM recovery_steps").all()).toEqual([]);
  });
});

describe("a replayed deletion records none", () => {
  it("the second delivery of the same event is a duplicate and records nothing more", async () => {
    await processConnectedWebhook(env, deletedEvent("evt_1"), RECEIVED);
    const after = await processConnectedWebhook(env, deletedEvent("evt_1"), RECEIVED);

    expect(after).toEqual({ status: "duplicate" });
    expect(outcomeRows()).toHaveLength(1);
  });

  it("a different event for the same subscription is refused by the sequence guard", async () => {
    await processConnectedWebhook(env, deletedEvent("evt_1"), RECEIVED);
    const after = await processConnectedWebhook(env, deletedEvent("evt_2"), RECEIVED);

    expect(after).toEqual({ status: "ignored", reason: "winback_exists" });
    expect(sqlite.prepare("SELECT id FROM win_back_sequences").all()).toHaveLength(1);
    expect(outcomeRows()).toHaveLength(1);
  });

  it("the `applied` gate, reached through the index the pre-check cannot see", async () => {
    // The pre-check is account-scoped but the subscription index is global, so a subscription held by
    // another account passes the pre-check and collides at the index.
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_2', 'Other', 1000)")
      .run();
    sqlite
      .prepare(
        "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, status, created_at) VALUES ('wb_other', 'acct_2', 'cus_9', 'sub_1', 'x@y.test', 'active', 1000)",
      )
      .run();

    const result = await processConnectedWebhook(env, deletedEvent("evt_1", "sub_1"), RECEIVED);

    expect(result).toEqual({ status: "duplicate" });
    expect(
      sqlite.prepare("SELECT id FROM win_back_sequences WHERE account_id = ?").all(ACCOUNT),
    ).toEqual([]);
    expect(outcomeRows()).toEqual([]);
  });

  it("the outcome key, reached on its own", async () => {
    // With the sequence row deleted only the outcome's idempotency key can stop a second started row.
    await processConnectedWebhook(env, deletedEvent("evt_1"), RECEIVED);
    sqlite.prepare("DELETE FROM win_back_steps").run();
    sqlite.prepare("DELETE FROM win_back_sequences").run();

    await processConnectedWebhook(env, deletedEvent("evt_2"), RECEIVED);

    expect(sqlite.prepare("SELECT id FROM win_back_sequences").all()).toHaveLength(1);
    expect(outcomeRows()).toHaveLength(1);
  });
});
