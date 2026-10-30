import { describe, expect, it } from "vitest";

import { feeForCurrency, recoveryFeeCents } from "~/lib/billing/fees";

// Stripe refuses KWD/BHD/JOD/OMR/TND amounts that are not a multiple of 10, so
// a fee Stripe would refuse never reaches the ledger.
describe("feeForCurrency", () => {
  it("rounds three-decimal currencies to a multiple of 10 and leaves others alone", () => {
    expect(feeForCurrency(recoveryFeeCents(12_345), "kwd")).toBe(2_470); // 2,469 raw
    expect(feeForCurrency(2_465, "BHD")).toBe(2_470);
    expect(feeForCurrency(2_469, "usd")).toBe(2_469);
    expect(feeForCurrency(2_469, "jpy")).toBe(2_469);
  });
});
