import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// A retry step whose account has no usable connected-account token was skipped
// with no write at all. It stayed unexecuted with a null result, which is
// precisely what stepDueCondition selects, so the tick re-read and re-skipped
// the same step every five minutes forever. Two consequences, not one: wasted
// work every tick, and a sequence that could never finish, because a step that
// never goes terminal keeps its parent 'active' indefinitely.

const ACCOUNT_ID = "acc_notoken";
const DETECTED_AT = new Date("2026-07-25T00:00:00.000Z");

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { flipExhaustedSequences, queryDueRecoverySteps, runRecoveryTick, RETRY_RESULT_NO_CONNECTION } =
  await import("~/lib/cron/recovery-tick");
const schema = await import("~/db/schema");

/** `mode` picks how the token goes missing: a connection row whose token was
 *  cleared (a disconnect), or no connection row on the payment at all. */
async function seed(mode: "null-token" | "no-connection", extraSteps: string[] = []) {
  const { db } = createInMemoryDb();
  harness.db = db;

  await db
    .insert(schema.accounts)
    .values({ id: ACCOUNT_ID, name: "No Token Co", createdAt: DETECTED_AT });
  await db.insert(schema.stripeConnections).values({
    id: "conn_1",
    accountId: ACCOUNT_ID,
    stripeUserId: "acct_connected_1",
    stripeAccessToken: null,
    isPrimary: true,
    createdAt: DETECTED_AT,
  });
  await db.insert(schema.failedPayments).values({
    id: "fp_1",
    accountId: ACCOUNT_ID,
    stripeConnectionId: mode === "null-token" ? "conn_1" : null,
    stripeEventId: "evt_intake",
    stripeInvoiceId: "in_1",
    stripeCustomerId: "cus_1",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "active",
    detectedAt: DETECTED_AT,
  });
  await db.insert(schema.recoverySteps).values({
    id: "step_retry",
    accountId: ACCOUNT_ID,
    failedPaymentId: "fp_1",
    stepType: "retry_early",
    stepNumber: 1,
    scheduledAt: DETECTED_AT,
  });
  for (const [i, stepType] of extraSteps.entries()) {
    await db.insert(schema.recoverySteps).values({
      id: `step_extra_${i}`,
      accountId: ACCOUNT_ID,
      failedPaymentId: "fp_1",
      stepType,
      stepNumber: i + 2,
      // Far future, so it is not due in these ticks.
      scheduledAt: new Date("2026-09-01T00:00:00.000Z"),
    });
  }
  return db;
}

/** Run a tick with the REAL due-step query, but no real Stripe or email. */
function tick(onRetry?: () => void) {
  return runRecoveryTick({} as Env, {
    runRetry: async () => {
      onRetry?.();
      return { recovered: false };
    },
    runEmail: async () => ({}),
  });
}

beforeEach(() => {
  harness.db = null;
});

describe.each(["null-token", "no-connection"] as const)(
  "an unrunnable retry step (%s)",
  (mode) => {
    it("is selected once, stamped terminal, and never selected again", async () => {
      const db = await seed(mode);

      // Tick 1: the step is genuinely due.
      expect(await queryDueRecoverySteps({} as Env, new Date("2026-07-26T00:00:00.000Z"))).toHaveLength(1);

      let charged = false;
      const first = await tick(() => {
        charged = true;
      });
      // Still never charges blind. That guard was always right; it just did not
      // finish the job.
      expect(charged).toBe(false);
      expect(first.message).toMatch(/1 skipped/);

      const [step] = await db.select().from(schema.recoverySteps);
      expect(step.result).toBe(RETRY_RESULT_NO_CONNECTION);
      expect(step.retryResult).toBe(RETRY_RESULT_NO_CONNECTION);
      expect(step.executedAt).not.toBeNull();

      // Tick 2: nothing due. Pre-fix this was still 1, and would have been
      // forever.
      expect(await queryDueRecoverySteps({} as Env, new Date("2026-07-26T00:05:00.000Z"))).toHaveLength(0);
      const second = await tick();
      expect(second.message).toMatch(/0 due/);
      expect(second.message).toMatch(/0 skipped/);
    });
  },
);

describe("what the stamp unblocks", () => {
  it("lets a one-step sequence exhaust into failed_unrecovered", async () => {
    // The interlock with the exhausted-sequence flip: while the step stayed
    // pending, the sequence could never be exhausted, so the payment sat in
    // "In recovery" permanently on top of the wasted work.
    const db = await seed("null-token");

    // Before the stamp the step is pending, so the sequence is not exhausted.
    expect(await flipExhaustedSequences({} as Env, new Date("2026-07-26T00:00:00.000Z"))).toBe(0);

    // One tick both stamps the step and, in the same pass, flips the now-finished
    // sequence: the sweep runs after the step loop for exactly this reason.
    const result = await tick();
    expect(result.message).toMatch(/1 exhausted/);

    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.status).toBe("failed_unrecovered");
  });

  it("lets the sequence move on to its next step rather than ending it", async () => {
    // A stamp is not a stop: the remaining email steps are untouched and still
    // pending, so a disconnected merchant's customers still get dunned.
    const db = await seed("null-token", ["email_day1", "email_day3"]);
    await tick();

    const steps = await db.select().from(schema.recoverySteps);
    const pending = steps.filter((s) => s.executedAt === null && s.result === null);
    expect(pending.map((s) => s.stepType).sort()).toEqual(["email_day1", "email_day3"]);

    // And with steps still pending, the sequence is correctly NOT exhausted.
    expect(await flipExhaustedSequences({} as Env, new Date("2026-07-26T00:01:00.000Z"))).toBe(0);
  });
});
