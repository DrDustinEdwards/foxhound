import { describe, expect, it } from "vitest";

import { mergeAuditLiftBands } from "~/lib/audit/full-audit.server";

describe("mergeAuditLiftBands", () => {

  it("produces an honest zero, not an omission, for a currency only on one side", () => {
    const result = mergeAuditLiftBands(
      [{ currency: "usd", stripeBaselineRecoveredCents: 100, stillDyingCents: 200, failedInvoicesCount: 1, failedInvoicesCents: 300 }],
      [{ currency: "eur", cents: 500 }],
    );
    expect(result).toContainEqual({ currency: "usd", stripeBaselineRecoveredCents: 100, stillDyingCents: 200, foxhoundAddsCents: 0 });
    expect(result).toContainEqual({ currency: "eur", stripeBaselineRecoveredCents: 0, stillDyingCents: 0, foxhoundAddsCents: 500 });
  });
});
