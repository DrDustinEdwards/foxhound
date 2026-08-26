import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 377(5), PRICING.md rev 5 item 1: POST-BILLING CLAWBACK IS A STRIPE
// CREDIT NOTE, REVERSING REV 2'S "NO AUTOMATIC CREDIT AFTER BILLING".
//
// Rev 2 was right about refunds and wrong about chargebacks. A recovery is not
// billed until it is 30 to 60 days settled and the billable predicate excludes
// anything stamped refunded at run time, so an ordinary refund never reaches an
// invoice: that is the CONTROL below, and it must credit nothing. A dispute
// lands up to roughly 120 days out, long after the fee was invoiced and
// charged, and there maturity has done all it can. Foxhound kept 20% of money
// the merchant no longer had.
//
// THE PLANTS RUN REAL SQL against the committed migrations and a fake Stripe
// that records its calls, so "exactly one credit note call" is counted rather
// than assumed, and the unique index doing the deduping is the real one.

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
  creditNoteCalls: [] as { args: Record<string, unknown>; options: Record<string, unknown> | undefined }[],
  failCreditNote: false,
  seen: new Set<string>(),
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
        return { id: `cn_${harness.creditNoteCalls.length}` };
      },
    },
  }),
  getConnectedStripe: () => {
    throw new Error("connected stripe must not be used here");
  },
}));

// The money DO, modelled with its seen-set so the idempotency key is doing real
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

const { issueCreditNoteForEvidence, findCreditableFeeLine } = await import(
  "~/lib/billing/credit-note"
);
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
  return db.select().from(schema.billingLineItems).where(eq(schema.billingLineItems.type, "credit"));
}

const RECOVERY_EVIDENCE = { recoveredPaymentId: RECOVERY };
const DISPUTE_EVIDENCE = { disputeId: DISPUTE };
const OPTS = { now: REFUNDED_AT, description: "Refunded recovery: fee credited" };

beforeEach(() => {
  harness.db = null;
  harness.creditNoteCalls = [];
  harness.failCreditNote = false;
  harness.seen = new Set<string>();
});

describe("a refund AFTER the fee was invoiced", () => {
  it("issues exactly one credit note and writes exactly one credit line", async () => {
    const db = await seed();

    const outcome = await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);
    expect(outcome.credited).toBe(true);

    expect(harness.creditNoteCalls).toHaveLength(1);
    const call = harness.creditNoteCalls[0];
    expect(call.args.invoice).toBe("in_platform_1");
    // credit_amount, NOT refund_amount: the money goes to the customer balance
    // in that currency, and no cash moves. That distinction is the ruling.
    expect(call.args.credit_amount).toBe(FEE_CENTS);
    expect(call.args.refund_amount).toBeUndefined();
    expect(call.options?.idempotencyKey).toBe(`credit-note:${FEE_LINE}`);

    const credits = await lines(db);
    expect(credits).toHaveLength(1);
    expect(credits[0].amountCents).toBe(-FEE_CENTS);
    expect(credits[0].creditsLineItemId).toBe(FEE_LINE);
    expect(credits[0].stripeCreditNoteId).toBe("cn_1");
    // FK-linked to the SAME evidence row as the fee it reverses.
    expect(credits[0].recoveredPaymentId).toBe(RECOVERY);
    expect(credits[0].currency).toBe("usd");
  });

  it("does not rewrite the invoice it credits", async () => {
    const db = await seed();
    await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    const [invoice] = await db.select().from(schema.billingInvoices);
    // A credit note offsets an invoice, it does not edit one. This is what the
    // merchant was invoiced and what Stripe finalized.
    expect(invoice.totalCents).toBe(FEE_CENTS);
    expect(invoice.status).toBe("finalized");
  });
});

