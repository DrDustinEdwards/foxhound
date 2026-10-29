import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The decline a failed payment is classified by comes from its latest charge,
// not the invoice event: on the pinned API version the invoice has no `charge`
// and last_finalization_error covers finalization only, so every real failure
// used to be filed "unknown". The same read stores the network advice, which
// can override the category, and a card-updater event retries the payment's
// next retry step now, through the tick's guarded retry path.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  paymentIntent: null as unknown,
  paid: [] as { invoiceId: string; idempotencyKey: string }[],
  /** The invoice as invoices.retrieve returns it now. */
  invoice: { status: "open", next_payment_attempt: null } as { status: string; next_payment_attempt: number | null },
  /** What invoices.pay throws, when it should. */
  payError: null as unknown,
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
        yield { created: 1, payment: { payment_intent: "pi_1" } };
      },
    },
    paymentIntents: {
      retrieve: async () => {
        if (!harness.paymentIntent) throw new Error("stripe unavailable");
        return harness.paymentIntent;
      },
    },
    invoices: {
      retrieve: async () => harness.invoice,
      pay: async (invoiceId: string, _params: unknown, opts: { idempotencyKey: string }) => {
        harness.paid.push({ invoiceId, idempotencyKey: opts.idempotencyKey });
        if (harness.payError) throw harness.payError;
        return { status: "open" };
      },
    },
  }),
  getStripe: () => {
    throw new Error("platform stripe must not be used here");
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const schema = await import("~/db/schema");

const ACCOUNT = "acc_decline";
const CUSTOMER = "cus_decline";
const AT = new Date("2026-10-01T00:00:00.000Z");

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(schema.accounts).values({ id: ACCOUNT, name: "Decline Co", createdAt: AT });
  await db.insert(schema.stripeConnections).values({
    id: "conn_decline",
    accountId: ACCOUNT,
    stripeUserId: "acct_connected_decline",
    isPrimary: true,
    stripeAccessToken: "cipher",
    connectedAt: AT,
    createdAt: AT,
  });
  return db;
}

function paymentFailed(eventId: string): Stripe.Event {
  return {
    id: eventId,
    type: "invoice.payment_failed",
    account: "acct_connected_decline",
    data: {
      object: {
        id: "in_decline",
        amount_due: 5_000,
        currency: "usd",
        customer: CUSTOMER,
        customer_email: "payer@example.com",
        collection_method: "charge_automatically",
        next_payment_attempt: null,
      },
    },
  } as unknown as Stripe.Event;
}

function cardUpdated(eventId: string): Stripe.Event {
  return {
    id: eventId,
    type: "payment_method.automatically_updated",
    account: "acct_connected_decline",
    data: { object: { id: "pm_1", object: "payment_method", customer: CUSTOMER } },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  harness.paymentIntent = null;
  harness.paid = [];
  harness.invoice = { status: "open", next_payment_attempt: null };
  harness.payError = null;
});

describe("intake reads the decline off the latest charge", () => {
  it("takes the specific decline code, the network advice and the card, and lets the advice win", async () => {
    const db = await seed();
    harness.paymentIntent = {
      id: "pi_1",
      last_payment_error: { decline_code: "insufficient_funds" },
      latest_charge: {
        id: "ch_1",
        failure_code: "card_declined",
        outcome: {
          type: "issuer_declined",
          reason: "insufficient_funds",
          network_advice_code: "do_not_try_again",
          network_decline_code: "05",
        },
        payment_method_details: { card: { funding: "debit", brand: "visa", country: "US" } },
      },
    };

    expect(await processConnectedWebhook({} as Env, paymentFailed("evt_1"), AT)).toEqual({ status: "applied" });

    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.declineCode).toBe("insufficient_funds");
    // Soft by its code, but the network said never to retry it.
    expect(payment.declineCategory).toBe("fraud");
    expect(payment.networkAdviceCode).toBe("do_not_try_again");
    expect(payment.networkDeclineCode).toBe("05");
    expect([payment.cardFunding, payment.cardBrand, payment.cardCountry]).toEqual(["debit", "visa", "US"]);
    const steps = await db.select().from(schema.recoverySteps);
    expect(steps.some((s) => s.stepType.startsWith("retry_"))).toBe(false);
  });

  it("a Stripe read failure never blocks intake", async () => {
    const db = await seed();
    expect(await processConnectedWebhook({} as Env, paymentFailed("evt_1"), AT)).toEqual({ status: "applied" });
    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.declineCategory).toBe("unknown");
    expect(payment.networkAdviceCode).toBeNull();
  });
});

