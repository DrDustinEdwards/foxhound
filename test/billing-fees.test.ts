import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import { getBillableDisputes, getBillableRecoveries } from "~/db/billable";
import * as schema from "~/db/schema";
import { disputeFeeCents, recoveryFeeCents } from "~/lib/billing/fees";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";

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

  it("caps at DISPUTE_FEE_CAP_CENTS above the threshold", () => {
    expect(disputeFeeCents(200_000)).toBe(DISPUTE_FEE_CAP_CENTS); // 40000 -> 25000
    expect(disputeFeeCents(1_000_000)).toBe(DISPUTE_FEE_CAP_CENTS);
  });

  it("hits the cap exactly at 5x the cap amount", () => {
    expect(disputeFeeCents(DISPUTE_FEE_CAP_CENTS * 5)).toBe(DISPUTE_FEE_CAP_CENTS);
  });
});

describe("billable recovery predicate (SQL shape)", () => {
  const { sql, params } = getBillableRecoveries(db, "acc_1", asOf).toSQL();

  it("excludes baseline, filters maturity + refund/dispute/deleted", () => {
    expect(sql).toMatch(/attribution_kind.*<>|<>.*attribution_kind/i);
    expect(sql).toMatch(/recovered_at.*<=/i);
    expect(sql).toMatch(/refunded_at.*is null/i);
    expect(sql).toMatch(/disputed_at.*is null/i);
    expect(sql).toMatch(/deleted_at.*is null/i);
    expect(params).toContain("stripe_baseline");
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
});
