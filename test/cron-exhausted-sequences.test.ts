import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RECOVERY_TICK_LIMIT } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Nothing wrote failed_payments.status = 'failed_unrecovered'. A payment dunned
// for thirty days and never recovered stayed 'active' forever, so every
// status-keyed count drifted upward permanently and "Active" lied.
//
// The flip creates a second problem the sweep alone does not solve: once a row
// leaves 'active', the invoice.payment_succeeded path has to still accept it, or
// a customer who pays on day 45 is silently dropped (no recovered_payments row,
// no attribution, no fee). Both halves are pinned here.

const ACCOUNT_ID = "acc_tick";
const CONNECTION_ID = "conn_tick";
const NOW = new Date("2026-08-01T04:00:00.000Z");
const DETECTED_AT = new Date("2026-06-25T00:00:00.000Z");

const harness = vi.hoisted(() => ({ db: null as unknown }));

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

const { flipExhaustedSequences, queryExhaustedSequences, runRecoveryTick } = await import(
  "~/lib/cron/recovery-tick"
);
const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const schema = await import("~/db/schema");

interface StepSpec {
  stepType: string;
  stepNumber: number;
  executedAt?: Date | null;
  result?: string | null;
  nextRetryAt?: Date | null;
  clickedAt?: Date | null;
  deletedAt?: Date | null;
}

async function seed(
  opts: {
    accountOverrides?: Partial<{ processingPaused: boolean; cancelledAt: Date; id: string }>;
    payments?: { id: string; invoiceId: string; status?: string; steps: StepSpec[] }[];
  } = {},
) {
  const { sqlite, db } = createInMemoryDb();
  harness.db = db;
  const accountId = opts.accountOverrides?.id ?? ACCOUNT_ID;

  await db.insert(schema.accounts).values({
    id: accountId,
    name: "Tick Co",
    createdAt: DETECTED_AT,
    processingPaused: opts.accountOverrides?.processingPaused ?? false,
    cancelledAt: opts.accountOverrides?.cancelledAt ?? null,
  });
  await db.insert(schema.stripeConnections).values({
    id: CONNECTION_ID,
    accountId,
    stripeUserId: "acct_connected_1",
    stripeAccessToken: "encrypted:token",
    isPrimary: true,
    createdAt: DETECTED_AT,
  });

  for (const p of opts.payments ?? []) {
    await db.insert(schema.failedPayments).values({
      id: p.id,
      accountId,
      stripeConnectionId: CONNECTION_ID,
      stripeEventId: `evt_intake_${p.id}`,
      stripeInvoiceId: p.invoiceId,
      stripeCustomerId: "cus_1",
      customerEmail: "payer@example.com",
      amountCents: 10_000,
      currency: "usd",
      declineCategory: "soft",
      status: p.status ?? "active",
      detectedAt: DETECTED_AT,
    });
    for (const s of p.steps) {
      await db.insert(schema.recoverySteps).values({
        id: `${p.id}_step_${s.stepNumber}`,
        accountId,
        failedPaymentId: p.id,
        stepType: s.stepType,
        stepNumber: s.stepNumber,
        scheduledAt: DETECTED_AT,
        executedAt: s.executedAt ?? null,
        result: s.result ?? null,
        nextRetryAt: s.nextRetryAt ?? null,
        clickedAt: s.clickedAt ?? null,
        deletedAt: s.deletedAt ?? null,
      });
    }
  }
  return { sqlite, db, accountId };
}

const ranStep = (stepNumber: number, stepType = "email_day1"): StepSpec => ({
  stepType,
  stepNumber,
  executedAt: new Date("2026-06-26T00:00:00.000Z"),
  result: "email_sent",
});
const pendingStep = (stepNumber: number, over: Partial<StepSpec> = {}): StepSpec => ({
  stepType: "email_day30",
  stepNumber,
  executedAt: null,
  result: null,
  ...over,
});

beforeEach(() => {
  harness.db = null;
});

