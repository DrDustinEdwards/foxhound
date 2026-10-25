import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db";
import {
  buildPaymentParams,
  type PaymentFilterState,
} from "~/lib/recovery/payment-filters";
import { listExecutedEmailSteps } from "~/lib/recovery/dashboard-queries.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

const BOUNDS = { minCents: 0, maxCents: 100_000 };

function filters(overrides: Partial<PaymentFilterState> = {}): PaymentFilterState {
  return {
    search: "",
    status: "",
    declineCategory: "",
    time: "all",
    sort: "newest",
    pageSize: 50,
    amountMinCents: BOUNDS.minCents,
    amountMaxCents: BOUNDS.maxCents,
    ...overrides,
  };
}

const build = (f: PaymentFilterState, overrides?: Record<string, string>) =>
  buildPaymentParams(f, { bounds: BOUNDS, defaultPageSize: 50, overrides });

describe("buildPaymentParams carries the amount range", () => {

  it("keeps the range across a status-pill override", () => {
    const params = build(filters({ amountMinCents: 5_000, amountMaxCents: 40_000 }), {
      status: "active",
    });
    expect(params.get("status")).toBe("active");
    expect(params.get("amountMin")).toBe("5000");
    expect(params.get("amountMax")).toBe("40000");
  });

  // A handle resting on its own bound is not a filter; emitting it would put a
  // redundant full-width range on every link.
  it("omits a bound that does not narrow anything", () => {
    const params = build(filters());
    expect(params.has("amountMin")).toBe(false);
    expect(params.has("amountMax")).toBe(false);
    expect(params.toString()).toBe("");
  });

  it("still round-trips the other dimensions", () => {
    const params = build(
      filters({ search: "acme", declineCategory: "soft", time: "30d", sort: "amount_desc", pageSize: 25 }),
    );
    expect(params.get("q")).toBe("acme");
    expect(params.get("category")).toBe("soft");
    expect(params.get("time")).toBe("30d");
    expect(params.get("sort")).toBe("amount_desc");
    expect(params.get("perPage")).toBe("25");
  });

  it("clears a param when an override is empty", () => {
    const params = build(filters({ status: "active" }), { status: "" });
    expect(params.has("status")).toBe(false);
  });
});

describe("listExecutedEmailSteps counts sends whose result is not yet recorded", () => {
  // `result != 'cancelled'` evaluates to NULL for a row whose result IS NULL,
  // and a WHERE clause treats NULL as false, so those rows were silently
  // dropped. An executed send with no result yet is a real send and must count.
  async function seed() {
    const { db } = createInMemoryDb();
    const now = new Date();
    await db.insert(accounts).values({ id: "acct_1", name: "Test", createdAt: now });
    await db.insert(failedPayments).values({
      id: "fp_1",
      accountId: "acct_1",
      stripeEventId: "evt_1",
      stripeInvoiceId: "in_1",
      stripeCustomerId: "cus_1",
      customerEmail: "a@example.com",
      amountCents: 1000,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: now,
      isRenewalNoise: false,
    });
    const step = (id: string, result: string | null) => ({
      id,
      accountId: "acct_1",
      failedPaymentId: "fp_1",
      stepType: "email_day1",
      stepNumber: 1,
      scheduledAt: now,
      executedAt: now,
      result,
    });
    await db.insert(recoverySteps).values([
      step("st_null", null),
      step("st_sent", "email_sent"),
      step("st_cancelled", "cancelled"),
    ]);
    return db;
  }

  it("includes the null-result step and still excludes the canceled one", async () => {
    const db = await seed();
    const rows = await listExecutedEmailSteps(db, "acct_1");
    expect(rows).toHaveLength(2);
  });
});
