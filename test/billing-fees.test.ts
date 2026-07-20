import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import { getBillableDisputes, getBillableRecoveries } from "~/db/billable";
import * as schema from "~/db/schema";
import { disputeFeeCents, recoveryFeeCents } from "~/lib/billing/fees";
import { BILLABLE_ATTRIBUTION_KINDS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";

const db = drizzle({} as never, { schema });
const asOf = new Date("2026-07-01T00:00:00.000Z").getTime();

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
    expect(disputeFeeCents(100_000)).toBe(20_000);
  });

  it("the cap binds only above roughly $2,500 disputed (PRICING.md rev 3): 20% governs below it", () => {
    // $2,000 disputed: 20% = $400, well under the $500 cap.
    expect(disputeFeeCents(200_000)).toBe(40_000);
    // $2,500 disputed: 20% = $500, exactly the cap boundary.
    expect(disputeFeeCents(250_000)).toBe(50_000);
  });

  it("caps at DISPUTE_FEE_CAP_CENTS above the threshold", () => {
    expect(disputeFeeCents(1_000_000)).toBe(DISPUTE_FEE_CAP_CENTS); // 200000 -> 50000
    expect(disputeFeeCents(10_000_000)).toBe(DISPUTE_FEE_CAP_CENTS);
  });

  it("hits the cap exactly at 5x the cap amount", () => {
    expect(disputeFeeCents(DISPUTE_FEE_CAP_CENTS * 5)).toBe(DISPUTE_FEE_CAP_CENTS);
  });
});

describe("billable recovery predicate (SQL shape)", () => {
  const { sql, params } = getBillableRecoveries(db, "acc_1", asOf).toSQL();

  it("excludes baseline via an explicit allow-list of billable kinds, filters maturity + refund/dispute/deleted", () => {
    // Phase 5 review LOW/INFO fix (2026-07-19): this used to be a deny-list
    // (attribution_kind <> 'stripe_baseline'), consolidated to the same
    // allow-list app/lib/recovery/attribution.ts's isBillableAttribution
    // uses, so a future fifth attribution kind cannot become billable by
    // default. Same practical set today: exactly the three non-baseline kinds.
    expect(sql).toMatch(/attribution_kind.*in/i);
    expect(sql).toMatch(/recovered_at.*<=/i);
    expect(sql).toMatch(/refunded_at.*is null/i);
    expect(sql).toMatch(/disputed_at.*is null/i);
    expect(sql).toMatch(/deleted_at.*is null/i);
    for (const kind of BILLABLE_ATTRIBUTION_KINDS) {
      expect(params).toContain(kind);
    }
    expect(params).not.toContain("stripe_baseline");
    expect(params).toContain("acc_1");
  });

  it("gates on account eligibility and not-previously-billed", () => {
    expect(sql).toMatch(/billing_exempt/i);
    expect(sql).toMatch(/processing_paused/i);
    expect(sql).toMatch(/not like/i);
    expect(sql).toMatch(/left join .*billing_line_items/i);
    expect(params).toContain("demo_%");
  });
});

describe("billable dispute predicate (SQL shape)", () => {
  const { sql, params } = getBillableDisputes(db, "acc_1", asOf).toSQL();

  it("only resolved_won, resolved by asOf, not previously billed, account-eligible", () => {
    expect(sql).toMatch(/state.*=/i);
    expect(sql).toMatch(/resolved_at.*<=/i);
    expect(sql).toMatch(/left join .*billing_line_items/i);
    expect(sql).toMatch(/billing_exempt/i);
    expect(params).toContain("resolved_won");
    expect(params).toContain("acc_1");
  });

  it("requires a Foxhound submission: inner-joins dispute_approvals AND requires submitted_at (review HIGH)", () => {
    // PRICING rev 3: billable only if Foxhound drafted AND submitted. Both
    // signals are structural in the predicate, so a merchant-fought win (no
    // approval row, no submitted_at) can never be selected. Behavior proven in
    // test/billing-dispute-submission-gate.test.ts against a real DB.
    expect(sql).toMatch(/inner join .*dispute_approvals/i);
    expect(sql).toMatch(/submitted_at.*is not null/i);
  });
});
