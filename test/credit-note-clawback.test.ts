import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// A refund or chargeback after the fee was invoiced is clawed back as a Stripe
// credit note. A refund before billing never reaches an invoice (the billable
// predicate excludes it), so that case must credit nothing.
//
// Real SQL against the committed migrations and a fake Stripe that records its
// calls, so "exactly one credit note call" is counted and the unique index doing
// the deduping is the real one.

const ACCOUNT = "acct_credit";
const PAYMENT = "fp_credit";
const RECOVERY = "rp_credit";
const DISPUTE = "dp_credit";
const INVOICE = "binv_credit";
const FEE_LINE = "bli_fee";

const BILLED_AT = new Date("2026-07-01T00:00:00.000Z");
const REFUNDED_AT = new Date("2026-09-15T00:00:00.000Z");
const FEE_CENTS = 2_000;

const harness = vi.hoisted(() => ({
  db: null as unknown,
  creditNoteCalls: [] as {
    args: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
  }[],
  failCreditNote: false,
  seen: new Set<string>(),
  // What Stripe holds, so a retry can find a note an earlier attempt left.
  stripeNotes: [] as {
    id: string;
    invoice: string;
    status: string;
    amount: number;
    metadata: Record<string, string>;
  }[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/client", () => ({
  getStripe: () => ({
    creditNotes: {
      create: async (args: Record<string, unknown>, options?: Record<string, unknown>) => {
        harness.creditNoteCalls.push({ args, options });
        if (harness.failCreditNote) throw new Error("stripe unavailable");
        const note = {
          id: `cn_${harness.creditNoteCalls.length}`,
          invoice: args.invoice as string,
          status: "issued",
          amount: args.credit_amount as number,
          metadata: args.metadata as Record<string, string>,
        };
        harness.stripeNotes.push(note);
        return note;
      },
      // Newest first, as Stripe lists them.
      list: async function* (params: { invoice: string }) {
        yield* harness.stripeNotes.filter((n) => n.invoice === params.invoice).reverse();
      },
    },
  }),
  getConnectedStripe: () => {
    throw new Error("connected stripe must not be used here");
  },
}));

// The money DO, modeled with its seen-set so the idempotency key is doing real
// work rather than being decoration.
vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[]; idempotencyKey: string },
  ): Promise<{ applied: boolean }> => {
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      harness.seen.add(write.idempotencyKey);
      return { applied: true };
    } catch (err) {
      if (String(err).match(/UNIQUE|constraint/i)) return { applied: false };
      throw err;
    }
  },
}));

const { issueCreditNoteForEvidence, findCreditableFeeLine, creditOwedFeeLines } =
  await import("~/lib/billing/credit-note");
const schema = await import("~/db/schema");

/** `invoiced` false models the maturity case: the ledger row exists but nothing
 *  ever reached Stripe, so there is no invoice to credit against. */
async function seed(opts: { invoiced?: boolean; kind?: "recovery" | "dispute" } = {}) {
  const invoiced = opts.invoiced ?? true;
  const kind = opts.kind ?? "recovery";
  const { db } = createInMemoryDb();
  harness.db = db;

  await db.insert(schema.accounts).values({ id: ACCOUNT, name: "Credit Co", createdAt: BILLED_AT });
  await db.insert(schema.failedPayments).values({
    id: PAYMENT,
    accountId: ACCOUNT,
    stripeEventId: "evt_credit",
    stripeInvoiceId: "in_merchant",
    stripeCustomerId: "cus_merchant",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "recovered",
    detectedAt: BILLED_AT,
  });
  await db.insert(schema.recoveredPayments).values({
    id: RECOVERY,
    failedPaymentId: PAYMENT,
    accountId: ACCOUNT,
    recoveredAt: BILLED_AT,
    amountCents: 10_000,
    currency: "usd",
    recoveryMethod: "email",
    attributionKind: "email_engaged",
  });
  await db.insert(schema.disputes).values({
    id: DISPUTE,
    accountId: ACCOUNT,
    stripeDisputeId: "dp_stripe_1",
    stripeChargeId: "ch_1",
    amountCents: 10_000,
    currency: "usd",
    reason: "fraudulent",
    status: "won",
    state: "resolved_won",
    createdAt: BILLED_AT,
  });
  await db.insert(schema.billingInvoices).values({
    id: INVOICE,
    accountId: ACCOUNT,
    currency: "usd",
    periodStart: BILLED_AT,
    periodEnd: BILLED_AT,
    status: invoiced ? "finalized" : "draft",
    // The presence of this is what "already on a finalized platform invoice"
    // means: it is written only after createPlatformInvoice returns.
    stripeInvoiceId: invoiced ? "in_platform_1" : null,
    totalCents: FEE_CENTS,
    idempotencyKey: "billing:acct_credit:usd:2026-06",
    createdAt: BILLED_AT,
  });
  await db.insert(schema.billingLineItems).values({
    id: FEE_LINE,
    invoiceId: INVOICE,
    accountId: ACCOUNT,
    type: kind === "recovery" ? "recovery_fee" : "dispute_fee",
    currency: "usd",
    amountCents: FEE_CENTS,
    feeCents: FEE_CENTS,
    recoveredPaymentId: kind === "recovery" ? RECOVERY : null,
    disputeId: kind === "dispute" ? DISPUTE : null,
    description: "Fee",
    createdAt: BILLED_AT,
  });
  return db;
}

