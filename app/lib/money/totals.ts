// The one money-total path (hard rule 2): sum per currency, never across
// currencies. A total that ignores currency adds yen to dollars and labels the
// result with whichever row came first. Client-safe: no server imports.

import { formatMoney } from "@dustinedwards/site-runtime/money";

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

/** Per-currency totals side by side, each in its own currency; none at all
 *  reads as zero. A total across currencies is meaningless, so
 *  the parts are never added together. The /disputes cards use it, and so does
 *  the /product/disputes preview of them. */
export function formatAmounts(rows: readonly CurrencyAmount[]): string {
  if (rows.length === 0) return formatMoney(0, "usd");
  return rows.map((r) => formatMoney(r.cents, r.currency)).join(" · ");
}

/** The order per-currency totals are shown in: by currency code, as
 *  /intelligence orders them (app/lib/intelligence/views.server.ts), so a
 *  figure's lines do not move with the order Stripe's rows happened to come. */
export function byCurrencyCode(a: { currency: string }, b: { currency: string }): number {
  return a.currency.localeCompare(b.currency);
}
