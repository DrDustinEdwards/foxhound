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

// The billable predicate is evaluated inside the invoice batch. The per-account Durable Object
// serializes the writes, not the billable READ, so a refund landing between the two would be invoiced
// (20% of money the merchant no longer has). The batch is built, the change is made in between, and
// the statements then run against a real SQLite with the committed migrations.

const ACCOUNT = "acct_billing";
const PAYMENT = "fp_billing";
const RECOVERY = "rp_billing";
const INVOICE = "inv_billing";

const RECOVERED_AT = new Date("2026-06-15T00:00:00.000Z");
// Past the 30-day maturity window, so maturity is never what excludes a row.
const NOW = new Date("2026-08-01T00:00:00.000Z");
const AMOUNT_CENTS = 10_000;

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

/** Build the batch as the run does, run `mutate` BETWEEN the build and the execute, then execute. */
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
    recoveries: [{ id: RECOVERY, amountCents: AMOUNT_CENTS, refundedCents: 0 }],
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
  const LATE = new Date("2026-07-20T00:00:00.000Z");

  it.each([
    ["a refund", { refundedAt: LATE }],
    ["a partial refund", { refundedCents: 1_000 }],
    ["a dispute", { disputedAt: LATE }],
    ["a soft delete", { deletedAt: LATE }],
    ["a downgrade to the free baseline", { attributionKind: "stripe_baseline" }],
  ] as const)("%s stamped between the read and the write bills nothing", async (_name, change) => {
    const db = await seedBillableRecovery();

    await runBatch(db, async () => {
      await db.update(recoveredPayments).set(change).where(eq(recoveredPayments.id, RECOVERY));
    });

    expect(await committedLines(db)).toHaveLength(0);
    // And the invoice does not claim money it has no line for.
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
});
