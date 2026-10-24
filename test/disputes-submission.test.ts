import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  buildStripeEvidencePayload,
  submitDisputeEvidenceWithClient,
} from "~/lib/disputes/submission";

describe("buildStripeEvidencePayload", () => {

  it("drops blank values so an empty edit never overwrites with nothing", () => {
    const payload = buildStripeEvidencePayload([
      { fieldName: "product_description", fieldValue: "   " },
      { fieldName: "service_date", fieldValue: "2026-07-01" },
    ]);
    expect(payload).toEqual({ service_date: "2026-07-01" });
  });
});

describe("submitDisputeEvidenceWithClient", () => {

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
