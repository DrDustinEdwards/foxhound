// Single money formatter: minor units + ISO currency code -> a localized
// display string. Every surface rendering a money amount uses this, not an ad
// hoc toFixed/concatenation (DESIGN.md: numbers render in DM Mono; the value
// string itself is centralized here).
//
// THE MINOR UNIT IS NOT ALWAYS A HUNDREDTH (a truthfulness fix).
// Stripe sends every amount in the currency's minor unit
// (https://docs.stripe.com/currencies, "Specify amounts in API requests"). For
// Stripe's zero-decimal currencies the amount IS the whole unit, so 5000 JPY is
// 5,000 yen; for its three-decimal currencies it is a thousandth. Recova divided
// everything by 100 and showed a 5,000 yen dispute as 50 yen. This table is the
// one place the exponent is decided; every display path below goes through it,
// and so does the dispute fee cap.
//
// Nothing here writes a fee or sends an amount to Stripe.
// billing/dispute-cap.ts reads currencyExponent to express the converted cap in
// the dispute's Stripe amount, so the cap and the display share one table.

/** Stripe's zero-decimal currencies: the amount is the whole unit.
 *  docs.stripe.com/currencies, "Zero-decimal currencies". UGX is left out on
 *  purpose: Stripe's "Special cases" table says UGX "transitioned to a
 *  zero-decimal currency, but backwards compatibility requires you to represent
 *  it as a two-decimal value", so 500 is 5 UGX. */
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/** Stripe's three-decimal currencies: the amount is in thousandths (and Stripe
 *  requires it to be divisible by 10). */
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Currencies Stripe sends as two-decimal values whose decimals are always 00
 *  (Stripe's "Special cases": ISK and UGX). Divided by 100 like any other,
 *  shown without the decimals that cannot exist. */
const WHOLE_UNITS_SENT_AS_HUNDREDTHS = new Set(["isk", "ugx"]);

/** The power of ten between a currency's Stripe amount and its whole unit:
 *  0 for JPY, 3 for KWD, 2 for everything else (including a code nobody
 *  recognizes, which is Recova's assumption and the commonest case). */
export function currencyExponent(currency: string): 0 | 2 | 3 {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Decimal places a display of this currency carries. */
function displayDigits(currency: string): number {
  return WHOLE_UNITS_SENT_AS_HUNDREDTHS.has(currency.toLowerCase()) ? 0 : currencyExponent(currency);
}

/** A Stripe amount in whole units of its currency: 5000 JPY is 5000, 5000 USD
 *  is 50, 5000 KWD is 5. For charts and exports that need the number. */
export function toMajorUnits(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}

/** The inverse, for a chart value read back into a Stripe amount. */
export function fromMajorUnits(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyExponent(currency));
}

/** The whole-unit figure as a plain number string with the currency's own
 *  places and no grouping or symbol ("50.00", "5000", "12.345"): CSV cells and
 *  model prompt text. */
export function plainMajorAmount(minor: number, currency: string): string {
  return toMajorUnits(minor, currency).toFixed(displayDigits(currency));
}

function format(minor: number, currency: string, digits: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(toMajorUnits(minor, currency));
  } catch {
    // Intl refuses a malformed code. Recova's fallback (lib/disputes-evidence.ts
    // formatMoney): the figure at two places and the code beside it, never a
    // thrown error on a page or in an email.
    return `${(minor / 100).toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

export function formatMoney(minor: number, currency: string): string {
  return format(minor, currency, displayDigits(currency));
}

/** Per-currency totals side by side, each in its own currency; none at all
 *  reads as zero. A total across currencies is meaningless, so
 *  the parts are never added together. The /disputes cards use it, and so does
 *  the /product/disputes preview of them. */
export function formatAmounts(rows: readonly { currency: string; cents: number }[]): string {
  if (rows.length === 0) return formatMoney(0, "usd");
  return rows.map((r) => formatMoney(r.cents, r.currency)).join(" · ");
}

/**
 * Whole-unit variant, no decimals. For dense surfaces where the decimals are
 * noise rather than information: the dashboard attention list, compact stat
 * tiles, and per-customer MRR suffixes, where two extra glyphs on every row
 * cost more legibility than the precision buys.
 *
 * Rounds rather than truncates, so 1060 cents reads as $11, not $10.
 */
export function formatMoneyShort(minor: number, currency: string): string {
  return format(minor, currency, 0);
}

/** The order per-currency totals are shown in: by currency code, as
 *  /intelligence orders them (app/lib/intelligence/views.server.ts), so a
 *  figure's lines do not move with the order Stripe's rows happened to come. */
export function byCurrencyCode(a: { currency: string }, b: { currency: string }): number {
  return a.currency.localeCompare(b.currency);
}
