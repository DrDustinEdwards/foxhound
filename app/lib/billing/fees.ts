import { DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS, RECOVERY_FEE_BPS } from "~/lib/constants";

// The ONE place fee amounts are computed (PRICING.md: 20% of attributed
// recoveries; 20% of won disputes capped at $500-equivalent). Pure functions,
// minor units in and out, always in the fee's own currency. The billing run and
// any UI preview both call these; the math is never re-derived inline.

const BPS_DIVISOR = 10_000;

/** Recovery fee: 20% of the recovered amount, rounded to the nearest minor unit. */
export function recoveryFeeCents(recoveredAmountCents: number): number {
  return Math.round((recoveredAmountCents * RECOVERY_FEE_BPS) / BPS_DIVISOR);
}

/**
 * Dispute fee: 20% of the won dispute amount, capped at DISPUTE_FEE_CAP_CENTS.
 * The cap is applied in the dispute's own currency minor units. True per-currency
 * FX-equivalent caps ("$500-equivalent") await an FX layer; until then a non-USD
 * dispute is capped at 50000 of its own minor units (flagged for Dustin).
 */
export function disputeFeeCents(disputedAmountCents: number): number {
  const raw = Math.round((disputedAmountCents * DISPUTE_FEE_BPS) / BPS_DIVISOR);
  return Math.min(raw, DISPUTE_FEE_CAP_CENTS);
}
