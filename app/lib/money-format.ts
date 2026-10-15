// Single money formatter: cents (minor units) + ISO currency code -> a
// localized display string. Every surface rendering a money amount uses this,
// not an ad hoc toFixed/concatenation (DESIGN.md: numbers render in DM Mono;
// the value string itself is centralized here).

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/** Per-currency totals side by side, each in its own currency; none at all
 *  reads as zero. A total across currencies is meaningless (RULES.md 3.20), so
 *  the parts are never added together. The /disputes cards use it, and so does
 *  the /product/disputes preview of them. */
export function formatAmounts(rows: readonly { currency: string; cents: number }[]): string {
  if (rows.length === 0) return formatMoney(0, "usd");
  return rows.map((r) => formatMoney(r.cents, r.currency)).join(" · ");
}

/**
 * Whole-dollar variant, no cents. For dense surfaces where the decimals are
 * noise rather than information: the dashboard attention list, compact stat
 * tiles, and per-customer MRR suffixes, where two extra glyphs on every row
 * cost more legibility than the precision buys.
 *
 * Rounds rather than truncates, so 1060 cents reads as $11, not $10.
 */
export function formatMoneyShort(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
