import { beforeEach, describe, expect, it, vi } from "vitest";

import { FEE_INVOICE_MAX_RETRY_ATTEMPTS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The stranded-invoice failure mode, end to end. runAccountBilling commits the
// ledger atomically and THEN charges Stripe, so a failure in the second half
// leaves a committed billing_invoices row whose money never moved, and the
// invoice-level idempotency key blocks re-billing the period forever. Nothing
// retried it because nothing existed to do the retrying.
//
// Two stranding modes are exercised here, both from review-findings.md:
//   1. the create threw, Stripe has nothing
//   2. the create SUCCEEDED and our follow-up ref write failed, so Stripe
//      charged the merchant while our row still says draft
//
// Mode 2 is the one that makes the Stripe metadata lookup load-bearing rather
// than defensive: Stripe expires idempotency keys after 24 hours and this sweep
// runs monthly, so a key-only retry would create a SECOND real invoice.

const ACCOUNT_ID = "acc_stranded";
const NOW = new Date("2026-09-01T04:00:00.000Z");
const NOW_MS = NOW.getTime();
const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const CREATED_AT = new Date("2026-08-01T04:00:00.000Z"); // last month's run

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

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

// The sweep's real Stripe seams go through getStripe, so the runMonthlyBilling
// wiring test below exercises the default (uninjected) path.
const stripeSpy = vi.hoisted(() => ({ searched: [] as string[], created: 0 }));
vi.mock("~/lib/stripe/client", () => ({
  getStripe: () => ({
    invoices: {
      search: async ({ query }: { query: string }) => {
        stripeSpy.searched.push(query);
        return { data: [] };
      },
      create: async () => {
        stripeSpy.created += 1;
        return { id: "in_from_run", hosted_invoice_url: null };
      },
      finalizeInvoice: async () => ({ id: "in_from_run", hosted_invoice_url: "https://pay/run" }),
      pay: async (id: string) => ({ id, status: "paid", hosted_invoice_url: null }),
    },
    invoiceItems: { create: async () => ({ id: "ii_1" }) },
  }),
}));

const { queryStrandedInvoices, retryInvoiceCharge, runChargeRetrySweep, periodKeyOf } = await import(
  "~/lib/billing/charge-retry"
);
const { runMonthlyBilling } = await import("~/lib/billing/run");
const { recoveryFeeItemIdempotencyKey } = await import("~/lib/billing/stripe-invoice");
const schema = await import("~/db/schema");

interface SeedOpts {
  status?: string;
  stripeInvoiceId?: string | null;
  chargeAttemptCount?: number;
  platformCustomerId?: string | null;
  totalCents?: number;
  billingExempt?: boolean;
  createdAt?: Date;
  withLineItem?: boolean;
}

async function seed(opts: SeedOpts = {}) {
  const { db } = createInMemoryDb();
  harness.db = db;

  await db.insert(schema.accounts).values({
    id: ACCOUNT_ID,
    name: "Stranded Co",
    createdAt: PERIOD_START,
    platformStripeCustomerId:
      opts.platformCustomerId === undefined ? "cus_platform_1" : opts.platformCustomerId,
    billingExempt: opts.billingExempt ?? false,
  });
  await db.insert(schema.failedPayments).values({
    id: "fp_1",
    accountId: ACCOUNT_ID,
    stripeEventId: "evt_1",
    stripeInvoiceId: "in_merchant_1",
    stripeCustomerId: "cus_1",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "recovered",
    detectedAt: PERIOD_START,
  });
  await db.insert(schema.recoveredPayments).values({
    id: "rec_1",
    accountId: ACCOUNT_ID,
    failedPaymentId: "fp_1",
    recoveredAt: PERIOD_START,
    amountCents: 10_000,
    currency: "usd",
    recoveryMethod: "foxhound_retry",
    attributionKind: "foxhound_retry",
  });
  await db.insert(schema.billingInvoices).values({
    id: "binv_1",
    accountId: ACCOUNT_ID,
    currency: "usd",
    periodStart: PERIOD_START,
    periodEnd: new Date("2026-08-01T00:00:00.000Z"),
    status: opts.status ?? "draft",
    totalCents: opts.totalCents ?? 2_000,
    stripeInvoiceId: opts.stripeInvoiceId ?? null,
    idempotencyKey: "billing:acc_stranded:usd:2026-07",
    createdAt: opts.createdAt ?? CREATED_AT,
    chargeAttemptCount: opts.chargeAttemptCount ?? 0,
  });
  if (opts.withLineItem !== false) {
    await db.insert(schema.billingLineItems).values({
      id: "bli_1",
      invoiceId: "binv_1",
      accountId: ACCOUNT_ID,
      type: "recovery_fee",
      currency: "usd",
      amountCents: 2_000,
      feeCents: 2_000,
      recoveredPaymentId: "rec_1",
      description: "Recovery fee",
      createdAt: CREATED_AT,
    });
  }
  return db;
}

/** Stripe stand-in. `existing` is what a metadata search finds.
 *
 *  `pay` used to be hardcoded to `{ status: "paid" }`, so no test anywhere could
 *  exercise a failed or rejected charge attempt, which is what hid MEDIUM-1.
 *  It now models Stripe's actual rule: an invoice must be finalized before it
 *  can be paid, and paying a draft is an error. */
function stripeDeps(
  existing: { id: string; status: string; hosted_invoice_url?: string | null } | null,
  overrides: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  // Mutable so `finalize` can move it out of draft, exactly as Stripe would.
  const state = { status: existing?.status ?? null };
  return {
    calls,
    state,
    deps: {
      findExisting: async () => {
        calls.push("findExisting");
        return (existing ? { ...existing, status: state.status as string } : null) as never;
      },
      create: async () => {
        calls.push("create");
        return { stripeInvoiceId: "in_platform_new", hostedInvoiceUrl: "https://pay/new" };
      },
      finalize: async (_env: Env, id: string, billingInvoiceId: string) => {
        calls.push(`finalize:${id}:${billingInvoiceId}`);
        if (state.status !== "draft") throw new Error("invoice is already finalized");
        state.status = "open";
        return { id, status: "open", hosted_invoice_url: "https://pay/open" } as never;
      },
      pay: async (_env: Env, id: string, attempt: number) => {
        calls.push(`pay:${id}:${attempt}`);
        // Stripe's real constraint, and the whole point of MEDIUM-1.
        if (state.status === "draft") throw new Error("cannot pay a draft invoice");
        state.status = "paid";
        return { id, status: "paid", hosted_invoice_url: "https://pay/paid" } as never;
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  harness.db = null;
  stripeSpy.searched = [];
  stripeSpy.created = 0;
});

describe("queryStrandedInvoices", () => {
  it("finds an unsettled invoice with a positive total", async () => {
    await seed();
    const rows = await queryStrandedInvoices({} as Env, 100);
    expect(rows.map((r) => r.id)).toEqual(["binv_1"]);
    expect(rows[0].platformCustomerId).toBe("cus_platform_1");
  });

  it("skips invoices that already settled", async () => {
    for (const status of ["paid", "void", "uncollectible", "gave_up"]) {
      await seed({ status });
      expect(await queryStrandedInvoices({} as Env, 100)).toEqual([]);
    }
  });

  it("skips a zero-total invoice, which has nothing chargeable", async () => {
    await seed({ totalCents: 0 });
    expect(await queryStrandedInvoices({} as Env, 100)).toEqual([]);
  });

  it("stops chasing a merchant who became billing-exempt after the invoice was raised", async () => {
    await seed({ billingExempt: true });
    expect(await queryStrandedInvoices({} as Env, 100)).toEqual([]);
  });
});

describe("mode 1: the create threw, Stripe has nothing", () => {
  it("creates the invoice on the next run and records the attempt", async () => {
    const db = await seed();
    const { calls, deps } = stripeDeps(null);
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result.outcome).toBe("charged");
    // LOOK UP before CREATE, always.
    expect(calls).toEqual(["findExisting", "create"]);

    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("finalized");
    expect(row.stripeInvoiceId).toBe("in_platform_new");
    expect(row.chargeAttemptCount).toBe(1);
    expect(row.lastChargeAttemptAt).toEqual(NOW);
  });

  it("rebuilds the line keys from the committed line items, not from the billable queries", async () => {
    // The billable queries exclude already-billed rows, so on a retry they
    // return nothing. Deriving the lines from the ledger is what makes the
    // replayed per-item idempotency keys match the original attempt's.
    await seed();
    let seenLines: { idempotencyKey: string }[] = [];
    const { deps } = stripeDeps(null, {
      create: async (_env: Env, input: { lines: { idempotencyKey: string }[] }) => {
        seenLines = input.lines;
        return { stripeInvoiceId: "in_platform_new", hostedInvoiceUrl: null };
      },
    });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);
    await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);

    expect(seenLines).toHaveLength(1);
    expect(seenLines[0].idempotencyKey).toBe(
      recoveryFeeItemIdempotencyKey(ACCOUNT_ID, periodKeyOf(PERIOD_START), "usd", "rec_1"),
    );
  });
});

