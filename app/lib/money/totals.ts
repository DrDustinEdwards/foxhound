// The one money-total path (hard rule 2): sum per currency, never across
// currencies. A total that ignores currency adds yen to dollars and labels the
// result with whichever row came first. Client-safe: no server imports.

export interface CurrencyAmount {
  currency: string;
  cents: number;
}

/** Sum minor units per currency, in first-seen currency order. */
export function groupSumByCurrency(rows: readonly CurrencyAmount[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.cents);
  }
  return [...totals.entries()].map(([currency, cents]) => ({ currency, cents }));
}
