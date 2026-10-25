import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The /billing fee preview (ruling 33). The preview is a READ of the same
// billable predicates and fee math the monthly run uses, evaluated at the NEXT
// run instant rather than at now. That is the whole design: a recovery aged 20
// days is not billable today but will be matured by the time the run fires, so
// a preview anchored at now would under-report what the merchant is about to be
// invoiced, which is a worse failure than showing nothing.
//
// The load-bearing test here is the equality one. A preview that computes its
// own totals is a second implementation of the money math, and the failure mode
// is silent: the card says one number, the invoice says another, and the
// merchant catches it before we do. So the preview is pinned against what
// runAccountBilling actually COMMITS for the same fixture at the same instant,
// not against hand-computed expectations.

const ACCOUNT_ID = "acc_preview";
// Mid-month "now": the merchant is looking at /billing on the 15th.
const NOW = new Date("2026-07-15T12:00:00.000Z");
const NOW_MS = NOW.getTime();
// The cron is "0 4 1 * *", so the next run relative to NOW is the 1st at 04:00 UTC.
const NEXT_RUN = new Date("2026-08-01T04:00:00.000Z");
const NEXT_RUN_MS = NEXT_RUN.getTime();
// 30-day maturity measured back from the RUN, not from now.
const MATURITY_CUTOFF = new Date("2026-07-02T04:00:00.000Z");

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// The money DO is not under test here; run the built batch straight at the
// in-memory schema so the committed invoice rows are real rows.
vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[] },
  ): Promise<{ applied: boolean }> => {
    const batch = write.build(harness.db);
    await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
    return { applied: true };
  },
}));

const { getBillingPreview, nextBillingRunAtMs } = await import("~/lib/billing/preview.server");
const { runAccountBilling } = await import("~/lib/billing/run");
const schema = await import("~/db/schema");

interface RecoverySpec {
  id: string;
  recoveredAt: Date;
  amountCents: number;
  currency?: string;
  attributionKind?: string;
  refundedAt?: Date | null;
  disputedAt?: Date | null;
}

// One fixture drives both sides of the equality test. Every row is here for a
// named reason; the comments are the spec for what each one proves.
const RECOVERIES: RecoverySpec[] = [
  // Matured well before the run: billable, and inside this calendar month.
  { id: "rec_matured", recoveredAt: new Date("2026-07-01T00:00:00.000Z"), amountCents: 10_000 },
  // Exactly ON the cutoff. The predicate is lte, so this one bills.
  { id: "rec_on_cutoff", recoveredAt: MATURITY_CUTOFF, amountCents: 5_000 },
  // One millisecond past the cutoff: NOT matured by the run, so it must not
  // appear in the estimate even though it is this month's recovered revenue.
  {
    id: "rec_past_cutoff",
    recoveredAt: new Date(MATURITY_CUTOFF.getTime() + 1),
    amountCents: 7_000,
  },
  // Refunded and disputed: they happened (recovered revenue) but never bill.
  {
    id: "rec_refunded",
    recoveredAt: new Date("2026-07-01T00:00:00.000Z"),
    amountCents: 3_000,
    refundedAt: new Date("2026-07-05T00:00:00.000Z"),
  },
  {
    id: "rec_disputed",
    recoveredAt: new Date("2026-07-01T00:00:00.000Z"),
    amountCents: 4_000,
    disputedAt: new Date("2026-07-06T00:00:00.000Z"),
  },
  // Stripe's own baseline: free forever, still the merchant's recovered money.
  {
    id: "rec_baseline",
    recoveredAt: new Date("2026-07-01T00:00:00.000Z"),
    amountCents: 6_000,
    attributionKind: "stripe_baseline",
  },
  // A second currency, invoiced separately by the run.
  {
    id: "rec_eur",
    recoveredAt: new Date("2026-07-01T00:00:00.000Z"),
    amountCents: 20_000,
    currency: "eur",
  },
  // LAST month's recovery: outside recoveredThisMonth, still unbilled and
  // matured, so it is on the next invoice. This is the row that proves the two
  // numbers on the card answer different questions and are not the same query.
  { id: "rec_last_month", recoveredAt: new Date("2026-06-20T00:00:00.000Z"), amountCents: 8_000 },
];

