import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// WRITER TWO (341 binding 4): the Stripe webhook's customer.updated handler.
//
// IT RECORDS AND NEVER SENDS. Legacy's handleCustomerUpdated writes the
// candidate row and the nightly cron owns every send, so a card update cannot
// email a customer directly. Half a subsystem is not parity, which is why this
// writer exists at all.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sent: [] as unknown[],
  retrievedPaymentMethods: [] as string[],
  paymentMethod: null as unknown,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    const batch = write.build(harness.db);
    await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
    return { applied: true };
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async (_e: unknown, c: string) => `plain:${c}`,
}));

vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    paymentMethods: {
      retrieve: async (id: string) => {
        harness.retrievedPaymentMethods.push(id);
        if (!harness.paymentMethod) throw new Error("no payment method");
        return harness.paymentMethod;
      },
    },
  }),
  getStripe: () => ({}),
}));

const { classifyStripeEvent } = await import("~/lib/webhooks/events");
const { processConnectedWebhook } = await import("~/lib/webhooks/process");

const ACCOUNT = "acct_1";
const RECEIVED = new Date("2026-11-01T00:00:00Z");
const env = { ENCRYPTION_KEY: "ab".repeat(32) } as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.sent = [];
  harness.retrievedPaymentMethods = [];
  harness.paymentMethod = null;
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000)",
    )
    .run(ACCOUNT);
});

function customerEvent(customer: Record<string, unknown>, id = "evt_1") {
  return {
    id,
    type: "customer.updated",
    account: "acct_stripe",
    data: { object: { id: "cus_1", email: "buyer@acme.test", name: "Jane Buyer", ...customer } },
  } as never;
}

function alertRows() {
  return sqlite
    .prepare(
      "SELECT stripe_customer_id AS customer, card_brand AS brand, card_last4 AS last4, expires_month AS m, expires_year AS y, alert_sent_at AS sentAt FROM expiring_card_alerts",
    )
    .all() as { customer: string; brand: string | null; last4: string | null; m: number; y: number; sentAt: number | null }[];
}

describe("PLANT 1: the classifier reads the card both ways legacy does", () => {

  it("ignores a customer with no card and one with no email", () => {
    expect(classifyStripeEvent(customerEvent({})).kind).toBe("ignore");
    expect(
      classifyStripeEvent(
        customerEvent({ email: null, sources: { data: [{ object: "card", exp_month: 11, exp_year: 2026 }] } }),
      ).kind,
    ).toBe("ignore");
  });
});

describe("PLANT 2: the webhook records a candidate and sends nothing", () => {
  it("writes the candidate from an inline card", async () => {
    const result = await processConnectedWebhook(
      env,
      customerEvent({ sources: { data: [{ object: "card", exp_month: 11, exp_year: 2026, brand: "visa", last4: "4242" }] } }),
      RECEIVED,
    );

    expect(result).toEqual({ status: "applied" });
    expect(alertRows()).toEqual([
      { customer: "cus_1", brand: "visa", last4: "4242", m: 11, y: 2026, sentAt: null },
    ]);
    // NEVER SENDS: the candidate is unsent and the nightly cron owns that.
    expect(harness.sent).toHaveLength(0);
  });

  it("retrieves the payment method when the event carries only its id", async () => {
    harness.paymentMethod = { card: { exp_month: 12, exp_year: 2026, brand: "amex", last4: "0005" } };

    await processConnectedWebhook(
      env,
      customerEvent({ invoice_settings: { default_payment_method: "pm_1" } }),
      RECEIVED,
    );

    expect(harness.retrievedPaymentMethods).toEqual(["pm_1"]);
    expect(alertRows()[0]).toMatchObject({ brand: "amex", last4: "0005", m: 12, y: 2026 });
  });

  it("AN ALREADY EXPIRED CARD RECORDS NOTHING, closing legacy's asymmetry", async () => {
    // Legacy's webhook guards only the upper bound, so it records expired cards
    // its own cron would never alert on, and the send pass would then email
    // about a card that already lapsed. Both writers share one band here.
    const result = await processConnectedWebhook(
      env,
      customerEvent({ sources: { data: [{ object: "card", exp_month: 9, exp_year: 2026, brand: "visa", last4: "4242" }] } }),
      RECEIVED,
    );
    expect(result).toEqual({ status: "ignored", reason: "card_outside_lead_window" });
    expect(alertRows()).toEqual([]);
  });

  it("a payment method that cannot be read is an ignore, never a failed webhook", async () => {
    harness.paymentMethod = null;
    const result = await processConnectedWebhook(
      env,
      customerEvent({ invoice_settings: { default_payment_method: "pm_missing" } }),
      RECEIVED,
    );
    expect(result).toEqual({ status: "ignored", reason: "no_card" });
    expect(alertRows()).toEqual([]);
  });
});

describe("PLANT 3: the two writers share one dedupe", () => {
  it("a repeated customer.updated for the same card-month writes one row", async () => {
    const event = (id: string) =>
      customerEvent(
        { sources: { data: [{ object: "card", exp_month: 11, exp_year: 2026, brand: "visa", last4: "4242" }] } },
        id,
      );

    await processConnectedWebhook(env, event("evt_1"), RECEIVED);
    await processConnectedWebhook(env, event("evt_2"), RECEIVED);

    expect(alertRows()).toHaveLength(1);
  });

  it("the candidate it writes is what the cron's send pass picks up", async () => {
    await processConnectedWebhook(
      env,
      customerEvent({ sources: { data: [{ object: "card", exp_month: 11, exp_year: 2026, brand: "visa", last4: "4242" }] } }),
      RECEIVED,
    );

    // Live sends default OFF for a new account, which would make the send a
    // logged "blocked" rather than a send. This assertion is about the HANDOFF
    // between the two writers, so the gate is opened deliberately.
    sqlite.prepare("UPDATE accounts SET live_sends_enabled = 1 WHERE id = ?").run(ACCOUNT);
    const { sendExpiringCardAlerts } = await import("~/lib/cron/expiring-cards");
    const sendEnv = {
      ...env,
      BETTER_AUTH_URL: "https://foxhoundapp.test",
      PHYSICAL_ADDRESS: "1 Test Way",
      EMAIL: { send: async () => ({ id: "m1" }) },
    } as unknown as Env;

    const result = await sendExpiringCardAlerts(sendEnv, RECEIVED);

    expect(result.sent).toBe(1);
    expect(alertRows()[0].sentAt).not.toBeNull();
  });
});
