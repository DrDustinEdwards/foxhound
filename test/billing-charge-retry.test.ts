import { monthKey } from "@dustinedwards/site-runtime/time";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FEE_INVOICE_MAX_RETRY_ATTEMPTS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// These tests exercise charging itself, so the hard-rule-12 switch is on here.
vi.mock("~/lib/billing/charges-switch", () => ({ PLATFORM_CHARGES_ENABLED: true }));

// Stranded invoices: the ledger commits, then the charge fails, so the sweep must retry without double-charging
// (including when Stripe charged but our ref write failed: Stripe idempotency keys expire in 24 hours).

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
    customers: { retrieve: async () => ({ invoice_settings: { default_payment_method: "pm_1" } }) },
  }),
}));

const { queryStrandedInvoices, retryInvoiceCharge, runChargeRetrySweep } =
  await import("~/lib/billing/charge-retry");
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

/** Stripe stand-in. `existing` is what a metadata search finds; `pay` refuses a draft, as Stripe does. */
function stripeDeps(
  existing: {
    id: string;
    status: string;
    total?: number;
    hosted_invoice_url?: string | null;
  } | null,
  overrides: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  // Mutable so `finalize` can move it out of draft, exactly as Stripe would.
  const state = { status: existing?.status ?? null };
  // The seeded invoice holds one 2,000-cent line; a draft's total defaults to it.
  const total = existing?.total ?? 2_000;
  return {
    calls,
    state,
    deps: {
      findExisting: async () => {
        calls.push("findExisting");
        return (existing ? { ...existing, total, status: state.status as string } : null) as never;
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

describe("mode 1: the create threw, Stripe has nothing", () => {
  it("COUNTS THE ATTEMPT when the create throws, so the cap is reachable", async () => {
    const db = await seed();
    const { deps } = stripeDeps(null, {
      create: async () => {
        throw new Error("stripe unavailable");
      },
    });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);

    expect(result.outcome).toBe("failed");
    expect(result.reason).toBe("stripe unavailable");

    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.chargeAttemptCount).toBe(1);
    expect(row.status).toBe("payment_failed");
    expect(row.lastChargeAttemptAt).toEqual(NOW);
    // No Stripe id was obtained, so none is recorded.
    expect(row.stripeInvoiceId).toBeNull();
  });

  it("rebuilds the line keys from the committed line items, not from the billable queries", async () => {
    // Retries derive lines from the ledger so the per-item idempotency keys match the original attempt's.
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
      recoveryFeeItemIdempotencyKey(ACCOUNT_ID, monthKey(PERIOD_START), "usd", "rec_1"),
    );
  });
});

describe("mode 2: Stripe charged, our ref write failed", () => {
  it("adopts the existing paid invoice instead of creating a second one", async () => {
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

describe("a Stripe invoice stuck in draft", () => {
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

  it("leaves a draft whose attached items do not add up to the invoice untouched", async () => {
    const db = await seed({ status: "draft", stripeInvoiceId: "in_platform_draft" });
    const { calls, deps } = stripeDeps({ id: "in_platform_draft", status: "draft", total: 0 });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result).toMatchObject({ outcome: "skipped", reason: "draft_lines_incomplete" });
    expect(calls).toEqual(["findExisting"]);
    expect((await db.select().from(schema.billingInvoices))[0].status).toBe("draft");
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

  it("finalizes a stranded send_invoice draft so Stripe emails it, and never pays it", async () => {
    const db = await seed({ status: "draft", stripeInvoiceId: "in_platform_draft" });
    const seen: unknown[] = [];
    const { calls, deps } = stripeDeps(
      { id: "in_platform_draft", status: "draft", collection_method: "send_invoice" } as never,
      {
        finalize: async (_env: Env, id: string, _billingInvoiceId: string, opts?: unknown) => {
          seen.push(opts);
          return { id, status: "open", hosted_invoice_url: "https://pay/open" } as never;
        },
      },
    );
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    // Finalized once, with the same params as the first attempt (auto_advance
    // on), which is what makes Stripe email it.
    expect(seen).toHaveLength(1);
    // The merchant pays an emailed invoice from Stripe's page; the sweep never charges it.
    expect(calls.some((c) => c.startsWith("pay:"))).toBe(false);
    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("finalized");
    expect(row.chargeAttemptCount).toBe(0);
  });

  it("leaves an open emailed invoice to Stripe: no pay, no failed attempt", async () => {
    const db = await seed({ status: "finalized", stripeInvoiceId: "in_emailed" });
    const { calls, deps } = stripeDeps({
      id: "in_emailed",
      status: "open",
      collection_method: "send_invoice",
    } as never);
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result.outcome).toBe("skipped");
    expect(calls).toEqual(["findExisting"]);
    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("finalized");
    expect(row.chargeAttemptCount).toBe(0);
  });

  it("syncs an emailed invoice the merchant paid", async () => {
    const db = await seed({ status: "finalized", stripeInvoiceId: "in_emailed" });
    const { calls, deps } = stripeDeps({
      id: "in_emailed",
      status: "paid",
      collection_method: "send_invoice",
    } as never);
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(calls).toEqual(["findExisting"]);
    expect((await db.select().from(schema.billingInvoices))[0].status).toBe("paid");
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
  it("creates and stores a platform customer for an account with none, then bills against it", async () => {
    const db = await seed({ platformCustomerId: null });
    let created: { platformCustomerId: string } | null = null;
    const { calls, deps } = stripeDeps(null, {
      ensureCustomer: async () => "cus_made_by_sweep",
      create: async (_env: Env, input: { platformCustomerId: string }) => {
        created = input;
        return { stripeInvoiceId: "in_platform_new", hostedInvoiceUrl: "https://pay/new" };
      },
    });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result.outcome).toBe("charged");
    expect(created!.platformCustomerId).toBe("cus_made_by_sweep");
    expect(calls).toEqual(["findExisting"]);
    const [account] = await db.select().from(schema.accounts);
    expect(account.platformStripeCustomerId).toBe("cus_made_by_sweep");
  });

  it("never charges an account whose platform customer could not be made", async () => {
    await seed({ platformCustomerId: null });
    const { calls, deps } = stripeDeps(null, {
      ensureCustomer: async () => {
        throw new Error("stripe unavailable");
      },
    });
    const [invoice] = await queryStrandedInvoices({} as Env, 100);

    const result = await retryInvoiceCharge({} as Env, invoice, NOW_MS, deps);
    expect(result).toEqual({
      invoiceId: "binv_1",
      outcome: "skipped",
      reason: "no_platform_customer",
    });
    expect(calls).toEqual([]); // Stripe never touched for the invoice
  });

  it("never sweeps an invoice with no line Stripe would be sent", async () => {
    // Covers a missing ledger and an admin adjustment alike: neither has a
    // chargeable line, so retrying could only fail it month after month.
    await seed({ withLineItem: false });
    expect(await queryStrandedInvoices({} as Env, 100)).toEqual([]);
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
  it("runMonthlyBilling runs the sweep, so the recovery needs no separate cron", async () => {
    const db = await seed();

    await runMonthlyBilling({} as Env, NOW_MS);

    expect(stripeSpy.searched).toEqual(["metadata['billing_invoice_id']:'binv_1'"]);
    expect(stripeSpy.created).toBe(1);

    const [row] = await db.select().from(schema.billingInvoices);
    expect(row.status).toBe("finalized");
    expect(row.stripeInvoiceId).toBe("in_from_run");
    expect(row.chargeAttemptCount).toBe(1);
  });
});

describe("the brake stops the sweep already in flight", () => {
  /** Three stranded invoices on three accounts, so the loop has somewhere to go. */
  async function seedThree() {
    const db = await seed({ status: "draft", stripeInvoiceId: null, withLineItem: true });
    for (const n of [2, 3]) {
      await db.insert(schema.accounts).values({
        id: `acc_${n}`,
        name: `Co ${n}`,
        createdAt: PERIOD_START,
        platformStripeCustomerId: `cus_platform_${n}`,
        billingExempt: false,
      });
      await db.insert(schema.billingInvoices).values({
        id: `inv_${n}`,
        accountId: `acc_${n}`,
        currency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_START,
        status: "draft",
        totalCents: 2_000,
        idempotencyKey: `billing:acc_${n}:usd:2026-07`,
        createdAt: CREATED_AT,
      });
      await db.insert(schema.billingLineItems).values({
        id: `li_${n}`,
        invoiceId: `inv_${n}`,
        accountId: `acc_${n}`,
        type: "recovery_fee",
        currency: "usd",
        amountCents: 2_000,
        description: "fee",
        createdAt: CREATED_AT,
      });
    }
    return db;
  }

  it("stops charging within one invoice when the brake engages mid-sweep", async () => {
    await seedThree();
    const created: string[] = [];
    let checks = 0;

    const results = await runChargeRetrySweep({} as Env, NOW_MS, {
      deps: {
        findExisting: async () => null,
        create: async (_env, input) => {
          created.push(input.billingInvoiceId);
          return { stripeInvoiceId: "in_new", hostedInvoiceUrl: null };
        },
        // Eligible for the first invoice only: the operator hits the brake.
        checkGuard: async () => {
          checks += 1;
          return { billingEligible: checks <= 2 };
        },
      },
    });

    expect(created).toHaveLength(1);
    // Skipped, never failed: nothing went wrong, an operator stopped it.
    const skipped = results.filter((r) => r.outcome === "skipped");
    expect(skipped).toHaveLength(2);
    expect(results.filter((r) => r.outcome === "failed")).toHaveLength(0);
    expect(skipped.every((r) => r.reason === "account_not_billing_eligible")).toBe(true);
  });

  it("closes the window between the loop check and the charge itself", async () => {
    // Eligible at the loop-level check, brake engaged before the Stripe call.
    await seedThree();
    const created: string[] = [];
    let call = 0;

    const results = await runChargeRetrySweep({} as Env, NOW_MS, {
      limit: 1,
      deps: {
        findExisting: async () => null,
        create: async (_env, input) => {
          created.push(input.billingInvoiceId);
          return { stripeInvoiceId: "in_new", hostedInvoiceUrl: null };
        },
        checkGuard: async () => {
          call += 1;
          return { billingEligible: call === 1 }; // loop yes, pre-charge no
        },
      },
    });

    expect(created).toEqual([]);
    expect(results[0]?.outcome).toBe("skipped");
  });

  it("guards the pay path too, not only the create path", async () => {
    // The retry branch: Stripe already holds an open invoice and the sweep would
    // collect on it. payPlatformInvoice moves money exactly like create does.
    await seed({ status: "payment_failed", stripeInvoiceId: "in_existing", withLineItem: true });
    const { calls, deps } = stripeDeps(
      { id: "in_existing", status: "open" },
      { checkGuard: async () => ({ billingEligible: false }) },
    );

    const result = await retryInvoiceCharge(
      {} as Env,
      (await queryStrandedInvoices({} as Env, 10))[0]!,
      NOW_MS,
      deps,
    );

    expect(calls.some((c) => c.startsWith("pay:"))).toBe(false);
    expect(result.outcome).toBe("skipped");
  });
});

describe("an aborted sweep is visible, and stops exactly where it should", () => {
  // The sweep aborts when it cannot read the billing gate, but that must not stop the new-period billing after it.

  /** The stranded invoice plus a second account with an unbilled matured recovery. */
  async function seedStrandedPlusBillable() {
    const db = await seed();
    await db.insert(schema.accounts).values({
      id: "acc_newperiod",
      name: "New Period Co",
      createdAt: PERIOD_START,
      platformStripeCustomerId: null,
      billingExempt: false,
    });
    await db.insert(schema.failedPayments).values({
      id: "fp_np",
      accountId: "acc_newperiod",
      stripeEventId: "evt_np",
      stripeInvoiceId: "in_merchant_np",
      stripeCustomerId: "cus_np",
      customerEmail: "np@example.com",
      amountCents: 5_000,
      currency: "usd",
      declineCategory: "soft",
      status: "recovered",
      detectedAt: PERIOD_START,
    });
    await db.insert(schema.recoveredPayments).values({
      id: "rec_np",
      accountId: "acc_newperiod",
      failedPaymentId: "fp_np",
      recoveredAt: PERIOD_START,
      amountCents: 5_000,
      currency: "usd",
      recoveryMethod: "foxhound_retry",
      attributionKind: "foxhound_retry",
    });
    return db;
  }

  /** Eligible at the loop level, unreadable at the pre-charge read. */
  function guardThatDiesBeforeCharging() {
    let calls = 0;
    return {
      calls: () => calls,
      checkGuard: async () => {
        calls += 1;
        if (calls === 1) return { billingEligible: true };
        throw new Error("d1 unavailable");
      },
    };
  }

  it("reports the abort by name, and says which read failed", async () => {
    await seedStrandedPlusBillable();
    const guard = guardThatDiesBeforeCharging();
    const created: string[] = [];

    const { sweep } = await runMonthlyBilling({} as Env, NOW_MS, {
      sweepDeps: {
        findExisting: async () => null,
        create: async (_env, input) => {
          created.push(input.billingInvoiceId);
          return { stripeInvoiceId: "in_new", hostedInvoiceUrl: null };
        },
        checkGuard: guard.checkGuard,
      },
    });

    expect(sweep.status).toBe("aborted");
    expect(sweep.abortReason).toMatch(/billing guard unreadable/);
    expect(sweep.abortReason).toMatch(/d1 unavailable/);
    // It got as far as the pre-charge read and no further.
    expect(guard.calls()).toBe(2);
    expect(created).toEqual([]);
  });
});
