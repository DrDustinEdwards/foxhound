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

  it("an invoice gets three monthly retries, then the AGE cap stops it", () => {
    // Worth pinning precisely, because it is not what the caps look like on
    // paper. With runs 30 days apart and a 90-day age cap, run 4 is 91 days out
    // and the age branch fires BEFORE the attempt cap is ever reached. So the
    // effective limit is three retries via max_age_exceeded, not four via
    // max_attempts_reached. Both caps land in the same place (stop chasing after
    // about three months); the attempt cap is the one that binds only if runs
    // are closer together than monthly.
    let attemptCount = 0;
    const outcomes: string[] = [];
    for (let month = 0; month < 5; month++) {
      const decision = decideFeeRetryAction({
        invoiceStatus: "open",
        attemptCount,
        // Created just before the first sweep, then one run per month.
        invoiceCreatedMs: NOW - DAY_MS,
        nowMs: NOW + month * 30 * DAY_MS,
      });
      outcomes.push(decision.action === "pay" ? "pay" : decision.reason);
      if (decision.action === "pay") attemptCount++;
    }
    expect(outcomes).toEqual(["pay", "pay", "pay", "max_age_exceeded", "max_age_exceeded"]);
    expect(attemptCount).toBe(3);
    expect(attemptCount).toBeLessThan(FEE_INVOICE_MAX_RETRY_ATTEMPTS);
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
