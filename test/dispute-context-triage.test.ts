import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { fetchDisputeContextWith } from "~/lib/disputes/context.server";
import { createdNotice } from "~/lib/disputes/notices";
import { calculateTriage, contextEvidenceFields } from "~/lib/disputes/triage";

// Recova read the disputed charge, the customer's other charges and their
// subscription from Stripe at intake, and triaged on them (lib/disputes-
// evidence.ts). This drives the port with a fake connected-account client.

const day = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function pages<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function fakeStripe(overrides: { chargeThrows?: boolean } = {}) {
  return {
    disputes: { retrieve: async () => ({ id: "dp_1", smart_disputes: { status: "available" } }) },
    charges: {
      retrieve: async () => {
        if (overrides.chargeThrows) throw new Error("stripe down");
        return {
          id: "ch_disputed",
          created: day("2026-09-01"),
          customer: "cus_1",
          receipt_email: "payer@example.com",
          billing_details: { name: "Pat Payer", email: null, address: { line1: "1 Main St", city: "Austin", state: "TX", postal_code: "78701", country: "US" } },
          metadata: {},
          outcome: { risk_score: 12, risk_level: "normal" },
          payment_method_details: {
            card: { checks: { address_line1_check: "pass", address_postal_code_check: "pass", cvc_check: "pass" }, three_d_secure: { result: "authenticated" } },
          },
        };
      },
      // Auto-paginated, as Stripe's list is when walked with for await.
      list: () => pages([
          { id: "ch_disputed", amount: 5000, currency: "usd", status: "succeeded", created: day("2026-09-01") },
          { id: "ch_a", amount: 5000, currency: "usd", status: "succeeded", created: day("2026-08-01") },
          { id: "ch_b", amount: 5000, currency: "usd", status: "succeeded", created: day("2026-07-01") },
          { id: "ch_c", amount: 5000, currency: "usd", status: "succeeded", created: day("2026-06-01") },
          { id: "ch_failed", amount: 5000, currency: "usd", status: "failed", created: day("2026-05-01") },
      ]),
    },
    subscriptions: {
      list: async () => ({
        data: [{ id: "sub_1", status: "active", start_date: day("2026-06-01"), canceled_at: null, items: { data: [{ price: { unit_amount: 5000 } }] } }],
      }),
    },
  } as unknown as Stripe;
}

describe("dispute context and triage from Stripe", () => {
  it("reads the charge, prior charges and subscription, and recommends fighting a well-verified fraud claim", async () => {
    const context = await fetchDisputeContextWith(fakeStripe(), { stripeDisputeId: "dp_1", chargeId: "ch_disputed", customerId: null });

    expect(context).toMatchObject({
      customerId: "cus_1",
      customerName: "Pat Payer",
      customerEmail: "payer@example.com",
      billingAddress: "1 Main St, Austin, TX 78701, US",
      avsResult: "line1:pass zip:pass",
      cvvResult: "pass",
      radarRiskScore: 12,
      threeDSecure: "authenticated",
      smartDisputesStatus: "available",
      priorChargesCount: 3,
      priorChargesTotal: 15000,
    });
    expect(context.subscriptionJson?.status).toBe("active");

    const triage = calculateTriage(context, 5000, "fraudulent", false);
    expect(triage).toEqual({
      recommendation: "fight",
      confidence: 85,
      reasoning: "3 prior successful charges, AVS and CVV both passed.",
    });
    expect(contextEvidenceFields(context).map((f) => f.fieldName)).toEqual([
      "customer_name",
      "customer_email_address",
      "billing_address",
      "subscription_information",
    ]);

    const mail = createdNotice({
      amountCents: 5000,
      currency: "usd",
      customerLabel: "Pat Payer",
      reason: "fraudulent",
      evidenceDeadline: null,
      disputeUrl: "https://example.com/disputes/d1",
      triage,
      autoSubmit: false,
    });
    expect(mail.notice.body).toContain("Recommendation: FIGHT (85/100). 3 prior successful charges, AVS and CVV both passed.");
  });

  it("an unreadable charge leaves the context empty and the intake goes on", async () => {
    const context = await fetchDisputeContextWith(fakeStripe({ chargeThrows: true }), {
      stripeDisputeId: "dp_1",
      chargeId: "ch_disputed",
      customerId: "cus_1",
    });
    expect(context.priorChargesCount).toBe(0);
    expect(context.avsResult).toBeNull();
    expect(calculateTriage(context, 3000, "general", false).recommendation).toBe("accept");
  });
});
