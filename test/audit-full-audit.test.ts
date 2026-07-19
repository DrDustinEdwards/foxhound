import { describe, expect, it } from "vitest";

import { mergeAuditLiftBands } from "~/lib/audit/full-audit.server";

describe("mergeAuditLiftBands", () => {
  it("merges Stripe-side bands with Foxhound's attributed total by currency", () => {
    const result = mergeAuditLiftBands(
      [{ currency: "usd", stripeBaselineRecoveredCents: 2_940_00, stillDyingCents: 4_820_00, failedInvoicesCount: 6, failedInvoicesCents: 7_760_00 }],
      [{ currency: "usd", cents: 1_200_00 }],
    );
    expect(result).toEqual([
      { currency: "usd", stripeBaselineRecoveredCents: 2_940_00, stillDyingCents: 4_820_00, foxhoundAddsCents: 1_200_00 },
    ]);
  });

  it("produces an honest zero, not an omission, for a currency only on one side", () => {
    const result = mergeAuditLiftBands(
      [{ currency: "usd", stripeBaselineRecoveredCents: 100, stillDyingCents: 200, failedInvoicesCount: 1, failedInvoicesCents: 300 }],
      [{ currency: "eur", cents: 500 }],
    );
    expect(result).toContainEqual({ currency: "usd", stripeBaselineRecoveredCents: 100, stillDyingCents: 200, foxhoundAddsCents: 0 });
    expect(result).toContainEqual({ currency: "eur", stripeBaselineRecoveredCents: 0, stillDyingCents: 0, foxhoundAddsCents: 500 });
  });

  it("returns an empty array when there is nothing on either side", () => {
    expect(mergeAuditLiftBands([], [])).toEqual([]);
  });
});
