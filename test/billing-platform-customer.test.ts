import { describe, expect, it } from "vitest";

import { ensurePlatformCustomer, getDefaultCard } from "~/lib/billing/platform-customer";

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

// J65 (row S3): Recova's Payment method section shows the card on file (brand,
// last four, expiry), read from the platform customer's default payment method.
// Foxhound's page said "A payment method is on file" whenever a platform
// customer existed, which the setup action creates BEFORE the card is
// collected, so an abandoned setup read as a card on file.
describe("getDefaultCard (the card on file, read only)", () => {
  const card = { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 };

  it("returns the default card's brand, last four and expiry", async () => {
    const result = await getDefaultCard({} as Env, "cus_1", {
      retrieveCustomer: async () => ({ invoice_settings: { default_payment_method: { card } } }),
    });
    expect(result).toEqual({ brand: "visa", last4: "4242", expMonth: 4, expYear: 2030 });
  });

  it("is null when the customer exists but no card was ever collected", async () => {
    const result = await getDefaultCard({} as Env, "cus_1", {
      retrieveCustomer: async () => ({ invoice_settings: { default_payment_method: null } }),
    });
    expect(result).toBeNull();
  });

  it("is null for a deleted customer, and for a read that fails, rather than breaking the page", async () => {
    expect(
      await getDefaultCard({} as Env, "cus_1", { retrieveCustomer: async () => ({ deleted: true }) }),
    ).toBeNull();
    const errors = console.error;
    console.error = () => {};
    try {
      expect(
        await getDefaultCard({} as Env, "cus_1", {
          retrieveCustomer: async () => {
            throw new Error("stripe down");
          },
        }),
      ).toBeNull();
    } finally {
      console.error = errors;
    }
  });
});
