import { drizzle } from "drizzle-orm/d1";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { resolveAttribution } from "~/lib/recovery/attribution";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import {
  buildDisputeIntakeBatch,
  buildDisputeResolutionBatch,
  buildDisputeStampBatch,
  buildIntakeBatch,
  buildRecoverBatch,
  buildRefundStampBatch,
  buildWebhookClaim,
  type WebhookClaimInput,
} from "~/lib/webhooks/batches";
import { classifyStripeEvent } from "~/lib/webhooks/events";

const now = new Date("2026-07-12T00:00:00.000Z");
const db = drizzle({} as never, { schema });

// MoneyWriteBatch items are typed as BatchItem; the executor compiles each via
// .toSQL() (app/lib/money/execute.ts). Mirror that cast to inspect the SQL.
function sqlOf(item: unknown): { sql: string; params: unknown[] } {
  return (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
}

function event(type: string, object: Record<string, unknown>, account = "acct_1"): Stripe.Event {
  return { id: "evt_1", type, account, data: { object } } as unknown as Stripe.Event;
}

describe("classifyStripeEvent", () => {
  it("payment_failed -> intake with decline classification", () => {
    const intent = classifyStripeEvent(
      event("invoice.payment_failed", {
        id: "in_1",
        amount_due: 4200,
        currency: "usd",
        customer: "cus_1",
        customer_email: "a@b.com",
        last_finalization_error: { decline_code: "expired_card" },
        // STATED, NOT OMITTED (377(1)). An absent next_payment_attempt reads as
        // null, which is "Stripe gave up", so a fixture that leaves it out
        // cannot tell a working gate from a missing one. expired_card is a hard
        // decline and Stripe does not retry one, so null is also what Stripe
        // really sends here.
        next_payment_attempt: null,
      }),
    );
    expect(intent.kind).toBe("intake");
    if (intent.kind === "intake") {
      expect(intent.invoiceId).toBe("in_1");
        expect(intent.declineCategory).toBe("expired");
      expect(intent.amountCents).toBe(4200);
      expect(intent.stripeGaveUp).toBe(true);
    }
  });

  it("payment_failed with $0 is ignored", () => {
    const intent = classifyStripeEvent(
      event("invoice.payment_failed", { id: "in_0", amount_due: 0, currency: "usd" }),
    );
    expect(intent).toEqual({ kind: "ignore", reason: "zero_amount" });
  });

  it("payment_succeeded -> recover", () => {
    const intent = classifyStripeEvent(
      event("invoice.payment_succeeded", {
        id: "in_2",
        amount_paid: 4200,
        currency: "usd",
        customer: "cus_1",
      }),
    );
    expect(intent.kind).toBe("recover");
    if (intent.kind === "recover") expect(intent.amountPaidCents).toBe(4200);
  });

  it("charge.refunded -> stamp_refund, partial as well as full (parity ruling 29)", () => {
    // This assertion used to require a PARTIAL refund to be ignored. Ruling 29
    // settled it the other way: any refund inside the maturity window
    // disqualifies the recovery from billing entirely, with no proration.
    expect(
      classifyStripeEvent(event("charge.refunded", { refunded: true, payment_intent: "pi_1" })),
    ).toEqual({ kind: "stamp_refund", paymentIntentId: "pi_1" });
    expect(
      classifyStripeEvent(event("charge.refunded", { refunded: false, payment_intent: "pi_1" })),
    ).toEqual({ kind: "stamp_refund", paymentIntentId: "pi_1" });
  });

  it("charge.dispute.created -> stamp_dispute (dispute intake); unrelated type ignored", () => {
    const createdSeconds = Math.floor(new Date("2026-07-19T00:00:00.000Z").getTime() / 1000);
    const dueBySeconds = Math.floor(new Date("2026-07-26T00:00:00.000Z").getTime() / 1000);
    expect(
      classifyStripeEvent(
        event("charge.dispute.created", {
          id: "dp_1",
          charge: "ch_1",
          payment_intent: "pi_1",
          amount: 4200,
          currency: "usd",
          reason: "fraudulent",
          status: "needs_response",
          created: createdSeconds,
          evidence_details: { due_by: dueBySeconds },
        }),
      ),
    ).toEqual({
      kind: "stamp_dispute",
      stripeDisputeId: "dp_1",
      chargeId: "ch_1",
      paymentIntentId: "pi_1",
      amountCents: 4200,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      evidenceDeadline: new Date(dueBySeconds * 1000),
      createdAt: new Date(createdSeconds * 1000),
    });
    // No dispute id: fails closed to ignore rather than a half-populated intake.
    expect(classifyStripeEvent(event("charge.dispute.created", { charge: "ch_1" }))).toEqual({
      kind: "ignore",
      reason: "no_dispute_id",
    });
    expect(classifyStripeEvent(event("customer.updated", {})).kind).toBe("ignore");
  });

  it("charge.dispute.closed -> dispute_resolved only for a definitive won/lost status", () => {
    expect(
      classifyStripeEvent(event("charge.dispute.closed", { id: "dp_1", status: "won" })),
    ).toEqual({ kind: "dispute_resolved", stripeDisputeId: "dp_1", won: true });
    expect(
      classifyStripeEvent(event("charge.dispute.closed", { id: "dp_2", status: "lost" })),
    ).toEqual({ kind: "dispute_resolved", stripeDisputeId: "dp_2", won: false });
    // An inquiry closed without ever becoming a real dispute is not a chargeback outcome.
    expect(
      classifyStripeEvent(event("charge.dispute.closed", { id: "dp_3", status: "warning_closed" })),
    ).toEqual({ kind: "ignore", reason: "dispute_not_resolved" });
  });
});

const claim: WebhookClaimInput = {
  stripeEventId: "evt_1",
  eventType: "invoice.payment_failed",
  accountId: "acc_1",
  receivedAt: now,
  payload: { id: "evt_1" },
};

describe("webhook batch builders (compile against schema)", () => {
  it("claim insert targets webhook_events with the event id bound", () => {
    const sql = sqlOf(buildWebhookClaim(db, claim));
    expect(sql.sql).toMatch(/insert into .*webhook_events/i);
    expect(sql.params).toContain("evt_1");
  });

  it("intake batch = claim + failed_payment + one insert per step", () => {
    const batch = buildIntakeBatch(db, {
      claim,
      failedPaymentId: "fp_1",
      accountId: "acc_1",
      stripeConnectionId: "conn_1",
      stripeEventId: "evt_1",
      invoiceId: "in_1",
      customerId: "cus_1",
      customerEmail: "a@b.com",
      customerName: null,
      amountCents: 4200,
      currency: "usd",
      declineCode: "insufficient_funds",
      declineCategory: "soft",
      detectedAt: now,
      // Stripe has given up, so this is the full sequence. The waiting arm has
      // its own coverage in test/intake-split-377.test.ts.
      stripeGaveUp: true,
    });
    // claim + failed_payment + 8 soft-schedule steps
    expect(batch.length).toBe(10);
    expect(sqlOf(batch[0]).sql).toMatch(/webhook_events/i);
    expect(sqlOf(batch[1]).sql).toMatch(/failed_payments/i);
    expect(sqlOf(batch[1]).params).toContain("fp_1");
    // Phase 5 review MEDIUM fix companion: intake now records WHICH
    // connection a failed payment belongs to, not just which account, so
    // card-update.tsx can resolve the correct connection for an account
    // with more than one.
    expect(sqlOf(batch[1]).params).toContain("conn_1");
    expect(sqlOf(batch[2]).sql).toMatch(/recovery_steps/i);
  });

  it("recover batch = claim + conditional status flip + recovered_payments + outcomes", () => {
    const batch = buildRecoverBatch(db, {
      claim,
      accountId: "acc_1",
      failedPaymentId: "fp_1",
      amountPaidCents: 4200,
      currency: "usd",
      recoveredAt: now,
      attribution: resolveAttribution({ succeededRetryStepId: "step_1" }),
      recoveredByStepId: "step_1",
      recoveryMethod: "foxhound_retry",
      idempotencyKey: "fp_1",
    });
    expect(batch.length).toBe(4);
    expect(sqlOf(batch[0]).sql).toMatch(/webhook_events/i);
    const flip = sqlOf(batch[1]);
    expect(flip.sql).toMatch(/update .*failed_payments/i);
    expect(flip.params).toContain("recovered");
    expect(sqlOf(batch[2]).sql).toMatch(/recovered_payments/i);
    expect(sqlOf(batch[3]).sql).toMatch(/outcomes/i);
  });

  it("refund stamp batch = claim + failed_payments marker + conditional recovered_payments update", () => {
    // Three statements, not two: the marker is what makes the refund
    // order-independent (review HIGH-1). It must ride the SAME batch as the
    // claim, or a claim can commit without it and the refund is lost.
    const refund = buildRefundStampBatch(db, { claim, failedPaymentId: "fp_1", at: now });
    expect(refund.length).toBe(3);
    expect(sqlOf(refund[0]).sql).toMatch(/insert into .*webhook_events/i);
    const marker = sqlOf(refund[1]);
    expect(marker.sql).toMatch(/update .*failed_payments/i);
    expect(marker.sql).toMatch(/refund_signal_at/i);
    expect(marker.sql).toMatch(/refund_signal_at.*is null/i); // first refund wins
    expect(sqlOf(refund[2]).sql).toMatch(/update .*recovered_payments/i);
  });

  it("dispute stamp batch is unchanged: claim + conditional update on recovered_payments", () => {
    const dispute = buildDisputeStampBatch(db, { claim, failedPaymentId: "fp_1", at: now });
    expect(dispute.length).toBe(2);
    expect(sqlOf(dispute[1]).sql).toMatch(/update .*recovered_payments/i);
  });

  it("dispute intake batch = claim + disputes row + evidence rows, no recovery link", () => {
    const batch = buildDisputeIntakeBatch(db, {
      claim,
      disputeId: "dsp_1",
      accountId: "acc_1",
      stripeConnectionId: "conn_1",
      stripeDisputeId: "dp_1",
      stripeChargeId: "ch_1",
      stripeCustomerId: null,
      customerEmail: null,
      customerName: null,
      amountCents: 4200,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      evidenceDeadline: now,
      createdAt: now,
      linkedFailedPaymentId: null,
      evidence: [{ fieldName: "product_description", fieldValue: "Widget" }],
    });
    // claim + disputes insert + 1 evidence insert, no stamp (no linked recovery)
    expect(batch.length).toBe(3);
    expect(sqlOf(batch[0]).sql).toMatch(/webhook_events/i);
    const disputeInsert = sqlOf(batch[1]);
    expect(disputeInsert.sql).toMatch(/insert into .*disputes/i);
    expect(disputeInsert.params).toContain("dsp_1");
    expect(disputeInsert.params).toContain("pending_review");
    const evidenceInsert = sqlOf(batch[2]);
    expect(evidenceInsert.sql).toMatch(/insert into .*dispute_evidence/i);
    expect(evidenceInsert.params).toContain("Widget");
  });

  it("dispute intake batch stamps recovered_payments.disputed_at when the charge resolves to a known recovery", () => {
    const batch = buildDisputeIntakeBatch(db, {
      claim,
      disputeId: "dsp_2",
      accountId: "acc_1",
      stripeConnectionId: "conn_1",
      stripeDisputeId: "dp_2",
      stripeChargeId: "ch_2",
      stripeCustomerId: "cus_1",
      customerEmail: "a@b.com",
      customerName: null,
      amountCents: 4200,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      evidenceDeadline: null,
      createdAt: now,
      linkedFailedPaymentId: "fp_1",
      evidence: [],
    });
    // claim + disputes insert + stamp (no evidence rows this time)
    expect(batch.length).toBe(3);
    const stamp = sqlOf(batch[2]);
    expect(stamp.sql).toMatch(/update .*recovered_payments/i);
    expect(stamp.sql).toMatch(/disputed_at/i);
    expect(stamp.params).toContain("fp_1");
  });

  it("dispute resolution batch snapshots the capped fee on a Foxhound-submitted win, none on a loss", () => {
    // 20% of a $500 dispute is $100, well under the $500 cap: proves the
    // ordinary 20% math, not just the cap.
    const won = buildDisputeResolutionBatch(db, {
      claim,
      accountId: "acc_1",
      stripeDisputeId: "dp_1",
      won: true,
      amountCents: 50_000,
      currency: "usd",
      foxhoundSubmitted: true,
      // A USD dispute: the cap needs no conversion (377(7)).
      cap: { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null },
      capError: null,
      resolvedAt: now,
    });
    expect(won.length).toBe(2);
    const wonUpdate = sqlOf(won[1]);
    expect(wonUpdate.sql).toMatch(/update .*disputes/i);
    expect(wonUpdate.sql).toMatch(/not in/i);
    // Account-scoping audit HIGH #3: the UPDATE pins account_id in its own WHERE,
    // so tenant isolation is DB-enforced, not caller-dependent.
    expect(wonUpdate.sql).toMatch(/account_id/);
    expect(wonUpdate.params).toContain("acc_1");
    expect(wonUpdate.params).toContain("resolved_won");
    expect(wonUpdate.params).toContain(10_000);

    // A much larger dispute proves the $500 cap actually applies, not just 20%
    // (20% of $10,000 would be $2,000, capped down to $500).
    const wonAtCap = buildDisputeResolutionBatch(db, {
      claim,
      accountId: "acc_1",
      stripeDisputeId: "dp_2",
      won: true,
      amountCents: 10_000_00,
      currency: "usd",
      foxhoundSubmitted: true,
      // A USD dispute: the cap needs no conversion (377(7)).
      cap: { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null },
      capError: null,
      resolvedAt: now,
    });
    expect(sqlOf(wonAtCap[1]).params).toContain(DISPUTE_FEE_CAP_CENTS);

    const lost = buildDisputeResolutionBatch(db, {
      claim,
      accountId: "acc_1",
      stripeDisputeId: "dp_3",
      won: false,
      amountCents: 50_000,
      currency: "usd",
      foxhoundSubmitted: true,
      // A USD dispute: the cap needs no conversion (377(7)).
      cap: { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null },
      capError: null,
      resolvedAt: now,
    });
    const lostUpdate = sqlOf(lost[1]);
    expect(lostUpdate.params).toContain("resolved_lost");
    expect(lostUpdate.params).not.toContain(10_000);
  });

  it("a won dispute Foxhound did NOT submit snapshots resolved_won but NO fee (merchant-fought, PRICING rev 3)", () => {
    // The review's HIGH: a win Foxhound never submitted must not carry a fee.
    const wonNotSubmitted = buildDisputeResolutionBatch(db, {
      claim,
      accountId: "acc_1",
      stripeDisputeId: "dp_4",
      won: true,
      amountCents: 50_000,
      currency: "usd",
      foxhoundSubmitted: false,
      // A USD dispute: the cap needs no conversion (377(7)).
      cap: { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null },
      capError: null,
      resolvedAt: now,
    });
    const update = sqlOf(wonNotSubmitted[1]);
    // Still records the WON outcome...
    expect(update.params).toContain("resolved_won");
    // ...but snapshots no fee: the 20% amount ($100 = 10_000) is absent, so the
    // UI shows "won, not billed" and getBillableDisputes never bills it.
    expect(update.params).not.toContain(10_000);
  });
});
