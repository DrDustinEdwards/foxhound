import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { platformBillingStatus } from "~/lib/billing/platform-webhook";
import {
  buildInvoiceStripeRefUpdate,
  chargeableLines,
  createPlatformInvoice,
  type PlatformInvoiceLineInput,
} from "~/lib/billing/stripe-invoice";

const db = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

describe("chargeableLines (what touches Stripe)", () => {
  const lines: PlatformInvoiceLineInput[] = [
    { type: "recovery_fee", amountCents: 2_000, description: "Recovery fee" },
    { type: "dispute_fee", amountCents: 50_000, description: "Dispute fee" },
    { type: "subscription", amountCents: 19_900, description: "Intelligence" },
    { type: "adjustment", amountCents: -500, description: "Goodwill credit" },
    { type: "recovery_fee", amountCents: 0, description: "Zero" },
  ];

  it("keeps fee + subscription lines, drops adjustments and zero amounts", () => {
    const charged = chargeableLines(lines);
    expect(charged.map((l) => l.type)).toEqual(["recovery_fee", "dispute_fee", "subscription"]);
    // adjustment (admin-audited, never charged) and the zero line are excluded.
    expect(charged.some((l) => l.type === "adjustment")).toBe(false);
    expect(charged.some((l) => l.amountCents === 0)).toBe(false);
  });
});

describe("platformBillingStatus mapping", () => {
  it("maps our own Stripe invoice events to billing_invoices status", () => {
    expect(platformBillingStatus("invoice.paid")).toBe("paid");
    expect(platformBillingStatus("invoice.payment_failed")).toBe("payment_failed");
    expect(platformBillingStatus("invoice.finalized")).toBe("finalized");
    expect(platformBillingStatus("invoice.voided")).toBe("void");
  });

  it("ignores unrelated events", () => {
    expect(platformBillingStatus("customer.created")).toBeNull();
    expect(platformBillingStatus("charge.refunded")).toBeNull();
  });
});

describe("createPlatformInvoice safe-throw (real getStripe, no mock)", () => {
  it("still throws 'STRIPE_SECRET_KEY is not set' cleanly, before any Stripe call, after the invoice-first reordering", async () => {
    await expect(
      createPlatformInvoice({} as Env, {
        platformCustomerId: "cus_1",
        currency: "usd",
        billingInvoiceId: "inv_1",
        lines: [{ type: "recovery_fee", amountCents: 2_000, description: "Recovery fee" }],
      }),
    ).rejects.toThrow("STRIPE_SECRET_KEY is not set");
  });

  it("still throws its own precondition errors before ever reaching getStripe", async () => {
    await expect(
      createPlatformInvoice({} as Env, {
        platformCustomerId: "",
        currency: "usd",
        billingInvoiceId: "inv_1",
        lines: [{ type: "recovery_fee", amountCents: 2_000, description: "Recovery fee" }],
      }),
    ).rejects.toThrow("no platform customer id for account billing");

    await expect(
      createPlatformInvoice({} as Env, {
        platformCustomerId: "cus_1",
        currency: "usd",
        billingInvoiceId: "inv_1",
        lines: [{ type: "adjustment", amountCents: -500, description: "Goodwill credit" }],
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
