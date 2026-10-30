import { describe, expect, it } from "vitest";

import { accounts, failedPayments } from "~/db/schema";
import { estimateCustomerLtvCents, getFailedPaymentDetail } from "~/lib/recovery/queries.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// S7 Phase 1 closing build, rulings 253, 255 and 256.
//
// 253's column guard: failed_payments.customer_ltv_cents holds a DIFFERENT
// value and must never be rendered under legacy's "est. LTV" label. The LTV is
// computed fresh, and legacy's own gate is two recovered payments, not one.
// The sanitized email preview is test/payments-parity-followups.test.ts.

describe("LTV computed fresh, under 253's column guard", () => {
  it("averages and multiplies by twelve", () => {
    expect(estimateCustomerLtvCents([1000, 2000])).toBe(18000);
    expect(estimateCustomerLtvCents([1000, 2000, 3000])).toBe(24000);
  });

  it("returns null below legacy's own two-payment gate", () => {
    // Legacy writes `allCustomerPayments.length >= 2` and passes null below it,
    // rendering no subtext at all. One sample is not an average.
    expect(estimateCustomerLtvCents([])).toBeNull();
    expect(estimateCustomerLtvCents([5000])).toBeNull();
  });
});

describe("previous failures, per 253's spec", () => {
  it("stays account-scoped: the same Stripe customer id on another account never appears", async () => {
    const { sqlite, db } = createInMemoryDb();
    runStatement(sqlite, db.insert(accounts).values([{ id: "acc_a", name: "A" }, { id: "acc_b", name: "B" }]));
    const payment = (id: string, accountId: string, day: number) => ({
      id,
      accountId,
      stripeEventId: `evt_${id}`,
      stripeInvoiceId: `in_${id}`,
      stripeCustomerId: "cus_shared",
      customerEmail: "x@example.com",
      amountCents: 4200,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: new Date(Date.UTC(2026, 9, day)),
    });
    runStatement(
      sqlite,
      db.insert(failedPayments).values([
        payment("fp_now", "acc_a", 10),
        payment("fp_before", "acc_a", 5),
        payment("fp_other_account", "acc_b", 8),
      ]),
    );

    const detail = await getFailedPaymentDetail(db, "acc_a", "fp_now");
    expect(detail?.previousFailures.map((p) => p.id)).toEqual(["fp_before"]);
  });
});
