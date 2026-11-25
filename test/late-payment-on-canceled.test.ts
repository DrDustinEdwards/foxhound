import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { FAILED_PAYMENT_STATUS_CANCELLED } from "~/lib/constants";
import {
  findAttributionSignals,
  isBillableAttribution,
  resolveAttribution,
} from "~/lib/recovery/attribution";
import { buildRecoverBatch } from "~/lib/webhooks/batches";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// A late invoice.payment_succeeded on a payment the merchant stopped is recorded, the status flips
// to recovered, and attribution resolves by the normal precedence.

const now = new Date("2026-08-14T00:00:00.000Z");

function seed() {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Mine" }));
  return { sqlite, db };
}

function seedPayment(
  sqlite: ReturnType<typeof createInMemoryDb>["sqlite"],
  db: ReturnType<typeof createInMemoryDb>["db"],
  id: string,
  status: string,
) {
  runStatement(
    sqlite,
    db.insert(failedPayments).values({
      id,
      accountId: "acc_1",
      stripeEventId: `evt_${id}`,
      stripeInvoiceId: `in_${id}`,
      stripeCustomerId: `cus_${id}`,
      customerEmail: "customer@example.com",
      customerName: "Jordan Lee",
      amountCents: 4999,
      currency: "usd",
      declineCategory: "soft",
      declineCode: "insufficient_funds",
      status,
      detectedAt: now,
    }),
  );
}

function claimFor(eventId: string) {
  return {
    stripeEventId: eventId,
    eventType: "invoice.payment_succeeded",
    receivedAt: now,
    accountId: "acc_1",
    payload: { id: eventId },
  };
}

function recoverInput(
  failedPaymentId: string,
  attribution: ReturnType<typeof resolveAttribution>,
  eventId = `evt_${failedPaymentId}`,
) {
  return {
    claim: claimFor(eventId),
    accountId: "acc_1",
    failedPaymentId,
    amountPaidCents: 4999,
    currency: "usd",
    recoveredAt: now,
    attribution,
    recoveredByStepId: null,
    recoveryMethod: attribution.kind === "stripe_baseline" ? "stripe_baseline" : "email",
    idempotencyKey: failedPaymentId,
  };
}

/** Models the money-write DO: the batch commits atomically, and a UNIQUE violation is an idempotent no-op replay. */
function commitBatch(
  sqlite: ReturnType<typeof createInMemoryDb>["sqlite"],
  batch: unknown[],
): { applied: boolean } {
  sqlite.exec("BEGIN");
  try {
    for (const stmt of batch) runStatement(sqlite, stmt);
    sqlite.exec("COMMIT");
    return { applied: true };
  } catch (err) {
    sqlite.exec("ROLLBACK");
    if (String(err).match(/UNIQUE|constraint/i)) return { applied: false };
    throw err;
  }
}

describe("a payment recovered after a stop", () => {
  it("a pure post-stop payment records stripe_baseline and bills NOTHING", () => {
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_pure", FAILED_PAYMENT_STATUS_CANCELLED);
    runStatement(
      sqlite,
      db.insert(recoverySteps).values({
        id: "step_pure",
        failedPaymentId: "fp_pure",
        accountId: "acc_1",
        stepType: "email_1",
        stepNumber: 1,
        scheduledAt: now,
        executedAt: null,
        result: "cancelled",
      }),
    );
    const steps = sqlite
      .prepare(
        "select id, step_type as stepType, result, clicked_at as clickedAt from recovery_steps where failed_payment_id = ?",
      )
      .all("fp_pure") as {
      id: string;
      stepType: string;
      result: string | null;
      clickedAt: Date | null;
    }[];
    const attribution = resolveAttribution(findAttributionSignals(steps, now));

    expect(attribution.kind).toBe("stripe_baseline");
    expect(isBillableAttribution(attribution.kind)).toBe(false);

    expect(
      commitBatch(sqlite, buildRecoverBatch(db, recoverInput("fp_pure", attribution))).applied,
    ).toBe(true);
    const rec = sqlite
      .prepare(
        "select attribution_kind, attributed_at, amount_cents from recovered_payments where failed_payment_id = ?",
      )
      .get("fp_pure") as {
      attribution_kind: string;
      attributed_at: number | null;
      amount_cents: number;
    };
    // attributed_at NULL is what makes it free: the billing query keys on it.
    expect(rec.attribution_kind).toBe("stripe_baseline");
    expect(rec.attributed_at).toBeNull();
    expect(rec.amount_cents).toBe(4999);
    const out = sqlite
      .prepare("select outcome from outcomes where idempotency_key = ?")
      .get("recovery:fp_pure") as { outcome: string };
    expect(out.outcome).toBe("recovered_baseline");
  });
});

describe("exactly-once recovery", () => {
  it("the DOUBLE delivery collapses: the whole batch rolls back, one fee row", () => {
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_dup", FAILED_PAYMENT_STATUS_CANCELLED);
    const attribution = resolveAttribution({});

    const first = commitBatch(
      sqlite,
      buildRecoverBatch(db, recoverInput("fp_dup", attribution, "evt_dup_1")),
    );
    expect(first.applied).toBe(true);

    // A different Stripe event id, so the webhook claim is not what stops it; the outcomes key is
    // derived from the failed payment and rolls the whole batch back.
    const second = commitBatch(
      sqlite,
      buildRecoverBatch(db, recoverInput("fp_dup", attribution, "evt_dup_2")),
    );
    expect(second.applied).toBe(false);

    const recCount = sqlite
      .prepare("select count(*) as n from recovered_payments where failed_payment_id = ?")
      .get("fp_dup") as { n: number };
    const outCount = sqlite
      .prepare("select count(*) as n from outcomes where idempotency_key = ?")
      .get("recovery:fp_dup") as { n: number };
    expect(recCount.n).toBe(1);
    expect(outCount.n).toBe(1);
  });
});

describe("the recovery insert is joined to its status flip", () => {
  it("a payment the flip cannot claim gets no recovered_payments row", () => {
    const { sqlite, db } = seed();
    // Already recovered by another path at a different moment, so the
    // conditional flip in this batch matches zero rows.
    seedPayment(sqlite, db, "fp_gone", "recovered");
    const result = commitBatch(
      sqlite,
      buildRecoverBatch(db, recoverInput("fp_gone", resolveAttribution({}), "evt_gone")),
    );
    expect(result.applied).toBe(false);
    const recCount = sqlite
      .prepare("select count(*) as n from recovered_payments where failed_payment_id = ?")
      .get("fp_gone") as { n: number };
    expect(recCount.n).toBe(0);
  });
});
