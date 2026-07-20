import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  buildStripeEvidencePayload,
  submitDisputeEvidenceWithClient,
} from "~/lib/disputes/submission";

describe("buildStripeEvidencePayload", () => {
  it("maps known evidence fields through and drops unknown field names", () => {
    const payload = buildStripeEvidencePayload([
      { fieldName: "product_description", fieldValue: "Widget Pro" },
      { fieldName: "customer_communication", fieldValue: "3 emails sent" },
      { fieldName: "smart_disputes_status", fieldValue: "not a real evidence field" },
    ]);
    expect(payload).toEqual({
      product_description: "Widget Pro",
      customer_communication: "3 emails sent",
    });
  });

  it("drops blank values so an empty edit never overwrites with nothing", () => {
    const payload = buildStripeEvidencePayload([
      { fieldName: "product_description", fieldValue: "   " },
      { fieldName: "service_date", fieldValue: "2026-07-01" },
    ]);
    expect(payload).toEqual({ service_date: "2026-07-01" });
  });

  it("returns an empty object for no evidence rows at all", () => {
    expect(buildStripeEvidencePayload([])).toEqual({});
  });
});

describe("submitDisputeEvidenceWithClient", () => {
  it("submits with submit:true (never staged-only) and the given evidence", async () => {
    const calls: { id: string; params: unknown }[] = [];
    const stripe = {
      disputes: {
        update: async (id: string, params: unknown) => {
          calls.push({ id, params });
          return {} as Stripe.Dispute;
        },
      },
    } as unknown as Stripe;

    const result = await submitDisputeEvidenceWithClient(stripe, {
      stripeDisputeId: "dp_1",
      evidence: { product_description: "Widget" },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("dp_1");
    expect(calls[0].params).toEqual({ evidence: { product_description: "Widget" }, submit: true });
  });

  it("classifies a thrown Stripe error as a clean failure, never an unhandled throw", async () => {
    const stripe = {
      disputes: {
        update: async () => {
          throw new Error("evidence character limit exceeded");
        },
      },
    } as unknown as Stripe;

    const result = await submitDisputeEvidenceWithClient(stripe, {
      stripeDisputeId: "dp_1",
      evidence: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("evidence character limit exceeded");
  });
});
