import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Early fraud warnings (Stripe radar.early_fraud_warning), end to end: the real
// webhook processor records the warning and notifies the merchant once, and the
// merchant's Refund asks Stripe first, never refunds a disputed charge, and
// writes nothing billable. Assertions read the tables, the sent mail and the
// Stripe calls, never a helper's return alone.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  seen: new Set<string>(),
  sent: [] as { to: string; subject: string; html: string }[],
  charge: { refunded: false, disputed: false },
  refunds: [] as { params: unknown; options: unknown }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// The money-write DO as the other webhook tests fake it: a seen key is a no-op,
// a throwing batch (the claim's unique index on a replay) rolls back whole.
vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { idempotencyKey: string; build: (db: unknown) => unknown[] }) => {
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    const sqlite = harness.sqlite as Database.Database;
    sqlite.exec("BEGIN");
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      if (/UNIQUE constraint failed/.test(String(err))) return { applied: false };
      throw err;
    }
    harness.seen.add(write.idempotencyKey);
    return { applied: true };
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({ decryptToken: async () => "sk_test_connected" }));

vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    charges: {
      retrieve: async (id: string) => ({
        id,
        amount: 12900,
        currency: "usd",
        customer: "cus_9",
        payment_intent: "pi_9",
        billing_details: { name: "Jane Buyer", email: "jane@buyer.test" },
        refunded: harness.charge.refunded,
        disputed: harness.charge.disputed,
      }),
    },
    // The recovery link: the warned charge's payment intent paid invoice in_9.
    invoicePayments: { list: async () => ({ data: [{ invoice: "in_9" }] }) },
    refunds: {
      create: async (params: unknown, options: unknown) => {
        harness.refunds.push({ params, options });
        return { id: "re_1" };
      },
    },
  }),
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { refundEarlyFraudWarning } = await import("~/lib/disputes/fraud-warnings.server");

const ACCOUNT = "acct_1";
const RECEIVED = new Date("2026-11-10T12:00:00Z");

const env = {
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  EMAIL: {
    send: async (m: { to: string; subject: string; html: string }) => {
      harness.sent.push(m);
      return { id: `msg_${harness.sent.length}` };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sqlite = made.sqlite;
  harness.seen = new Set();
  harness.sent = [];
  harness.refunds = [];
  harness.charge = { refunded: false, disputed: false };
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, 'ops@acme.test', 0, 1)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000)",
    )
    .run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) VALUES ('fp1', ?, 'evt_f', 'in_9', 'cus_9', 'jane@buyer.test', 12900, 'usd', 'soft', 'recovered', 1000)",
    )
    .run(ACCOUNT);
});

function warningEvent(type: "created" | "updated", id: string, actionable = true) {
  return {
    id,
    type: `radar.early_fraud_warning.${type}`,
    account: "acct_stripe",
    data: {
      object: {
        id: "issfr_1",
        object: "radar.early_fraud_warning",
        charge: "ch_9",
        payment_intent: "pi_9",
        fraud_type: "made_with_stolen_card",
        actionable,
        created: Math.floor(RECEIVED.getTime() / 1000) - 3600,
      },
    },
  } as never;
}

function warningRow() {
  return sqlite.prepare("SELECT * FROM early_fraud_warnings WHERE stripe_warning_id = 'issfr_1'").get() as Record<
    string,
    unknown
  >;
}

describe("intake: the webhook records the warning and tells the merchant once", () => {
  it("one row with the charge's amount and the linked recovery, one notice, nothing on a replay", async () => {
    expect(await processConnectedWebhook(env, warningEvent("created", "evt_1"), RECEIVED)).toEqual({ status: "applied" });

    const row = warningRow();
    expect(row).toMatchObject({
      account_id: ACCOUNT,
      stripe_connection_id: "c1",
      stripe_charge_id: "ch_9",
      stripe_payment_intent_id: "pi_9",
      stripe_customer_id: "cus_9",
      customer_name: "Jane Buyer",
      failed_payment_id: "fp1",
      fraud_type: "made_with_stolen_card",
      actionable: 1,
      amount_cents: 12900,
      currency: "usd",
      refunded_at: null,
      dismissed_at: null,
    });

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].to).toBe("ops@acme.test");
    expect(harness.sent[0].subject).toBe("Early fraud warning: $129.00 from Jane Buyer");
    expect(harness.sent[0].html).toContain("https://foxhoundapp.test/disputes/dashboard#early-fraud-warnings");

    expect(await processConnectedWebhook(env, warningEvent("created", "evt_1"), RECEIVED)).toEqual({ status: "duplicate" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM early_fraud_warnings").get()).toEqual({ n: 1 });
    expect(harness.sent).toHaveLength(1);
  });

  it(".updated moves actionable on the same row", async () => {
    await processConnectedWebhook(env, warningEvent("created", "evt_1"), RECEIVED);
    await processConnectedWebhook(env, warningEvent("updated", "evt_2", false), RECEIVED);
    expect(warningRow().actionable).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM early_fraud_warnings").get()).toEqual({ n: 1 });
  });
});

describe("refund: Stripe first, never a disputed charge, nothing billable", () => {
  it("refunds once with the warning's idempotency key and records it, writing no fee", async () => {
    await processConnectedWebhook(env, warningEvent("created", "evt_1"), RECEIVED);
    const id = warningRow().id as string;

    const result = await refundEarlyFraudWarning(env, { accountId: ACCOUNT, warningId: id, now: RECEIVED });
    expect(result).toEqual({ status: "refunded", refundId: "re_1" });
    expect(harness.refunds).toEqual([
      {
        params: { charge: "ch_9", reason: "fraudulent" },
        options: { idempotencyKey: "early-fraud-warning-refund:issfr_1" },
      },
    ]);
    expect(warningRow()).toMatchObject({ refunded_at: RECEIVED.getTime(), stripe_refund_id: "re_1" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM outcomes").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM billing_line_items").get()).toEqual({ n: 0 });

    // A second click is refused before Stripe is asked again.
    const again = await refundEarlyFraudWarning(env, { accountId: ACCOUNT, warningId: id, now: RECEIVED });
    expect(again).toMatchObject({ status: "error", reason: "already_refunded" });
    expect(harness.refunds).toHaveLength(1);
  });

  it("a charge Stripe says is disputed is never refunded, and another account cannot reach the warning", async () => {
    await processConnectedWebhook(env, warningEvent("created", "evt_1"), RECEIVED);
    const id = warningRow().id as string;

    expect(await refundEarlyFraudWarning(env, { accountId: "acct_other", warningId: id, now: RECEIVED })).toMatchObject({
      status: "error",
      reason: "not_found",
    });

    harness.charge.disputed = true;
    expect(await refundEarlyFraudWarning(env, { accountId: ACCOUNT, warningId: id, now: RECEIVED })).toMatchObject({
      status: "error",
      reason: "stripe_disputed",
    });
    expect(harness.refunds).toHaveLength(0);
    expect(warningRow().refunded_at).toBeNull();
  });
});
