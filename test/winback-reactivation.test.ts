import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Win-back reactivation: checkout.session.completed or invoice.payment_succeeded flips the sequence once,
// matched by sequence id (never by customer), and is never billable.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  subscriptions: {} as Record<string, { metadata?: Record<string, string> }>,
  retrieved: [] as string[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
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
    subscriptions: {
      retrieve: async (id: string) => {
        harness.retrieved.push(id);
        const sub = harness.subscriptions[id];
        if (!sub) throw new Error("no such subscription");
        return sub;
      },
    },
    customers: { retrieve: async () => ({ id: "cus_1", email: "b@a.test", name: null }) },
  }),
  getStripe: () => ({}),
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { classifyStripeEvent } = await import("~/lib/webhooks/events");

const ACCOUNT = "acct_1";
const CANCELLED_AT = new Date("2026-10-20T00:00:00Z");
const RECEIVED = new Date("2026-11-01T00:00:00Z");
const env = { ENCRYPTION_KEY: "ab".repeat(32) } as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.subscriptions = {};
  harness.retrieved = [];
  sqlite
    .prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)")
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000)",
    )
    .run(ACCOUNT);
});

function seedSequence(
  opts: { id?: string; status?: string; customerId?: string; accountId?: string } = {},
): string {
  const id = opts.id ?? "wb_1";
  sqlite
    .prepare(
      "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, plan_name, amount_cents, currency, status, created_at, stripe_connection_id) VALUES (?, ?, ?, ?, 'buyer@acme.test', 'Pro', 4900, 'usd', ?, ?, 'c1')",
    )
    .run(
      id,
      opts.accountId ?? ACCOUNT,
      opts.customerId ?? "cus_1",
      `sub_dead_${id}`,
      opts.status ?? "active",
      CANCELLED_AT.getTime(),
    );
  return id;
}

function checkoutEvent(metadata: Record<string, string> | null, id = "evt_c1") {
  return {
    id,
    type: "checkout.session.completed",
    account: "acct_stripe",
    data: { object: { id: "cs_1", customer: "cus_1", metadata } },
  } as never;
}

function invoiceEvent(subscriptionId: string | null, id = "evt_i1", customer = "cus_1") {
  return {
    id,
    type: "invoice.payment_succeeded",
    account: "acct_stripe",
    data: {
      object: {
        id: `in_${id}`,
        customer,
        parent: { subscription_details: { subscription: subscriptionId } },
        amount_paid: 4900,
        currency: "usd",
      },
    },
  } as never;
}

function sequenceRows() {
  return sqlite
    .prepare(
      "SELECT id, status, reactivated_at AS reactivatedAt FROM win_back_sequences ORDER BY id",
    )
    .all() as { id: string; status: string; reactivatedAt: number | null }[];
}

function outcomeRows() {
  return sqlite
    .prepare(
      "SELECT event_type AS eventType, outcome, event_data AS eventData, idempotency_key AS key FROM outcomes",
    )
    .all() as { eventType: string; outcome: string; eventData: string; key: string }[];
}

describe("the classifier reads the sequence id off the session", () => {
  it("ignores an ordinary checkout that carries no win-back metadata", () => {
    expect(classifyStripeEvent(checkoutEvent(null)).kind).toBe("ignore");
    expect(classifyStripeEvent(checkoutEvent({ other: "x" })).kind).toBe("ignore");
    expect(classifyStripeEvent(checkoutEvent({ win_back_sequence_id: "" })).kind).toBe("ignore");
  });
});

