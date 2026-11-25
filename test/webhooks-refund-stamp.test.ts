import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getBillableRecoveries } from "~/db/billable";
import { RECOVERY_MATURITY_MS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// A refund stamps recovered_payments so billing never takes a fee on refunded money, whichever of
// the refund and the recovery arrives first.

const ACCOUNT_ID = "acc_refund";
const CONNECTION_ID = "conn_refund";
const NOW = new Date("2026-08-01T04:00:00.000Z");
// Recovered 31 days before the run, so it is matured and otherwise billable.
const RECOVERED_AT = new Date(NOW.getTime() - RECOVERY_MATURITY_MS - 24 * 60 * 60 * 1000);
// The refund lands on day 10 of the maturity window, well before billing.
const REFUNDED_AT = new Date(RECOVERED_AT.getTime() + 10 * 24 * 60 * 60 * 1000);

const harness = vi.hoisted(() => ({
  db: null as unknown,
  invoicePaymentsResult: [{ invoice: "in_recovered_1" }] as { invoice: string }[],
  invoicePaymentsError: null as Error | null,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[] },
  ): Promise<{ applied: boolean }> => {
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      return { applied: true };
    } catch (err) {
      // Mirrors the money DO: a UNIQUE violation (the webhook_events claim on a
      // replay) rolls the whole batch back as an idempotent no-op.
      if (String(err).includes("UNIQUE")) return { applied: false };
      throw err;
    }
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async () => "sk_test_connected",
}));

vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    invoicePayments: {
      list: async () => {
        if (harness.invoicePaymentsError) throw harness.invoicePaymentsError;
        return { data: harness.invoicePaymentsResult };
      },
    },
    invoices: {
      search: async () => {
        throw new Error("search is eventually consistent; the refund path must not use it");
      },
    },
  }),
  getStripe: () => {
    throw new Error("platform stripe must not be used by the connected webhook");
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const schema = await import("~/db/schema");

/** A charge.refunded event; `refunded` is false for a partial refund. */
function refundEvent(id: string, fullyRefunded: boolean): Stripe.Event {
  return {
    id,
    type: "charge.refunded",
    account: "acct_connected_1",
    data: {
      object: {
        id: "ch_1",
        payment_intent: "pi_1",
        refunded: fullyRefunded,
        amount: 10_000,
        amount_refunded: fullyRefunded ? 10_000 : 2_500,
      },
    },
  } as unknown as Stripe.Event;
}

async function seedRecoveredPayment() {
  const { sqlite, db } = createInMemoryDb();
  harness.db = db;

  await db.insert(schema.accounts).values({ id: ACCOUNT_ID, name: "Refund Co", createdAt: NOW });
  await db.insert(schema.stripeConnections).values({
    id: CONNECTION_ID,
    accountId: ACCOUNT_ID,
    stripeUserId: "acct_connected_1",
    stripeAccessToken: "encrypted:token",
    isPrimary: true,
    createdAt: NOW,
  });
  await db.insert(schema.failedPayments).values({
    id: "fp_1",
    accountId: ACCOUNT_ID,
    stripeConnectionId: CONNECTION_ID,
    stripeEventId: "evt_intake",
    stripeInvoiceId: "in_recovered_1",
    stripeCustomerId: "cus_1",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "recovered",
    detectedAt: new Date(RECOVERED_AT.getTime() - 60_000),
    resolvedAt: RECOVERED_AT,
  });
  await db.insert(schema.recoveredPayments).values({
    id: "rp_1",
    accountId: ACCOUNT_ID,
    failedPaymentId: "fp_1",
    recoveredAt: RECOVERED_AT,
    amountCents: 10_000,
    currency: "usd",
    recoveryMethod: "foxhound_retry",
    attributionKind: "foxhound_retry",
  });
  return { sqlite, db };
}

beforeEach(() => {
  harness.invoicePaymentsResult = [{ invoice: "in_recovered_1" }];
  harness.invoicePaymentsError = null;
});

describe("a partial refund reduces the fee base; a full refund ends it", () => {
  it("keeps the largest refunded amount when Stripe's events arrive out of order", async () => {
    const { db } = await seedRecoveredPayment();
    await processConnectedWebhook({} as Env, refundEvent("evt_full", true), REFUNDED_AT);
    await processConnectedWebhook({} as Env, refundEvent("evt_partial_late", false), REFUNDED_AT);

    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.refundedCents).toBe(10_000);
    expect(recovery.refundedAt).toEqual(REFUNDED_AT);
    expect(await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime())).toHaveLength(0);
  });

  it("a partial refund leaves the recovery billable on what is left", async () => {
    const { db } = await seedRecoveredPayment();
    await processConnectedWebhook({} as Env, refundEvent("evt_partial", false), REFUNDED_AT);

    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.refundedAt).toBeNull();
    expect(recovery.refundedCents).toBe(2_500);
    expect(await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime())).toHaveLength(1);
  });
});

