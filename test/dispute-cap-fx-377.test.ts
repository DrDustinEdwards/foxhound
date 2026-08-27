import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 377(7), PRICING.md rev 5 item 2: THE $500 CAP IS CONVERTED AT
// RESOLUTION, REVERSING 376(6)'S "FX NEVER".
//
// fees.ts capped a non-USD dispute at 50,000 of ITS OWN minor units, with a
// comment flagging it for Dustin. That is not a rounding difference: 50,000 yen
// is roughly $320 and 50,000 pence is roughly $630, so the merchant's invoice
// and the page promising "$500" disagreed, in OPPOSITE directions depending on
// the currency. Both directions are planted below for exactly that reason.
//
// THE RATES HERE ARE FAKE AND DELIBERATELY UNREALISTIC. They are chosen to land
// the converted cap on either side of the old flat 50,000, because the property
// under test is "the cap is computed, not the constant", and a rate that
// happened to produce something near 50,000 would not discriminate.
//
// FAIL CLOSED IS THE OTHER HALF. A quote that cannot be fetched leaves the fee
// unsnapshotted with the error recorded. It NEVER falls back to the flat cap,
// because a wrong number invoiced silently is worse than a right one invoiced
// late.

const ACCOUNT = "acct_fx";
const DISPUTE = "dp_fx";
const RESOLVED_AT = new Date("2026-09-01T00:00:00.000Z");

const harness = vi.hoisted(() => ({
  db: null as unknown,
  rawRequests: [] as { method: string; path: string; params: Record<string, unknown> }[],
  /** usd -> currency. Fake, see the header. */
  rates: {} as Record<string, number>,
  failQuote: false,
  omitRate: false,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/client", () => ({
  getStripe: () => ({
    rawRequest: async (method: string, path: string, params: Record<string, unknown>) => {
      harness.rawRequests.push({ method, path, params });
      if (harness.failQuote) throw new Error("stripe unavailable");
      const to = String(params["to_currencies[0]"]);
      if (harness.omitRate) return { id: "fxq_1", rates: {} };
      return { id: "fxq_1", rates: { [to]: { exchange_rate: harness.rates[to] } } };
    },
  }),
  getConnectedStripe: () => {
    throw new Error("connected stripe must not be used here");
  },
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[] },
  ): Promise<{ applied: boolean }> => {
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      return { applied: true };
    } catch (err) {
      if (String(err).match(/UNIQUE|constraint/i)) return { applied: false };
      throw err;
    }
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({ decryptToken: async () => "sk_test" }));

const { resolveDisputeCap, minorUnitsPerMajor, DisputeCapQuoteError } = await import(
  "~/lib/billing/dispute-cap"
);
const { disputeFeeCents } = await import("~/lib/billing/fees");
const { buildDisputeResolutionBatch } = await import("~/lib/webhooks/batches");
const schema = await import("~/db/schema");

async function seed(currency: string, amountCents: number) {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(schema.accounts).values({ id: ACCOUNT, name: "FX Co", createdAt: RESOLVED_AT });
  await db.insert(schema.disputes).values({
    id: DISPUTE,
    accountId: ACCOUNT,
    stripeDisputeId: "dp_stripe_fx",
    stripeChargeId: "ch_fx",
    amountCents,
    currency,
    reason: "fraudulent",
    status: "won",
    state: "submitted",
    submittedAt: RESOLVED_AT,
    createdAt: RESOLVED_AT,
  });
  return db;
}

