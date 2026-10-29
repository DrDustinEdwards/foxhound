import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Recova stopped card retries for a customer who won a dispute against the
// merchant (handleDisputeClosed, process-recovery). This drives the real due-step
// query and the real lost-dispute read against a migrated schema: the retry is
// never charged, the step goes terminal, and the suppression is recorded.

const T0 = new Date("2026-07-26T00:00:00.000Z");

const harness = vi.hoisted(() => ({ db: null as unknown, outcomes: [] as unknown[] }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/engine/outcomes", () => ({
  recordOutcome: async (_env: unknown, params: unknown) => {
    harness.outcomes.push(params);
    return true;
  },
}));

const { runRecoveryTick } = await import("~/lib/cron/recovery-tick");
const schema = await import("~/db/schema");

async function seed(disputeState: string) {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(schema.accounts).values({ id: "acc_1", name: "Live Co", createdAt: T0 });
  await db.insert(schema.stripeConnections).values({
    id: "conn_1",
    accountId: "acc_1",
    stripeUserId: "acct_1",
    stripeAccessToken: "iv:cipher",
    isPrimary: true,
    createdAt: T0,
  });
  await db.insert(schema.failedPayments).values({
    id: "fp_1",
    accountId: "acc_1",
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
    accountId: "acc_1",
    failedPaymentId: "fp_1",
    stepType: "retry_early",
    stepNumber: 1,
    scheduledAt: T0,
  });
  await db.insert(schema.disputes).values({
    id: "dp_1",
    accountId: "acc_1",
    stripeDisputeId: "dp_stripe_1",
    stripeChargeId: "ch_1",
    stripeCustomerId: "cus_1",
    amountCents: 10_000,
    currency: "usd",
    reason: "fraudulent",
    status: "lost",
    state: disputeState,
    createdAt: T0,
  });
  return db;
}

const deps = (runRetry: ReturnType<typeof vi.fn>) => ({
  runRetry,
  checkGuards: async () => ({ tickEnabled: true, accountEligible: true }),
  flipExhausted: async () => [],
});

beforeEach(() => {
  harness.outcomes = [];
});

describe("a lost dispute stops card retries", () => {
  it("skips the charge, stamps the step and records the suppression", async () => {
    const db = await seed("resolved_lost");
    const runRetry = vi.fn(async () => ({ recovered: false }));

    await runRecoveryTick({} as Env, deps(runRetry));

    expect(runRetry).not.toHaveBeenCalled();
    const [step] = await db.select().from(schema.recoverySteps).where(eq(schema.recoverySteps.id, "step_1"));
    expect(step.result).toBe("retry_skipped_dispute_lost");
    expect(step.executedAt).not.toBeNull();
    expect(harness.outcomes).toEqual([
      expect.objectContaining({
        accountId: "acc_1",
        eventType: "recovery_retry_suppressed",
        outcome: "suppressed",
        idempotencyKey: "recovery_retry_suppressed_step_1",
      }),
    ]);
  });

  it("still charges when the customer's dispute was won", async () => {
    await seed("resolved_won");
    const runRetry = vi.fn(async () => ({ recovered: false }));

    await runRecoveryTick({} as Env, deps(runRetry));

    expect(runRetry).toHaveBeenCalledTimes(1);
    expect(harness.outcomes).toEqual([]);
  });
});