describe("payment_method.automatically_updated retries on the new card now", () => {
  async function seedPayment(db: Awaited<ReturnType<typeof seed>>, networkAdviceCode: string | null = null) {
    await db.insert(schema.failedPayments).values({
      id: "fp_1",
      accountId: ACCOUNT,
      stripeConnectionId: "conn_decline",
      stripeEventId: "evt_intake",
      stripeInvoiceId: "in_decline",
      stripeCustomerId: CUSTOMER,
      customerEmail: "payer@example.com",
      amountCents: 5_000,
      currency: "usd",
      declineCode: "insufficient_funds",
      declineCategory: "soft",
      networkAdviceCode,
      status: "active",
      detectedAt: AT,
    });
    await db.insert(schema.recoverySteps).values({
      id: "step_retry",
      failedPaymentId: "fp_1",
      accountId: ACCOUNT,
      stepType: "retry_day2",
      // Not due for weeks: the card update is what runs it.
      scheduledAt: new Date(Date.now() + 20 * 86_400_000),
    });
  }

  async function stepResult(db: Awaited<ReturnType<typeof seed>>, id = "step_retry") {
    const [step] = await db.select().from(schema.recoverySteps).where(eq(schema.recoverySteps.id, id));
    return step.result;
  }

  it("charges the next pending retry step with its own idempotency key", async () => {
    const db = await seed();
    await seedPayment(db);
    expect(await processConnectedWebhook({} as Env, cardUpdated("evt_cau"), AT)).toEqual({ status: "applied" });
    expect(harness.paid).toEqual([{ invoiceId: "in_decline", idempotencyKey: "foxhound_retry_step_retry" }]);
    expect(await stepResult(db)).toBe("retry_failed");
  });

  it("keeps the lost-dispute and do-not-try-again stops", async () => {
    const db = await seed();
    await seedPayment(db, "do_not_try_again");
    await processConnectedWebhook({} as Env, cardUpdated("evt_cau"), AT);
    expect(harness.paid).toEqual([]);
    expect(await stepResult(db)).toBe("retry_skipped_do_not_try_again");

    const db2 = await seed();
    await seedPayment(db2);
    await db2.insert(schema.disputes).values({
      accountId: ACCOUNT,
      stripeDisputeId: "dp_1",
      stripeChargeId: "ch_old",
      stripeCustomerId: CUSTOMER,
      amountCents: 5_000,
      currency: "usd",
      reason: "fraudulent",
      status: "lost",
      state: "resolved_lost",
      createdAt: AT,
    });
    await processConnectedWebhook({} as Env, cardUpdated("evt_cau"), AT);
    expect(harness.paid).toEqual([]);
    expect(await stepResult(db2)).toBe("retry_skipped_dispute_lost");
  });

  it("a declined retry stores its own decline, and a hard one stops the later retries", async () => {
    const db = await seed();
    await seedPayment(db);
    await db.insert(schema.recoverySteps).values({
      id: "step_retry_2",
      failedPaymentId: "fp_1",
      accountId: ACCOUNT,
      stepType: "retry_day21",
      scheduledAt: new Date(Date.now() + 40 * 86_400_000),
    });
    harness.payError = { type: "StripeCardError", code: "card_declined", decline_code: "stolen_card" };

    await processConnectedWebhook({} as Env, cardUpdated("evt_cau_1"), AT);
    expect(await stepResult(db)).toBe("retry_card_declined");
    const [payment] = await db.select().from(schema.failedPayments);
    expect([payment.declineCode, payment.declineCategory]).toEqual(["stolen_card", "fraud"]);

    await processConnectedWebhook({} as Env, cardUpdated("evt_cau_2"), AT);
    expect(harness.paid).toHaveLength(1);
    expect(await stepResult(db, "step_retry_2")).toBe("retry_skipped_hard_decline");
  });

  it("charges only an invoice Stripe has finished with, and a void one ends recovery", async () => {
    const db = await seed();
    await seedPayment(db);
    harness.invoice = { status: "open", next_payment_attempt: 1_900_000_000 };
    await processConnectedWebhook({} as Env, cardUpdated("evt_cau_1"), AT);
    expect(await stepResult(db)).toBe("retry_skipped_stripe_retrying");

    const db2 = await seed();
    await seedPayment(db2);
    harness.invoice = { status: "void", next_payment_attempt: null };
    await processConnectedWebhook({} as Env, cardUpdated("evt_cau_2"), AT);
    expect(harness.paid).toEqual([]);
    expect(await stepResult(db2)).toBe("retry_skipped_invoice_closed");
    const [payment] = await db2.select().from(schema.failedPayments);
    expect(payment.status).toBe("cancelled");
  });

  it("leaves the step pending when another run holds the charge's idempotency key", async () => {
    const db = await seed();
    await seedPayment(db);
    harness.payError = { type: "StripeIdempotencyError" };
    await processConnectedWebhook({} as Env, cardUpdated("evt_cau"), AT);
    const [step] = await db.select().from(schema.recoverySteps);
    expect([step.executedAt, step.result]).toEqual([null, null]);
  });
});
