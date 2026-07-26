import { describe, expect, it } from "vitest";

import { billingStatusForSettledStripeStatus, decideFeeRetryAction } from "~/lib/billing/fee-retry";
import {
  FEE_INVOICE_MAX_RETRY_AGE_DAYS,
  FEE_INVOICE_MAX_RETRY_ATTEMPTS,
} from "~/lib/constants";

// The scenarios legacy's dispute-fee retry machine pinned (parity ruling 11),
// ported to Foxhound's monthly cadence. Legacy had no test file of its own for
// decideFeeRetryAction, so these are derived from its branch order in
// lib/dispute-fees.ts plus the behaviors process-recovery-billing.test.ts
// depended on it for.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-01T04:00:00.000Z").getTime();
const daysAgo = (n: number) => NOW - n * DAY_MS;

const base = { attemptCount: 0, invoiceCreatedMs: daysAgo(31), nowMs: NOW };

describe("decideFeeRetryAction: terminal Stripe statuses win over the caps", () => {
  it("paid -> sync_paid", () => {
    expect(decideFeeRetryAction({ ...base, invoiceStatus: "paid" })).toEqual({
      action: "sync_paid",
      reason: "stripe_status_paid",
    });
  });

  it("void and uncollectible -> give_up, each naming its own status", () => {
    expect(decideFeeRetryAction({ ...base, invoiceStatus: "void" })).toEqual({
      action: "give_up",
      reason: "stripe_status_void",
    });
    expect(decideFeeRetryAction({ ...base, invoiceStatus: "uncollectible" })).toEqual({
      action: "give_up",
      reason: "stripe_status_uncollectible",
    });
  });

  it("reports the real reason when a terminal invoice is ALSO over both caps", () => {
    // Branch order: a voided invoice is dead because it was voided, not because
    // it aged out. Getting this backwards would misattribute every give_up.
    const decision = decideFeeRetryAction({
      invoiceStatus: "void",
      attemptCount: 99,
      invoiceCreatedMs: daysAgo(400),
      nowMs: NOW,
    });
    expect(decision.reason).toBe("stripe_status_void");
  });
});

describe("decideFeeRetryAction: the caps", () => {
  it("retries an open invoice inside both caps", () => {
    expect(decideFeeRetryAction({ ...base, invoiceStatus: "open" })).toEqual({
      action: "pay",
      reason: "retry",
    });
  });

  it("gives up past the age cap", () => {
    expect(
      decideFeeRetryAction({
        ...base,
        invoiceStatus: "open",
        invoiceCreatedMs: daysAgo(FEE_INVOICE_MAX_RETRY_AGE_DAYS + 1),
      }),
    ).toEqual({ action: "give_up", reason: "max_age_exceeded" });
  });

  it("gives up at the attempt cap, and not one attempt earlier", () => {
    const atCap = decideFeeRetryAction({
      ...base,
      invoiceStatus: "open",
      attemptCount: FEE_INVOICE_MAX_RETRY_ATTEMPTS,
    });
    expect(atCap).toEqual({ action: "give_up", reason: "max_attempts_reached" });

    const belowCap = decideFeeRetryAction({
      ...base,
      invoiceStatus: "open",
      attemptCount: FEE_INVOICE_MAX_RETRY_ATTEMPTS - 1,
    });
    expect(belowCap.action).toBe("pay");
  });

  it("age is checked before attempts", () => {
    expect(
      decideFeeRetryAction({
        invoiceStatus: "open",
        attemptCount: FEE_INVOICE_MAX_RETRY_ATTEMPTS,
        invoiceCreatedMs: daysAgo(FEE_INVOICE_MAX_RETRY_AGE_DAYS + 1),
        nowMs: NOW,
      }).reason,
    ).toBe("max_age_exceeded");
  });

  it("honors explicit overrides, so the caps stay injectable for tests", () => {
    expect(
      decideFeeRetryAction({ ...base, invoiceStatus: "open", maxAgeDays: 30 }).reason,
    ).toBe("max_age_exceeded");
    expect(
      decideFeeRetryAction({ ...base, invoiceStatus: "open", attemptCount: 1, maxAttempts: 1 }).reason,
    ).toBe("max_attempts_reached");
  });
});

