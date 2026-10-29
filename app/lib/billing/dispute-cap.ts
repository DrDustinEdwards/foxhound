import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { currencyExponent } from "~/lib/money-format";
import { getStripe } from "~/lib/stripe/client";

// THE $500 CAP, CONVERTED AT RESOLUTION (ruling 377(7), PRICING.md rev 5 item 2,
// reversing 376(6)'s "FX never").
//
// fees.ts capped a non-USD dispute at 50,000 of ITS OWN minor units and a
// comment flagged it for Dustin. That is not a rounding difference, it is a
// different number: 50,000 yen is about $320 and 50,000 pence is about $630, so
// the merchant's invoice and the page promising "$500" disagreed, in opposite
// directions depending on the currency.
//
// PRICING rev 5's wording is what this implements: "USD 500 converted at
// Stripe's current rate on the resolution day, with the rate and its timestamp
// stored on the dispute row". lock_duration none, because there is nothing to
// hold: the conversion happens once, at resolution, and the number is then
// frozen on the row. A locked quote would cost a fee for a guarantee nobody
// needs.
//
// THE SDK DOES NOT TYPE THIS ENDPOINT. stripe@23.0.1 ships no `fxQuotes`
// resource, so the call goes through `stripe.rawRequest`, which still carries
// the SDK's auth, retries and idempotency. Adding a dependency to reach a typed
// wrapper is exactly what 371 binding 1 warns about on a money repo. The
// response shape below is Stripe's documented one and has NOT been exercised
// against a live account; that is stated rather than implied.

/** Minor units per major unit for a currency, as Stripe reports amounts (100
 *  for USD, 1 for JPY, 1,000 for KWD, and 100 for UGX, which Stripe still
 *  sends as a two-decimal value). The exponent comes from the one table in
 *  money-format.ts, so the cap and every displayed amount agree on what a
 *  Stripe amount means. Getting this wrong scales a cap by 100. */
export function minorUnitsPerMajor(currency: string): number {
  return 10 ** currencyExponent(currency);
}

export interface ResolvedDisputeCap {
  /** The cap to apply, in the DISPUTE's minor units. */
  capMinorUnits: number;
  /** USD to the dispute currency. Null for a USD dispute, where none was fetched. */
  rate: number | null;
  quoteId: string | null;
  quotedAt: Date | null;
}

export class DisputeCapQuoteError extends Error {
  constructor(readonly currency: string, cause: unknown) {
    super(
      `fx quote for usd->${currency} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "DisputeCapQuoteError";
  }
}

interface FxQuoteResponse {
  id?: string;
  rates?: Record<string, { exchange_rate?: number } | undefined>;
}

/**
 * The USD 500 cap expressed in one dispute's currency, at today's rate.
 *
 * FAILS CLOSED, and that is the whole design (377(7)). A quote that cannot be
 * fetched throws, the caller does not snapshot a fee, and the dispute stays
 * unresolved for billing with the error recorded. It NEVER falls back to the
 * flat 50,000, because that fallback is the defect being removed and a silent
 * one would be worse than the loud one it replaced: the merchant would be
 * invoiced a number nobody chose.
 */
export async function resolveDisputeCap(
  env: Env,
  currency: string,
  now: Date,
): Promise<ResolvedDisputeCap> {
  const code = currency.toLowerCase();
  if (code === "usd") {
    // Nothing to convert and nothing to record. A USD dispute must not depend
    // on an external call to resolve at all.
    return { capMinorUnits: DISPUTE_FEE_CAP_CENTS, rate: null, quoteId: null, quotedAt: null };
  }

  let quote: FxQuoteResponse;
  try {
    quote = (await getStripe(env).rawRequest("POST", "/v1/fx_quotes", {
      from_currency: "usd",
      "to_currencies[0]": code,
      lock_duration: "none",
    })) as FxQuoteResponse;
  } catch (err) {
    throw new DisputeCapQuoteError(code, err);
  }

  const rate = quote.rates?.[code]?.exchange_rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new DisputeCapQuoteError(code, new Error("quote carried no usable exchange rate"));
  }

  // USD 500 in major units, converted, then expressed in the target's minor
  // units. Going through major units is what keeps a zero-decimal currency from
  // being capped a hundred times too high.
  const capMajor = (DISPUTE_FEE_CAP_CENTS / 100) * rate;
  return {
    capMinorUnits: Math.round(capMajor * minorUnitsPerMajor(code)),
    rate,
    quoteId: quote.id ?? null,
    quotedAt: now,
  };
}
