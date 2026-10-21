import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_STRIPE_RETRYING,
} from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 377(1): FOXHOUND STARTED WHILE STRIPE WAS STILL TRYING.
//
// Intake spawned the recovery sequence on the FIRST invoice.payment_failed, so
// the 4-hour retry and the day-1 email ran inside Stripe's own Smart Retries
// window. Two things followed. The docs' promise, "Foxhound starts after
// Stripe's own Smart Retries have run and failed", was false at HEAD. And a
// customer clicking a Foxhound email during Stripe's window made STRIPE'S
// recovery billable, which is money taken for work Foxhound did not do.
//
// The row is still created on the first event, in the new `stripe_retrying`
// status with no steps. That is halt 1 of session 82 and it is not a detail:
// the involuntary-churn guard keys on a failed_payments row existing, so
// deferring the row would turn a card-failure cancellation into a win-back
// campaign aimed at customers whose card just failed.
//
// BOTH ARMS ARE PLANTED, and that is the point of this file. `stripeGaveUp` is
// derived from `next_payment_attempt` being null, and an ABSENT field is also
// null, so a suite whose fixtures omit it passes identically whether the gate
// works or was never written. Every fixture here states the field.

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
  /** The Durable Object's seen-set, modelled rather than stubbed away: the DO
   *  skips a key it has already committed and reports applied=false. Without
   *  this the mock would be more permissive than production and the
   *  payment-scoped key below would prove nothing. */
  seen: new Set<string>(),
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
  getConnectedStripe: () => ({ invoicePayments: { list: async () => ({ data: [] }) } }),
  getStripe: () => {
    throw new Error("platform stripe must not be used here");
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { classifyStripeEvent } = await import("~/lib/webhooks/events");
const schema = await import("~/db/schema");

/**
 * A payment_failed event. `nextPaymentAttempt` is REQUIRED by this helper, with
 * no default: the whole defect class here is a field that means one thing when
 * absent and another when stated, so a fixture cannot decline to say.
 */
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
});

describe("the classifier reads Stripe's own retry intent", () => {
  it("a scheduled next attempt means Stripe has NOT given up", () => {
    const intent = classifyStripeEvent(paymentFailed("evt_a", 1_756_000_000));
    expect(intent.kind).toBe("intake");
    if (intent.kind === "intake") expect(intent.stripeGaveUp).toBe(false);
  });

  it("a null next attempt means Stripe HAS given up", () => {
    const intent = classifyStripeEvent(paymentFailed("evt_b", null));
    expect(intent.kind).toBe("intake");
    if (intent.kind === "intake") expect(intent.stripeGaveUp).toBe(true);
  });

  it("invoice.marked_uncollectible is its own intent, not an unhandled type", () => {
    expect(classifyStripeEvent(markedUncollectible("evt_c"))).toEqual({
      kind: "stripe_gave_up",
      invoiceId: INVOICE,
    });
  });
});

describe("ARM ONE: Stripe is still retrying", () => {
  it("records the payment in stripe_retrying and plans NOTHING", async () => {
    const db = await seed();

    const outcome = await processConnectedWebhook(
      {} as Env,
      paymentFailed("evt_first", 1_756_000_000),
      FIRST_FAILURE,
    );
    expect(outcome).toEqual({ status: "applied" });

    const [payment] = await payments(db);
    expect(payment.status).toBe(FAILED_PAYMENT_STATUS_STRIPE_RETRYING);
    expect(payment.detectedAt).toEqual(FIRST_FAILURE);
    // The whole point: no outreach while the payment is Stripe's.
    expect(await steps(db)).toHaveLength(0);
  });

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

  it("THE HALT-1 CASE: the involuntary-churn guard still sees a parked row", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);

    // The subscription is cancelled while the payment is still Stripe's. This
    // is involuntary churn, and if the guard cannot see the parked row it reads
    // as voluntary and spawns a win-back at a customer whose card just failed.
    const outcome = await processConnectedWebhook(
      {} as Env,
      subscriptionCancelled("evt_cancel"),
      new Date("2026-08-10T00:00:00.000Z"),
    );

    // ASSERT ON THE GUARD'S OWN ANSWER, not on a downstream absence. The first
    // version of this test asserted "no win-back sequence exists", which stayed
    // GREEN when the guard was narrowed back to active-only: the win-back path
    // returns early in this fixture for its own reasons, so zero sequences
    // proved nothing about whether the guard saw the row. `involuntary_churn`
    // is reachable ONLY through listActiveFailedPaymentIds finding it.
    expect(outcome).toEqual({ status: "ignored", reason: "involuntary_churn" });
    expect(await db.select().from(schema.winBackSequences)).toHaveLength(0);
  });
});

