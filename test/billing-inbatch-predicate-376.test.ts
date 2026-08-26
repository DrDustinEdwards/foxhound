import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  accounts,
  billingInvoices,
  billingLineItems,
  failedPayments,
  recoveredPayments,
} from "~/db/schema";
import { buildBillingInvoiceBatch } from "~/lib/billing/run";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 376(3): THE BILLABLE READ RAN OUTSIDE THE DURABLE OBJECT.
//
// getBillableRecoveries ran before executeMoneyWrite and buildBillingInvoiceBatch
// then inserted from that in-memory list with no predicate of its own. The
// per-account DO serializes the WRITES, not the READ, so a refund landing in the
// gap between the two was invoiced: the row was billable when it was read and was
// not when it was written, and nothing looked again. One monthly pass, seconds
// wide, and the merchant is charged 20% of money they no longer have.
//
// THESE PLANTS EXECUTE SQL. The batch is built and then run statement by
// statement against a real SQLite carrying the committed migrations, with the
// refund stamped IN BETWEEN, which is the only place the defect exists. A test
// that matched the generated SQL with toContain would pass against a predicate
// that was syntactically present and semantically never evaluated.

const ACCOUNT = "acct_billing";
const PAYMENT = "fp_billing";
const RECOVERY = "rp_billing";
const INVOICE = "inv_billing";

const RECOVERED_AT = new Date("2026-06-15T00:00:00.000Z");
// Well past the 30-day maturity window, so maturity is never what excludes a row.
const NOW = new Date("2026-08-01T00:00:00.000Z");
const AMOUNT_CENTS = 10_000;
const EXPECTED_FEE = 2_000; // 20% of the recovered amount (PRICING.md)

async function seedBillableRecovery() {
  const { db } = createInMemoryDb();
  await db.insert(accounts).values({ id: ACCOUNT, name: "Billing Co", createdAt: RECOVERED_AT });
  await db.insert(failedPayments).values({
    id: PAYMENT,
    accountId: ACCOUNT,
    stripeEventId: "evt_billing",
    stripeInvoiceId: "in_billing",
    stripeCustomerId: "cus_billing",
    customerEmail: "payer@example.com",
    amountCents: AMOUNT_CENTS,
    currency: "usd",
    declineCategory: "soft",
    status: "recovered",
    detectedAt: RECOVERED_AT,
  });
  await db.insert(recoveredPayments).values({
    id: RECOVERY,
    failedPaymentId: PAYMENT,
    accountId: ACCOUNT,
    recoveredAt: RECOVERED_AT,
    amountCents: AMOUNT_CENTS,
    currency: "usd",
    recoveryMethod: "email",
    attributionKind: "email_engaged",
  });
  return db;
}

/** Build the batch exactly as the run does, then execute it in order. The
 *  `mutate` callback runs BETWEEN the build and the execute, which is precisely
 *  the window the DO does not cover. */
async function runBatch(
  db: Awaited<ReturnType<typeof seedBillableRecovery>>,
  mutate?: () => Promise<void>,
) {
  const built = buildBillingInvoiceBatch(db, {
    invoiceId: INVOICE,
    accountId: ACCOUNT,
    currency: "usd",
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-01T00:00:00.000Z"),
    periodKey: "2026-07",
    idempotencyKey: `billing:${ACCOUNT}:usd:2026-07`,
    createdAt: NOW,
    asOfMs: NOW.getTime(),
    recoveries: [{ id: RECOVERY, amountCents: AMOUNT_CENTS }],
    disputes: [],
  });

  if (mutate) await mutate();

  for (const statement of built.batch) await (statement as unknown as Promise<unknown>);
  return built;
}

async function committedLines(db: Awaited<ReturnType<typeof seedBillableRecovery>>) {
  return db.select().from(billingLineItems).where(eq(billingLineItems.invoiceId, INVOICE));
}

async function invoiceTotal(db: Awaited<ReturnType<typeof seedBillableRecovery>>) {
  const [row] = await db.select().from(billingInvoices).where(eq(billingInvoices.id, INVOICE));
  return row.totalCents;
}

