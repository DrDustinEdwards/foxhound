import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getBillableRecoveries } from "~/db/billable";
import { RECOVERY_MATURITY_MS } from "~/lib/constants";
import { classifyStripeEvent } from "~/lib/webhooks/events";

import { createInMemoryDb } from "./helpers/inmemory-db";

// charge.refunded was CLASSIFIED and never APPLIED: buildRefundStampBatch had
// zero callers, so recovered_payments.refunded_at stayed null forever and
// app/db/billable.ts's isNull(refundedAt) clause could never exclude anything.
// Foxhound would have invoiced 20% of money the merchant had already refunded,
// on the very first billing run.
//
// Two distinct defects are pinned here, and each assertion below fails against
// the pre-fix code:
//   1. classifyStripeEvent dropped PARTIAL refunds entirely
//      (`if (!charge.refunded) return ignore`), against parity ruling 29.
//   2. processConnectedWebhook's stamp_refund branch claimed the event and
//      returned "stamp_refund_resolution_deferred" without ever stamping.

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

/** A charge.refunded event. `fullyRefunded` drives Stripe's `refunded` flag,
 *  which is FALSE for a partial refund: the exact field the pre-fix classifier
 *  used to drop the event. */
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

describe("classifyStripeEvent on charge.refunded (parity ruling 29)", () => {
  it("classifies a PARTIAL refund as stamp_refund, not ignore", () => {
    // Pre-fix this returned { kind: "ignore", reason: "partial_refund" }.
    expect(classifyStripeEvent(refundEvent("evt_partial", false))).toEqual({
      kind: "stamp_refund",
      paymentIntentId: "pi_1",
    });
  });

  it("still classifies a FULL refund as stamp_refund", () => {
    expect(classifyStripeEvent(refundEvent("evt_full", true))).toEqual({
      kind: "stamp_refund",
      paymentIntentId: "pi_1",
    });
  });

  it("ignores a refund with no payment intent to resolve against", () => {
    const event = refundEvent("evt_no_pi", true) as unknown as {
      data: { object: { payment_intent: null } };
    };
    event.data.object.payment_intent = null;
    expect(classifyStripeEvent(event as unknown as Stripe.Event)).toEqual({
      kind: "ignore",
      reason: "no_payment_intent",
    });
  });
});

describe("a refunded recovery is not billable at maturity", () => {
  for (const [label, fullyRefunded] of [
    ["fully", true],
    ["partially", false],
  ] as const) {
    it(`stamps refunded_at and drops the recovery from the billable set when ${label} refunded on day 10`, async () => {
      const { db } = await seedRecoveredPayment();

      // Billable before the refund arrives: proves the exclusion below is the
      // refund stamp doing the work, not some other predicate.
      expect(await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime())).toHaveLength(1);

      const outcome = await processConnectedWebhook(
        {} as Env,
        refundEvent(`evt_${label}`, fullyRefunded),
        REFUNDED_AT,
      );
      expect(outcome).toEqual({ status: "applied" });

      const [recovery] = await db.select().from(schema.recoveredPayments);
      expect(recovery.refundedAt).toEqual(REFUNDED_AT);

      // The whole point: at the 2026-08-01 run this recovery is gone from the
      // billable set. Pre-fix it billed 20% of refunded money.
      expect(await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime())).toHaveLength(0);
    });
  }

  it("keeps the FIRST refund timestamp when a second partial refund arrives", async () => {
    const { db } = await seedRecoveredPayment();
    await processConnectedWebhook({} as Env, refundEvent("evt_partial_1", false), REFUNDED_AT);

    const later = new Date(REFUNDED_AT.getTime() + 60 * 60 * 1000);
    await processConnectedWebhook({} as Env, refundEvent("evt_partial_2", false), later);

    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.refundedAt).toEqual(REFUNDED_AT);
  });

  it("a replayed refund event is a duplicate no-op", async () => {
    await seedRecoveredPayment();
    expect(await processConnectedWebhook({} as Env, refundEvent("evt_dup", true), REFUNDED_AT)).toEqual({
      status: "applied",
    });
    expect(await processConnectedWebhook({} as Env, refundEvent("evt_dup", true), REFUNDED_AT)).toEqual({
      status: "duplicate",
    });
  });
});

