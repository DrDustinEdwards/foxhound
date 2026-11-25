import type Stripe from "stripe";

import { asId } from "~/lib/stripe/ids";
import { stripeMs } from "~/lib/stripe/time";
import { churnReasonOf, type ChurnReason } from "./mrr";
import type { BillingInterval } from "./signals";
import type { ScheduleTerms } from "./subscription-terms";
import type { RawDiscount } from "./sync-stripe-cache.server";

// Cuts a Stripe subscription down to what the Intelligence sync reads.

export function priceInterval(price: Stripe.Price | null | undefined): BillingInterval {
  // The SDK types Stripe's enums as open, so equality does not narrow them: each known value is returned by name.
  switch (price?.recurring?.interval) {
    case "day":
      return "day";
    case "week":
      return "week";
    case "year":
      return "year";
    default:
      return "month";
  }
}

interface NarrowSubscriptionItem {
  priceId: string;
  productId: string | null;
  unitAmountCents: number;
  quantity: number;
  interval: BillingInterval;
  intervalCount: number;
  discounts: RawDiscount[];
}

/** A subscription cut down to what the sync reads, as each page arrives, so expanded subscriptions are
 *  never held whole (the Worker's 128 MB). */
interface NarrowSubscription {
  status: Stripe.Subscription.Status;
  createdMs: number;
  currency: string;
  churnReason: ChurnReason;
  cancelAtMs: number | null;
  items: NarrowSubscriptionItem[];
  discounts: RawDiscount[];
  schedule: ScheduleTerms | null;
}

function narrowDiscounts(
  discounts: readonly (string | Stripe.Discount)[] | null | undefined,
): RawDiscount[] {
  const out: RawDiscount[] = [];
  for (const d of discounts ?? []) {
    if (typeof d === "string") continue;
    const coupon = d.source?.coupon;
    if (!coupon) continue;
    out.push({
      couponId: typeof coupon === "string" ? coupon : coupon.id,
      embedded: typeof coupon === "string" ? null : coupon,
      endMs: stripeMs(d.end),
    });
  }
  return out;
}

/** A schedule phase's billing terms as one comparable key (see subscription-terms.ts nextScheduledChange). */
function phaseBillingKey(phase: Stripe.SubscriptionSchedule.Phase): string {
  const items = phase.items.map((i) => `${asId(i.price) ?? ""}x${i.quantity ?? 1}`).sort();
  const discounts = phase.discounts
    .map((d) => asId(d.coupon) || asId(d.discount) || asId(d.promotion_code) || "")
    .sort();
  return `${items.join(",")}|${discounts.join(",")}`;
}

function narrowSchedule(schedule: Stripe.Subscription["schedule"]): ScheduleTerms | null {
  if (!schedule || typeof schedule === "string") return null;
  return {
    status: schedule.status,
    endBehavior: schedule.end_behavior,
    phases: schedule.phases.map((p) => ({
      startMs: stripeMs(p.start_date),
      endMs: stripeMs(p.end_date),
      billingKey: phaseBillingKey(p),
    })),
  };
}

export function narrowSubscriptionForSync(sub: Stripe.Subscription): NarrowSubscription {
  return {
    status: sub.status,
    createdMs: stripeMs(sub.created),
    currency: sub.currency,
    churnReason: sub.status === "canceled" ? churnReasonOf(sub.cancellation_details?.reason) : null,
    cancelAtMs: stripeMs(sub.cancel_at),
    items: sub.items.data.map((item) => ({
      priceId: item.price.id,
      productId: asId(item.price.product) || null,
      unitAmountCents: item.price.unit_amount ?? 0,
      quantity: item.quantity ?? 1,
      interval: priceInterval(item.price),
      intervalCount: Math.max(1, item.price.recurring?.interval_count ?? 1),
      discounts: narrowDiscounts(item.discounts),
    })),
    discounts: narrowDiscounts(sub.discounts),
    schedule: narrowSchedule(sub.schedule),
  };
}
