import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

import { buildGuardedRecoveryLineInsert } from "~/db/billable";
import * as schema from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The guarded fee insert re-checks the whole billable predicate as it writes, the account's
// eligibility included: a pause landing after the billing read must stop the fee line.

const RECOVERED_AT = new Date("2026-06-01T00:00:00.000Z");
const AS_OF = new Date("2026-07-21T00:00:00.000Z");

async function insertFor(processingPaused: boolean) {
  const { db } = createInMemoryDb();
  await db.insert(schema.accounts).values({ id: "acc_1", name: "Acme", processingPaused });
  await db.insert(schema.failedPayments).values({
    id: "fp_1",
    accountId: "acc_1",
    stripeEventId: "evt_1",
    stripeInvoiceId: "in_1",
    stripeCustomerId: "cus_1",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "recovered",
    detectedAt: RECOVERED_AT,
  });
  await db.insert(schema.recoveredPayments).values({
    id: "rec_1",
    accountId: "acc_1",
    failedPaymentId: "fp_1",
    recoveredAt: RECOVERED_AT,
    amountCents: 10_000,
    currency: "usd",
    recoveryMethod: "foxhound_retry",
    attributionKind: "foxhound_retry",
  });
  await db.insert(schema.billingInvoices).values({
    id: "binv_1",
    accountId: "acc_1",
    currency: "usd",
    periodStart: RECOVERED_AT,
    periodEnd: AS_OF,
    status: "draft",
    totalCents: 0,
    idempotencyKey: "k",
    createdAt: AS_OF,
  });
  await buildGuardedRecoveryLineInsert(db, {
    lineItemId: "bli_1",
    invoiceId: "binv_1",
    accountId: "acc_1",
    currency: "usd",
    recoveredPaymentId: "rec_1",
    feeCents: 2_000,
    refundedCents: 0,
    description: "Recovery fee",
    createdAt: AS_OF,
    asOfMs: AS_OF.getTime(),
  });
  return db.select().from(schema.billingLineItems).where(eq(schema.billingLineItems.id, "bli_1"));
}

it("writes the fee line for an eligible account", async () => {
  expect(await insertFor(false)).toHaveLength(1);
});

it("writes nothing when the account was paused after the read", async () => {
  expect(await insertFor(true)).toHaveLength(0);
});
