import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
} from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Foxhound starts a recovery sequence only after Stripe's own Smart Retries have run and failed (a
// click on a Foxhound email during Stripe's window would make Stripe's recovery billable). The row is
// created on the first event as `stripe_retrying` with no steps, so the involuntary-churn guard still
// sees it. `next_payment_attempt` null and absent both read as "gave up", so every fixture states it.

const ACCOUNT_ID = "acc_intake";
const CONNECTION_ID = "conn_intake";
const CUSTOMER = "cus_intake";
const INVOICE = "in_intake";

const FIRST_FAILURE = new Date("2026-08-01T00:00:00.000Z");
const STRIPE_GAVE_UP_AT = new Date("2026-08-25T00:00:00.000Z");

const harness = vi.hoisted(() => ({
  db: null as unknown,
  /** Every idempotency key the money write was asked to commit, in order. */
  keys: [] as string[],
  /** The Durable Object's seen-set: it skips a key it has already committed. */
  seen: new Set<string>(),
  /** The invoice's status as Stripe reports it now (invoices.retrieve). */
  invoiceStatus: "open",
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[]; idempotencyKey: string },
  ): Promise<{ applied: boolean }> => {
    harness.keys.push(write.idempotencyKey);
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    harness.seen.add(write.idempotencyKey);
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
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
    invoicePayments: { list: async () => ({ data: [] }) },
    invoices: { retrieve: async () => ({ status: harness.invoiceStatus }) },
  }),
  getStripe: () => {
    throw new Error("platform stripe must not be used here");
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const schema = await import("~/db/schema");

/** A payment_failed event. `nextPaymentAttempt` has no default: absent and null read the same. */
function paymentFailed(
  eventId: string,
  nextPaymentAttempt: number | null,
  opts: { declineCode?: string; invoiceId?: string } = {},
): Stripe.Event {
  return {
    id: eventId,
    type: "invoice.payment_failed",
    account: "acct_connected_1",
    data: {
      object: {
        id: opts.invoiceId ?? INVOICE,
        amount_due: 10_000,
        currency: "usd",
        customer: CUSTOMER,
        customer_email: "payer@example.com",
        collection_method: "charge_automatically",
        next_payment_attempt: nextPaymentAttempt,
        last_finalization_error: { decline_code: opts.declineCode ?? "insufficient_funds" },
      },
    },
  } as unknown as Stripe.Event;
}

function markedUncollectible(eventId: string, invoiceId = INVOICE): Stripe.Event {
  return {
    id: eventId,
    type: "invoice.marked_uncollectible",
    account: "acct_connected_1",
    data: { object: { id: invoiceId } },
  } as unknown as Stripe.Event;
}

function subscriptionCancelled(eventId: string): Stripe.Event {
  return {
    id: eventId,
    type: "customer.subscription.deleted",
    account: "acct_connected_1",
    data: {
      object: {
        id: "sub_intake",
        customer: CUSTOMER,
        cancellation_details: { reason: "payment_failed" },
      },
    },
  } as unknown as Stripe.Event;
}

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(schema.accounts).values({
    id: ACCOUNT_ID,
    name: "Intake Co",
    createdAt: FIRST_FAILURE,
  });
  await db.insert(schema.stripeConnections).values({
    id: CONNECTION_ID,
    accountId: ACCOUNT_ID,
    stripeUserId: "acct_connected_1",
    isPrimary: true,
    stripeAccessToken: "cipher",
    connectedAt: FIRST_FAILURE,
    createdAt: FIRST_FAILURE,
  });
  return db;
}

async function payments(db: Awaited<ReturnType<typeof seed>>) {
  return db.select().from(schema.failedPayments);
}

async function steps(db: Awaited<ReturnType<typeof seed>>) {
  return db.select().from(schema.recoverySteps);
}

beforeEach(() => {
  harness.db = null;
  harness.keys = [];
  harness.seen = new Set<string>();
  harness.invoiceStatus = "open";
});

describe("Stripe is still retrying", () => {
  it("a second failure while Stripe is STILL retrying stays parked and adds no row", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);

    const outcome = await processConnectedWebhook(
      {} as Env,
      paymentFailed("evt_2", 1_757_000_000),
      new Date("2026-08-08T00:00:00.000Z"),
    );
    expect(outcome).toEqual({ status: "ignored", reason: "stripe_still_retrying" });

    // One row, not two: the dedupe has to SEE a stripe_retrying row.
    expect(await payments(db)).toHaveLength(1);
    expect(await steps(db)).toHaveLength(0);
  });

  it("the involuntary-churn guard still sees a parked row", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);

    // Canceled while the payment is still Stripe's: involuntary churn. If the guard could not see
    // the parked row it would read as voluntary and spawn a win-back at a customer whose card just failed.
    const outcome = await processConnectedWebhook(
      {} as Env,
      subscriptionCancelled("evt_cancel"),
      new Date("2026-08-10T00:00:00.000Z"),
    );

    // Assert the guard's own answer: zero win-back sequences would also hold if the guard missed the row.
    expect(outcome).toEqual({ status: "ignored", reason: "involuntary_churn" });
    expect(await db.select().from(schema.winBackSequences)).toHaveLength(0);
  });
});

