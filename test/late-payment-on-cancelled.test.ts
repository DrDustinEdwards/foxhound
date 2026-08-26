import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  BILLABLE_ATTRIBUTION_KINDS,
  FAILED_PAYMENT_STATUS_CANCELLED,
  RECOVERABLE_FAILED_PAYMENT_STATUSES,
} from "~/lib/constants";
import { findAttributionSignals, isBillableAttribution, resolveAttribution } from "~/lib/recovery/attribution";
import { buildRecoverBatch } from "~/lib/webhooks/batches";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// RULING 284 DECISION ONE, built 2026-08-14: a late invoice.payment_succeeded on
// a payment a merchant STOPPED is RECORDED, the status FLIPS to recovered, and
// attribution resolves by the NORMAL precedence.
//
// GROUND TRUTH, read at source before any of this was designed (the 284 rule):
// legacy's handlePaymentSucceeded (app/api/webhooks/stripe/route.ts, blob
// deb585e) selects failed_payments with `.eq('status','active')` ALONE, so a
// cancelled payment is never found, `failedPayment` is null, and the entire
// recovered block is skipped. LEGACY RECORDS NOTHING: no recovered_payments row,
// no status flip, no outcome, no merchant notification. Foxhound's behaviour
// here is therefore a DELIBERATE DIVERGENCE, ratified onto PRIME DIRECTIVE item
// 3 under 284's reasoning: a merchant's stop is Foxhound workflow state, Stripe
// does not rescind the event, and money that came back is a fact.
//
// THE WHOLE BUILD IS ONE CONSTANT. `cancelled` joins
// RECOVERABLE_FAILED_PAYMENT_STATUSES, which has exactly TWO call sites and they
// must stay symmetric: findRecoverableFailedPayment (the lookup) and
// buildRecoverBatch's status flip (the guard). Nothing else changes, because the
// spine already records facts and derives policy.

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

/**
 * Models executeMoneyWrite and the per-account money-write DO HONESTLY: the whole
 * batch commits atomically or not at all, and a UNIQUE violation is the replay
 * case, an idempotent no-op rather than an error. This is the idiom
 * test/billing-platform-webhook-claim.test.ts already uses, and it is
 * load-bearing here: WITHOUT the transaction a redelivery would leave the
 * recovered_payments row behind when the outcomes key collided, and this file
 * would prove the opposite of what it claims. Measured, not assumed: the first
 * draft of this test ran the statements bare and reported TWO fee rows.
 */
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

describe("284 one: the gate widens to cancelled, and stays symmetric", () => {
  it("cancelled is recoverable alongside active and the exhausted status", () => {
    expect([...RECOVERABLE_FAILED_PAYMENT_STATUSES]).toContain(FAILED_PAYMENT_STATUS_CANCELLED);
    // The other two must survive: widening for one status must not drop another.
    expect([...RECOVERABLE_FAILED_PAYMENT_STATUSES]).toContain("active");
    expect([...RECOVERABLE_FAILED_PAYMENT_STATUSES]).toContain("failed_unrecovered");
    // FOUR since 2026-08-26, not three. 377(1)'s intake split added
    // 'stripe_retrying', and this pin is what caught it, which is the pin doing
    // its job rather than a nuisance: a status list that grows silently is how
    // a recovery goes missing. 284's three all survive, asserted above; the
    // addition is recorded on the constant with the plant that measures it.
    expect([...RECOVERABLE_FAILED_PAYMENT_STATUSES]).toContain("stripe_retrying");
    expect(RECOVERABLE_FAILED_PAYMENT_STATUSES).toHaveLength(4);
  });

  it("the status flip accepts a cancelled row and writes recovered", () => {
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_cancelled", FAILED_PAYMENT_STATUS_CANCELLED);
    const attribution = resolveAttribution({});
    expect(commitBatch(sqlite, buildRecoverBatch(db, recoverInput("fp_cancelled", attribution))).applied).toBe(true);
    const row = sqlite
      .prepare("select status, resolved_at from failed_payments where id = ?")
      .get("fp_cancelled") as { status: string; resolved_at: number | null };
    expect(row.status).toBe("recovered");
    expect(row.resolved_at).not.toBeNull();
  });

  it("POSITIVE CONTROL: an already-recovered row is NOT flipped again", () => {
    // The guard is a real guard, not a pass-through. `recovered` is outside the
    // list, so the conditional UPDATE touches zero rows.
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_done", "recovered");
    const attribution = resolveAttribution({});
    const stmts = buildRecoverBatch(db, recoverInput("fp_done", attribution));
    runStatement(sqlite, stmts[1]);
    const row = sqlite
      .prepare("select status, resolved_at from failed_payments where id = ?")
      .get("fp_done") as { status: string; resolved_at: number | null };
    expect(row.status).toBe("recovered");
    expect(row.resolved_at).toBeNull();
  });
});