// The stamp is an UPDATE, so a refund processed before the recovery exists must still be remembered.
describe("a refund that arrives BEFORE the recovery still unbills it", () => {
  // A minute before the recovery lands, so the refund is genuinely first.
  const REFUND_BEFORE_AT = new Date(RECOVERED_AT.getTime() - 60_000);

  /** failed_payment still active, one clicked email step (so the recovery
   *  attributes to email_engaged and is genuinely BILLABLE), and deliberately
   *  NO recovered_payments row yet. */
  async function seedAwaitingRecovery() {
    const { db } = createInMemoryDb();
    harness.db = db;

    await db.insert(schema.accounts).values({ id: ACCOUNT_ID, name: "Refund Co", createdAt: NOW });
    await db.insert(schema.stripeConnections).values({
      id: CONNECTION_ID,
      accountId: ACCOUNT_ID,
      stripeUserId: "acct_connected_1",
      stripeAccessToken: "encrypted:token",
      isPrimary: true,
      createdAt: NOW,
    });
    await db.insert(schema.failedPayments).values({
      id: "fp_1",
      accountId: ACCOUNT_ID,
      stripeConnectionId: CONNECTION_ID,
      stripeEventId: "evt_intake",
      stripeInvoiceId: "in_recovered_1",
      stripeCustomerId: "cus_1",
      customerEmail: "payer@example.com",
      amountCents: 10_000,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: new Date(RECOVERED_AT.getTime() - 5 * 60_000),
    });
    await db.insert(schema.recoverySteps).values({
      id: "step_1",
      accountId: ACCOUNT_ID,
      failedPaymentId: "fp_1",
      stepType: "email_day1",
      stepNumber: 1,
      scheduledAt: new Date(RECOVERED_AT.getTime() - 4 * 60_000),
      executedAt: new Date(RECOVERED_AT.getTime() - 4 * 60_000),
      result: "email_sent",
      clickedAt: new Date(RECOVERED_AT.getTime() - 3 * 60_000),
    });
    return db;
  }

  function paymentSucceeded(eventId: string): Stripe.Event {
    return {
      id: eventId,
      type: "invoice.payment_succeeded",
      account: "acct_connected_1",
      data: {
        object: { id: "in_recovered_1", amount_paid: 10_000, currency: "usd", customer: "cus_1" },
      },
    } as unknown as Stripe.Event;
  }

  it("records the recovery already refunded, and never bills it, when fully refunded first", async () => {
    const db = await seedAwaitingRecovery();

    // 1. The refund lands with nothing to stamp.
    expect(
      await processConnectedWebhook({} as Env, refundEvent("evt_early", true), REFUND_BEFORE_AT),
    ).toEqual({ status: "applied" });

    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.refundSignalAt).toEqual(REFUND_BEFORE_AT);
    expect(await db.select().from(schema.recoveredPayments)).toHaveLength(0);

    // 2. The recovery lands afterwards and is born refunded.
    expect(
      await processConnectedWebhook({} as Env, paymentSucceeded("evt_late"), RECOVERED_AT),
    ).toEqual({ status: "applied" });

    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.attributionKind).toBe("email_engaged"); // billable kind
    expect(recovery.refundedAt).toEqual(REFUND_BEFORE_AT);

    expect(await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime())).toHaveLength(0);
  });

  it("records a partial refund that came first, so the fee is taken on what is left", async () => {
    const db = await seedAwaitingRecovery();
    await processConnectedWebhook({} as Env, refundEvent("evt_early", false), REFUND_BEFORE_AT);
    await processConnectedWebhook({} as Env, paymentSucceeded("evt_late"), RECOVERED_AT);

    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.refundedAt).toBeNull();
    expect(recovery.refundedCents).toBe(2_500);
    const billable = await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime());
    expect(billable.map((r) => [r.amountCents, r.refundedCents])).toEqual([[10_000, 2_500]]);
  });

  it("records the recovery already disputed when the dispute intake landed first", async () => {
    const db = await seedAwaitingRecovery();
    const { buildDisputeIntakeBatch } = await import("~/lib/webhooks/dispute-batches");
    const DISPUTED_AT = REFUND_BEFORE_AT;

    // 1. Dispute intake for this payment's charge, with no recovery row yet.
    await db.batch(
      buildDisputeIntakeBatch(db, {
        claim: {
          stripeEventId: "evt_dispute_early",
          eventType: "charge.dispute.created",
          accountId: ACCOUNT_ID,
          receivedAt: DISPUTED_AT,
          payload: {},
        },
        disputeId: "dp_1",
        accountId: ACCOUNT_ID,
        stripeConnectionId: CONNECTION_ID,
        stripeDisputeId: "dp_stripe_1",
        stripeChargeId: "ch_1",
        stripeCustomerId: "cus_1",
        customerEmail: null,
        customerName: null,
        amountCents: 10_000,
        currency: "usd",
        reason: "fraudulent",
        status: "needs_response",
        evidenceDeadline: null,
        createdAt: DISPUTED_AT,
        linkedFailedPaymentId: "fp_1",
        evidence: [],
      }),
    );

    // 2. The recovery lands afterwards and is born disputed, so it never bills.
    expect(
      await processConnectedWebhook({} as Env, paymentSucceeded("evt_late_disputed"), RECOVERED_AT),
    ).toEqual({ status: "applied" });

    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.disputedAt).toEqual(DISPUTED_AT);
    expect(await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime())).toHaveLength(0);
  });
});

