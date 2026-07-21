import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import { logAdminAction } from "~/lib/admin/audit.server";
import { buildAdjustmentInvoiceBatch, type AdjustmentInvoiceInput } from "~/lib/billing/adjustment";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Manual billing adjustments (admin Pass 2). Adjustments never touch Stripe
// (PRICING.md/stripe-invoice.ts: only recovery_fee/dispute_fee/subscription are
// chargeable), so the only invariant worth proving at this layer is the ledger
// shape: signed amount, invoice-first ordering, and the DB-enforced
// admin_audit_log_id requirement (I3, closed here via a real CHECK constraint).

const fakeDb = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

const baseInput = (over: Partial<AdjustmentInvoiceInput>): AdjustmentInvoiceInput => ({
  invoiceId: "inv_adj_1",
  accountId: "acc_1",
  currency: "usd",
  amountCents: -500,
  description: "Goodwill credit",
  adminAuditLogId: "audit_1",
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  idempotencyKey: "adjustment:inv_adj_1",
  ...over,
});

describe("buildAdjustmentInvoiceBatch (pure, compile-tested like buildBillingInvoiceBatch)", () => {
  it("invoice first, then the line item, both carrying the signed amount", () => {
    const batch = buildAdjustmentInvoiceBatch(fakeDb, baseInput({}));
    expect(batch).toHaveLength(2);

    const invoice = sqlOf(batch[0]);
    expect(invoice.sql).toMatch(/insert into .*billing_invoices/i);
    expect(invoice.params).toContain(-500);
    expect(invoice.params).toContain("adjustment:inv_adj_1");

    const line = sqlOf(batch[1]);
    expect(line.sql).toMatch(/insert into .*billing_line_items/i);
    expect(line.params).toContain("adjustment");
    expect(line.params).toContain(-500);
    expect(line.params).toContain("audit_1"); // admin_audit_log_id FK
    expect(line.params).toContain("inv_adj_1"); // invoice linkage
  });

  it("a positive amount corrects the fee upward (no sign flip, just passed through)", () => {
    const batch = buildAdjustmentInvoiceBatch(fakeDb, baseInput({ amountCents: 1_200 }));
    const invoice = sqlOf(batch[0]);
    expect(invoice.params).toContain(1_200);
  });

  it("never carries a recoveredPaymentId or disputeId (an adjustment is its own evidence)", () => {
    const batch = buildAdjustmentInvoiceBatch(fakeDb, baseInput({}));
    const line = sqlOf(batch[1]);
    // recovered_payment_id / dispute_id are bound as null, not omitted.
    expect(line.sql).toMatch(/recovered_payment_id/i);
    expect(line.sql).toMatch(/dispute_id/i);
  });
});

describe("billing_line_items_adjustment_audit_ck (DB-enforced, real sqlite; closes I3)", () => {
  async function seedInvoice(db: ReturnType<typeof createInMemoryDb>["db"], accountId: string) {
    await db.insert(schema.accounts).values({ id: accountId, name: "Acme", billingExempt: false, processingPaused: false });
    await db.insert(schema.billingInvoices).values({
      id: "inv_1",
      accountId,
      currency: "usd",
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-07-01T00:00:00.000Z"),
      status: "draft",
      totalCents: 0,
      idempotencyKey: "adjustment:inv_1",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });
  }

  it("rejects an adjustment line item with no admin_audit_log_id", async () => {
    const { db } = createInMemoryDb();
    await seedInvoice(db, "acc_1");

    await expect(
      db.insert(schema.billingLineItems).values({
        id: "li_bad",
        invoiceId: "inv_1",
        accountId: "acc_1",
        type: "adjustment",
        currency: "usd",
        amountCents: -500,
        adminAuditLogId: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/constraint/i);
  });

  it("accepts an adjustment line item WITH an admin_audit_log_id", async () => {
    const { db } = createInMemoryDb();
    await seedInvoice(db, "acc_1");
    const auditId = await logAdminAction(db, {
      actorEmail: "ops@foxhoundapp.com",
      action: "billing.adjustment.create",
      metadata: { accountId: "acc_1" },
    });

    await expect(
      db.insert(schema.billingLineItems).values({
        id: "li_good",
        invoiceId: "inv_1",
        accountId: "acc_1",
        type: "adjustment",
        currency: "usd",
        amountCents: -500,
        adminAuditLogId: auditId,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ).resolves.not.toThrow();
  });

  it("a recovery_fee line item is unaffected: still valid with no admin_audit_log_id", async () => {
    const { db } = createInMemoryDb();
    await seedInvoice(db, "acc_1");

    await expect(
      db.insert(schema.billingLineItems).values({
        id: "li_recovery",
        invoiceId: "inv_1",
        accountId: "acc_1",
        type: "recovery_fee",
        currency: "usd",
        amountCents: 2_000,
        adminAuditLogId: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ).resolves.not.toThrow();
  });
});

describe("logAdminAction returns the inserted row's id", () => {
  it("the returned id resolves to the row actually written", async () => {
    const { db } = createInMemoryDb();
    const id = await logAdminAction(db, {
      actorEmail: "ops@foxhoundapp.com",
      action: "merchant.cancel",
      metadata: { accountId: "acc_1" },
    });

    const rows = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("merchant.cancel");
  });
});
