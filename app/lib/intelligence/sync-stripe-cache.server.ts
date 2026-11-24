import type Stripe from "stripe";

import type { CouponTerms, DiscountTerms } from "./subscription-terms";

/** A subscription or item discount as read off Stripe: its coupon and when a repeating one ends. */
export interface RawDiscount {
  couponId: string;
  embedded: Stripe.Coupon | null;
  endMs: number | null;
}

/** Products and prices read once per sync run and shared across customers. Stripe expands at most four
 *  levels and a list's `data` counts as one, so a price's product (data.items.data.price.product) and an
 *  invoice line's price cannot be expanded in the list call. */
export type ObjectCache<T> = Map<string, Promise<T | null>>;
export interface StripeObjectCaches {
  coupons: ObjectCache<Stripe.Coupon>;
  products: ObjectCache<Stripe.Product>;
  prices: ObjectCache<Stripe.Price>;
}

export function cached<T>(
  cache: ObjectCache<T>,
  id: string,
  read: () => Promise<T>,
): Promise<T | null> {
  let pending = cache.get(id);
  if (!pending) {
    pending = read().catch(() => null);
    cache.set(id, pending);
  }
  return pending;
}

/** Coupons read once per sync run and shared across customers. Retrieved with applies_to and
 *  currency_options (Stripe includes them only on request). A coupon that cannot be retrieved (a deleted
 *  coupon still discounts its subscriptions) falls back to the embedded object. */
function couponTermsIn(coupon: Stripe.Coupon, currency: string): CouponTerms {
  const amountOffCents =
    coupon.amount_off === null
      ? null
      : coupon.currency === currency
        ? coupon.amount_off
        : (coupon.currency_options?.[currency]?.amount_off ?? null);
  return {
    percentOff: coupon.percent_off,
    amountOffCents,
    // Anything but once or repeating counts as forever, as recurs() in subscription-terms.ts reads it.
    duration:
      coupon.duration === "once"
        ? "once"
        : coupon.duration === "repeating"
          ? "repeating"
          : "forever",
    appliesToProducts: coupon.applies_to?.products ?? null,
  };
}

export async function resolveDiscounts(
  stripe: Stripe,
  cache: ObjectCache<Stripe.Coupon>,
  discounts: readonly RawDiscount[],
  currency: string,
): Promise<DiscountTerms[]> {
  const out: DiscountTerms[] = [];
  for (const d of discounts) {
    const coupon =
      (await cached(cache, d.couponId, () =>
        stripe.coupons.retrieve(d.couponId, {
          expand: ["applies_to", "currency_options"],
        }),
      )) ?? d.embedded;
    if (coupon) out.push({ coupon: couponTermsIn(coupon, currency), endMs: d.endMs });
  }
  return out;
}