describe("mode 2: Stripe charged, our ref write failed", () => {
  it("adopts the existing paid invoice instead of creating a second one", async () => {
    // The double-charge this whole lookup exists to prevent. A key-only retry a
    // month later would call invoices.create with an EXPIRED idempotency key and
    // raise a second real invoice against the merchant.
    const db = await seed({ status: "draft", stripeInvoiceId: null });
    const { calls, deps } = stripeDeps({
      id: "in_platform_existing",
      status: "paid",
      hosted_invoice_url: "https://pay/existing",
    });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result).toEqual({
      invoiceId: "binv_1",
      outcome: "adopted",
      reason: "stripe_status_paid",
    });
    expect(calls).toEqual(["findExisting"]); // never created, never re-paid

    // Self-healed: the row now links to the charge that really happened.
    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("paid");
    expect(row.stripeInvoiceId).toBe("in_platform_existing");
    expect(row.stripeInvoiceUrl).toBe("https://pay/existing");
    // No charge was made, so the attempt count must not move.
    expect(row.chargeAttemptCount).toBe(0);
  });

  it("adopts a voided or uncollectible invoice as terminal, never re-charging it", async () => {
    for (const status of ["void", "uncollectible"]) {
      const db = await seed();
      const { calls, deps } = stripeDeps({ id: "in_platform_dead", status });
      const [invoice] = await queryStrandedInvoices({} as Env, 100);

      const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
      expect(result.outcome).toBe("gave_up");
      expect(result.reason).toBe(`stripe_status_${status}`);
      expect(calls).toEqual(["findExisting"]);
      const [row] = await db.select().from(schema.billingInvoices);
      expect(row.status).toBe(status);
    }
  });
});

