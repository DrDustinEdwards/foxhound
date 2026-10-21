// Recova's compare() from app/audit/dashboard/page.tsx (blob 988c190a), which
// draws the "Since last run" rows on the audit history page.
//
// Ported as written: a move under 5% of a non-zero baseline is "no change",
// both zero is "no change", a zero baseline measures the move against the
// current figure, and the tone says whether the move is good for that metric.
//
// Two cases Recova never meets are refused rather than guessed. Recova reads
// every column with `?? 0`, so a figure that could not be read compared as a
// zero; Foxhound stores it as NULL (365 binding 2) and a comparison with it
// would be a claim about a number nobody read. And two runs can be in
// different currencies (or one with no stored currency), where a percentage
// between the amounts means nothing. All of these return "none", and the row shows the figures with no comparison.

export type TrendComparison =
  | { kind: "none" }
  | { kind: "unchanged" }
  | {
      kind: "moved";
      deltaPct: number;
      direction: "up" | "down";
      tone: "good" | "bad";
    };

/** Recova's "unchanged" threshold, in percent. */
const UNCHANGED_BELOW_PCT = 5;

export function compareRuns(
  currentCents: number | null,
  previousCents: number | null,
  higherIsBetter: boolean,
  currentCurrency: string | null,
  previousCurrency: string | null,
): TrendComparison {
  if (currentCents === null || previousCents === null) return { kind: "none" };
  // A run with no stored currency is unknown, never assumed to be USD.
  if (currentCurrency === null || previousCurrency === null) return { kind: "none" };
  if (currentCurrency.toLowerCase() !== previousCurrency.toLowerCase()) return { kind: "none" };
  if (previousCents === 0 && currentCents === 0) return { kind: "unchanged" };

  const delta = currentCents - previousCents;
  const base = previousCents !== 0 ? Math.abs(previousCents) : Math.abs(currentCents);
  const deltaPct = Math.round((Math.abs(delta) / base) * 100);
  if (previousCents !== 0 && deltaPct < UNCHANGED_BELOW_PCT) return { kind: "unchanged" };

  const direction = delta >= 0 ? "up" : "down";
  const improving = higherIsBetter ? direction === "up" : direction === "down";
  return {
    kind: "moved",
    deltaPct,
    direction,
    tone: improving ? "good" : "bad",
  };
}
