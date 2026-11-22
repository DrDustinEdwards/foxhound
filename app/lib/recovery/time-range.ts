// The /recovery/payments "time" filter dropdown.

import { DAY_MS } from "~/lib/constants";

const PAYMENT_TIME_RANGES = ["all", "today", "7d", "30d", "90d"] as const;
export type PaymentTimeRange = (typeof PAYMENT_TIME_RANGES)[number];

/** Resolve a time-range selector into a detected_at >= cutoff, or null for
 *  "all" (no cutoff). "today" is the start of the current UTC day. */
export function resolvePaymentTimeRangeCutoff(
  range: PaymentTimeRange,
  nowMs: number,
): number | null {
  if (range === "all") return null;
  if (range === "today") {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return nowMs - days * DAY_MS;
}

export function isPaymentTimeRange(value: string): value is PaymentTimeRange {
  return (PAYMENT_TIME_RANGES as readonly string[]).includes(value);
}
