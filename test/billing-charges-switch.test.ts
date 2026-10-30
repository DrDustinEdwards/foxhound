import { describe, expect, it } from "vitest";

import { runChargeRetrySweep } from "~/lib/billing/charge-retry";
import { PLATFORM_CHARGES_ENABLED } from "~/lib/billing/charges-switch";
import { createPlatformInvoice, payPlatformInvoice } from "~/lib/billing/stripe-invoice";

// Hard rule 12: until the LLC exists no merchant is charged, whatever D1 says.
describe("the platform charges switch", () => {
  it("is off, and while off nothing reaches Stripe", async () => {
    expect(PLATFORM_CHARGES_ENABLED).toBe(false);
    const env = {} as Env; // any D1 or Stripe access would throw on this
    await expect(runChargeRetrySweep(env, Date.now())).resolves.toEqual([]);
    await expect(
      createPlatformInvoice(env, {
        platformCustomerId: "cus_platform",
        currency: "usd",
        lines: [],
        billingInvoiceId: "inv_1",
        periodStart: new Date(),
        billingEmail: async () => null,
      } as never),
    ).rejects.toThrow(/switched off/);
    await expect(payPlatformInvoice(env, "in_1", 1)).rejects.toThrow(/switched off/);
  });
});
