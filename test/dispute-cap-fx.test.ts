import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The $500 dispute fee cap is converted to the dispute's currency at resolution.
// A flat 50,000 minor units is about $320 in yen and $630 in pence, so the
// invoice and the promised "$500" disagreed in opposite directions.
//
// The rates are fake and chosen to land the converted cap on either side of
// 50,000, so the cap is shown to be computed, not the constant. A quote that
// cannot be fetched fails closed: the fee stays unsnapshotted with the error
// recorded, never the flat cap, because a wrong number invoiced silently is
// worse than a right one invoiced late.

const ACCOUNT = "acct_fx";
const DISPUTE = "dp_fx";
const RESOLVED_AT = new Date("2026-09-01T00:00:00.000Z");

const harness = vi.hoisted(() => ({
  db: null as unknown,
  rawRequests: [] as { method: string; path: string; params: Record<string, unknown> }[],
  /** Target units per one USD. */
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
      // Stripe's shape: rates keyed by the source currency.
      const to = String(params.to_currency);
      const from = String(params["from_currencies[0]"]);
      if (harness.omitRate) return { id: "fxq_1", rates: {} };
      return { id: "fxq_1", rates: { [from]: { exchange_rate: harness.rates[to] } } };
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

const { resolveDisputeCap, DisputeCapQuoteError } = await import("~/lib/billing/dispute-cap");
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
async function resolveWon(
  db: Awaited<ReturnType<typeof seed>>,
  currency: string,
  amountCents: number,
) {
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

describe("a UGX dispute: Stripe sends UGX in hundredths, so the cap is too", () => {
  it("caps at 500 x rate shillings, expressed as hundredths", async () => {
    harness.rates.ugx = 3_700; // fake
    const db = await seed("ugx", 10_000_000_000);
    const row = await resolveWon(db, "ugx", 10_000_000_000);

    // $500 * 3,700 = 1,850,000 UGX; Stripe reports UGX as a two-decimal value.
    expect(row.resolvedFeeCents).toBe(185_000_000);
    expect(row.resolvedFeeCurrency).toBe("ugx");
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
});

describe("a JPY dispute: the converted cap lands below 50,000", () => {
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
});

describe("a GBP dispute: the converted cap lands above 50,000", () => {
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
});

describe("fail closed when the quote cannot be had", () => {
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
    // Never the flat cap.
    expect(row.resolvedFeeCents).not.toBe(DISPUTE_FEE_CAP_CENTS);
  });

  it("a quote that carries no usable rate fails the same way", async () => {
    harness.omitRate = true;
    const db = await seed("gbp", 1_000_000);
    const row = await resolveWon(db, "gbp", 1_000_000);

    expect(row.resolvedFeeCents).toBeNull();
    expect(row.resolvedFeeError).toContain("no usable exchange rate");
  });

  it("a zero or negative rate is not a rate", async () => {
    harness.rates.gbp = 0;
    await seed("gbp", 1_000_000);
    await expect(resolveDisputeCap({} as Env, "gbp", RESOLVED_AT)).rejects.toBeInstanceOf(
      DisputeCapQuoteError,
    );
  });
});
