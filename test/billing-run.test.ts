import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  buildBillingInvoiceBatch,
  computeBillingPeriod,
  shouldAttemptPlatformCharge,
  type InvoiceBatchInput,
} from "~/lib/billing/run";
import {
  disputeFeeItemIdempotencyKey,
  recoveryFeeItemIdempotencyKey,
  type PlatformInvoiceLineInput,
} from "~/lib/billing/stripe-invoice";

const db = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

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
  it("bills an attributed recovery once at 20%, invoice first, evidence linked", () => {
    const { batch, totalCents, lineItemCount } = buildBillingInvoiceBatch(
      db,
      baseInput({ recoveries: [{ id: "rec_1", amountCents: 10_000 }] }),
    );
    expect(lineItemCount).toBe(1);
    expect(totalCents).toBe(2_000);

    // Invoice is the first statement so the line-item FK resolves in-transaction.
    const invoice = sqlOf(batch[0]);
    expect(invoice.sql).toMatch(/insert into .*billing_invoices/i);
    expect(invoice.params).toContain("billing:acc_1:usd:2026-06");
    expect(invoice.params).toContain(2_000); // invoice total

    const line = sqlOf(batch[1]);
    expect(line.sql).toMatch(/insert into .*billing_line_items/i);
    expect(line.params).toContain("recovery_fee");
    expect(line.params).toContain("rec_1"); // recovered_payment FK (unique -> no double bill)
    expect(line.params).toContain("inv_1"); // invoice linkage
    expect(line.params).toContain(2_000);
  });

  it("a won dispute bills capped (no resolution snapshot)", () => {
    // $10,000 disputed: 20% = $2,000, capped at $500 (PRICING.md rev 3).
    const { batch, totalCents } = buildBillingInvoiceBatch(
      db,
      baseInput({ disputes: [{ id: "dsp_1", amountCents: 1_000_000, resolvedFeeCents: null }] }),
    );
    expect(totalCents).toBe(50_000);
    const line = sqlOf(batch[1]);
    expect(line.params).toContain("dispute_fee");
    expect(line.params).toContain("dsp_1");
    expect(line.params).toContain(50_000);
  });

  it("prefers the resolved fee snapshot when present", () => {
    const { totalCents } = buildBillingInvoiceBatch(
      db,
      baseInput({ disputes: [{ id: "dsp_2", amountCents: 200_000, resolvedFeeCents: 15_000 }] }),
    );
    expect(totalCents).toBe(15_000); // snapshot wins over the computed cap
  });

  it("sums recoveries and disputes into the invoice total", () => {
    const { totalCents, lineItemCount } = buildBillingInvoiceBatch(
      db,
      baseInput({
        recoveries: [
          { id: "rec_1", amountCents: 10_000 },
          { id: "rec_2", amountCents: 5_000 },
        ],
        disputes: [{ id: "dsp_1", amountCents: 50_000, resolvedFeeCents: null }],
      }),
    );
    // 2000 + 1000 + 10000 = 13000; 3 line items.
    expect(totalCents).toBe(13_000);
    expect(lineItemCount).toBe(3);
  });

  it("also returns the plain line data alongside the SQL batch, for the platform charge step", () => {
    const { lines } = buildBillingInvoiceBatch(
      db,
      baseInput({
        recoveries: [{ id: "rec_1", amountCents: 10_000 }],
        disputes: [{ id: "dsp_1", amountCents: 50_000, resolvedFeeCents: null }],
      }),
    );
    expect(lines).toEqual([
      {
        type: "recovery_fee",
        amountCents: 2_000,
        description: "Recovery fee",
        idempotencyKey: recoveryFeeItemIdempotencyKey("acc_1", "2026-06", "usd", "rec_1"),
      },
      {
        type: "dispute_fee",
        amountCents: 10_000,
        description: "Dispute fee",
        idempotencyKey: disputeFeeItemIdempotencyKey("dsp_1"),
      },
    ]);
  });

  it("gives every line its own idempotency key, derived from that line's evidence", () => {
    const { lines } = buildBillingInvoiceBatch(
      db,
      baseInput({
        recoveries: [
          { id: "rec_1", amountCents: 10_000 },
          { id: "rec_2", amountCents: 10_000 },
        ],
        disputes: [{ id: "dsp_1", amountCents: 50_000, resolvedFeeCents: null }],
      }),
    );
    // Two recovery lines with IDENTICAL amounts and descriptions must still get
    // distinct keys, or a retry would collapse them into one Stripe item and
    // silently undercharge. The recovery id is what separates them.
    const keys = lines.map((l) => l.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toContain("rec_1");
    expect(keys[1]).toContain("rec_2");
    expect(keys[2]).toBe("dispute_fee_item_dsp_1");
  });

  it("derives a recovery line's key from account+period+currency+recovery, not from the invoice row id", () => {
    // The billing_invoices id is a fresh uuid on every run attempt, so keying
    // items off it would produce a different key on a retry and duplicate the
    // line. These four inputs are all stable across retries of the same period.
    const base = { recoveries: [{ id: "rec_1", amountCents: 10_000 }] };
    const first = buildBillingInvoiceBatch(db, baseInput({ ...base, invoiceId: "inv_a" }));
    const second = buildBillingInvoiceBatch(db, baseInput({ ...base, invoiceId: "inv_b" }));
    expect(first.lines[0].idempotencyKey).toBe(second.lines[0].idempotencyKey);

    // ...and it does change when any of the four does.
    const otherPeriod = buildBillingInvoiceBatch(db, baseInput({ ...base, periodKey: "2026-07" }));
    const otherCurrency = buildBillingInvoiceBatch(db, baseInput({ ...base, currency: "eur" }));
    const otherAccount = buildBillingInvoiceBatch(db, baseInput({ ...base, accountId: "acc_2" }));
    for (const other of [otherPeriod, otherCurrency, otherAccount]) {
      expect(other.lines[0].idempotencyKey).not.toBe(first.lines[0].idempotencyKey);
    }
  });
});

describe("shouldAttemptPlatformCharge (the guard: never charge without a stored platform customer id)", () => {
  const chargeableLine: PlatformInvoiceLineInput = {
    type: "recovery_fee",
    amountCents: 2_000,
    description: "Recovery fee",
    idempotencyKey: recoveryFeeItemIdempotencyKey("acc_1", "2026-06", "usd", "rec_1"),
  };

  it("false when there is no platform customer id, even with chargeable lines", () => {
    expect(shouldAttemptPlatformCharge(null, [chargeableLine])).toBe(false);
  });

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