describe("CONTROL: a refund BEFORE the fee was invoiced", () => {
  it("credits nothing, because maturity already handled it", async () => {
    const db = await seed({ invoiced: false });

    const outcome = await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    expect(outcome).toEqual({ credited: false, reason: "no_charged_fee_line" });
    // The control that matters: a clawback that fired on everything would pass
    // every assertion in the block above.
    expect(harness.creditNoteCalls).toHaveLength(0);
    expect(await lines(db)).toHaveLength(0);
  });

  it("and a recovery with no fee line at all credits nothing", async () => {
    const db = await seed();
    await db.delete(schema.billingLineItems).where(eq(schema.billingLineItems.id, FEE_LINE));

    expect(await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS)).toEqual({
      credited: false,
      reason: "no_charged_fee_line",
    });
    expect(harness.creditNoteCalls).toHaveLength(0);
    expect(await lines(db)).toHaveLength(0);
  });
});

describe("a SECOND refund event on the same line", () => {
  it("yields no second note and no second line", async () => {
    const db = await seed();
    await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    const second = await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    expect(second).toEqual({ credited: false, reason: "no_charged_fee_line" });
    expect(harness.creditNoteCalls).toHaveLength(1);
    expect(await lines(db)).toHaveLength(1);
  });

  it("AND THE DATABASE REFUSES ONE EVEN IF THE READ IS BYPASSED", async () => {
    // The read above is a courtesy that avoids a redundant Stripe call. The
    // guarantee is the unique index, so it is exercised directly rather than
    // trusted: a caller reaching the insert with the check skipped still cannot
    // produce a second credit for one fee line.
    const db = await seed();
    await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    await expect(
      db.insert(schema.billingLineItems).values({
        id: "bli_second_credit",
        invoiceId: INVOICE,
        accountId: ACCOUNT,
        type: "credit",
        currency: "usd",
        amountCents: -FEE_CENTS,
        recoveredPaymentId: RECOVERY,
        description: "second credit",
        createdAt: REFUNDED_AT,
        stripeCreditNoteId: "cn_rogue",
        creditsLineItemId: FEE_LINE,
      }),
    ).rejects.toThrow();

    expect(await lines(db)).toHaveLength(1);
  });
});

describe("a LOST dispute on a dispute fee behaves the same as a refund on a recovery fee", () => {
  it("issues one credit note against the invoice and links the dispute", async () => {
    const db = await seed({ kind: "dispute" });

    const outcome = await issueCreditNoteForEvidence({} as Env, DISPUTE_EVIDENCE, {
      now: REFUNDED_AT,
      description: "Dispute lost after billing: fee credited",
    });

    expect(outcome.credited).toBe(true);
    expect(harness.creditNoteCalls).toHaveLength(1);
    expect(harness.creditNoteCalls[0].args.credit_amount).toBe(FEE_CENTS);

    const credits = await lines(db);
    expect(credits).toHaveLength(1);
    expect(credits[0].disputeId).toBe(DISPUTE);
    expect(credits[0].recoveredPaymentId).toBeNull();
    expect(credits[0].amountCents).toBe(-FEE_CENTS);
  });

  it("a second lost-dispute delivery yields nothing new", async () => {
    const db = await seed({ kind: "dispute" });
    await issueCreditNoteForEvidence({} as Env, DISPUTE_EVIDENCE, OPTS);
    await issueCreditNoteForEvidence({} as Env, DISPUTE_EVIDENCE, OPTS);

    expect(harness.creditNoteCalls).toHaveLength(1);
    expect(await lines(db)).toHaveLength(1);
  });
});

describe("the failure shape", () => {
  it("a Stripe failure writes no credit line and never throws at the caller", async () => {
    const db = await seed();
    harness.failCreditNote = true;

    const outcome = await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    // The refund stamp has already committed by the time this runs. A Stripe
    // outage must not unwind a ledger fact that is true.
    expect(outcome).toEqual({ credited: false, reason: "credit_note_failed" });
    expect(await lines(db)).toHaveLength(0);
  });

  it("and the retry after that failure credits exactly once", async () => {
    const db = await seed();
    harness.failCreditNote = true;
    await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    harness.failCreditNote = false;
    const retry = await issueCreditNoteForEvidence({} as Env, RECOVERY_EVIDENCE, OPTS);

    expect(retry.credited).toBe(true);
    expect(await lines(db)).toHaveLength(1);
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
    // 377(5) scoped that index to the fee types so a credit could carry the
    // same evidence FK. The guard it exists for must be unchanged: a recovery
    // still cannot carry two recovery_fee lines.
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