describe("checkout.session.completed reactivates", () => {
  it("flips the sequence and records the outcome", async () => {
    seedSequence();

    const result = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }),
      RECEIVED,
    );

    expect(result).toEqual({ status: "applied" });
    expect(sequenceRows()).toEqual([
      { id: "wb_1", status: "reactivated", reactivatedAt: RECEIVED.getTime() },
    ]);

    const rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("winback_reactivated");
    expect(rows[0].outcome).toBe("reactivated");
    expect(JSON.parse(rows[0].eventData)).toEqual({ amountCents: 4900, daysSinceCancel: 12 });
    expect(rows[0].key).toBe("winback-reactivated:wb_1");
  });

  it("a sequence on another account is not found, and nothing flips", async () => {
    sqlite
      .prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_other', 'Other', 1000)")
      .run();
    seedSequence({ accountId: "acct_other" });

    const result = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }),
      RECEIVED,
    );

    expect(result).toEqual({ status: "ignored", reason: "winback_not_found" });
    expect(sequenceRows()[0].status).toBe("active");
    expect(outcomeRows()).toEqual([]);
  });

  it("a redelivery of the same event flips nothing and records nothing", async () => {
    seedSequence();
    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }), RECEIVED);

    const again = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }, "evt_c1"),
      RECEIVED,
    );

    expect(again).toEqual({ status: "duplicate" });
    expect(outcomeRows()).toHaveLength(1);
  });

  it("a new event id for the same sequence records nothing, reaching the status claim alone", async () => {
    // The webhook claim cannot refuse this one, so only the status condition
    // on the flip can.
    seedSequence();
    await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }, "evt_c1"),
      RECEIVED,
    );

    const again = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }, "evt_c2"),
      new Date(RECEIVED.getTime() + 60_000),
    );

    expect(again).toEqual({ status: "ignored", reason: "winback_already_handled" });
    expect(outcomeRows()).toHaveLength(1);
    expect(sequenceRows()[0].reactivatedAt).toBe(RECEIVED.getTime());
  });

  it("a lost claim records no outcome, reaching that guard past the status check", async () => {
    // reactivated_at set with the status still active lets the load succeed while the claim fails.
    seedSequence();
    sqlite
      .prepare("UPDATE win_back_sequences SET reactivated_at = ? WHERE id = 'wb_1'")
      .run(RECEIVED.getTime() - 1000);

    const result = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }),
      RECEIVED,
    );

    expect(result).toEqual({ status: "ignored", reason: "winback_duplicate" });
    expect(outcomeRows()).toEqual([]);
  });
});

describe("a reactivation that died between its claim and its outcome", () => {
  it("records the outcome when the event is redelivered", async () => {
    seedSequence();
    sqlite
      .prepare(
        "UPDATE win_back_sequences SET status = 'reactivated', reactivated_at = ? WHERE id = 'wb_1'",
      )
      .run(RECEIVED.getTime() - 1000);
    expect(outcomeRows()).toEqual([]);

    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }), RECEIVED);
    expect(outcomeRows().map((r) => r.eventType)).toEqual(["winback_reactivated"]);

    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }), RECEIVED);
    expect(outcomeRows()).toHaveLength(1);
  });
});

describe("invoice.payment_succeeded reactivates by metadata, never by customer", () => {
  it("reactivates when the paid subscription carries the sequence id", async () => {
    seedSequence();
    harness.subscriptions["sub_new"] = { metadata: { win_back_sequence_id: "wb_1" } };

    await processConnectedWebhook(env, invoiceEvent("sub_new"), RECEIVED);

    expect(harness.retrieved).toEqual(["sub_new"]);
    expect(sequenceRows()[0].status).toBe("reactivated");
    expect(outcomeRows().map((r) => r.eventType)).toEqual(["winback_reactivated"]);
  });

  it("a customer with no live sequence costs no Stripe read", async () => {
    await processConnectedWebhook(env, invoiceEvent("sub_new"), RECEIVED);

    expect(harness.retrieved).toEqual([]);
    expect(outcomeRows()).toEqual([]);
  });

  it("a Stripe failure is swallowed and the webhook still completes", async () => {
    seedSequence();
    // No subscription registered, so retrieve throws.

    const result = await processConnectedWebhook(env, invoiceEvent("sub_missing"), RECEIVED);

    expect(result).toEqual({ status: "ignored", reason: "no_active_failure" });
    expect(sequenceRows()[0].status).toBe("active");
  });
});
