import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { buildBillingInvoiceBatch, type InvoiceBatchInput } from "~/lib/billing/invoice-batch";
import { computeBillingPeriod, shouldAttemptPlatformCharge } from "~/lib/billing/run";
import {
  recoveryFeeItemIdempotencyKey,
  type PlatformInvoiceLineInput,
} from "~/lib/billing/stripe-invoice";

const db = drizzle({} as never, { schema });

const baseInput = (over: Partial<InvoiceBatchInput>): InvoiceBatchInput => ({
  invoiceId: "inv_1",
  accountId: "acc_1",
  currency: "usd",
  periodStart: new Date("2026-06-01T00:00:00.000Z"),
  periodEnd: new Date("2026-07-01T00:00:00.000Z"),
  periodKey: "2026-06",
  idempotencyKey: "billing:acc_1:usd:2026-06",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  asOfMs: new Date("2026-07-01T00:00:00.000Z").getTime(),
  recoveries: [],
  disputes: [],
  ...over,
});

describe("computeBillingPeriod (prior calendar month, UTC)", () => {
  it("mid-year: July run bills June", () => {
    const p = computeBillingPeriod(new Date("2026-07-12T09:00:00.000Z").getTime());
    expect(p.periodKey).toBe("2026-06");
    expect(p.periodStart.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(p.periodEnd.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("January run rolls back to prior December", () => {
    const p = computeBillingPeriod(new Date("2026-01-15T00:00:00.000Z").getTime());
    expect(p.periodKey).toBe("2025-12");
    expect(p.periodStart.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(p.periodEnd.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("buildBillingInvoiceBatch", () => {
  it("sums recoveries and disputes into the invoice total", () => {
    const { totalCents, lineItemCount } = buildBillingInvoiceBatch(
      db,
      baseInput({
        recoveries: [
          { id: "rec_1", amountCents: 10_000, refundedCents: 0 },
          // Half refunded: the fee is on the 2,500 kept (Dustin).
          { id: "rec_2", amountCents: 5_000, refundedCents: 2_500 },
        ],
        disputes: [{ id: "dsp_1", amountCents: 50_000, resolvedFeeCents: 10_000 }],
      }),
    );
    // 2000 + 500 + 10000 = 12500; 3 line items.
    expect(totalCents).toBe(12_500);
    expect(lineItemCount).toBe(3);
  });

  it("gives every line its own idempotency key, derived from that line's evidence", () => {
    const { lines } = buildBillingInvoiceBatch(
      db,
      baseInput({
        recoveries: [
          { id: "rec_1", amountCents: 10_000, refundedCents: 0 },
          { id: "rec_2", amountCents: 10_000, refundedCents: 0 },
        ],
        disputes: [{ id: "dsp_1", amountCents: 50_000, resolvedFeeCents: 10_000 }],
      }),
    );
    // Identical lines must still get distinct keys, or a retry collapses them into one Stripe item.
    const keys = lines.map((l) => l.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toContain("rec_1");
    expect(keys[1]).toContain("rec_2");
    expect(keys[2]).toBe("dispute_fee_item_dsp_1");
  });
});

describe("shouldAttemptPlatformCharge (the guard: never charge without a stored platform customer id)", () => {
  const chargeableLine: PlatformInvoiceLineInput = {
    type: "recovery_fee",
    amountCents: 2_000,
    description: "Recovery fee",
    idempotencyKey: recoveryFeeItemIdempotencyKey("acc_1", "2026-06", "usd", "rec_1"),
  };

  it("false when there is a customer id but nothing chargeable (adjustment-only or zero-amount)", () => {
    const adjustmentOnly: PlatformInvoiceLineInput = {
      type: "adjustment",
      amountCents: -500,
      description: "Goodwill credit",
      idempotencyKey: "adjustment_never_charged",
    };
    expect(shouldAttemptPlatformCharge("cus_1", [adjustmentOnly])).toBe(false);
    expect(shouldAttemptPlatformCharge("cus_1", [])).toBe(false);
  });

  it("true only when both a customer id and a chargeable line are present", () => {
    expect(shouldAttemptPlatformCharge("cus_1", [chargeableLine])).toBe(true);
  });
});
