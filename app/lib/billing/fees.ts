import { DISPUTE_FEE_BPS, RECOVERY_FEE_BPS } from "~/lib/constants";

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
 * Dispute fee: 20% of the won dispute amount, capped at `capMinorUnits`.
 *
 * THE CAP IS A REQUIRED ARGUMENT WITH NO DEFAULT (PRICING.md rev 5 item 2,
 * ruling 377(7)). It used to be the constant, applied to whatever currency the
 * dispute was in, so a non-USD dispute was capped at 50,000 of its OWN minor
 * units: about $320 for a yen dispute and about $630 for a pence one, against a
 * page promising $500. A comment flagged that for Dustin; rev 5 decided it, and
 * the flag is gone with the defect.
 *
 * No default, because every caller now has to say WHICH cap it means, and the
 * two are different things. The authoritative one is converted at resolution
 * from a Stripe FX quote (dispute-cap.ts) and frozen on the dispute row. A
 * projection shown before resolution passes the USD cap and is a projection.
 * A default would have let a caller silently get the old behavior back.
 */
export function disputeFeeCents(disputedAmountCents: number, capMinorUnits: number): number {
  const raw = Math.round((disputedAmountCents * DISPUTE_FEE_BPS) / BPS_DIVISOR);
  return Math.min(raw, capMinorUnits);
}
