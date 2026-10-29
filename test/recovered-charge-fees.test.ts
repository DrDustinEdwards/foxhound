import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// A recovery records what Stripe actually took: the paying charge's balance
// transaction gives its fee and net, read before the money batch and stored on
// the recovered_payments row. The read is best effort: when Stripe fails, the
// recovery is recorded exactly as before with the fee columns null, and the
// gross amount billing reads is never touched either way.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  paymentIntent: null as unknown,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
      return { applied: true };
    } catch (err) {
      if (String(err).includes("UNIQUE")) return { applied: false };
      throw err;
    }
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({ decryptToken: async () => "sk_test_connected" }));
vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    invoicePayments: {
      list: async function* () {
        yield { created: 1, payment: { payment_intent: "pi_paid" } };
      },
    },
    paymentIntents: {
      retrieve: async (_id: string, params: { expand: string[] }) => {
        if (!harness.paymentIntent) throw new Error("stripe unavailable");
        expect(params.expand).toContain("latest_charge.balance_transaction");
        return harness.paymentIntent;
      },
    },
  }),
  getStripe: () => {
    throw new Error("platform stripe must not be used here");
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const schema = await import("~/db/schema");

const ACCOUNT = "acc_fees";
const AT = new Date("2026-10-01T00:00:00.000Z");

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(schema.accounts).values({ id: ACCOUNT, name: "Fees Co", createdAt: AT });
  await db.insert(schema.stripeConnections).values({
    id: "conn_fees",
    accountId: ACCOUNT,
    stripeUserId: "acct_connected_fees",
    isPrimary: true,
    stripeAccessToken: "cipher",
    connectedAt: AT,
    createdAt: AT,
  });
  await db.insert(schema.failedPayments).values({
    id: "fp_fees",
    accountId: ACCOUNT,
    stripeConnectionId: "conn_fees",
    stripeEventId: "evt_intake",
    stripeInvoiceId: "in_fees",
    stripeCustomerId: "cus_fees",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "active",
    detectedAt: AT,
  });
  return db;
}

function paymentSucceeded(): Stripe.Event {
  return {
    id: "evt_paid",
    type: "invoice.payment_succeeded",
    account: "acct_connected_fees",
    data: { object: { id: "in_fees", amount_paid: 10_000, currency: "usd", customer: "cus_fees" } },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  harness.paymentIntent = null;
});

describe("a recovery records Stripe's fee and net from the charge's balance transaction", () => {
  it("stores the fee, net and settlement currency beside the gross amount", async () => {
    const db = await seed();
    harness.paymentIntent = {
      id: "pi_paid",
      latest_charge: {
        id: "ch_paid",
        balance_transaction: { id: "txn_paid", amount: 10_000, fee: 320, net: 9_680, currency: "usd" },
      },
    };

    expect(await processConnectedWebhook({} as Env, paymentSucceeded(), AT)).toEqual({ status: "applied" });

    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery).toMatchObject({
      amountCents: 10_000,
      currency: "usd",
      stripeBalanceTransactionId: "txn_paid",
      stripeFeeCents: 320,
      netAmountCents: 9_680,
      netCurrency: "usd",
    });
  });

  it("a Stripe read failure records the recovery with the fee left null", async () => {
    const db = await seed();

    expect(await processConnectedWebhook({} as Env, paymentSucceeded(), AT)).toEqual({ status: "applied" });

    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.status).toBe("recovered");
    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery).toMatchObject({
      amountCents: 10_000,
      stripeBalanceTransactionId: null,
      stripeFeeCents: null,
      netAmountCents: null,
      netCurrency: null,
    });
  });
});