describe("collection on a finalized-but-unpaid invoice", () => {
  it("calls invoices.pay, because Stripe does not auto-retry a one-off invoice", async () => {
    const db = await seed({ status: "payment_failed", stripeInvoiceId: "in_platform_open" });
    const { calls, deps } = stripeDeps({ id: "in_platform_open", status: "open" });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result.outcome).toBe("retried");
    expect(calls).toEqual(["findExisting", "pay:in_platform_open:1"]);

    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("paid");
    expect(row.chargeAttemptCount).toBe(1);
  });

  it("stops at the attempt cap and marks the invoice gave_up", async () => {
    const db = await seed({
      status: "payment_failed",
      stripeInvoiceId: "in_platform_open",
      chargeAttemptCount: FEE_INVOICE_MAX_RETRY_ATTEMPTS,
    });
    const { calls, deps } = stripeDeps({ id: "in_platform_open", status: "open" });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result).toEqual({
      invoiceId: "binv_1",
      outcome: "gave_up",
      reason: "max_attempts_reached",
    });
    expect(calls).toEqual(["findExisting"]);

    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("gave_up");
    // And it is out of the sweep's set for good.
    expect(await queryStrandedInvoices({} as Env, 100)).toEqual([]);
  });
});

describe("a Stripe invoice stuck in draft (review MEDIUM-1)", () => {
  // createPlatformInvoice is create, then items, then finalize. A throw on that
  // last call leaves Stripe holding a DRAFT with the items already attached and
  // our row on 'draft'. Before this branch the sweep called invoices.pay on it,
  // Stripe rejected it, the throw skipped writeAttempt so charge_attempt_count
  // never moved, and it repeated monthly until the age cap wrote it off.
  it("finalizes the draft first, then pays it, exactly once", async () => {
    const db = await seed({ status: "draft", stripeInvoiceId: "in_platform_draft" });
    const { calls, deps } = stripeDeps({ id: "in_platform_draft", status: "draft" });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result.outcome).toBe("retried");
    expect(calls).toEqual([
      "findExisting",
      "finalize:in_platform_draft:binv_1",
      "pay:in_platform_draft:1",
    ]);

    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("paid");
    expect(row.chargeAttemptCount).toBe(1);
    // And it leaves the sweep's set for good.
    expect(await queryStrandedInvoices({} as Env, 100)).toEqual([]);
  });

  it("counts the attempt when finalize fails, so the cap can bind", async () => {
    const db = await seed({ status: "draft", stripeInvoiceId: "in_platform_draft" });
    const { deps } = stripeDeps(
      { id: "in_platform_draft", status: "draft" },
      {
        finalize: async () => {
          throw new Error("stripe unavailable");
        },
      },
    );
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result.outcome).toBe("failed");

    // Pre-fix this stayed at 0 forever, so max_attempts_reached was unreachable
    // and only the age cap could ever stop it.
    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.chargeAttemptCount).toBe(1);
    expect(row.status).toBe("payment_failed");
  });

  it("reaches the attempt cap after repeated failures instead of retrying forever", async () => {
    const db = await seed({
      status: "draft",
      stripeInvoiceId: "in_platform_draft",
      chargeAttemptCount: FEE_INVOICE_MAX_RETRY_ATTEMPTS,
    });
    const { calls, deps } = stripeDeps({ id: "in_platform_draft", status: "draft" });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result).toEqual({
      invoiceId: "binv_1",
      outcome: "gave_up",
      reason: "max_attempts_reached",
    });
    expect(calls).toEqual(["findExisting"]); // never touched Stripe again
    expect((await db.select().from(schema.billingInvoices))[0].status).toBe("gave_up");
  });

  it("does not finalize an invoice that is already open", async () => {
    await seed({ status: "payment_failed", stripeInvoiceId: "in_platform_open" });
    const { calls, deps } = stripeDeps({ id: "in_platform_open", status: "open" });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(calls).toEqual(["findExisting", "pay:in_platform_open:1"]);
  });
});

