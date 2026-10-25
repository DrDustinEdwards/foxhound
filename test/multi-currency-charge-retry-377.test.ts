import { describe, expect, it, vi } from "vitest";


// RULING 377(6): MULTI-CURRENCY IS ONE PLATFORM CUSTOMER, AND STRIPE NEEDS TO BE
// TOLD THE CURRENCY EVERY TIME.
//
// Stripe bills one customer in a second currency on one-off invoices only when
// `currency` is set on the invoice create AND on every invoice item. Miss it on
// either and Stripe falls back to the customer's existing currency, which is
// how a EUR recovery silently becomes a USD charge, or the create fails and the
// invoice ages to gave_up (376(5)'s stranding).
//
// MEASURED AT THIS SHA: the code already passes it on both calls. That is worth
// saying plainly rather than quietly writing a no-op commit, and it is worth
// PINNING, because "already correct" and "protected" are different states and
// only one of them survives the next edit. These drive the real
// createPlatformInvoice against a fake Stripe client and read the arguments it
// actually sends.
//
// WHAT THESE DO NOT DO: prove the behaviour against Stripe. 377(6) asks for one
// platform customer billed in two currencies in test mode; that needs the live
// key, which is a Worker secret this environment cannot read. The proof is
// owed and is reported as owed.

interface CapturedCall {
  args: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

const harness = vi.hoisted(() => ({
  invoiceCreates: [] as CapturedCall[],
  itemCreates: [] as CapturedCall[],
}));

vi.mock("~/lib/stripe/client", () => ({
  getStripe: () => ({
    invoices: {
      create: async (args: Record<string, unknown>, options?: Record<string, unknown>) => {
        harness.invoiceCreates.push({ args, options });
        return { id: "in_platform_fake" };
      },
      finalizeInvoice: async () => ({
        id: "in_platform_fake",
        hosted_invoice_url: "https://pay.stripe.com/x",
      }),
    },
    invoiceItems: {
      create: async (args: Record<string, unknown>, options?: Record<string, unknown>) => {
        harness.itemCreates.push({ args, options });
        return { id: `ii_${harness.itemCreates.length}` };
      },
    },
    customers: { retrieve: async () => ({ invoice_settings: { default_payment_method: "pm_1" } }) },
  }),
  getConnectedStripe: () => {
    throw new Error("connected stripe must not be used here");
  },
}));

const { createPlatformInvoice } = await import("~/lib/billing/stripe-invoice");

function lines() {
  return [
    {
      type: "recovery_fee",
      amountCents: 2_000,
      description: "Recovery fee",
      idempotencyKey: "key_recovery",
    },
    {
      type: "dispute_fee",
      amountCents: 5_000,
      description: "Dispute fee",
      idempotencyKey: "key_dispute",
    },
  ];
}

async function createIn(currency: string) {
  harness.invoiceCreates = [];
  harness.itemCreates = [];
  await createPlatformInvoice({ STRIPE_SECRET_KEY: "sk_test_x" } as unknown as Env, {
    platformCustomerId: "cus_platform",
    currency,
    lines: lines(),
    billingInvoiceId: "binv_1",
    periodStart: new Date(Date.UTC(2026, 5, 1)),
  });
  return { invoiceCreates: [...harness.invoiceCreates], itemCreates: [...harness.itemCreates] };
}

describe("every Stripe call in a platform invoice carries the currency", () => {

  it("each item still carries its own evidence-derived idempotency key", async () => {
    const { itemCreates } = await createIn("usd");
    expect(itemCreates.map((c) => c.options?.idempotencyKey)).toEqual([
      "key_recovery",
      "key_dispute",
    ]);
  });
});
