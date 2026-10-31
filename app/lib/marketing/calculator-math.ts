// The home page's recovery calculator's math (components/recovery-calculator.tsx), Recova's multipliers,
// shared with the calculator island (islands/calculator.ts) that runs it on a page that does not hydrate.
// No imports: the island is bundled on its own, and the constants come in as arguments.

export interface CalculatorInputs {
  mrr: number;
  /** The visitor's assumed share of MRR that fails, in percent. */
  failureShare: number;
  /** The visitor's assumed recovery of what Stripe could not get, in percent. */
  recoveryShare: number;
  stripeRecoveryRatePercent: number;
  recoveryFeeBps: number;
}

export function calculatorFigures({ mrr, failureShare, recoveryShare, stripeRecoveryRatePercent, recoveryFeeBps }: CalculatorInputs) {
  const failedRevenue = Math.round((mrr * failureShare) / 100); // the visitor's assumed share of MRR that fails
  const stripeRecovers = Math.round(failedRevenue * (stripeRecoveryRatePercent / 100));
  const remaining = failedRevenue - stripeRecovers; // what Stripe could not get
  const foxhoundRecovers = Math.round(remaining * (recoveryShare / 100));
  const foxhoundFee = Math.round((foxhoundRecovers * recoveryFeeBps) / 10_000); // the outcome fee
  const netGain = foxhoundRecovers - foxhoundFee; // net to merchant
  return { failedRevenue, stripeRecovers, remaining, foxhoundRecovers, foxhoundFee, netGain, netGainAnnual: netGain * 12 };
}

export function fmt(n: number): string {
  return "$" + n.toLocaleString();
}

/** Capsomer's Range fill: how far along its track the thumb is. */
export function rangeFill(value: number, min: number, max: number): string {
  return `${(max > min ? ((value - min) / (max - min)) * 100 : 0).toFixed(2)}%`;
}