/** Resolve the cap and commit the resolution exactly as process.ts does. */
async function resolveWon(db: Awaited<ReturnType<typeof seed>>, currency: string, amountCents: number) {
  let cap = null;
  let capError: string | null = null;
  try {
    cap = await resolveDisputeCap({} as Env, currency, RESOLVED_AT);
  } catch (err) {
    capError = err instanceof Error ? err.message : "fx quote failed";
  }
  const batch = buildDisputeResolutionBatch(db as never, {
    claim: {
      stripeEventId: `evt_${currency}`,
      eventType: "charge.dispute.closed",
      accountId: ACCOUNT,
      receivedAt: RESOLVED_AT,
      payload: {},
    },
    accountId: ACCOUNT,
    stripeDisputeId: "dp_stripe_fx",
    won: true,
    amountCents,
    currency,
    foxhoundSubmitted: true,
    resolvedAt: RESOLVED_AT,
    cap,
    capError,
  });
  await (db as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
  const [row] = await db.select().from(schema.disputes).where(eq(schema.disputes.id, DISPUTE));
  return row;
}

beforeEach(() => {
  harness.db = null;
  harness.rawRequests = [];
  harness.rates = {};
  harness.failQuote = false;
  harness.omitRate = false;
});

describe("minor units are per currency, or the cap is out by a factor of a hundred", () => {
  it("usd and gbp have 100, jpy has 1, kwd has 1000", () => {
    expect(minorUnitsPerMajor("usd")).toBe(100);
    expect(minorUnitsPerMajor("gbp")).toBe(100);
    expect(minorUnitsPerMajor("jpy")).toBe(1);
    expect(minorUnitsPerMajor("kwd")).toBe(1_000);
  });
});

describe("a USD dispute is unchanged and asks Stripe nothing", () => {
  it("caps at the flat 50,000 with no rate, no quote and no call", async () => {
    const db = await seed("usd", 1_000_000);
    const row = await resolveWon(db, "usd", 1_000_000);

    expect(row.resolvedFeeCents).toBe(DISPUTE_FEE_CAP_CENTS);
    expect(row.resolvedFeeCurrency).toBe("usd");
    expect(row.resolvedFeeRate).toBeNull();
    expect(row.resolvedFeeQuoteId).toBeNull();
    expect(row.resolvedFeeError).toBeNull();
    // A USD dispute must not depend on an external call to resolve at all.
    expect(harness.rawRequests).toHaveLength(0);
  });

  it("and below the cap the percentage still governs", async () => {
    const db = await seed("usd", 100_000);
    const row = await resolveWon(db, "usd", 100_000);
    expect(row.resolvedFeeCents).toBe(20_000);
  });
});

describe("a JPY dispute: the converted cap lands BELOW the old flat 50,000", () => {
  it("caps at 500 x rate in whole yen, not at 50,000 yen", async () => {
    harness.rates.jpy = 90; // fake, chosen to land under the old flat cap
    const db = await seed("jpy", 10_000_000);
    const row = await resolveWon(db, "jpy", 10_000_000);

    // $500 * 90 = 45,000 yen, and yen has no minor unit, so 45,000 minor units.
    expect(row.resolvedFeeCents).toBe(45_000);
    expect(row.resolvedFeeCents).toBeLessThan(DISPUTE_FEE_CAP_CENTS);
    expect(row.resolvedFeeRate).toBe(90);
    expect(row.resolvedFeeQuoteId).toBe("fxq_1");
    expect(row.resolvedFeeRateAt).toEqual(RESOLVED_AT);
    expect(row.resolvedFeeError).toBeNull();
  });

  it("asks Stripe for a usd quote with no lock", async () => {
    harness.rates.jpy = 90;
    const db = await seed("jpy", 10_000_000);
    await resolveWon(db, "jpy", 10_000_000);

    expect(harness.rawRequests).toHaveLength(1);
    const call = harness.rawRequests[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v1/fx_quotes");
    expect(call.params.from_currency).toBe("usd");
    expect(call.params["to_currencies[0]"]).toBe("jpy");
    // No lock: the number is frozen on the row at resolution, so there is
    // nothing to hold and no fee to pay for holding it.
    expect(call.params.lock_duration).toBe("none");
  });
});

describe("a GBP dispute: the converted cap lands ABOVE the old flat 50,000", () => {
  it("caps at 500 x rate in pence, not at 50,000 pence", async () => {
    harness.rates.gbp = 1.2; // fake, chosen to land over the old flat cap
    const db = await seed("gbp", 1_000_000);
    const row = await resolveWon(db, "gbp", 1_000_000);

    // $500 * 1.2 = 600 GBP = 60,000 pence.
    expect(row.resolvedFeeCents).toBe(60_000);
    expect(row.resolvedFeeCents).toBeGreaterThan(DISPUTE_FEE_CAP_CENTS);
    expect(row.resolvedFeeRate).toBe(1.2);
    expect(row.resolvedFeeRateAt).toEqual(RESOLVED_AT);
  });

  it("the two directions together are the point: the cap is computed, not the constant", async () => {
    harness.rates.jpy = 90;
    const jpyDb = await seed("jpy", 10_000_000);
    const jpy = await resolveWon(jpyDb, "jpy", 10_000_000);

    harness.rates.gbp = 1.2;
    const gbpDb = await seed("gbp", 1_000_000);
    const gbp = await resolveWon(gbpDb, "gbp", 1_000_000);

    expect(jpy.resolvedFeeCents).not.toBe(DISPUTE_FEE_CAP_CENTS);
    expect(gbp.resolvedFeeCents).not.toBe(DISPUTE_FEE_CAP_CENTS);
    expect(jpy.resolvedFeeCents).not.toBe(gbp.resolvedFeeCents);
  });
});

describe("FAIL CLOSED when the quote cannot be had", () => {
  it("a failing quote leaves resolvedFeeCents null and records the error", async () => {
    harness.failQuote = true;
    const db = await seed("gbp", 1_000_000);
    const row = await resolveWon(db, "gbp", 1_000_000);

    // Resolved as a dispute, unpriced for billing.
    expect(row.state).toBe("resolved_won");
    expect(row.resolvedFeeCents).toBeNull();
    expect(row.resolvedFeeCurrency).toBeNull();
    expect(row.resolvedFeeRate).toBeNull();
    expect(row.resolvedFeeError).toContain("fx quote for usd->gbp failed");
    // NEVER the flat cap. This is the assertion the whole ruling turns on.
    expect(row.resolvedFeeCents).not.toBe(DISPUTE_FEE_CAP_CENTS);
  });

  it("a quote that carries no usable rate fails the same way", async () => {
    harness.omitRate = true;
    const db = await seed("gbp", 1_000_000);
    const row = await resolveWon(db, "gbp", 1_000_000);

    expect(row.resolvedFeeCents).toBeNull();
    expect(row.resolvedFeeError).toContain("no usable exchange rate");
  });

  it("resolveDisputeCap throws rather than returning a guess", async () => {
    harness.failQuote = true;
    await seed("gbp", 1_000_000);
    await expect(resolveDisputeCap({} as Env, "gbp", RESOLVED_AT)).rejects.toBeInstanceOf(
      DisputeCapQuoteError,
    );
  });

  it("a zero or negative rate is not a rate", async () => {
    harness.rates.gbp = 0;
    await seed("gbp", 1_000_000);
    await expect(resolveDisputeCap({} as Env, "gbp", RESOLVED_AT)).rejects.toBeInstanceOf(
      DisputeCapQuoteError,
    );
  });
});

describe("the pure fee function caps at whatever it is handed", () => {
  it("uses the given cap, in both directions", () => {
    expect(disputeFeeCents(1_000_000, 45_000)).toBe(45_000);
    expect(disputeFeeCents(1_000_000, 60_000)).toBe(60_000);
    // Below the cap the percentage governs, whatever the cap is.
    expect(disputeFeeCents(100_000, 45_000)).toBe(20_000);
  });
});
