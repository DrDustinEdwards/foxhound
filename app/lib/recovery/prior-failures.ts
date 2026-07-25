// The "repeat failure" indicator's arithmetic, kept pure and separate from the
// query so it can be tested and so both call sites (the payments list and the
// dashboard preview) cannot drift apart again.

/**
 * How many OTHER failed payments a customer has, given their total.
 *
 * The row being rendered is itself one of the totals, so it is subtracted. A
 * customer whose only failure is the row on screen has zero prior failures,
 * and the indicator stays hidden. Clamped at zero so a totals map that is
 * missing or stale can never render a negative count.
 */
export function priorFailureCount(totalForCustomer: number | undefined): number {
  return Math.max(0, (totalForCustomer ?? 0) - 1);
}