describe("queryExhaustedSequences", () => {
  it("selects an active payment whose every step has run", async () => {
    await seed({ payments: [{ id: "fp_done", invoiceId: "in_1", steps: [ranStep(1), ranStep(2)] }] });
    expect(await queryExhaustedSequences({} as Env, 100)).toEqual(["fp_done"]);
  });

  it("does not select a sequence with a step still to run", async () => {
    await seed({
      payments: [{ id: "fp_running", invoiceId: "in_1", steps: [ranStep(1), pendingStep(2)] }],
    });
    expect(await queryExhaustedSequences({} as Env, 100)).toEqual([]);
  });

  it("does not select a sequence waiting on a send backoff", async () => {
    // afterTransientFailure leaves the step unexecuted with next_retry_at set.
    // That is pending, not exhausted; flipping it would abandon a live retry.
    await seed({
      payments: [
        {
          id: "fp_backoff",
          invoiceId: "in_1",
          steps: [ranStep(1), pendingStep(2, { nextRetryAt: new Date("2026-08-02T00:00:00.000Z") })],
        },
      ],
    });
    expect(await queryExhaustedSequences({} as Env, 100)).toEqual([]);
  });

  it("does not select a payment that has no steps at all", async () => {
    // Not a finished sequence: a sequence that never started. Intake always
    // plans at least one step, so this shape means something went wrong and
    // must stay visible rather than be quietly marked done.
    await seed({ payments: [{ id: "fp_nosteps", invoiceId: "in_1", steps: [] }] });
    expect(await queryExhaustedSequences({} as Env, 100)).toEqual([]);
  });

  it("does not select a payment that already left 'active'", async () => {
    await seed({
      payments: [{ id: "fp_recovered", invoiceId: "in_1", status: "recovered", steps: [ranStep(1)] }],
    });
    expect(await queryExhaustedSequences({} as Env, 100)).toEqual([]);
  });

  it("honors the processing gate: demo, paused and cancelled accounts are excluded", async () => {
    for (const overrides of [
      { id: "demo_teamflow" },
      { processingPaused: true },
      { cancelledAt: NOW },
    ]) {
      await seed({
        accountOverrides: overrides,
        payments: [{ id: "fp_gated", invoiceId: "in_1", steps: [ranStep(1)] }],
      });
      expect(await queryExhaustedSequences({} as Env, 100)).toEqual([]);
    }
  });
});

describe("the flip itself", () => {
  it("sets failed_unrecovered and resolved_at, exactly once across repeated sweeps", async () => {
    const { db } = await seed({
      payments: [{ id: "fp_done", invoiceId: "in_1", steps: [ranStep(1), ranStep(2)] }],
    });

    // The flip now returns WHAT IT CLAIMED, so the shape is asserted too: a
    // count alone could not tell a claimed sequence from a considered one.
    expect(await flipExhaustedSequences({} as Env, NOW)).toEqual([
      { failedPaymentId: expect.any(String), accountId: expect.any(String) },
    ]);
    const [afterFirst] = await db.select().from(schema.failedPayments);
    expect(afterFirst.status).toBe("failed_unrecovered");
    expect(afterFirst.resolvedAt).toEqual(NOW);

    // A second sweep finds nothing: the row is no longer 'active'.
    const later = new Date(NOW.getTime() + 5 * 60 * 1000);
    expect((await flipExhaustedSequences({} as Env, later)).length).toBe(0);
    const [afterSecond] = await db.select().from(schema.failedPayments);
    expect(afterSecond.resolvedAt).toEqual(NOW); // not overwritten
  });

  it("runs as part of the tick and is reported in the run message", async () => {
    await seed({ payments: [{ id: "fp_done", invoiceId: "in_1", steps: [ranStep(1)] }] });
    const result = await runRecoveryTick({} as Env, { query: async () => [] });
    expect(result.message).toContain("1 exhausted");
  });

  it("a sweep failure is reported without being counted as a step failure", async () => {
    await seed({ payments: [] });
    const result = await runRecoveryTick({} as Env, {
      query: async () => [],
      flipExhausted: async () => {
        throw new Error("d1 unavailable");
      },
    });
    expect(result.message).toContain("exhausted-sweep FAILED");
    // `failed` counts STEPS. A sweep failure must not inflate it, or the number
    // means two different things depending on which part of the tick broke.
    expect(result.message).toContain("0 failed");
  });

  it("LOW-1: is bounded by RECOVERY_TICK_LIMIT, the same constant that caps due steps", async () => {
    // The second, undocumented consumer of that constant. Dropping it from 500
    // to 100 cut this sweep fivefold as well, and only the step cap was
    // reasoned about at the time. Pinned behaviourally so the shared budget is
    // a fact rather than a comment, and so a future change to one bound cannot
    // move the other silently.
    await seed({
      payments: Array.from({ length: RECOVERY_TICK_LIMIT + 5 }, (_, i) => ({
        id: `fp_${String(i).padStart(3, "0")}`,
        invoiceId: `in_${i}`,
        steps: [ranStep(1)],
      })),
    });

    expect(await queryExhaustedSequences({} as Env, RECOVERY_TICK_LIMIT + 5)).toHaveLength(
      RECOVERY_TICK_LIMIT + 5,
    );
    // One tick flips exactly the cap, and the remainder survives for the next.
    expect((await flipExhaustedSequences({} as Env, NOW)).length).toBe(RECOVERY_TICK_LIMIT);
    expect((await flipExhaustedSequences({} as Env, NOW)).length).toBe(5);
  });
});

