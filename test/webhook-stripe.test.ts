import { drizzle } from "drizzle-orm/d1";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { resolveAttribution } from "~/lib/recovery/attribution";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import {
  buildDisputeResolutionBatch,
  buildRecoverBatch,
  type WebhookClaimInput,
} from "~/lib/webhooks/batches";
import { classifyStripeEvent } from "~/lib/webhooks/events";

const now = new Date("2026-07-12T00:00:00.000Z");
const db = drizzle({} as never, { schema });

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
        collection_method: "charge_automatically",
        last_finalization_error: { decline_code: "expired_card" },
        // Stated: an absent next_payment_attempt reads as null, "Stripe gave up".
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
      event("invoice.payment_failed", {
        id: "in_0",
        amount_due: 0,
        currency: "usd",
        collection_method: "charge_automatically",
      }),
    );
    expect(intent).toEqual({ kind: "ignore", reason: "zero_amount" });
  });

  it("charge.refunded -> stamp_refund with the cumulative refunded amount, partial as well as full", () => {
    expect(
      classifyStripeEvent(
        event("charge.refunded", {
          refunded: true,
          amount_refunded: 10_000,
          payment_intent: "pi_1",
        }),
      ),
    ).toEqual({ kind: "stamp_refund", paymentIntentId: "pi_1", refundedCents: 10_000, full: true });
    expect(
      classifyStripeEvent(
        event("charge.refunded", { refunded: false, amount_refunded: 1, payment_intent: "pi_1" }),
      ),
    ).toEqual({ kind: "stamp_refund", paymentIntentId: "pi_1", refundedCents: 1, full: false });
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

  it("routes the card updater's pre-2020 event name to the same retry as the current one", () => {
    for (const type of [
      "payment_method.automatically_updated",
      "payment_method.card_automatically_updated",
    ]) {
      expect(classifyStripeEvent(event(type, { id: "pm_1", customer: "cus_1" }))).toEqual({
        kind: "card_auto_updated",
        customerId: "cus_1",
      });
    }
  });

  it("charge.dispute.closed -> dispute_resolved only for a definitive won/lost status", () => {
    expect(
      classifyStripeEvent(event("charge.dispute.closed", { id: "dp_1", status: "won" })),
    ).toEqual({ kind: "dispute_resolved", stripeDisputeId: "dp_1", won: true });
    expect(
      classifyStripeEvent(event("charge.dispute.closed", { id: "dp_2", status: "lost" })),
    ).toEqual({ kind: "dispute_resolved", stripeDisputeId: "dp_2", won: false });
    // An inquiry closed without ever becoming a real dispute is not a chargeback
    // outcome: it closes the inquiry, never won or lost.
    expect(
      classifyStripeEvent(event("charge.dispute.closed", { id: "dp_3", status: "warning_closed" })),
    ).toEqual({ kind: "inquiry_closed", stripeDisputeId: "dp_3" });
  });
});

const claim: WebhookClaimInput = {
  stripeEventId: "evt_1",
  eventType: "invoice.payment_failed",
  accountId: "acc_1",
  receivedAt: now,
  payload: { id: "evt_1" },
};

describe("webhook batch builders", () => {
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
    // Pinned to the account, so a foreign failed payment id matches no row.
    expect(flip.params).toContain("acc_1");
    // The outcomes key first, so a second recorder reads as a replay.
    expect(sqlOf(batch[2]).sql).toMatch(/insert into "outcomes"/i);
    expect(sqlOf(batch[3]).sql).toMatch(/insert into "recovered_payments"/i);
  });

  it("dispute resolution batch snapshots the capped fee on a Foxhound-submitted win, none on a loss", () => {
    const won = buildDisputeResolutionBatch(db, {
      claim,
      accountId: "acc_1",
      stripeDisputeId: "dp_1",
      won: true,
      amountCents: 50_000,
      currency: "usd",
      foxhoundSubmitted: true,
      // A USD dispute: the cap needs no conversion.
      cap: { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null },
      capError: null,
      resolvedAt: now,
    });
    expect(won.length).toBe(2);
    const wonUpdate = sqlOf(won[1]);
    expect(wonUpdate.sql).toMatch(/update .*disputes/i);
    expect(wonUpdate.sql).toMatch(/not in/i);
    // The UPDATE pins account_id in its own WHERE.
    expect(wonUpdate.sql).toMatch(/account_id/);
    expect(wonUpdate.params).toContain("acc_1");
    expect(wonUpdate.params).toContain("resolved_won");
    expect(wonUpdate.params).toContain(10_000);

    // 20% of $10,000 is capped down to $500.
    const wonAtCap = buildDisputeResolutionBatch(db, {
      claim,
      accountId: "acc_1",
      stripeDisputeId: "dp_2",
      won: true,
      amountCents: 10_000_00,
      currency: "usd",
      foxhoundSubmitted: true,
      // A USD dispute: the cap needs no conversion.
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
      // A USD dispute: the cap needs no conversion.
      cap: { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null },
      capError: null,
      resolvedAt: now,
    });
    const lostUpdate = sqlOf(lost[1]);
    expect(lostUpdate.params).toContain("resolved_lost");
    expect(lostUpdate.params).not.toContain(10_000);
  });

  it("a won dispute Foxhound did NOT submit snapshots resolved_won but NO fee", () => {
    const wonNotSubmitted = buildDisputeResolutionBatch(db, {
      claim,
      accountId: "acc_1",
      stripeDisputeId: "dp_4",
      won: true,
      amountCents: 50_000,
      currency: "usd",
      foxhoundSubmitted: false,
      // A USD dispute: the cap needs no conversion.
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
