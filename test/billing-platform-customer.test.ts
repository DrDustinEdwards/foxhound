import { describe, expect, it } from "vitest";

import * as platformCustomer from "~/lib/billing/platform-customer";

const { ensurePlatformCustomer, getDefaultCard } = platformCustomer;

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

// J65: Recova's Payment method section shows the card on file (brand,
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

// E25: Recova's billing customer carries the address Stripe emails the
// invoice to, chosen in lib/billing-email.ts (blob 312e9177): the connected
// account's support_email, then its account email, then the login email, with
// an empty string treated as missing.
describe("billing email for the platform customer (E25)", () => {
  it("prefers support_email, then the account email, then the login email", () => {
    const resolve = platformCustomer.resolveBillingEmailFromStripeAccount;
    const full = { business_profile: { support_email: "support@example.com" }, email: "acct@example.com" };
    expect(resolve(full, "login@example.com")).toBe("support@example.com");
    expect(resolve({ business_profile: { support_email: "" }, email: "acct@example.com" }, "login@example.com")).toBe("acct@example.com");
    expect(resolve({ business_profile: null, email: "" }, "login@example.com")).toBe("login@example.com");
    expect(resolve(null, "login@example.com")).toBe("login@example.com");
    expect(resolve(null, null)).toBeNull();
  });
});
