import { describe, expect, it } from "vitest";

import {
  discountedItemCents,
  nextScheduledChange,
  type CouponTerms,
  type DiscountTerms,
} from "~/lib/intelligence/subscription-terms";

// MRR has to be what the customer pays (coupons applied), and a planned
// schedule change has to be read the way Stripe will apply it.

const NOW = Date.UTC(2026, 9, 29);
const DAY = 86_400_000;

function coupon(over: Partial<CouponTerms>): CouponTerms {
  return { percentOff: null, amountOffCents: null, duration: "forever", appliesToProducts: null, ...over };
}
const discount = (c: Partial<CouponTerms>, endMs: number | null = null): DiscountTerms => ({ coupon: coupon(c), endMs });

describe("discountedItemCents", () => {
  const base = { productId: "prod_base", unitAmountCents: 10000, quantity: 1, discounts: [] };
  const addon = { productId: "prod_addon", unitAmountCents: 5000, quantity: 2, discounts: [] };

  it("applies recurring percent and amount discounts and leaves out ones that no longer recur", () => {
    expect(discountedItemCents([base], [discount({ percentOff: 25 })], NOW)).toEqual([7500]);
    expect(discountedItemCents([base], [discount({ amountOffCents: 2000 })], NOW)).toEqual([8000]);
    // A once coupon took one invoice down; it is not recurring revenue.
    expect(discountedItemCents([base], [discount({ percentOff: 50, duration: "once" })], NOW)).toEqual([10000]);
    // A repeating coupon counts until its end, not after.
    const repeating = { percentOff: 50, duration: "repeating" as const };
    expect(discountedItemCents([base], [discount(repeating, NOW + DAY)], NOW)).toEqual([5000]);
    expect(discountedItemCents([base], [discount(repeating, NOW - DAY)], NOW)).toEqual([10000]);
  });

  it("stacks item then subscription discounts, honors applies_to and never goes below zero", () => {
    const itemDiscounted = { ...base, discounts: [discount({ percentOff: 10 })] };
    // Item: 10000 -> 9000. Subscription amount off 3000 across 9000 + 10000,
    // shared in proportion.
    const [a, b] = discountedItemCents([itemDiscounted, addon], [discount({ amountOffCents: 3000 })], NOW);
    expect(a + b).toBeCloseTo(16000);
    expect(a).toBeCloseTo(9000 * (16000 / 19000));
    // A coupon restricted to the add-on leaves the base alone.
    expect(
      discountedItemCents([base, addon], [discount({ percentOff: 50, appliesToProducts: ["prod_addon"] })], NOW),
    ).toEqual([10000, 5000]);
    expect(discountedItemCents([base], [discount({ amountOffCents: 99999 })], NOW)).toEqual([0]);
  });
});

describe("nextScheduledChange", () => {
  const phase = (startDays: number, endDays: number, billingKey: string) => ({
    startMs: NOW + startDays * DAY,
    endMs: NOW + endDays * DAY,
    billingKey,
  });

  it("reports the first upcoming phase that bills differently, skipping same-terms renewals", () => {
    const schedule = {
      status: "active",
      endBehavior: "release",
      phases: [phase(-30, 10, "price_a"), phase(10, 40, "price_a"), phase(40, 70, "price_b")],
    };
    expect(nextScheduledChange(schedule, NOW)).toEqual({ kind: "change", atMs: NOW + 40 * DAY });
  });

  it("reports a cancellation at the last phase's end when the schedule ends by canceling", () => {
    const schedule = { status: "active", endBehavior: "cancel", phases: [phase(-30, 12, "price_a")] };
    expect(nextScheduledChange(schedule, NOW)).toEqual({ kind: "cancel", atMs: NOW + 12 * DAY });
    expect(nextScheduledChange({ ...schedule, endBehavior: "release" }, NOW)).toBeNull();
    expect(nextScheduledChange({ ...schedule, status: "released" }, NOW)).toBeNull();
  });
});