describe("the caps are re-derived for a MONTHLY sweep, not copied from legacy", () => {
  it("a first retry one month after the invoice is still inside the age cap", () => {
    // Legacy's 14-day cap came from an HOURLY cron. Transcribing it would have
    // made this give_up, so the 'pay' branch would be unreachable for every
    // invoice Foxhound ever sweeps and the port would collect nothing.
    expect(FEE_INVOICE_MAX_RETRY_AGE_DAYS).toBeGreaterThan(31);
    expect(decideFeeRetryAction({ ...base, invoiceStatus: "open" }).action).toBe("pay");
  });

  /** Walk the REAL cron cadence (`0 4 1 * *`) from the run that wrote the
   *  invoice. The sweep runs at the START of runMonthlyBilling, so the first
   *  sweep that can see an invoice is the following month's run, never the one
   *  that created it. Returns one entry per run. */
  function walkMonthlyRuns(createdYear: number, createdMonth: number, runs: number): string[] {
    const createdMs = Date.UTC(createdYear, createdMonth, 1, 4, 0, 0);
    let attemptCount = 0;
    const outcomes: string[] = [];
    for (let run = 1; run <= runs; run++) {
      const decision = decideFeeRetryAction({
        invoiceStatus: "open",
        attemptCount,
        invoiceCreatedMs: createdMs,
        nowMs: Date.UTC(createdYear, createdMonth + run, 1, 4, 0, 0),
      });
      outcomes.push(decision.action === "pay" ? "pay" : decision.reason);
      if (decision.action === "pay") attemptCount++;
    }
    return outcomes;
  }

  it("stops on the AGE cap after two or three runs, depending on month lengths", () => {
    // The exact count is calendar-dependent, and pinning a single number is how
    // this went wrong twice: the original note said three (from a fixture with
    // the invoice created one day before the first sweep, which cannot happen),
    // and the review said two (from real August dates). Both are right for their
    // month. Review LOW-1.
    //
    // Created Aug 1: sweeps at 31, 61, 92 days. 92 > 90, so TWO pays.
    expect(walkMonthlyRuns(2026, 7, 4)).toEqual([
      "pay",
      "pay",
      "max_age_exceeded",
      "max_age_exceeded",
    ]);

    // Created Feb 1, where three short months fit inside 90: 28, 59, 89, 120.
    // 89 is still under the cap, so THREE pays.
    expect(walkMonthlyRuns(2027, 1, 4)).toEqual([
      "pay",
      "pay",
      "pay",
      "max_age_exceeded",
    ]);
  });

  it("never reaches the attempt ceiling at a monthly cadence, whatever the month", () => {
    // This is the durable property, and the reason the age cap is the one that
    // actually governs: 4 attempts are unreachable when runs are a month apart.
    for (let month = 0; month < 12; month++) {
      const outcomes = walkMonthlyRuns(2026, month, 6);
      const pays = outcomes.filter((o) => o === "pay").length;
      expect(pays).toBeLessThan(FEE_INVOICE_MAX_RETRY_ATTEMPTS);
      expect(outcomes).toContain("max_age_exceeded");
      expect(outcomes).not.toContain("max_attempts_reached");
    }
  });

  it("the attempt cap binds instead when runs are closer together", () => {
    let attemptCount = 0;
    const outcomes: string[] = [];
    for (let week = 0; week < 6; week++) {
      const decision = decideFeeRetryAction({
        invoiceStatus: "open",
        attemptCount,
        invoiceCreatedMs: NOW - DAY_MS,
        nowMs: NOW + week * 7 * DAY_MS,
      });
      outcomes.push(decision.action === "pay" ? "pay" : decision.reason);
      if (decision.action === "pay") attemptCount++;
    }
    expect(outcomes).toEqual([
      "pay",
      "pay",
      "pay",
      "pay",
      "max_attempts_reached",
      "max_attempts_reached",
    ]);
    expect(attemptCount).toBe(FEE_INVOICE_MAX_RETRY_ATTEMPTS);
  });

  it("an unrecognized status falls through to pay rather than failing closed", () => {
    // 'pay' against an already-settled Stripe invoice is a no-op at Stripe;
    // failing closed would strand the invoice this machine exists to rescue.
    expect(decideFeeRetryAction({ ...base, invoiceStatus: "some_future_status" }).action).toBe("pay");
  });
});

describe("billingStatusForSettledStripeStatus", () => {
  it("maps only settled Stripe statuses", () => {
    expect(billingStatusForSettledStripeStatus("paid")).toBe("paid");
    expect(billingStatusForSettledStripeStatus("void")).toBe("void");
    expect(billingStatusForSettledStripeStatus("uncollectible")).toBe("uncollectible");
    expect(billingStatusForSettledStripeStatus("open")).toBeNull();
    expect(billingStatusForSettledStripeStatus("draft")).toBeNull();
  });
});