describe("284 one: the recovery is recorded through the spine's sole builder", () => {
  it("a pure post-stop payment records stripe_baseline and bills NOTHING", () => {
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_pure", FAILED_PAYMENT_STATUS_CANCELLED);
    // Stop recovery resolved every unexecuted step to 'cancelled' (265), so
    // there is no Foxhound signal of any kind behind this payment.
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
      .prepare("select id, step_type as stepType, result, clicked_at as clickedAt from recovery_steps where failed_payment_id = ?")
      .all("fp_pure") as { id: string; stepType: string; result: string | null; clickedAt: Date | null }[];
    const attribution = resolveAttribution(findAttributionSignals(steps, now));

    expect(attribution.kind).toBe("stripe_baseline");
    expect(isBillableAttribution(attribution.kind)).toBe(false);

    expect(commitBatch(sqlite, buildRecoverBatch(db, recoverInput("fp_pure", attribution))).applied).toBe(true);
    const rec = sqlite
      .prepare("select attribution_kind, attributed_at, amount_cents from recovered_payments where failed_payment_id = ?")
      .get("fp_pure") as { attribution_kind: string; attributed_at: number | null; amount_cents: number };
    // attributed_at NULL is what makes it free: the billing query keys on it.
    expect(rec.attribution_kind).toBe("stripe_baseline");
    expect(rec.attributed_at).toBeNull();
    expect(rec.amount_cents).toBe(4999);
    // The moat keeps the row either way.
    const out = sqlite
      .prepare("select outcome from outcomes where idempotency_key = ?")
      .get("recovery:fp_pure") as { outcome: string };
    expect(out.outcome).toBe("recovered_baseline");
  });

  it("a Foxhound click that PRECEDED the stop keeps its kind and BILLS", () => {
    // The other half of 284's rule: the stop click must not launder a real
    // Foxhound recovery free. An executed, clicked email survives Stop recovery
    // because Stop only resolves UNEXECUTED steps.
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_clicked", FAILED_PAYMENT_STATUS_CANCELLED);
    runStatement(
      sqlite,
      db.insert(recoverySteps).values({
        id: "step_clicked",
        failedPaymentId: "fp_clicked",
        accountId: "acc_1",
        stepType: "email_1",
        stepNumber: 1,
        scheduledAt: now,
        executedAt: now,
        result: "email_sent",
        clickedAt: now,
      }),
    );
    const steps = sqlite
      .prepare("select id, step_type as stepType, result, clicked_at as clickedAt from recovery_steps where failed_payment_id = ?")
      .all("fp_clicked") as { id: string; stepType: string; result: string | null; clickedAt: Date | null }[];
    // A second after the click, because the click must PRECEDE the payment to
    // have caused it (377(2)) and this fixture stamps both at `now`. The test's
    // subject is unchanged: a click before the merchant's stop still bills.
    const recoveredAt = new Date(now.getTime() + 1_000);
    const attribution = resolveAttribution(findAttributionSignals(steps, recoveredAt));

    expect(attribution.kind).toBe("email_engaged");
    expect(isBillableAttribution(attribution.kind)).toBe(true);
    expect([...BILLABLE_ATTRIBUTION_KINDS]).toContain("email_engaged");

    expect(commitBatch(sqlite, buildRecoverBatch(db, recoverInput("fp_clicked", attribution))).applied).toBe(true);
    const rec = sqlite
      .prepare("select attribution_kind, attributed_at from recovered_payments where failed_payment_id = ?")
      .get("fp_clicked") as { attribution_kind: string; attributed_at: number | null };
    expect(rec.attribution_kind).toBe("email_engaged");
    // attributed_at SET is what makes it billable.
    expect(rec.attributed_at).not.toBeNull();
  });

  it("manual stays NEVER billable, unchanged by this fold (262 one)", () => {
    expect(isBillableAttribution("manual")).toBe(false);
    expect([...BILLABLE_ATTRIBUTION_KINDS]).not.toContain("manual");
  });
});