async function seed(
  opts: { billingExempt?: boolean; processingPaused?: boolean; cancelledAt?: Date } = {},
) {
  const { db } = createInMemoryDb();
  harness.db = db;

  await db.insert(schema.accounts).values({
    id: ACCOUNT_ID,
    name: "Preview Co",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    // Null keeps runAccountBilling off the Stripe path entirely: the ledger is
    // what this test compares, not the charge dispatch.
    platformStripeCustomerId: null,
    billingExempt: opts.billingExempt ?? false,
    processingPaused: opts.processingPaused ?? false,
    cancelledAt: opts.cancelledAt ?? null,
  });

  for (const [i, r] of RECOVERIES.entries()) {
    await db.insert(schema.failedPayments).values({
      id: `fp_${r.id}`,
      accountId: ACCOUNT_ID,
      stripeEventId: `evt_${i}`,
      stripeInvoiceId: `in_${i}`,
      stripeCustomerId: `cus_${i}`,
      customerEmail: "payer@example.com",
      amountCents: r.amountCents,
      currency: r.currency ?? "usd",
      declineCategory: "soft",
      status: "recovered",
      detectedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    await db.insert(schema.recoveredPayments).values({
      id: r.id,
      accountId: ACCOUNT_ID,
      failedPaymentId: `fp_${r.id}`,
      recoveredAt: r.recoveredAt,
      amountCents: r.amountCents,
      currency: r.currency ?? "usd",
      recoveryMethod: "foxhound_retry",
      attributionKind: r.attributionKind ?? "foxhound_retry",
      refundedAt: r.refundedAt ?? null,
      disputedAt: r.disputedAt ?? null,
    });
  }

  // Two won disputes, both Foxhound-submitted and approved. The first carries a
  // resolved fee snapshot DIFFERENT from what the fee function would compute
  // (20% of 200_000 is 40_000, the snapshot says 15_000), which is the only way
  // to prove the preview reads the stored fee the run bills rather than
  // recomputing it.
  const disputeRows = [
    { id: "dsp_snapshot", amountCents: 200_000, resolvedFeeCents: 15_000 },
    { id: "dsp_computed", amountCents: 50_000, resolvedFeeCents: 10_000 },
  ];
  for (const [i, d] of disputeRows.entries()) {
    await db.insert(schema.disputes).values({
      id: d.id,
      accountId: ACCOUNT_ID,
      stripeDisputeId: `dp_${i}`,
      stripeChargeId: `ch_${i}`,
      amountCents: d.amountCents,
      currency: "usd",
      reason: "fraudulent",
      status: "won",
      state: "resolved_won",
      submittedAt: new Date("2026-07-05T00:00:00.000Z"),
      resolvedAt: new Date("2026-07-10T00:00:00.000Z"),
      resolvedFeeCents: d.resolvedFeeCents,
      resolvedFeeCurrency: "usd",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await db.insert(schema.disputeApprovals).values({
      id: `appr_${i}`,
      disputeId: d.id,
      accountId: ACCOUNT_ID,
      evidenceVersionHash: `hash_${i}`,
      approvedAt: new Date("2026-07-04T00:00:00.000Z"),
    });
  }

  return db;
}

const byCurrency = (rows: { currency: string; cents: number }[]) =>
  Object.fromEntries(rows.map((r) => [r.currency, r.cents]));

describe("nextBillingRunAtMs (derived from the '0 4 1 * *' cron, never hardcoded)", () => {

  it("on the 1st before 04:00, the next run is later THAT day, not next month", () => {
    // The cron fires at 04:00 on the 1st. A merchant loading /billing at 02:00
    // on the 1st is two hours from being invoiced, and telling them the date is
    // a month out would be wrong by a whole billing period.
    const early = new Date("2026-08-01T02:00:00.000Z").getTime();
    expect(new Date(nextBillingRunAtMs(early)).toISOString()).toBe("2026-08-01T04:00:00.000Z");
  });

  it("on the 1st at exactly 04:00, that run is going, so the next one is next month", () => {
    expect(new Date(nextBillingRunAtMs(NEXT_RUN_MS)).toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });
});

describe("getBillingPreview", () => {
  beforeEach(() => {
    harness.db = null;
  });

  // THE equality gate. Same fixture, same instant, two code paths, one number.
  it("its estimate equals per currency what the run actually commits at that instant", async () => {
    const db = await seed();

    const preview = await getBillingPreview(db, ACCOUNT_ID, NOW_MS);

    // Bill the account AT the run instant the preview was anchored to.
    await runAccountBilling({} as Env, { accountId: ACCOUNT_ID, nowMs: NEXT_RUN_MS });

    const committed = await db
      .select({
        currency: schema.billingInvoices.currency,
        totalCents: schema.billingInvoices.totalCents,
      })
      .from(schema.billingInvoices)
      .where(eq(schema.billingInvoices.accountId, ACCOUNT_ID));

    expect(committed.length).toBeGreaterThan(0);
    expect(byCurrency(preview.estimatedInvoice)).toEqual(
      byCurrency(committed.map((c) => ({ currency: c.currency, cents: c.totalCents }))),
    );
  });

  describe("recoveredThisMonth", () => {

    it("never bills them: neither refunded nor disputed reaches the estimate", async () => {
      const db = await seed();
      const preview = await getBillingPreview(db, ACCOUNT_ID, NOW_MS);
      const usd = byCurrency(preview.estimatedInvoice).usd;
      // Their fees would be 600 and 800.
      expect(usd).not.toBe(29_600 + 600);
      expect(usd).not.toBe(29_600 + 800);
      expect(usd).not.toBe(29_600 + 600 + 800);
    });
  });

  describe("account billing state (an empty estimate is not the same claim as nothing owed)", () => {
    it("reports billing exempt, and the estimate is empty by construction", async () => {
      const db = await seed({ billingExempt: true });
      const preview = await getBillingPreview(db, ACCOUNT_ID, NOW_MS);
      expect(preview.accountBillingState.billingExempt).toBe(true);
      // The billable queries gate on the account, so this is zero for a reason
      // the card must state rather than render as "nothing owed".
      expect(preview.estimatedInvoice).toEqual([]);
      // The merchant still recovered money; that half is not gated.
      expect(byCurrency(preview.recoveredThisMonth).usd).toBe(35_000);
    });

    it("reports processing paused, and the estimate is empty by construction", async () => {
      const db = await seed({ processingPaused: true });
      const preview = await getBillingPreview(db, ACCOUNT_ID, NOW_MS);
      expect(preview.accountBillingState.processingPaused).toBe(true);
      expect(preview.estimatedInvoice).toEqual([]);
    });

    it("reports a canceled account, which is NOT a billing gate", async () => {
      const cancelledAt = new Date("2026-07-09T00:00:00.000Z");
      const db = await seed({ cancelledAt });
      const preview = await getBillingPreview(db, ACCOUNT_ID, NOW_MS);
      expect(preview.accountBillingState.cancelledAt?.getTime()).toBe(cancelledAt.getTime());
      // accountBillingEligibleCondition deliberately does not reference
      // cancelled_at: cancel never forgives an already-matured fee.
      expect(byCurrency(preview.estimatedInvoice).usd).toBe(29_600);
    });
  });

  it("returns empty totals for an account with nothing at all, without throwing", async () => {
    const db = await seed();
    const preview = await getBillingPreview(db, "acc_nobody", NOW_MS);
    expect(preview.estimatedInvoice).toEqual([]);
    expect(preview.recoveredThisMonth).toEqual([]);
    expect(preview.nextRunAtMs).toBe(NEXT_RUN_MS);
  });
});

// J65 (row S3): Recova's /billing splits the next invoice into its Recovery
// section (recovered this month and the recovery fee) and its Dispute Fees
// section (the pending dispute fees), and counts only attributed recoveries in
// "Recovered this month". These are the same reads as above, split, so the
// equality gate above still pins the total.
describe("getBillingPreview, split for Recova's sections (J65)", () => {
  it("counts only attributed recoveries as recovered this month, never the free baseline", async () => {
    const db = await seed();
    const preview = await getBillingPreview(db, ACCOUNT_ID, NOW_MS);
    // 35_000 less the 6_000 baseline. Refunded and disputed still count: they
    // were recovered, as Recova counts them.
    expect(byCurrency(preview.attributedThisMonth)).toEqual({ usd: 29_000, eur: 20_000 });
  });
});
