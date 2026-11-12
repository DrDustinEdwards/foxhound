// Stripe sends every time as Unix seconds (created, due_by, current_period_end...). These are the
// one conversion: a number that is not finite, or no number at all, is no time (null). Stripe never
// sends 0 for a time it has, so 0 is read as the epoch like any other number.

/** A Stripe time (Unix seconds) in epoch milliseconds, or null when there is none. */
export function stripeMs(seconds: number): number;
export function stripeMs(seconds: number | null | undefined): number | null;
export function stripeMs(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** A Stripe time (Unix seconds) as a Date, or null when there is none. */
export function stripeDate(seconds: number): Date;
export function stripeDate(seconds: number | null | undefined): Date | null;
export function stripeDate(seconds: number | null | undefined): Date | null {
  const ms = stripeMs(seconds);
  return ms === null ? null : new Date(ms);
}
