import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Db, MoneyWrite } from "~/db";
import * as schema from "~/db/schema";
import {
  createAdjustment,
} from "~/lib/billing/adjustment";
import { SerialMoneyCommitter } from "~/lib/money/serializer";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Manual billing adjustments (admin Pass 2). Adjustments never touch Stripe
// (PRICING.md/stripe-invoice.ts: only recovery_fee/dispute_fee/subscription are
// chargeable), so the only invariant worth proving at this layer is the ledger
// shape: signed amount, invoice-first ordering, and the DB-enforced
// admin_audit_log_id requirement (I3, closed here via a real CHECK constraint).



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

// createAdjustment idempotency (Opus review LOW-1): a stable token, not a fresh
// per-call id, anchors the idempotency key, so a double-submitted / retried POST
// no-ops instead of double-crediting. Driven through the REAL SerialMoneyCommitter
// (the DO's core, as money-write-serialization.test.ts does) backed by an
// in-memory sqlite, so "same token -> one credit" is proven at the enforcing layer.
type Sqlite = ReturnType<typeof createInMemoryDb>["sqlite"];

/** A fake executor matching executeMoneyWrite: compiles the caller's batch and
 *  commits it through SerialMoneyCommitter against `sqlite`, atomically. A fresh
 *  committer means an empty seen-set (models DO storage loss, forcing the DB
 *  unique-index backstop); a shared one models the DO seen-set fast path. */
function sqliteExecutor(sqlite: Sqlite, db: Db) {
  const seen = new Set<string>();
  const committer = new SerialMoneyCommitter({
    hasSeen: async (k) => seen.has(k),
    markSeen: async (k) => {
      seen.add(k);
    },
    runBatch: async (statements) => {
      const tx = sqlite.transaction((stmts: { sql: string; params: unknown[] }[]) => {
        for (const s of stmts) sqlite.prepare(s.sql).run(...(s.params as never[]));
      });
      tx(statements);
    },
  });
  const execute = (async (_env: Env, write: MoneyWrite) => {
    const batch = write.build(db);
    const statements = batch.map((item) =>
      (item as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL(),
    );
    return committer.commit({ idempotencyKey: write.idempotencyKey, statements });
  }) as unknown as typeof import("~/lib/money/execute").executeMoneyWrite;
  return { execute };
}

describe("createAdjustment idempotency (same token yields exactly one ledger credit)", () => {
  const env = {} as Env;
  const baseCreate = (over: Record<string, unknown> = {}) => ({
    accountId: "acc_1",
    currency: "usd",
    amountCents: -500,
    description: "Goodwill credit",
    actorEmail: "ops@foxhoundapp.com",
    idempotencyToken: "tok-1",
    now: new Date("2026-07-20T12:00:00.000Z"),
    ...over,
  });

  async function seedAccount(db: Db) {
    await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme", billingExempt: false, processingPaused: false });
  }
  const adjustmentLines = (db: Db) =>
    db.select().from(schema.billingLineItems).where(eq(schema.billingLineItems.type, "adjustment"));

  it("two calls with the SAME token yield exactly one credit (DO seen-set fast path)", async () => {
    const { sqlite, db } = createInMemoryDb();
    await seedAccount(db);
    const { execute } = sqliteExecutor(sqlite, db); // one committer = shared seen-set

    const r1 = await createAdjustment(env, baseCreate(), { db, execute });
    const r2 = await createAdjustment(env, baseCreate(), { db, execute }); // same token

    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(false);
    const lines = await adjustmentLines(db);
    expect(lines).toHaveLength(1);
    expect(lines[0].amountCents).toBe(-500);
  });

  it("dedupes even if the DO seen-set is lost, via the billing_invoices unique index (DB backstop)", async () => {
    const { sqlite, db } = createInMemoryDb();
    await seedAccount(db);

    // A fresh committer per call = no shared seen-set: the second batch actually
    // runs and must be rejected by billing_invoices_idempotency_uq, then mapped
    // to applied=false by the serializer.
    const r1 = await createAdjustment(env, baseCreate(), { db, execute: sqliteExecutor(sqlite, db).execute });
    const r2 = await createAdjustment(env, baseCreate(), { db, execute: sqliteExecutor(sqlite, db).execute });

    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(false);
    expect(await adjustmentLines(db)).toHaveLength(1);
  });

  it("different tokens create two distinct credits (a deliberate second adjustment still works)", async () => {
    const { sqlite, db } = createInMemoryDb();
    await seedAccount(db);
    const { execute } = sqliteExecutor(sqlite, db);

    await createAdjustment(env, baseCreate({ idempotencyToken: "tok-1" }), { db, execute });
    await createAdjustment(env, baseCreate({ idempotencyToken: "tok-2", amountCents: -300 }), { db, execute });

    const lines = await adjustmentLines(db);
    expect(lines).toHaveLength(2);
  });
});