async function lines(db: Awaited<ReturnType<typeof seed>>) {
  return db
    .select()
    .from(schema.billingLineItems)
    .where(eq(schema.billingLineItems.type, "credit"));
}

/** Stamp the recovery as the refund webhook would: `cents` refunded so far,
 *  and refunded_at once it is all of it. */
async function refund(db: Awaited<ReturnType<typeof seed>>, cents = 10_000) {
  await db
    .update(schema.recoveredPayments)
    .set({ refundedCents: cents, ...(cents >= 10_000 ? { refundedAt: REFUNDED_AT } : {}) })
    .where(eq(schema.recoveredPayments.id, RECOVERY));
}

const RECOVERY_EVIDENCE = { recoveredPaymentId: RECOVERY };
const DISPUTE_EVIDENCE = { disputeId: DISPUTE };
const OPTS = { now: REFUNDED_AT, description: "Refunded recovery: fee credited" };

beforeEach(() => {
  harness.db = null;
  harness.creditNoteCalls = [];
  harness.failCreditNote = false;
  harness.seen = new Set<string>();
  harness.stripeNotes = [];
});

describe("a refund AFTER the fee was invoiced", () => {
  it("issues exactly one credit note and writes exactly one credit line", async () => {
    const db = await seed();
    await refund(db);

    const outcome = await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);
    expect(outcome.credited).toBe(true);

    expect(harness.creditNoteCalls).toHaveLength(1);
    const call = harness.creditNoteCalls[0];
    expect(call.args.invoice).toBe("in_platform_1");
    // credit_amount, not refund_amount: no cash moves.
    expect(call.args.credit_amount).toBe(FEE_CENTS);
    expect(call.args.refund_amount).toBeUndefined();
    expect(call.options?.idempotencyKey).toBe(`credit-note:${FEE_LINE}:${FEE_CENTS}`);

    const credits = await lines(db);
    expect(credits).toHaveLength(1);
    expect(credits[0].amountCents).toBe(-FEE_CENTS);
    expect(credits[0].creditsLineItemId).toBe(FEE_LINE);
    expect(credits[0].stripeCreditNoteId).toBe("cn_1");
    // FK-linked to the SAME evidence row as the fee it reverses.
    expect(credits[0].recoveredPaymentId).toBe(RECOVERY);
    expect(credits[0].currency).toBe("usd");
  });
});

describe("a second refund event on the same line", () => {
  it("yields no second note and no second line", async () => {
    const db = await seed();
    await refund(db);
    await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    const second = await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    expect(second).toEqual({ credited: false, reason: "nothing_owed" });
    expect(harness.creditNoteCalls).toHaveLength(1);
    expect(await lines(db)).toHaveLength(1);
  });
});

describe("the failure shape", () => {
  it("a Stripe failure writes no credit line and never throws at the caller", async () => {
    const db = await seed();
    await refund(db);
    harness.failCreditNote = true;

    const outcome = await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    // The refund stamp has already committed by the time this runs. A Stripe
    // outage must not unwind a ledger fact that is true.
    expect(outcome).toEqual({ credited: false, reason: "credit_note_failed" });
    expect(await lines(db)).toHaveLength(0);
  });
});

