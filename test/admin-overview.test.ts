import { describe, expect, it } from "vitest";

import {
  accounts,
  billingInvoices,
  disputes,
  failedPayments,
  recoveredPayments,
  stripeConnections,
} from "~/db";
import { getAdminOverview as adminOverview } from "~/lib/admin/overview.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW - msAgo);

async function seed() {
  const { db } = createInMemoryDb();
  await db.insert(accounts).values([
    { id: "acct_north", name: "Northwind Coffee", createdAt: at(40 * DAY) },
    { id: "acct_lumen", name: "Lumen Studio", createdAt: at(3 * DAY), processingPaused: true },
    {
      id: "acct_brake",
      name: "Harbor Yoga",
      createdAt: at(90 * DAY),
      processingPaused: true,
      pauseReason: "brake",
      billingExempt: true,
    },
    // Paused but canceled: processing is already gated by the cancel, so there
    // is nothing to resume and it is not a problem to act on.
    {
      id: "acct_gone",
      name: "Gone Co",
      createdAt: at(60 * DAY),
      processingPaused: true,
      cancelledAt: at(5 * DAY),
    },
    // Demo accounts never count on the operator surface.
    {
      id: "demo_acct",
      name: "Demo",
      createdAt: at(1 * DAY),
      processingPaused: true,
      billingExempt: true,
    },
  ]);

  await db.insert(stripeConnections).values([
    {
      id: "sc_new",
      accountId: "acct_lumen",
      stripeUserId: "acct_s1",
      connectedAt: at(2 * DAY),
      createdAt: at(2 * DAY),
    },
    {
      id: "sc_old",
      accountId: "acct_north",
      stripeUserId: "acct_s2",
      connectedAt: at(30 * DAY),
      createdAt: at(30 * DAY),
    },
    {
      id: "sc_gone",
      accountId: "acct_gone",
      stripeUserId: "acct_s3",
      connectedAt: at(3 * DAY),
      disconnectedAt: at(1 * DAY),
      createdAt: at(3 * DAY),
    },
    {
      id: "sc_demo",
      accountId: "demo_acct",
      stripeUserId: "acct_s4",
      connectedAt: at(1 * DAY),
      createdAt: at(1 * DAY),
    },
  ]);

  const dispute = (
    id: string,
    accountId: string,
    daysAgo: number,
    over: Partial<typeof disputes.$inferInsert> = {},
  ) => ({
    id,
    accountId,
    stripeDisputeId: `dp_${id}`,
    stripeChargeId: `ch_${id}`,
    amountCents: 12000,
    currency: "usd",
    reason: "product_not_received",
    status: "needs_response",
    createdAt: at(daysAgo * DAY),
    ...over,
  });
  await db.insert(disputes).values([
    dispute("d_stale_old", "acct_north", 12, { evidenceDeadline: at(-10 * DAY) }),
    dispute("d_stale", "acct_lumen", 9, {
      currency: "eur",
      amountCents: 4500,
      evidenceDeadline: at(-2 * DAY),
    }),
    // Its deadline has passed: nothing can be sent, so it goes after the ones
    // that can still be answered.
    dispute("d_stale_past", "acct_north", 15, { evidenceDeadline: at(1 * DAY) }),
    dispute("d_fresh", "acct_north", 2),
    dispute("d_submitted", "acct_north", 10, { submittedAt: at(8 * DAY), state: "submitted" }),
    dispute("d_won", "acct_north", 20, { state: "resolved_won", status: "won" }),
    dispute("d_demo", "demo_acct", 20),
  ]);

  const invoice = (
    id: string,
    accountId: string,
    status: string,
    over: Partial<typeof billingInvoices.$inferInsert> = {},
  ) => ({
    id,
    accountId,
    currency: "usd",
    periodStart: at(45 * DAY),
    periodEnd: at(15 * DAY),
    status,
    totalCents: 2400,
    idempotencyKey: `key_${id}`,
    createdAt: at(14 * DAY),
    ...over,
  });
  await db.insert(billingInvoices).values([
    invoice("inv_failed", "acct_north", "payment_failed", {
      chargeAttemptCount: 2,
      lastChargeAttemptAt: at(1 * DAY),
    }),
    invoice("inv_paid", "acct_lumen", "paid"),
    // The retry sweep stopped chasing it: the fee is owed and nobody will
    // collect it unless a person does something.
    invoice("inv_gave_up", "acct_lumen", "gave_up", {
      chargeAttemptCount: 4,
      lastChargeAttemptAt: at(3 * DAY),
    }),
    invoice("inv_uncollectible", "acct_north", "uncollectible", { createdAt: at(5 * DAY) }),
    // Voided on purpose, and an old write-off outside the 30-day window.
    invoice("inv_void", "acct_north", "void"),
    invoice("inv_old", "acct_north", "uncollectible", { createdAt: at(40 * DAY) }),
    invoice("inv_demo", "demo_acct", "payment_failed"),
  ]);

  const failed = (id: string, accountId: string, status = "recovered") => ({
    id,
    accountId,
    stripeEventId: `evt_${id}`,
    stripeInvoiceId: `in_${id}`,
    stripeCustomerId: `cus_${id}`,
    customerEmail: "customer@example.com",
    amountCents: 5000,
    currency: "usd",
    declineCategory: "soft",
    status,
    detectedAt: at(20 * DAY),
  });
  await db
    .insert(failedPayments)
    .values([
      failed("fp_1", "acct_north"),
      failed("fp_2", "acct_lumen"),
      failed("fp_3", "acct_north"),
      failed("fp_4", "acct_north"),
      failed("fp_5", "demo_acct"),
      failed("fp_6", "acct_north"),
      failed("fp_7", "acct_north"),
    ]);
  const recovered = (
    id: string,
    fp: string,
    accountId: string,
    cents: number,
    currency: string,
    recoveredAt: Date,
    over = {},
  ) => ({
    id,
    failedPaymentId: fp,
    accountId,
    amountCents: cents,
    currency,
    recoveredAt,
    recoveryMethod: "retry",
    ...over,
  });
  // The month began on 1 October 2026 (UTC).
  await db.insert(recoveredPayments).values([
    recovered("rp_usd", "fp_1", "acct_north", 5000, "usd", at(2 * DAY), {
      attributionKind: "foxhound_retry",
    }),
    recovered("rp_eur", "fp_2", "acct_lumen", 3000, "eur", at(3 * DAY), {
      attributionKind: "email_engaged",
    }),
    recovered("rp_usd2", "fp_6", "acct_north", 2500, "usd", at(4 * DAY), {
      attributionKind: "card_update",
    }),
    // Stripe recovered it on its own: not Foxhound's, so not counted, as on /billing.
    recovered("rp_baseline", "fp_7", "acct_north", 6666, "usd", at(1 * DAY)),
    recovered("rp_last_month", "fp_3", "acct_north", 9999, "usd", at(20 * DAY)),
    recovered("rp_deleted", "fp_4", "acct_north", 7777, "usd", at(1 * DAY), {
      deletedAt: at((1 * DAY) / 2),
    }),
    recovered("rp_demo", "fp_5", "demo_acct", 8888, "usd", at(1 * DAY)),
  ]);

  return db;
}

