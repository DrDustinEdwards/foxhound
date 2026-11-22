// The one money-total path (hard rule 2): sum per currency, never across currencies, or yen is added to dollars under the
// first row's label. Client-safe: no server imports.

import { formatMoney } from "@dustinedwards/site-runtime/money";

export interface CurrencyAmount {
  currency: string;
  cents: number;
}

export function groupSumByCurrency(rows: readonly CurrencyAmount[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.cents);
  }
  return [...totals.entries()].map(([currency, cents]) => ({ currency, cents }));
}

/** Per-currency totals side by side, each in its own currency; none at all reads as zero. Never added together. Used by the
 *  /disputes cards and the /product/disputes preview. */
export function formatAmounts(rows: readonly CurrencyAmount[]): string {
  if (rows.length === 0) return formatMoney(0, "usd");
  return rows.map((r) => formatMoney(r.cents, r.currency)).join(" · ");
}

/** Per-currency totals ordered by currency code (as /intelligence does), so a figure's lines do not move with Stripe's row order. */
export function byCurrencyCode(a: { currency: string }, b: { currency: string }): number {
  return a.currency.localeCompare(b.currency);
}