// The webhook's credit never throws and its redelivery is a duplicate that skips
// the clawback, so without the sweep a failed Stripe call would keep the fee.
describe("the daily credit-note-retry sweep", () => {
  const stampRefund = (db: Awaited<ReturnType<typeof seed>>) => refund(db);

  it("credits a fee the webhook failed to credit, exactly once", async () => {
    const db = await seed();
    // Not refunded: nothing is owed, so the sweep must not touch it.
    expect(await creditOwedFeeLines({} as Env, REFUNDED_AT)).toEqual({
      credited: 0,
      failed: [],
      full: false,
    });

    await stampRefund(db);
    harness.failCreditNote = true;
    await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);
    expect(await lines(db)).toHaveLength(0);

    harness.failCreditNote = false;
    expect((await creditOwedFeeLines({} as Env, REFUNDED_AT)).credited).toBe(1);
    expect((await creditOwedFeeLines({} as Env, REFUNDED_AT)).credited).toBe(0);
    expect(await lines(db)).toHaveLength(1);
  });

  it("credits an invoiced recovery fee once when the recovered payment is charged back", async () => {
    const db = await seed();
    await db
      .update(schema.recoveredPayments)
      .set({ disputedAt: REFUNDED_AT })
      .where(eq(schema.recoveredPayments.id, RECOVERY));

    expect((await creditOwedFeeLines({} as Env, REFUNDED_AT)).credited).toBe(1);
    // A refund on the same payment later is the same fee line: no second credit.
    await stampRefund(db);
    expect((await creditOwedFeeLines({} as Env, REFUNDED_AT)).credited).toBe(0);
    expect(await lines(db)).toHaveLength(1);
  });

  it("finds a note that reached Stripe without its ledger row instead of issuing a second", async () => {
    // Stripe prunes idempotency keys after 24 hours, and the sweep is daily, so
    // the key cannot be what stops the second note.
    const db = await seed();
    await stampRefund(db);
    harness.stripeNotes.push({
      id: "cn_earlier",
      invoice: "in_platform_1",
      status: "issued",
      amount: FEE_CENTS,
      metadata: { fee_line_item_id: FEE_LINE },
    });

    expect((await creditOwedFeeLines({} as Env, REFUNDED_AT)).credited).toBe(1);
    expect(harness.creditNoteCalls).toHaveLength(0);
    const credits = await lines(db);
    expect(credits).toHaveLength(1);
    expect(credits[0].stripeCreditNoteId).toBe("cn_earlier");
  });

  it("never reissues a note someone voided, and reports it", async () => {
    const db = await seed();
    await stampRefund(db);
    harness.stripeNotes.push({
      id: "cn_voided",
      invoice: "in_platform_1",
      status: "void",
      amount: FEE_CENTS,
      metadata: { fee_line_item_id: FEE_LINE },
    });

    const result = await creditOwedFeeLines({} as Env, REFUNDED_AT);
    expect(result.failed.map((f) => f.lineItemId)).toEqual([FEE_LINE]);
    expect(harness.creditNoteCalls).toHaveLength(0);
    expect(await lines(db)).toHaveLength(0);
  });
});

// The fee is reduced by the refunded share; a full refund means no fee.
describe("a PARTIAL refund after the fee was invoiced credits the refunded share", () => {
  it("credits the share, raises the same credit line as more is refunded, and the whole fee at a full refund", async () => {
    const db = await seed();

    // 2,500 of 10,000 refunded: the fee on the 7,500 kept is 1,500, so 500 back.
    await refund(db, 2_500);
    expect((await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS)).credited).toBe(
      true,
    );
    // Half refunded in all: 1,000 owed back, 500 of it new.
    await refund(db, 5_000);
    expect((await creditOwedFeeLines({} as Env, REFUNDED_AT)).credited).toBe(1);
    // All of it: the whole fee.
    await refund(db, 10_000);
    expect((await creditOwedFeeLines({} as Env, REFUNDED_AT)).credited).toBe(1);

    expect(harness.creditNoteCalls.map((c) => c.args.credit_amount)).toEqual([500, 500, 1_000]);
    const credits = await lines(db);
    expect(credits).toHaveLength(1);
    expect(credits[0].amountCents).toBe(-FEE_CENTS);
    // Settled: nothing more is owed or found.
    expect((await creditOwedFeeLines({} as Env, REFUNDED_AT)).credited).toBe(0);
    expect(harness.creditNoteCalls).toHaveLength(3);
  });

  it("a refund too small to move the fee credits nothing and stops being looked for", async () => {
    const db = await seed();
    await refund(db, 1);

    expect(await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS)).toEqual({
      credited: false,
      reason: "nothing_owed",
    });
    expect(harness.creditNoteCalls).toHaveLength(0);
    const [fee] = await db
      .select()
      .from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.id, FEE_LINE));
    expect(fee.refundedCents).toBe(1);
  });
});

describe("the fee line lookup itself", () => {
  it("does not mistake a dispute fee for a recovery fee, or the reverse", async () => {
    await seed({ kind: "dispute" });
    // The dispute's fee exists, but this asks about the recovery.
    expect(await findCreditableFeeLine({} as Env, RECOVERY_EVIDENCE)).toBeNull();
    expect(await findCreditableFeeLine({} as Env, DISPUTE_EVIDENCE)).not.toBeNull();
  });

  it("the fee line's own no-double-billing index still holds", async () => {
    const db = await seed();
    // The index is scoped to fee types so a credit can carry the same evidence
    // FK; a recovery still cannot carry two recovery_fee lines.
    await expect(
      db.insert(schema.billingLineItems).values({
        id: "bli_double_fee",
        invoiceId: INVOICE,
        accountId: ACCOUNT,
        type: "recovery_fee",
        currency: "usd",
        amountCents: FEE_CENTS,
        recoveredPaymentId: RECOVERY,
        description: "double bill",
        createdAt: REFUNDED_AT,
      }),
    ).rejects.toThrow();
  });
});