describe("refund resolution failure semantics", () => {
  it("a refund on a payment Foxhound never took in claims and ignores", async () => {
    const { db } = await seedRecoveredPayment();
    harness.invoicePaymentsResult = []; // Stripe answered; no invoice payment matches.

    expect(
      await processConnectedWebhook({} as Env, refundEvent("evt_theirs", true), REFUNDED_AT),
    ).toEqual({
      status: "ignored",
      reason: "refund_not_ours",
    });
    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.refundedAt).toBeNull();
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);
  });

  it("a TRANSIENT resolution failure claims nothing and surfaces as an error, so Stripe redelivers", async () => {
    const { db } = await seedRecoveredPayment();
    harness.invoicePaymentsError = new Error("stripe unavailable");

    const outcome = await processConnectedWebhook(
      {} as Env,
      refundEvent("evt_flaky", true),
      REFUNDED_AT,
    );
    expect(outcome.status).toBe("error");

    // Nothing claimed: the event must come back. Claiming an unstampable refund
    // is the one direction that overcharges a merchant.
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.refundedAt).toBeNull();
  });

  it("a TRANSIENT failure on dispute intake saves no unlinked dispute, so Stripe redelivers", async () => {
    const { db } = await seedRecoveredPayment();
    harness.invoicePaymentsError = new Error("stripe unavailable");
    const disputeCreated = {
      id: "evt_dispute_flaky",
      type: "charge.dispute.created",
      account: "acct_connected_1",
      data: {
        object: {
          id: "dp_flaky",
          charge: "ch_1",
          payment_intent: "pi_1",
          amount: 10_000,
          currency: "usd",
        },
      },
    } as unknown as Stripe.Event;

    const outcome = await processConnectedWebhook({} as Env, disputeCreated, REFUNDED_AT);
    expect(outcome.status).toBe("error");
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
    expect(await db.select().from(schema.disputes)).toHaveLength(0);
  });
});
