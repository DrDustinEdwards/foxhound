import { DISPUTE_FEE_CAP_CENTS, STRIPE_PREVIEW_API_VERSION } from "~/lib/constants";
import { fromMajorUnits } from "@dustinedwards/site-runtime/money";
import { getStripe } from "~/lib/stripe/client";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// THE SDK DOES NOT TYPE THIS ENDPOINT. stripe@23.0.1 ships no `fxQuotes`
// resource, so the call goes through `stripe.rawRequest`, which still carries
// the SDK's auth, retries and idempotency. Adding a dependency to reach a typed
// wrapper is exactly what 371 binding 1 warns about on a money repo.

export interface ResolvedDisputeCap {
  /** The cap to apply, in the DISPUTE's minor units. */
  capMinorUnits: number;
  /**
   * USD to the dispute currency. Null for a USD dispute, where none was
   * fetched.
   */
  rate: number | null;
  quoteId: string | null;
  quotedAt: Date | null;
}

export class DisputeCapQuoteError extends Error {
  constructor(
    readonly currency: string,
    cause: unknown,
  ) {
    super(`fx quote for usd->${currency} failed: ${errorMessage(cause)}`);
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
 * A quote that cannot be fetched throws, the caller does not snapshot a fee,
 * and the dispute stays unresolved for billing with the error recorded. It
 * NEVER falls back to the flat 50,000, because that fallback is the defect
 * being removed and a silent one would be worse than the loud one it replaced:
 * the merchant would be invoiced a number nobody chose.
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
    return {
      capMinorUnits: DISPUTE_FEE_CAP_CENTS,
      rate: null,
      quoteId: null,
      quotedAt: null,
    };
  }

  let quote: FxQuoteResponse;
  try {
    // Stripe's shape: ONE `to_currency` and a list of `from_currencies`, with
    // `rates` keyed by the SOURCE currency, where rates[from].exchange_rate is
    // units of to_currency per one unit of from. So USD is the source and the
    // dispute's currency the target, and the rate is read at rates.usd.
    quote = (await getStripe(env).rawRequest(
      "POST",
      "/v1/fx_quotes",
      {
        to_currency: code,
        "from_currencies[0]": "usd",
        lock_duration: "none",
      },
      { apiVersion: STRIPE_PREVIEW_API_VERSION },
    )) as FxQuoteResponse;
  } catch (err) {
    throw new DisputeCapQuoteError(code, err);
  }

  // Dispute-currency units per one USD.
  const rate = quote.rates?.usd?.exchange_rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new DisputeCapQuoteError(code, new Error("quote carried no usable exchange rate"));
  }

  // USD 500 in major units, converted, then expressed in the target's minor
  // units. Going through major units is what keeps a zero-decimal currency from
  // being capped a hundred times too high.
  const capMajor = (DISPUTE_FEE_CAP_CENTS / 100) * rate;
  return {
    capMinorUnits: fromMajorUnits(capMajor, code),
    rate,
    quoteId: quote.id ?? null,
    quotedAt: now,
  };
}
