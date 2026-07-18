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