describe("ARM TWO: Stripe has given up", () => {
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
    // detected_at DOES NOT MOVE. 377(1) records the cost of the split as "day
    // 30 becomes roughly day 58", which is counted from the original failure,
    // so this column has to still mark it. The dashboard measures
    // days-to-recover and failures-per-day from it too.
    expect(payment.detectedAt).toEqual(FIRST_FAILURE);
    expect(await payments(db)).toHaveLength(1);

    const planned = await steps(db);
    expect(planned.length).toBeGreaterThan(0);
    // Every offset hangs off the moment STRIPE STOPPED, not the first failure.
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

  it("a SECOND give-up event plans no second sequence", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);
    await processConnectedWebhook({} as Env, paymentFailed("evt_final", null), STRIPE_GAVE_UP_AT);
    const afterFirst = (await steps(db)).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Stripe can send marked_uncollectible after a final payment_failed. The
    // flip is conditional on the row still being stripe_retrying, so this is a
    // no-op rather than a duplicate cadence.
    const outcome = await processConnectedWebhook(
      {} as Env,
      markedUncollectible("evt_uncollectible"),
      new Date("2026-08-26T00:00:00.000Z"),
    );
    expect(outcome).toEqual({ status: "ignored", reason: "sequence_already_started" });
    expect(await steps(db)).toHaveLength(afterFirst);
  });
});

describe("hard declines never wait, because Stripe never retries them", () => {
  // Stripe does not retry an expired card, a fraud block or a revoked card, so
  // those invoices carry a null next_payment_attempt on the FIRST failure and
  // run through the same single gate. No decline-category branch exists in the
  // code, and these prove the behaviour falls out of Stripe's own field.
  it.each([
    ["expired_card", "expired"],
    ["fraudulent", "fraud"],
  ])("%s starts on the first event", async (declineCode) => {
    const db = await seed();

    const outcome = await processConnectedWebhook(
      {} as Env,
      paymentFailed("evt_hard", null, { declineCode }),
      FIRST_FAILURE,
    );
    expect(outcome).toEqual({ status: "applied" });

    const [payment] = await payments(db);
    expect(payment.status).toBe(FAILED_PAYMENT_STATUS_ACTIVE);
    expect((await steps(db)).length).toBeGreaterThan(0);
  });

  it("a soft decline WAITS, which is the contrast that makes the above mean something", async () => {
    const db = await seed();

    await processConnectedWebhook(
      {} as Env,
      paymentFailed("evt_soft", 1_756_000_000, { declineCode: "insufficient_funds" }),
      FIRST_FAILURE,
    );

    const [payment] = await payments(db);
    expect(payment.status).toBe(FAILED_PAYMENT_STATUS_STRIPE_RETRYING);
    expect(await steps(db)).toHaveLength(0);
  });
});

describe("the parked row does not leak into the rest of the engine", () => {
  it("a payment on a parked invoice still records, and attributes to no Foxhound action", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);

    const paid = {
      id: "evt_paid",
      type: "invoice.payment_succeeded",
      account: "acct_connected_1",
      data: {
        object: { id: INVOICE, amount_paid: 10_000, currency: "usd", customer: CUSTOMER },
      },
    } as unknown as Stripe.Event;

    await processConnectedWebhook({} as Env, paid, new Date("2026-08-05T00:00:00.000Z"));

    const recoveries = await db.select().from(schema.recoveredPayments);
    expect(recoveries).toHaveLength(1);
    // Stripe's own retry got the money and Foxhound sent nothing, so this is
    // the free baseline. Billing it would be the exact defect 377(1) closes.
    expect(recoveries[0].attributionKind).toBe("stripe_baseline");

    const [payment] = await db
      .select()
      .from(schema.failedPayments)
      .where(eq(schema.failedPayments.stripeInvoiceId, INVOICE));
    expect(payment.status).toBe("recovered");
  });
});


describe("the promotion is keyed on the PAYMENT, which is what stops a double cadence", () => {
  it("both give-up routes derive the same payment-scoped key", async () => {
    const db = await seed();
    await processConnectedWebhook({} as Env, paymentFailed("evt_1", 1_756_000_000), FIRST_FAILURE);
    const [parked] = await payments(db);

    await processConnectedWebhook({} as Env, paymentFailed("evt_final", null), STRIPE_GAVE_UP_AT);
    const viaPaymentFailed = harness.keys.at(-1);

    // Put the row back so the uncollectible route reaches its promotion too,
    // in isolation from the first. This is about how the KEY is derived.
    await db
      .update(schema.failedPayments)
      .set({ status: FAILED_PAYMENT_STATUS_STRIPE_RETRYING })
      .where(eq(schema.failedPayments.id, parked.id));
    await processConnectedWebhook(
      {} as Env,
      markedUncollectible("evt_unc"),
      new Date("2026-08-27T00:00:00.000Z"),
    );
    const viaUncollectible = harness.keys.at(-1);

    expect(viaPaymentFailed).toBe(`sequence-start:${parked.id}`);
    // SAME key from a DIFFERENT event, which is the whole point. Keyed on the
    // event, two give-up events for one invoice would each commit a cadence,
    // because the status read that separates them happens outside the Durable
    // Object. A plant measured that: the second promotion's steps landed even
    // though its conditional flip matched nothing, giving sixteen steps.
    expect(viaUncollectible).toBe(viaPaymentFailed);
  });

  it("and the second commit under that key is a no-op, so no second cadence lands", async () => {
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