describe("a late recovery on a flipped row still wins", () => {
  function paymentSucceeded(eventId: string, invoiceId: string): Stripe.Event {
    return {
      id: eventId,
      type: "invoice.payment_succeeded",
      account: "acct_connected_1",
      data: { object: { id: invoiceId, amount_paid: 10_000, currency: "usd", customer: "cus_1" } },
    } as unknown as Stripe.Event;
  }

  it("records the recovery and flips failed_unrecovered -> recovered", async () => {
    const { db } = await seed({
      payments: [
        {
          id: "fp_done",
          invoiceId: "in_late",
          steps: [
            ranStep(1),
            { ...ranStep(2), clickedAt: new Date("2026-06-27T00:00:00.000Z") },
          ],
        },
      ],
    });
    await flipExhaustedSequences({} as Env, NOW);

    // The customer pays on day 45, well after the cadence ran out.
    const paidAt = new Date("2026-08-09T00:00:00.000Z");
    const outcome = await processConnectedWebhook(
      {} as Env,
      paymentSucceeded("evt_late_paid", "in_late"),
      paidAt,
    );
    // Pre-widening this returned ignored/no_active_failure and recorded nothing.
    expect(outcome).toEqual({ status: "applied" });

    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.status).toBe("recovered");
    expect(payment.resolvedAt).toEqual(paidAt);

    const recoveries = await db.select().from(schema.recoveredPayments);
    expect(recoveries).toHaveLength(1);
    // FLIPPED BY RULING 377(2); carried in parity/REVERSALS.md as 377(a).
    //
    // This asserted `email_engaged` across a 43-day gap (clicked 2026-06-27,
    // paid 2026-08-09), and it asserted it only because nothing else had been
    // ruled: 284 widened the gate so LATE RECOVERIES RECORD, which it still
    // does, and never ruled that a six-week-old click was their cause.
    // `email_engaged` now needs a click inside 14 days that precedes the
    // payment, so this recovery records with equal fidelity and bills nothing.
    //
    // 284 ITSELF STANDS. The row is still found, still flips to recovered, and
    // still lands in the ledger; only the KIND changed, and only for a stale
    // click.
    expect(recoveries[0].attributionKind).toBe("stripe_baseline");
    expect(recoveries[0].amountCents).toBe(10_000);
  });

  it("a replay of that late recovery is a duplicate, not a second recording", async () => {
    const { db } = await seed({
      payments: [{ id: "fp_done", invoiceId: "in_late", steps: [ranStep(1)] }],
    });
    await flipExhaustedSequences({} as Env, NOW);

    const paidAt = new Date("2026-08-09T00:00:00.000Z");
    await processConnectedWebhook({} as Env, paymentSucceeded("evt_late", "in_late"), paidAt);
    expect(
      await processConnectedWebhook({} as Env, paymentSucceeded("evt_late", "in_late"), paidAt),
    ).toEqual({ status: "duplicate" });
    expect(await db.select().from(schema.recoveredPayments)).toHaveLength(1);
  });
});

describe("intake dedupe stays narrow", () => {
  it("a NEW failure on an invoice whose sequence exhausted spawns a fresh sequence", async () => {
    // The widening applies to the RECOVER lookup only. If it had been applied to
    // intake dedupe too, this second failure would be swallowed as a duplicate
    // of the finished sequence and the customer would never be dunned again.
    const { db } = await seed({
      payments: [{ id: "fp_done", invoiceId: "in_repeat", steps: [ranStep(1)] }],
    });
    await flipExhaustedSequences({} as Env, NOW);

    const failedAgain = {
      id: "evt_failed_again",
      type: "invoice.payment_failed",
      account: "acct_connected_1",
      data: {
        object: {
          id: "in_repeat",
          amount_due: 10_000,
          currency: "usd",
          customer: "cus_1",
          customer_email: "payer@example.com",
          // Stated rather than omitted (377(1)): Stripe has finished with this
          // invoice, so the fresh sequence starts on this event.
          next_payment_attempt: null,
        },
      },
    } as unknown as Stripe.Event;

    const outcome = await processConnectedWebhook({} as Env, failedAgain, NOW);
    expect(outcome).toEqual({ status: "applied" });

    const payments = await db.select().from(schema.failedPayments);
    expect(payments).toHaveLength(2);
    expect(payments.filter((p) => p.status === "active")).toHaveLength(1);
  });
});
