import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// E25 (J97). Recova creates every account's billing customer when the merchant
// connects Stripe (app/api/auth/stripe/callback/route.ts, blob c60331af,
// ensureBillingCustomer), with the billing email on it, so every billable
// account gets an invoice: charged when a card is on file, emailed by Stripe
// when not. Foxhound created the customer only when billing setup started, and
// the run skipped an account without one, so that merchant got no invoice at
// all. The run now creates the customer through ensurePlatformCustomer.

const ACCOUNT_ID = "acc_no_customer";
const RUN_MS = new Date("2026-08-01T04:00:00.000Z").getTime();

const harness = vi.hoisted(() => ({
  db: null as unknown,
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

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

vi.mock("~/lib/stripe/client", () => {
  const record = (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      harness.calls.push({ method, args });
      return result;
    };
  return {
    getStripe: () => ({
      accounts: {
        retrieve: record("accounts.retrieve", {
          business_profile: { support_email: "billing@example.com" },
          email: "acct@example.com",
        }),
      },
      customers: {
        create: record("customers.create", { id: "cus_created" }),
        // A brand-new customer: no card yet, email set at creation.
        retrieve: record("customers.retrieve", {
          id: "cus_created",
          email: "billing@example.com",
          invoice_settings: { default_payment_method: null },
          default_source: null,
        }),
        update: record("customers.update", {}),
      },
      invoices: {
        create: record("invoices.create", { id: "in_new" }),
        finalizeInvoice: record("invoices.finalizeInvoice", { id: "in_new", hosted_invoice_url: "https://pay/new" }),
      },
      invoiceItems: { create: record("invoiceItems.create", { id: "ii_1" }) },
    }),
  };
});

const { runAccountBilling } = await import("~/lib/billing/run");
const schema = await import("~/db/schema");
const { user } = await import("~/db/auth-schema");

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  harness.calls = [];
  await db.insert(schema.accounts).values({
    id: ACCOUNT_ID,
    name: "Example Co",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    platformStripeCustomerId: null,
    billingExempt: false,
  });
  await db.insert(user).values({ id: "user_1", name: "Owner", email: "login@example.com" });
  await db.insert(schema.accountMembers).values({
    id: "mem_1",
    accountId: ACCOUNT_ID,
    userId: "user_1",
    role: "owner",
    status: "active",
  });
  await db.insert(schema.stripeConnections).values({
    id: "conn_1",
    accountId: ACCOUNT_ID,
    stripeUserId: "acct_merchant",
    isPrimary: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  await db.insert(schema.failedPayments).values({
    id: "fp_1",
    accountId: ACCOUNT_ID,
    stripeEventId: "evt_1",
    stripeInvoiceId: "in_merchant_1",
    stripeCustomerId: "cus_payer",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "recovered",
    detectedAt: new Date("2026-06-01T00:00:00.000Z"),
  });
  await db.insert(schema.recoveredPayments).values({
    id: "rec_1",
    accountId: ACCOUNT_ID,
    failedPaymentId: "fp_1",
    recoveredAt: new Date("2026-06-20T00:00:00.000Z"),
    amountCents: 10_000,
    currency: "usd",
    recoveryMethod: "foxhound_retry",
    attributionKind: "foxhound_retry",
  });
  return db;
}

describe("an account with billable lines and no platform customer (E25)", () => {
  it("gets a platform customer with Recova's billing email, stored, and an invoice against it", async () => {
    const db = await seed();

    const result = await runAccountBilling({} as Env, { accountId: ACCOUNT_ID, nowMs: RUN_MS });

    const create = harness.calls.find((c) => c.method === "customers.create");
    expect(create).toBeTruthy();
    expect((create!.args[0] as Record<string, unknown>).email).toBe("billing@example.com");

    const [account] = await db
      .select({ id: schema.accounts.platformStripeCustomerId })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, ACCOUNT_ID));
    expect(account.id).toBe("cus_created");

    const invoice = harness.calls.find((c) => c.method === "invoices.create");
    expect((invoice!.args[0] as Record<string, unknown>).customer).toBe("cus_created");
    expect((invoice!.args[0] as Record<string, unknown>).collection_method).toBe("send_invoice");
    expect(result.invoices[0].charged).toBe(true);
  });
});
