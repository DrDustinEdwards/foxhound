import { describe, expect, it } from "vitest";

import { ensurePlatformCustomer } from "~/lib/billing/platform-customer";

describe("ensurePlatformCustomer (reuse vs create)", () => {
  it("returns the existing id without calling Stripe when one is already stored", async () => {
    // No STRIPE_SECRET_KEY in this fake env: if the function fell through to
    // getStripe(env), it would throw. Returning cleanly proves the early return.
    const fakeEnv = {} as Env;
    const id = await ensurePlatformCustomer(fakeEnv, {
      existingCustomerId: "cus_existing",
      accountId: "acc_1",
      accountName: "Acme",
    });
    expect(id).toBe("cus_existing");
  });
});