describe("284 one: exactly-once, proven at the capability level (265)", () => {
  it("the DOUBLE delivery collapses: the whole batch rolls back, one fee row", () => {
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_dup", FAILED_PAYMENT_STATUS_CANCELLED);
    const attribution = resolveAttribution({});

    const first = commitBatch(
      sqlite,
      buildRecoverBatch(db, recoverInput("fp_dup", attribution, "evt_dup_1")),
    );
    expect(first.applied).toBe(true);

    // The redelivery, a DIFFERENT Stripe event id so the webhook claim itself
    // cannot be what stops it. The outcomes key is derived from the FAILED
    // PAYMENT, not the event, so the second batch writes the identical
    // `recovery:fp_dup` into a column carrying a real partial unique index; the
    // whole batch rolls back, INCLUDING the recovered_payments insert.
    const second = commitBatch(
      sqlite,
      buildRecoverBatch(db, recoverInput("fp_dup", attribution, "evt_dup_2")),
    );
    expect(second.applied).toBe(false);

    // The assertion that would catch a second fee row, which is the whole risk
    // on a money path.
    const recCount = sqlite
      .prepare("select count(*) as n from recovered_payments where failed_payment_id = ?")
      .get("fp_dup") as { n: number };
    const outCount = sqlite
      .prepare("select count(*) as n from outcomes where idempotency_key = ?")
      .get("recovery:fp_dup") as { n: number };
    expect(recCount.n).toBe(1);
    expect(outCount.n).toBe(1);
  });

  it("the SINGLE delivery records: the both-sides shape", () => {
    // Without this half, the test above would pass against code that records
    // nothing at all.
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_once", FAILED_PAYMENT_STATUS_CANCELLED);
    const { applied } = commitBatch(
      sqlite,
      buildRecoverBatch(db, recoverInput("fp_once", resolveAttribution({}))),
    );
    expect(applied).toBe(true);
    const recCount = sqlite
      .prepare("select count(*) as n from recovered_payments where failed_payment_id = ?")
      .get("fp_once") as { n: number };
    const row = sqlite
      .prepare("select status from failed_payments where id = ?")
      .get("fp_once") as { status: string };
    expect(recCount.n).toBe(1);
    expect(row.status).toBe("recovered");
  });

  it("two DIFFERENT cancelled payments each record: the key is per payment", () => {
    const { sqlite, db } = seed();
    seedPayment(sqlite, db, "fp_a", FAILED_PAYMENT_STATUS_CANCELLED);
    seedPayment(sqlite, db, "fp_b", FAILED_PAYMENT_STATUS_CANCELLED);
    for (const id of ["fp_a", "fp_b"]) {
      const { applied } = commitBatch(
        sqlite,
        buildRecoverBatch(db, recoverInput(id, resolveAttribution({}))),
      );
      expect(applied).toBe(true);
    }
    const n = sqlite
      .prepare("select count(*) as n from recovered_payments where account_id = ?")
      .get("acc_1") as { n: number };
    expect(n.n).toBe(2);
  });
});
