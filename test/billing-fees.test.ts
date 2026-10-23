import { describe, expect, it } from "vitest";

import { disputeFeeCents, recoveryFeeCents } from "~/lib/billing/fees";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";


describe("recovery fee math", () => {
  it("is 20% of the recovered amount", () => {
    expect(recoveryFeeCents(10_000)).toBe(2_000);
    expect(recoveryFeeCents(5_000)).toBe(1_000);
  });

  it("rounds to the nearest minor unit", () => {
    expect(recoveryFeeCents(999)).toBe(200); // 199.8 -> 200
    expect(recoveryFeeCents(101)).toBe(20); // 20.2 -> 20
  });

  it("is zero for a zero recovery", () => {
    expect(recoveryFeeCents(0)).toBe(0);
  });
});

describe("dispute fee math (capped)", () => {
  it("is 20% below the cap", () => {
    expect(disputeFeeCents(100_000, DISPUTE_FEE_CAP_CENTS)).toBe(20_000);
  });

  it("the cap binds only above roughly $2,500 disputed (PRICING.md rev 3): 20% governs below it", () => {
    // $2,000 disputed: 20% = $400, well under the $500 cap.
    expect(disputeFeeCents(200_000, DISPUTE_FEE_CAP_CENTS)).toBe(40_000);
    // $2,500 disputed: 20% = $500, exactly the cap boundary.
    expect(disputeFeeCents(250_000, DISPUTE_FEE_CAP_CENTS)).toBe(50_000);
  });

  it("caps at DISPUTE_FEE_CAP_CENTS above the threshold", () => {
    expect(disputeFeeCents(1_000_000, DISPUTE_FEE_CAP_CENTS)).toBe(DISPUTE_FEE_CAP_CENTS); // 200000 -> 50000
    expect(disputeFeeCents(10_000_000, DISPUTE_FEE_CAP_CENTS)).toBe(DISPUTE_FEE_CAP_CENTS);
  });

  it("hits the cap exactly at 5x the cap amount", () => {
    expect(disputeFeeCents(DISPUTE_FEE_CAP_CENTS * 5, DISPUTE_FEE_CAP_CENTS)).toBe(DISPUTE_FEE_CAP_CENTS);
  });
});
