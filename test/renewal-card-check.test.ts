import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The renewal card check: invoice.upcoming and customer.subscription.trial_will_end
// record into the expiring-card table when the charge they announce will fail,
// and the nightly send pass mails it like any other candidate.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  customer: null as unknown,
  subscriptions: {} as Record<string, unknown>,
  paymentMethods: {} as Record<string, unknown>,
  sent: [] as { subject: string; text?: string }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
    return { applied: true };
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async (_e: unknown, c: string) => `plain:${c}`,
}));

vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    customers: { retrieve: async () => harness.customer },
    subscriptions: { retrieve: async (id: string) => harness.subscriptions[id] },
    paymentMethods: { retrieve: async (id: string) => harness.paymentMethods[id] },
  }),
  getStripe: () => ({}),
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { sendExpiringCardAlerts } = await import("~/lib/cron/expiring-cards");

const ACCOUNT = "acct_1";
const RECEIVED = new Date("2026-11-01T00:00:00Z");
const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  PHYSICAL_ADDRESS: "1 Test Way",
  EMAIL: {
    send: async (m: { subject: string; text?: string }) => {
      harness.sent.push(m);
      return { id: "m1" };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;

beforeEach(() => {
  let db;
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.customer = { id: "cus_1", email: "buyer@acme.test", name: "Jane Buyer", invoice_settings: {} };
  harness.subscriptions = {};
  harness.paymentMethods = {};
  harness.sent = [];
  sqlite.prepare("INSERT INTO accounts (id, name, created_at, live_sends_enabled) VALUES (?, 'Acme', 1000, 1)").run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000)",
    )
    .run(ACCOUNT);
});

const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function upcomingInvoice(renewsAt: string, id = "evt_up") {
  return {
    id,
    type: "invoice.upcoming",
    account: "acct_stripe",
    data: {
      object: {
        customer: "cus_1",
        customer_email: "buyer@acme.test",
        customer_name: "Jane Buyer",
        collection_method: "charge_automatically",
        amount_due: 4900,
        next_payment_attempt: seconds(renewsAt),
        default_payment_method: null,
        parent: { subscription_details: { subscription: "sub_1" } },
      },
    },
  } as never;
}

function rows() {
  return sqlite
    .prepare("SELECT card_last4 AS last4, expires_month AS m, expires_year AS y, reason FROM expiring_card_alerts")
    .all();
}

describe("invoice.upcoming", () => {
  it("records a card that expires before the renewal, even past the 30-day lead window", async () => {
    // The subscription's default is the card charged. It expires 12/2026, which
    // is outside the nightly scan's 30 days, but the renewal is in January.
    harness.subscriptions.sub_1 = { default_payment_method: "pm_sub" };
    harness.paymentMethods.pm_sub = { card: { exp_month: 12, exp_year: 2026, brand: "visa", last4: "4242" } };

    const result = await processConnectedWebhook(env, upcomingInvoice("2027-01-05T00:00:00Z"), RECEIVED);

    expect(result).toEqual({ status: "applied" });
    expect(rows()).toEqual([{ last4: "4242", m: 12, y: 2026, reason: "card_expiring" }]);
  });

  it("records nothing when the card is still valid on the renewal date", async () => {
    harness.subscriptions.sub_1 = { default_payment_method: "pm_sub" };
    harness.paymentMethods.pm_sub = { card: { exp_month: 12, exp_year: 2026, brand: "visa", last4: "4242" } };

    const result = await processConnectedWebhook(env, upcomingInvoice("2026-12-20T00:00:00Z"), RECEIVED);

    expect(result).toEqual({ status: "ignored", reason: "card_valid_at_charge" });
    expect(rows()).toEqual([]);
  });
});

describe("customer.subscription.trial_will_end", () => {
  it("a trial with no payment method records a no-card alert, and the send pass mails the variant", async () => {
    const event = {
      id: "evt_trial",
      type: "customer.subscription.trial_will_end",
      account: "acct_stripe",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          trial_end: seconds("2026-11-04T00:00:00Z"),
          cancel_at_period_end: false,
          collection_method: "charge_automatically",
          default_payment_method: null,
        },
      },
    } as never;

    expect(await processConnectedWebhook(env, event, RECEIVED)).toEqual({ status: "applied" });
    expect(rows()).toEqual([{ last4: null, m: 11, y: 2026, reason: "no_payment_method" }]);

    const send = await sendExpiringCardAlerts(env, RECEIVED);
    expect(send.sent).toBe(1);
    expect(harness.sent[0].subject).toBe("Action required: Add a payment method before your trial ends");
    expect(harness.sent[0].text).toContain("your trial ends on 11/2026");
    expect(harness.sent[0].text).not.toContain("card ending in");
  });

  it("a customer charged through a legacy default source is not called cardless", async () => {
    harness.customer = { id: "cus_1", email: "buyer@acme.test", name: null, invoice_settings: {}, default_source: "card_1" };
    const event = {
      id: "evt_trial2",
      type: "customer.subscription.trial_will_end",
      account: "acct_stripe",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          trial_end: seconds("2026-11-04T00:00:00Z"),
          collection_method: "charge_automatically",
          default_payment_method: null,
        },
      },
    } as never;

    expect(await processConnectedWebhook(env, event, RECEIVED)).toEqual({ status: "ignored", reason: "legacy_source" });
    expect(rows()).toEqual([]);
  });
});
