import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Review LOW-3: the brake's existing tick coverage asserted the account-level
// PREDICATE in isolation. That is the thing the brake changes, but it is not the
// thing that decides whether a card gets charged. This file drives the real
// composed selection query and the real mid-run guard against a migrated
// in-memory schema, so "a brake-paused account's due steps are not selected" is
// asserted rather than inferred from a WHERE clause.

const ACCOUNT_ID = "acc_live";
const T0 = new Date("2026-07-26T00:00:00.000Z");

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { checkTickGuards, queryDueRecoverySteps } = await import("~/lib/cron/recovery-tick");
const { engageBrake, releaseBrake } = await import("~/lib/admin/brake.server");
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

describe("the brake against the real step-selection query", () => {
  it("a due step is selected before the brake and NOT selected after", async () => {
    const db = await seed();
    const laterThanDue = new Date(T0.getTime() + 60_000);

    expect(await queryDueRecoverySteps({} as Env, laterThanDue)).toHaveLength(1);

    await engageBrake(db, { actorEmail: ACTOR });

    // The composed query, not the predicate: joins, status filter and all.
    expect(await queryDueRecoverySteps({} as Env, laterThanDue)).toHaveLength(0);
  });

  it("releasing the brake makes the same step selectable again", async () => {
    const db = await seed();
    const laterThanDue = new Date(T0.getTime() + 60_000);

    await engageBrake(db, { actorEmail: ACTOR });
    await releaseBrake(db, { actorEmail: ACTOR });

    // Nothing about the step changed: it was never executed, never stamped.
    expect(await queryDueRecoverySteps({} as Env, laterThanDue)).toHaveLength(1);
  });
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

    // Missing row means ENABLED (gotcha #44). Getting this backwards would make
    // the guard halt every tick on a fresh database.
    expect((await checkTickGuards({} as Env, ACCOUNT_ID)).tickEnabled).toBe(true);

    await db
      .insert(schema.cronConfig)
      .values({ cronName: RECOVERY_TICK_CRON_NAME, enabled: false, updatedAt: T0 });

    expect((await checkTickGuards({} as Env, ACCOUNT_ID)).tickEnabled).toBe(false);
  });

  it("reports an unknown account as ineligible rather than throwing", async () => {
    await seed();
    expect((await checkTickGuards({} as Env, "acc_does_not_exist")).accountEligible).toBe(false);
  });
});

describe("LOW-B: the tick guard fails closed in BOTH halves", () => {
  it("treats a missing cron_config row as enabled (gotcha 44), not as a failure", async () => {
    await seed();
    expect((await checkTickGuards({} as Env, ACCOUNT_ID)).tickEnabled).toBe(true);
  });

  it("throws rather than reading a malformed batch result as enabled", async () => {
    await seed();
    // The fail-open shape the review flagged: `cfgRows[0]?.enabled ?? true`
    // could not tell "no row" from "the read did not return what I expected",
    // and resolved both to enabled on the control whose job is stopping a loop
    // that charges cards.
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
