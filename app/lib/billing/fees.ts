import { DISPUTE_FEE_BPS, RECOVERY_FEE_BPS } from "~/lib/constants";
import { currencyExponent } from "@dustinedwards/site-runtime/money";

// The ONE place fee amounts are computed (PRICING.md: 20% of attributed
// recoveries; 20% of won disputes capped at $500-equivalent). Pure functions,
// minor units in and out, always in the fee's own currency. The billing run and
// any UI preview both call these; the math is never re-derived inline.

const BPS_DIVISOR = 10_000;

/**
 * What a recovery's fee is taken on: the recovered amount less what the
 * merchant has refunded of it, never below zero.
 */
export function unrefundedCents(amountCents: number, refundedCents: number): number {
  return Math.max(0, amountCents - refundedCents);
}

/**
 * Recovery fee: 20% of the recovered amount, rounded to the nearest minor unit.
 */
export function recoveryFeeCents(recoveredAmountCents: number): number {
  return Math.round((recoveredAmountCents * RECOVERY_FEE_BPS) / BPS_DIVISOR);
}

/**
 * Dispute fee: 20% of the won dispute amount, capped at `capMinorUnits`.
 *
 * The authoritative one is converted at resolution from a Stripe FX quote
 * (dispute-cap.ts) and frozen on the dispute row.
 */
export function disputeFeeCents(disputedAmountCents: number, capMinorUnits: number): number {
  const raw = Math.round((disputedAmountCents * DISPUTE_FEE_BPS) / BPS_DIVISOR);
  return Math.min(raw, capMinorUnits);
}

/**
 * A fee as Stripe will accept it in `currency`. Stripe requires amounts in the
 * three-decimal currencies (KWD, BHD, JOD, OMR, TND) to be a multiple of 10, so
 * a fee there is rounded to the nearest 10 before it is written to the ledger;
 * every other currency is unchanged.
 */
export function feeForCurrency(feeMinorUnits: number, currency: string): number {
  return currencyExponent(currency) === 3 ? Math.round(feeMinorUnits / 10) * 10 : feeMinorUnits;
}
