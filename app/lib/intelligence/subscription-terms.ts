// Pure subscription-terms math for the Intelligence sync (sync.server.ts):
// what a subscription item actually bills per period once its coupons are
// applied, and what a subscription schedule or cancel_at says will happen
// next. Takes normalized shapes, never raw Stripe objects, so it is testable
// without a connected account.

type CouponDuration = "once" | "repeating" | "forever";

/** A coupon's terms in the subscription's currency. */
export interface CouponTerms {
  percentOff: number | null;
  /** amount_off in the subscription's currency (the coupon's own currency or
   *  its currency_options entry); null when the coupon has no amount there. */
  amountOffCents: number | null;
  duration: CouponDuration;
  /** applies_to.products; null means every product. */
  appliesToProducts: string[] | null;
}

/** One discount attached to a subscription or a subscription item. */
export interface DiscountTerms {
  coupon: CouponTerms;
  /** discount.end in ms: when a repeating discount stops; null otherwise. */
  endMs: number | null;
}

export interface ItemTerms {
  productId: string | null;
  unitAmountCents: number;
  quantity: number;
  /** Discounts set on this item. */
  discounts: DiscountTerms[];
}

/**
 * Whether a discount still lowers the recurring charge. A `once` coupon takes
 * one invoice down and never recurs, so it is not part of monthly recurring
 * revenue; a `repeating` one counts until its end; `forever` always counts.
 */
function recurs(discount: DiscountTerms, nowMs: number): boolean {
  if (discount.coupon.duration === "once") return false;
  if (discount.coupon.duration === "repeating") return discount.endMs === null || discount.endMs > nowMs;
  return true;
}

function appliesTo(coupon: CouponTerms, productId: string | null): boolean {
  if (!coupon.appliesToProducts) return true;
  return productId !== null && coupon.appliesToProducts.includes(productId);
}

/**
 * Each item's charge per billing period after its recurring discounts, in the
 * order given. Item discounts apply to their item first; then each
 * subscription discount applies across the items its coupon covers: a percent
 * off each, an amount off the covered items' total, shared in proportion and
 * never below zero, as Stripe applies them on the invoice.
 */
export function discountedItemCents(
  items: readonly ItemTerms[],
  subscriptionDiscounts: readonly DiscountTerms[],
  nowMs: number,
): number[] {
  const cents = items.map((item) => {
    let amount = item.unitAmountCents * item.quantity;
    for (const d of item.discounts) {
      if (!recurs(d, nowMs) || !appliesTo(d.coupon, item.productId)) continue;
      if (d.coupon.percentOff !== null) amount *= 1 - d.coupon.percentOff / 100;
      else if (d.coupon.amountOffCents !== null) amount -= d.coupon.amountOffCents;
      amount = Math.max(0, amount);
    }
    return amount;
  });

  for (const d of subscriptionDiscounts) {
    if (!recurs(d, nowMs)) continue;
    const covered = items.map((item, i) => (appliesTo(d.coupon, item.productId) ? i : -1)).filter((i) => i >= 0);
    if (d.coupon.percentOff !== null) {
      for (const i of covered) cents[i] *= 1 - d.coupon.percentOff / 100;
    } else if (d.coupon.amountOffCents !== null) {
      const total = covered.reduce((sum, i) => sum + cents[i], 0);
      if (total <= 0) continue;
      const kept = Math.max(0, total - d.coupon.amountOffCents) / total;
      for (const i of covered) cents[i] *= kept;
    }
  }
  return cents;
}

type ScheduledChangeKind = "change" | "cancel";

export interface ScheduledChange {
  kind: ScheduledChangeKind;
  atMs: number;
}

/** One schedule phase as the comparison reads it. */
interface SchedulePhaseTerms {
  startMs: number;
  endMs: number;
  /** A stable key of what the phase bills: its items' prices and quantities
   *  and its discounts. Two phases with the same key bill the same. */
  billingKey: string;
}

export interface ScheduleTerms {
  status: string;
  endBehavior: string;
  phases: SchedulePhaseTerms[];
}

/**
 * What a schedule will next do to the subscription after `nowMs`: the first
 * upcoming phase that bills differently from the phase before it is a
 * change on its start date; failing that, a schedule that ends by canceling
 * cancels on its last phase's end. A phase that only renews the same terms
 * is not a change. Null when nothing is scheduled.
 */
export function nextScheduledChange(schedule: ScheduleTerms, nowMs: number): ScheduledChange | null {
  if (schedule.status !== "active" && schedule.status !== "not_started") return null;
  const phases = [...schedule.phases].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (phase.startMs <= nowMs) continue;
    const before = phases[i - 1];
    if (!before || before.billingKey !== phase.billingKey) return { kind: "change", atMs: phase.startMs };
  }
  const last = phases[phases.length - 1];
  if (schedule.endBehavior === "cancel" && last && last.endMs > nowMs) return { kind: "cancel", atMs: last.endMs };
  return null;
}

/** The earliest of several scheduled events; null when there are none. */
export function earliestScheduledChange(changes: readonly (ScheduledChange | null)[]): ScheduledChange | null {
  let first: ScheduledChange | null = null;
  for (const c of changes) if (c && (!first || c.atMs < first.atMs)) first = c;
  return first;
}
