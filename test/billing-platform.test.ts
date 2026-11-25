import { describe, expect, it, vi } from "vitest";

import { createPlatformInvoice } from "~/lib/billing/stripe-invoice";

// Charging is switched on here (CLAUDE.md, Launch).
vi.mock("~/lib/billing/charges-switch", () => ({ PLATFORM_CHARGES_ENABLED: true }));

describe("createPlatformInvoice preconditions", () => {
  it("still throws its own precondition errors before ever reaching getStripe", async () => {
    await expect(
      createPlatformInvoice({} as Env, {
        platformCustomerId: "",
        currency: "usd",
        billingInvoiceId: "inv_1",
        periodStart: new Date(Date.UTC(2026, 5, 1)),
        lines: [
          {
            type: "recovery_fee",
            amountCents: 2_000,
            description: "Recovery fee",
            idempotencyKey: "item_recovery_fee_2000",
          },
        ],
      }),
    ).rejects.toThrow("no platform customer id for account billing");

    await expect(
      createPlatformInvoice({} as Env, {
        platformCustomerId: "cus_1",
        currency: "usd",
        billingInvoiceId: "inv_1",
        periodStart: new Date(Date.UTC(2026, 5, 1)),
        lines: [
          {
            type: "adjustment",
            amountCents: -500,
            description: "Goodwill credit",
            idempotencyKey: "item_adjustment_neg500",
          },
        ],
      }),
    ).rejects.toThrow("no chargeable line items for platform invoice");
  });
});