describe("guards", () => {
  it("never charges an account with no stored platform customer id", async () => {
    await seed({ platformCustomerId: null });
    const { calls, deps } = stripeDeps(null);
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result).toEqual({
      invoiceId: "binv_1",
      outcome: "skipped",
      reason: "no_platform_customer",
    });
    expect(calls).toEqual([]); // Stripe never touched at all
  });

  it("skips an invoice whose line items are missing rather than creating an empty one", async () => {
    await seed({ withLineItem: false });
    const { calls, deps } = stripeDeps(null);
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result.reason).toBe("no_line_items");
    expect(calls).toEqual(["findExisting"]);
  });

  it("isolates a per-invoice failure so the sweep completes", async () => {
    await seed();
    const results = await runChargeRetrySweep({} as Env, NOW_MS, {
      deps: {
        findExisting: async () => {
          throw new Error("stripe unavailable");
        },
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("failed");
    expect(results[0].reason).toBe("stripe unavailable");
  });
});

describe("stranded-invoice-recovers-on-next-run", () => {
  it("a draft invoice from last month is charged by this month's run and then leaves the set", async () => {
    const db = await seed();

    // Run 1 (2026-09-01): finds it, creates the Stripe invoice.
    const first = await runChargeRetrySweep({} as Env, NOW_MS, { deps: stripeDeps(null).deps });
    expect(first.map((r) => r.outcome)).toEqual(["charged"]);
    expect((await db.select().from(schema.billingInvoices))[0].stripeInvoiceId).toBe(
      "in_platform_new",
    );

    // Run 2 (2026-10-01): Stripe now reports it paid, so the row is synced and
    // the invoice drops out of the sweep permanently.
    const nextMonth = NOW_MS + 30 * 24 * 60 * 60 * 1000;
    const second = await runChargeRetrySweep({} as Env, nextMonth, {
      deps: stripeDeps({ id: "in_platform_new", status: "paid" }).deps,
    });
    expect(second.map((r) => r.outcome)).toEqual(["adopted"]);

    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("paid");
    expect(await queryStrandedInvoices({} as Env, 100)).toEqual([]);
  });

  it("runMonthlyBilling runs the sweep, so the recovery needs no separate cron", async () => {
    // The wiring. Pre-fix runMonthlyBilling went straight to billing the new
    // period and never looked at prior stranded invoices, which is why a
    // committed-but-uncharged invoice stayed stranded run after run: its own
    // idempotency key blocks re-billing the period, so the main loop could
    // never rescue it either.
    const db = await seed();

    await runMonthlyBilling({} as Env, NOW_MS);

    expect(stripeSpy.searched).toEqual(["metadata['billing_invoice_id']:'binv_1'"]);
    expect(stripeSpy.created).toBe(1);

    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("finalized");
    expect(row.stripeInvoiceId).toBe("in_from_run");
    expect(row.chargeAttemptCount).toBe(1);
  });

  it("a sweep failure never aborts the billing run", async () => {
    const db = await seed({ platformCustomerId: null });
    // No platform customer, so the sweep skips; the run must still complete and
    // leave the ledger untouched.
    await expect(runMonthlyBilling({} as Env, NOW_MS)).resolves.toBeDefined();
    expect((await db.select().from(schema.billingInvoices))[0].status).toBe("draft");
  });
});
