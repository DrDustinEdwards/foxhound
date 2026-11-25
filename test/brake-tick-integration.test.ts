import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Drives the real composed selection guard against a migrated in-memory schema: a brake-paused account's due steps are not selected.

const ACCOUNT_ID = "acc_live";
const T0 = new Date("2026-07-26T00:00:00.000Z");

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { checkTickGuards } = await import("~/lib/cron/tick-guards");
const { engageBrake } = await import("~/lib/admin/brake.server");
const { RECOVERY_TICK_CRON_NAME } = await import("~/lib/constants");
const schema = await import("~/db/schema");

const ACTOR = "admin@foxhoundapp.com";

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;

  await db.insert(schema.accounts).values({
    id: ACCOUNT_ID,
    name: "Live Co",
    billingExempt: false,
    processingPaused: false,
    createdAt: T0,
  });
  await db.insert(schema.stripeConnections).values({
    id: "conn_1",
    accountId: ACCOUNT_ID,
    stripeUserId: "acct_1",
    stripeAccessToken: "iv:cipher",
    isPrimary: true,
    createdAt: T0,
  });
  await db.insert(schema.failedPayments).values({
    id: "fp_1",
    accountId: ACCOUNT_ID,
    stripeConnectionId: "conn_1",
    stripeEventId: "evt_1",
    stripeInvoiceId: "in_1",
    stripeCustomerId: "cus_1",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "active",
    detectedAt: T0,
  });
  await db.insert(schema.recoverySteps).values({
    id: "step_1",
    accountId: ACCOUNT_ID,
    failedPaymentId: "fp_1",
    stepType: "retry_early",
    stepNumber: 1,
    scheduledAt: T0,
  });
  return db;
}

beforeEach(() => {
  harness.db = null;
});

describe("the real mid-run guard reads live state", () => {
  it("reports the account ineligible the moment the brake marks it", async () => {
    const db = await seed();

    expect(await checkTickGuards({} as Env, ACCOUNT_ID)).toEqual({
      tickEnabled: true,
      accountEligible: true,
    });

    await engageBrake(db, { actorEmail: ACTOR });

    expect(await checkTickGuards({} as Env, ACCOUNT_ID)).toEqual({
      tickEnabled: true,
      accountEligible: false,
    });
  });

  it("reports the tick disabled from cron_config, and treats a missing row as enabled", async () => {
    const db = await seed();

    // A missing row means enabled.
    expect((await checkTickGuards({} as Env, ACCOUNT_ID)).tickEnabled).toBe(true);

    await db
      .insert(schema.cronConfig)
      .values({ cronName: RECOVERY_TICK_CRON_NAME, enabled: false, updatedAt: T0 });

    expect((await checkTickGuards({} as Env, ACCOUNT_ID)).tickEnabled).toBe(false);
  });
});

describe("the tick guard fails closed in both halves", () => {
  it("throws rather than reading a malformed batch result as enabled", async () => {
    await seed();
    const realBatch = (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch;
    (harness.db as { batch: unknown }).batch = async () => [{ notAnArray: true }, []];
    await expect(checkTickGuards({} as Env, ACCOUNT_ID)).rejects.toThrow(/unexpected batch result/);
    (harness.db as { batch: unknown }).batch = realBatch;
  });

  it("throws when a present cron_config row carries a non-boolean enabled", async () => {
    await seed();
    const realBatch = (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch;
    (harness.db as { batch: unknown }).batch = async () => [[{ enabled: "yes" }], []];
    await expect(checkTickGuards({} as Env, ACCOUNT_ID)).rejects.toThrow(/not a boolean/);
    (harness.db as { batch: unknown }).batch = realBatch;
  });
});
