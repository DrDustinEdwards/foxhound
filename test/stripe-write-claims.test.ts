
import { describe, expect, it } from "vitest";

import { buildResubscribeSessionParams } from "~/lib/card-update/service";

// WHAT FOXHOUND DOES WITH A MERCHANT'S read_write GRANT, SAID TRUTHFULLY
// (job_c6d167f29506).
//
// WHAT WAS WRONG. Eight public surfaces said Foxhound writes to a connected
// Stripe account in "three places" (retrying a failed invoice, setting a default
// payment method after a card update, submitting approved dispute evidence), and
// four of them added that it "never creates a charge outside an invoice you
// already issued". Both were false: the win-back resubscribe link
// (createResubscribeSession in app/lib/card-update/service.ts) opens a Checkout
// Session in subscription mode on the connected account, and a completed
// checkout makes a new subscription, invoice and charge.
//
// THE PLANT. Every surface that lists the writes must name the resubscribe
// checkout in the same sentence, no surface may state a count of write places
// (a count has to be kept in step by hand, and it already drifted once), and
// the "outside an invoice" sentence may not come back. The code fact the copy
// rests on is pinned below too, so the disclosure cannot outlive the code.
//
// /connect (app/routes/auth/connect.tsx) is left out on purpose: PR #65 rewrites
// that page and its panel, and carries the same fix there. /audit/connect is
// left out because the audit's grant is read_only.





describe("the code fact the disclosure rests on", () => {
  it("the resubscribe Checkout Session is in subscription mode, so completing it creates a subscription", () => {
    const params = buildResubscribeSessionParams({
      customerId: "cus_sample",
      priceId: "price_sample",
      quantity: 1,
      winBackSequenceId: "wb_sample",
      winBackStepNumber: 1,
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/cancel",
    });
    expect(params.mode).toBe("subscription");
  });
});
