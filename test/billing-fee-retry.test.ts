import { describe, expect, it } from "vitest";

import { decideFeeRetryAction } from "~/lib/billing/fee-retry";
import {
  FEE_INVOICE_MAX_RETRY_AGE_DAYS,
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
});