describe("the Overview's figures come from Foxhound's engine", () => {
  it("counts billing exempt merchants without the demo, and Stripe connections from the last seven days still connected", async () => {
    const overview = await adminOverview(await seed(), NOW);
    expect(overview.billingExemptCount).toBe(1);
    expect(overview.newConnectionsCount).toBe(1);
  });

  it("counts open disputes by Foxhound's state, and lists those a week old with no response, soonest deadline first", async () => {
    const overview = await adminOverview(await seed(), NOW);
    // d_stale_old, d_stale, d_stale_past, d_fresh, d_submitted are open; d_won is resolved.
    expect(overview.openDisputesCount).toBe(5);
    // Counted, not the length of the capped list, so a group past the cap still
    // says how many there are.
    expect(overview.staleDisputesCount).toBe(3);
    // Soonest evidence deadline first among those still answerable, then the
    // ones whose deadline has passed (or that have none), oldest first.
    expect(
      overview.attention.staleDisputes.map((d) => [
        d.id,
        d.merchantName,
        d.amountCents,
        d.currency,
      ]),
    ).toEqual([
      ["d_stale", "Lumen Studio", 4500, "eur"],
      ["d_stale_old", "Northwind Coffee", 12000, "usd"],
      ["d_stale_past", "Northwind Coffee", 12000, "usd"],
    ]);
  });

  it("lists fee invoices from the last 30 days that failed or will not be collected", async () => {
    const overview = await adminOverview(await seed(), NOW);
    expect(
      overview.attention.failedFeeInvoices.map((i) => [
        i.id,
        i.merchantName,
        i.status,
        i.chargeAttemptCount,
        i.failedAt.getTime(),
      ]),
    ).toEqual([
      ["inv_failed", "Northwind Coffee", "payment_failed", 2, NOW - DAY],
      ["inv_gave_up", "Lumen Studio", "gave_up", 4, NOW - 3 * DAY],
      ["inv_uncollectible", "Northwind Coffee", "uncollectible", 0, NOW - 5 * DAY],
    ]);
    expect(overview.failedFeeInvoicesCount).toBe(3);
  });

  it("sums what Foxhound recovered since the first of the month (attributed, as /billing) per currency", async () => {
    const overview = await adminOverview(await seed(), NOW);
    expect(overview.recoveredThisMonth.paymentCount).toBe(3);
    expect(
      [...overview.recoveredThisMonth.byCurrency].sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
    ).toEqual([
      { currency: "eur", cents: 3000 },
      { currency: "usd", cents: 7500 },
    ]);
  });
});