// Review HIGH-1. Every test above seeds the recovery row FIRST, so none of them
// could see the hole: the stamp is an UPDATE, and a refund processed before
// invoice.payment_succeeded matched zero rows, committed its claim anyway, and
// was lost forever. The recovery was then recorded with refunded_at null and
// billed at maturity, which is the exact overcharge this path exists to prevent.
// It needed no Stripe misordering: one transient 500 on the success webhook
// opens the window.
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

  it("CONTROL: with no refund at all, that same recovery IS billable at maturity", async () => {
    // Without this the assertions below would pass for the wrong reason.
    const db = await seedAwaitingRecovery();
    await processConnectedWebhook({} as Env, paymentSucceeded("evt_ok"), RECOVERED_AT);

    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.attributionKind).toBe("email_engaged");
    expect(recovery.refundedAt).toBeNull();
    expect(await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime())).toHaveLength(1);
  });

  for (const [label, fullyRefunded] of [
    ["fully", true],
    ["partially", false],
  ] as const) {
    it(`records the recovery already refunded, and never bills it, when ${label} refunded first`, async () => {
      const db = await seedAwaitingRecovery();

      // 1. The refund lands with nothing to stamp.
      expect(
        await processConnectedWebhook(
          {} as Env,
          refundEvent(`evt_early_${label}`, fullyRefunded),
          REFUND_BEFORE_AT,
        ),
      ).toEqual({ status: "applied" });

      const [payment] = await db.select().from(schema.failedPayments);
      expect(payment.refundSignalAt).toEqual(REFUND_BEFORE_AT);
      expect(await db.select().from(schema.recoveredPayments)).toHaveLength(0);

      // 2. The recovery lands afterwards and is born refunded.
      expect(
        await processConnectedWebhook({} as Env, paymentSucceeded(`evt_late_${label}`), RECOVERED_AT),
      ).toEqual({ status: "applied" });

      const [recovery] = await db.select().from(schema.recoveredPayments);
      expect(recovery.attributionKind).toBe("email_engaged"); // billable kind
      expect(recovery.refundedAt).toEqual(REFUND_BEFORE_AT);

      // Pre-fix this was refunded_at null and a billable row: 20% of refunded money.
      expect(await getBillableRecoveries(db, ACCOUNT_ID, NOW.getTime())).toHaveLength(0);
    });
  }

  it("keeps the FIRST refund's timestamp when two refunds arrive before the recovery", async () => {
    const db = await seedAwaitingRecovery();
    await processConnectedWebhook({} as Env, refundEvent("evt_e1", false), REFUND_BEFORE_AT);
    const later = new Date(REFUND_BEFORE_AT.getTime() + 30_000);
    await processConnectedWebhook({} as Env, refundEvent("evt_e2", false), later);

    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.refundSignalAt).toEqual(REFUND_BEFORE_AT);

    await processConnectedWebhook({} as Env, paymentSucceeded("evt_late"), RECOVERED_AT);
    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.refundedAt).toEqual(REFUND_BEFORE_AT);
  });

  it("a marker with no recovery ever recorded is inert", async () => {
    const db = await seedAwaitingRecovery();
    await processConnectedWebhook({} as Env, refundEvent("evt_orphan", true), REFUND_BEFORE_AT);

    expect(await db.select().from(schema.recoveredPayments)).toHaveLength(0);
    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.refundSignalAt).toEqual(REFUND_BEFORE_AT);
    expect(payment.status).toBe("active"); // the refund never resolves the payment
  });

  it("a recovery for a DIFFERENT failed payment is unaffected by the marker", async () => {
    // The marker is scoped per failed_payment, not per account or per invoice.
    const db = await seedAwaitingRecovery();
    await processConnectedWebhook({} as Env, refundEvent("evt_scoped", true), REFUND_BEFORE_AT);

    await db.insert(schema.failedPayments).values({
      id: "fp_other",
      accountId: ACCOUNT_ID,
      stripeConnectionId: CONNECTION_ID,
      stripeEventId: "evt_intake_other",
      stripeInvoiceId: "in_other",
      stripeCustomerId: "cus_1",
      customerEmail: "payer@example.com",
      amountCents: 5_000,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: new Date(RECOVERED_AT.getTime() - 5 * 60_000),
    });
    harness.invoicePaymentsResult = [{ invoice: "in_other" }];

    await processConnectedWebhook(
      {} as Env,
      {
        id: "evt_other_paid",
        type: "invoice.payment_succeeded",
        account: "acct_connected_1",
        data: { object: { id: "in_other", amount_paid: 5_000, currency: "usd", customer: "cus_1" } },
      } as unknown as Stripe.Event,
      RECOVERED_AT,
    );

    const other = (await db.select().from(schema.recoveredPayments)).find(
      (r) => r.failedPaymentId === "fp_other",
    );
    expect(other?.refundedAt).toBeNull();
  });
});

describe("refund resolution failure semantics", () => {
  it("a refund on a payment Foxhound never took in claims and ignores", async () => {
    const { db } = await seedRecoveredPayment();
    harness.invoicePaymentsResult = []; // Stripe answered; no invoice payment matches.

    expect(await processConnectedWebhook({} as Env, refundEvent("evt_theirs", true), REFUNDED_AT)).toEqual({
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

    const outcome = await processConnectedWebhook({} as Env, refundEvent("evt_flaky", true), REFUNDED_AT);
    expect(outcome.status).toBe("error");

    // Nothing claimed: the event must come back. Claiming an unstampable refund
    // is the one direction that overcharges a merchant.
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
    const [recovery] = await db.select().from(schema.recoveredPayments);
    expect(recovery.refundedAt).toBeNull();
  });
});
