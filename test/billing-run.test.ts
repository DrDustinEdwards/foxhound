import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  buildBillingInvoiceBatch,
  computeBillingPeriod,
  type InvoiceBatchInput,
} from "~/lib/billing/run";

const db = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

const baseInput = (over: Partial<InvoiceBatchInput>): InvoiceBatchInput => ({
  invoiceId: "inv_1",
  accountId: "acc_1",
  currency: "usd",
  periodStart: new Date("2026-06-01T00:00:00.000Z"),
  periodEnd: new Date("2026-07-01T00:00:00.000Z"),
  idempotencyKey: "billing:acc_1:usd:2026-06",
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
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
    const { batch, totalCents } = buildBillingInvoiceBatch(
      db,
      baseInput({ disputes: [{ id: "dsp_1", amountCents: 200_000, resolvedFeeCents: null }] }),
    );
    expect(totalCents).toBe(25_000); // 20% of 200000 = 40000, capped at 25000
    const line = sqlOf(batch[1]);
    expect(line.params).toContain("dispute_fee");
    expect(line.params).toContain("dsp_1");
    expect(line.params).toContain(25_000);
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
});