describe("Stripe has given up", () => {
  it("a later failure with a null next attempt starts the sequence", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);
    expect(await steps(db)).toHaveLength(0);

    const outcome = await processConnectedWebhook(
      {} as Env,
      paymentFailed("evt_final", null),
      STRIPE_GAVE_UP_AT,
    );
    expect(outcome).toEqual({ status: "applied" });

    const [payment] = await payments(db);
    expect(payment.status).toBe(FAILED_PAYMENT_STATUS_ACTIVE);
    // detected_at does not move: the dashboard measures days-to-recover from it.
    expect(payment.detectedAt).toEqual(FIRST_FAILURE);
    expect(await payments(db)).toHaveLength(1);

    const planned = await steps(db);
    expect(planned.length).toBeGreaterThan(0);
    // Every offset hangs off the moment Stripe stopped, not the first failure.
    for (const step of planned) {
      expect(step.scheduledAt.getTime()).toBeGreaterThanOrEqual(STRIPE_GAVE_UP_AT.getTime());
    }
  });

  it("invoice.marked_uncollectible starts it too", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);

    const outcome = await processConnectedWebhook(
      {} as Env,
      markedUncollectible("evt_uncollectible"),
      STRIPE_GAVE_UP_AT,
    );
    expect(outcome).toEqual({ status: "applied" });

    const [payment] = await payments(db);
    expect(payment.status).toBe(FAILED_PAYMENT_STATUS_ACTIVE);
    expect((await steps(db)).length).toBeGreaterThan(0);
  });

  it("a second give-up event plans no second sequence", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);
    await processConnectedWebhook({} as Env, paymentFailed("evt_final", null), STRIPE_GAVE_UP_AT);
    const afterFirst = (await steps(db)).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Stripe can send marked_uncollectible after a final payment_failed; the flip is conditional
    // on the row still being stripe_retrying, so this is a no-op, not a duplicate cadence.
    const outcome = await processConnectedWebhook(
      {} as Env,
      markedUncollectible("evt_uncollectible"),
      new Date("2026-08-26T00:00:00.000Z"),
    );
    expect(outcome).toEqual({ status: "ignored", reason: "sequence_already_started" });
    expect(await steps(db)).toHaveLength(afterFirst);
  });
});

describe("hard declines never wait, because Stripe will not retry the same card", () => {
  // Stripe keeps a next_payment_attempt on an expired or fraud decline but runs it only after a new
  // payment method is attached, so waiting for it to go null would hold the first email for the
  // whole retry window.
  it("an expired_card decline starts on the first event while Stripe still has an attempt scheduled", async () => {
    const db = await seed();

    const outcome = await processConnectedWebhook(
      {} as Env,
      paymentFailed("evt_hard", 1_756_000_000, { declineCode: "expired_card" }),
      FIRST_FAILURE,
    );
    expect(outcome).toEqual({ status: "applied" });

    const [payment] = await payments(db);
    expect(payment.status).toBe(FAILED_PAYMENT_STATUS_ACTIVE);
    expect((await steps(db)).length).toBeGreaterThan(0);
  });
});

describe("a closed invoice opens and keeps no dunning", () => {
  it("a late payment_failed for an invoice Stripe now reports paid is claimed and nothing more", async () => {
    const db = await seed();
    harness.invoiceStatus = "paid";

    const outcome = await processConnectedWebhook(
      {} as Env,
      paymentFailed("evt_late", null),
      FIRST_FAILURE,
    );
    expect(outcome).toEqual({ status: "ignored", reason: "invoice_closed" });
    expect(await payments(db)).toHaveLength(0);
  });

  it("invoice.voided stops a running sequence", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_final", null), FIRST_FAILURE);
    expect((await steps(db)).length).toBeGreaterThan(0);

    const outcome = await processConnectedWebhook(
      {} as Env,
      {
        id: "evt_void",
        type: "invoice.voided",
        account: "acct_connected_1",
        data: { object: { id: INVOICE } },
      } as unknown as Stripe.Event,
      STRIPE_GAVE_UP_AT,
    );
    expect(outcome).toEqual({ status: "applied" });
    const [payment] = await payments(db);
    expect(payment.status).toBe("cancelled");
    expect((await steps(db)).every((s) => s.result === "cancelled")).toBe(true);
  });
});

describe("the promotion is keyed on the payment, which stops a double cadence", () => {
  it("a second give-up delivered concurrently is a no-op, so no second cadence lands", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);
    const [parked] = await payments(db);
    await processConnectedWebhook({} as Env, paymentFailed("evt_final", null), STRIPE_GAVE_UP_AT);
    const afterFirst = (await steps(db)).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Simulate the concurrent delivery: the row is back to stripe_retrying as
    // the second event's read would have seen it, and the second promotion is
    // attempted for real. The DO has already committed this key.
    await db
      .update(schema.failedPayments)
      .set({ status: FAILED_PAYMENT_STATUS_STRIPE_RETRYING })
      .where(eq(schema.failedPayments.id, parked.id));
    const outcome = await processConnectedWebhook(
      {} as Env,
      markedUncollectible("evt_unc"),
      new Date("2026-08-27T00:00:00.000Z"),
    );

    expect(outcome).toEqual({ status: "duplicate" });
    expect(await steps(db)).toHaveLength(afterFirst);
  });
});