describe("the billable predicate is evaluated inside the batch", () => {
  it("CONTROL: an untouched billable recovery still bills one line at 20%", async () => {
    const db = await seedBillableRecovery();
    const built = await runBatch(db);

    // The control matters as much as the plants: a guard that bills nothing is
    // not a fix, and every assertion below would pass against one.
    const lines = await committedLines(db);
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("recovery_fee");
    expect(lines[0].amountCents).toBe(EXPECTED_FEE);
    expect(lines[0].recoveredPaymentId).toBe(RECOVERY);
    expect(await invoiceTotal(db)).toBe(EXPECTED_FEE);
    expect(built.lineItemCount).toBe(1);
  });

  it("a refund stamped BETWEEN the read and the write bills nothing", async () => {
    const db = await seedBillableRecovery();

    await runBatch(db, async () => {
      // The refund lands after the billable set was read and before the batch
      // runs. Pre-fix this row was already in the in-memory list and was
      // invoiced anyway.
      await db
        .update(recoveredPayments)
        .set({ refundedAt: new Date("2026-07-20T00:00:00.000Z") })
        .where(eq(recoveredPayments.id, RECOVERY));
    });

    expect(await committedLines(db)).toHaveLength(0);
    // And the invoice does not claim money it has no line for.
    expect(await invoiceTotal(db)).toBe(0);
  });

  it("a dispute stamped in the same window bills nothing", async () => {
    const db = await seedBillableRecovery();
    await runBatch(db, async () => {
      await db
        .update(recoveredPayments)
        .set({ disputedAt: new Date("2026-07-20T00:00:00.000Z") })
        .where(eq(recoveredPayments.id, RECOVERY));
    });

    expect(await committedLines(db)).toHaveLength(0);
    expect(await invoiceTotal(db)).toBe(0);
  });

  it("a soft delete in the same window bills nothing", async () => {
    const db = await seedBillableRecovery();
    await runBatch(db, async () => {
      await db
        .update(recoveredPayments)
        .set({ deletedAt: new Date("2026-07-20T00:00:00.000Z") })
        .where(eq(recoveredPayments.id, RECOVERY));
    });

    expect(await committedLines(db)).toHaveLength(0);
    expect(await invoiceTotal(db)).toBe(0);
  });

  it("an attribution downgraded to the free baseline in the same window bills nothing", async () => {
    const db = await seedBillableRecovery();
    await runBatch(db, async () => {
      await db
        .update(recoveredPayments)
        .set({ attributionKind: "stripe_baseline" })
        .where(eq(recoveredPayments.id, RECOVERY));
    });

    expect(await committedLines(db)).toHaveLength(0);
    expect(await invoiceTotal(db)).toBe(0);
  });

  it("a recovery deleted outright in the window bills nothing rather than failing the batch", async () => {
    const db = await seedBillableRecovery();
    await runBatch(db, async () => {
      await db.delete(recoveredPayments).where(eq(recoveredPayments.id, RECOVERY));
    });

    expect(await committedLines(db)).toHaveLength(0);
    expect(await invoiceTotal(db)).toBe(0);
  });

  it("the invoice total follows the lines that landed when only ONE of two is withdrawn", async () => {
    const db = await seedBillableRecovery();
    // A second billable recovery on the same account and currency.
    await db.insert(recoveredPayments).values({
      id: "rp_second",
      failedPaymentId: PAYMENT,
      accountId: ACCOUNT,
      recoveredAt: RECOVERED_AT,
      amountCents: 5_000,
      currency: "usd",
      recoveryMethod: "email",
      attributionKind: "email_engaged",
    });

    const built = buildBillingInvoiceBatch(db, {
      invoiceId: INVOICE,
      accountId: ACCOUNT,
      currency: "usd",
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-01T00:00:00.000Z"),
      periodKey: "2026-07",
      idempotencyKey: `billing:${ACCOUNT}:usd:2026-07`,
      createdAt: NOW,
      asOfMs: NOW.getTime(),
      recoveries: [
        { id: RECOVERY, amountCents: AMOUNT_CENTS },
        { id: "rp_second", amountCents: 5_000 },
      ],
      disputes: [],
    });

    // Only the first is refunded in the gap.
    await db
      .update(recoveredPayments)
      .set({ refundedAt: new Date("2026-07-20T00:00:00.000Z") })
      .where(eq(recoveredPayments.id, RECOVERY));

    for (const statement of built.batch) await (statement as unknown as Promise<unknown>);

    const lines = await committedLines(db);
    expect(lines).toHaveLength(1);
    expect(lines[0].recoveredPaymentId).toBe("rp_second");
    // 20% of 5,000 only. The JS-computed total was 3,000; the invoice must not
    // keep that number, which is the half of this fix that is easy to miss.
    expect(await invoiceTotal(db)).toBe(1_000);
    expect(built.totalCents).toBe(3_000);
  });

  it("a recovery that has not matured is not billed even though the caller listed it", async () => {
    const db = await seedBillableRecovery();
    await db
      .update(recoveredPayments)
      .set({ recoveredAt: new Date("2026-07-30T00:00:00.000Z") })
      .where(eq(recoveredPayments.id, RECOVERY));

    await runBatch(db);

    expect(await committedLines(db)).toHaveLength(0);
    expect(await invoiceTotal(db)).toBe(0);
  });

  it("a recovery belonging to another account cannot be billed to this one", async () => {
    const db = await seedBillableRecovery();
    await db.insert(accounts).values({ id: "acct_other", name: "Other", createdAt: RECOVERED_AT });
    await db
      .update(recoveredPayments)
      .set({ accountId: "acct_other" })
      .where(eq(recoveredPayments.id, RECOVERY));

    await runBatch(db);

    expect(await committedLines(db)).toHaveLength(0);
  });
});
