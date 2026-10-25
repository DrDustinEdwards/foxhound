import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  buildInvoiceStripeRefUpdate,
  createPlatformInvoice,
} from "~/lib/billing/stripe-invoice";

const db = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

describe("createPlatformInvoice safe-throw (real getStripe, no mock)", () => {
  it("still throws 'STRIPE_SECRET_KEY is not set' cleanly, before any Stripe call, after the invoice-first reordering", async () => {
    await expect(
      createPlatformInvoice({} as Env, {
        platformCustomerId: "cus_1",
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
    ).rejects.toThrow("STRIPE_SECRET_KEY is not set");
  });

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

describe("buildInvoiceStripeRefUpdate (compile against schema)", () => {
  it("stamps stripe id, url, and status onto the billing invoice row", () => {
    const [update] = buildInvoiceStripeRefUpdate(db, {
      billingInvoiceId: "inv_1",
      stripeInvoiceId: "in_stripe_1",
      hostedInvoiceUrl: "https://pay.stripe.com/x",
      status: "finalized",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    const { sql, params } = sqlOf(update);
    expect(sql).toMatch(/update .*billing_invoices/i);
    expect(sql).toMatch(/stripe_invoice_id/i);
    expect(params).toContain("in_stripe_1");
    expect(params).toContain("finalized");
    expect(params).toContain("inv_1");
  });
});
