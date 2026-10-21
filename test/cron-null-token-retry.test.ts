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

const { flipExhaustedSequences, recordMissingTokenAttempt, runRecoveryTick, RETRY_RESULT_NO_CONNECTION } = await import("~/lib/cron/recovery-tick");
const { queryDueRecoverySteps } = await import("~/lib/cron/due-steps");
const { RETRY_TOKEN_MAX_ATTEMPTS, SEND_RETRY_BACKOFF_MINUTES } = await import("~/lib/constants");
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

beforeEach(() => {
  harness.db = null;
});

const T0 = new Date("2026-07-26T00:00:00.000Z");
const minutesAfter = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);

describe.each(["null-token", "no-connection"] as const)(
  "an unrunnable retry step gets bounded grace (%s)",
  (mode) => {
    it("reschedules with backoff instead of dying on the first tick", async () => {
      const db = await seed(mode);
      expect(await queryDueRecoverySteps({} as Env, T0)).toHaveLength(1);

      const result = await recordMissingTokenAttempt({} as Env, { stepId: "step_retry", attemptCount: 0 }, T0);
      expect(result).toBeNull(); // still in grace, no terminal result

      const [step] = await db.select().from(schema.recoverySteps);
      expect(step.attemptCount).toBe(1);
      expect(step.result).toBeNull();
      expect(step.executedAt).toBeNull();
      expect(step.lastAttemptError).toBe("no connected stripe token");
      // Derived from the constant, not a literal: this assertion silently
      // encoded 5 minutes and had to be hand-edited when CHUNKS item 17 restored the
      // legacy backoff span. The behaviour under test is "reschedules by the
      // first backoff", not "reschedules by five minutes".
      const firstBackoff = SEND_RETRY_BACKOFF_MINUTES[0];
      expect(step.nextRetryAt).toEqual(minutesAfter(T0, firstBackoff));

      // Not re-selected until the backoff elapses: the livelock stays fixed.
      expect(await queryDueRecoverySteps({} as Env, minutesAfter(T0, firstBackoff - 1))).toHaveLength(0);
      expect(await queryDueRecoverySteps({} as Env, minutesAfter(T0, firstBackoff + 1))).toHaveLength(1);
    });

    it("goes terminal only on the last attempt, and exactly once", async () => {
      const db = await seed(mode);

      // Attempts 1 and 2 stay pending.
      for (const attempt of [0, 1]) {
        const r = await recordMissingTokenAttempt(
          {} as Env,
          { stepId: "step_retry", attemptCount: attempt },
          T0,
        );
        expect(r).toBeNull();
      }

      // Attempt 3 (RETRY_TOKEN_MAX_ATTEMPTS) is terminal.
      const terminal = await recordMissingTokenAttempt(
        {} as Env,
        { stepId: "step_retry", attemptCount: RETRY_TOKEN_MAX_ATTEMPTS - 1 },
        T0,
      );
      expect(terminal).toBe(RETRY_RESULT_NO_CONNECTION);

      const [step] = await db.select().from(schema.recoverySteps);
      expect(step.result).toBe(RETRY_RESULT_NO_CONNECTION);
      expect(step.retryResult).toBe(RETRY_RESULT_NO_CONNECTION);
      expect(step.executedAt).toEqual(T0);
      expect(step.nextRetryAt).toBeNull();

      // Never selected again, and the conditional claim-on-write means a
      // redelivered tick cannot re-terminate it.
      expect(await queryDueRecoverySteps({} as Env, minutesAfter(T0, 600))).toHaveLength(0);
      await recordMissingTokenAttempt({} as Env, { stepId: "step_retry", attemptCount: 9 }, minutesAfter(T0, 10));
      const [again] = await db.select().from(schema.recoverySteps);
      expect(again.executedAt).toEqual(T0);
      expect(again.attemptCount).toBe(RETRY_TOKEN_MAX_ATTEMPTS);
    });
  },
);

describe("a token that comes back mid-grace", () => {
  it("lets the silent retry run normally instead of having forfeited it", async () => {
    // The whole point of MEDIUM-2: a merchant mid-reconnect must not lose the
    // first and highest-value step of a soft-decline sequence.
    const db = await seed("null-token");
    await recordMissingTokenAttempt({} as Env, { stepId: "step_retry", attemptCount: 0 }, T0);

    // The merchant reconnects: the token is stored again.
    await db
      .update(schema.stripeConnections)
      .set({ stripeAccessToken: "encrypted:reconnected" });

    let charged = 0;
    const result = await runRecoveryTick({} as Env, {
      query: async (env, now) => queryDueRecoverySteps(env, now),
      runRetry: async () => {
        charged += 1;
        return { recovered: false };
      },
      runEmail: async () => ({}),
      flipExhausted: async () => [],
    });
    // The tick's own clock is real time, well past T0 + 5min backoff.
    expect(charged).toBe(1);
    expect(result.message).toMatch(/1 retries/);
  });
});

describe("what the terminal stamp unblocks", () => {
  it("lets a one-step sequence exhaust into failed_unrecovered", async () => {
    const db = await seed("null-token");

    // While the step is pending (in grace) the sequence is NOT exhausted.
    await recordMissingTokenAttempt({} as Env, { stepId: "step_retry", attemptCount: 0 }, T0);
    expect((await flipExhaustedSequences({} as Env, T0)).length).toBe(0);

    // Once terminal it is.
    await recordMissingTokenAttempt(
      {} as Env,
      { stepId: "step_retry", attemptCount: RETRY_TOKEN_MAX_ATTEMPTS - 1 },
      T0,
    );
    expect((await flipExhaustedSequences({} as Env, minutesAfter(T0, 1))).length).toBe(1);

    const [payment] = await db.select().from(schema.failedPayments);
    expect(payment.status).toBe("failed_unrecovered");
  });

  it("leaves the remaining email steps alone", async () => {
    const db = await seed("null-token", ["email_day1", "email_day3"]);
    await recordMissingTokenAttempt(
      {} as Env,
      { stepId: "step_retry", attemptCount: RETRY_TOKEN_MAX_ATTEMPTS - 1 },
      T0,
    );

    const steps = await db.select().from(schema.recoverySteps);
    const pending = steps.filter((s) => s.executedAt === null && s.result === null);
    expect(pending.map((s) => s.stepType).sort()).toEqual(["email_day1", "email_day3"]);
    expect((await flipExhaustedSequences({} as Env, minutesAfter(T0, 1))).length).toBe(0);
  });
});
