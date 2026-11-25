import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { buildEmailStepPatch } from "~/lib/engine/execute-step";
import { buildRetryStepPatch } from "~/lib/engine/retry-step";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// The email step claim (WHERE executed_at IS NULL) admits one writer, so a cron tick racing the manual
// trigger cannot send a dunning email twice. Run against real SQLite so the actual WHERE clause is tested.

const now = new Date("2026-08-11T00:00:00.000Z");
const later = new Date("2026-08-11T00:05:00.000Z");

/** One account, one failed payment, one UNEXECUTED email step (step_e). */
function seedPendingEmailStep() {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Acme" }));
  runStatement(
    sqlite,
    db.insert(failedPayments).values({
      id: "fp_1",
      accountId: "acc_1",
      stripeEventId: "evt_1",
      stripeInvoiceId: "in_1",
      stripeCustomerId: "cus_1",
      customerEmail: "customer@example.com",
      amountCents: 4200,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: now,
    }),
  );
  runStatement(
    sqlite,
    db.insert(recoverySteps).values({
      id: "step_e",
      accountId: "acc_1",
      failedPaymentId: "fp_1",
      stepType: "email_day1",
      scheduledAt: now,
      executedAt: null,
      result: null,
      attemptCount: 0,
    }),
  );
  return { sqlite, db };
}

function readStep(sqlite: ReturnType<typeof seedPendingEmailStep>["sqlite"]) {
  return sqlite
    .prepare("select result, executed_at, attempt_count from recovery_steps where id = 'step_e'")
    .get() as { result: string | null; executed_at: number | null; attempt_count: number };
}

const terminal = (result: string, executedAt: Date) => ({
  attemptCount: 1,
  lastAttemptError: null,
  nextRetryAt: null,
  executedAt,
  result,
});

describe("the email step claim admits exactly one writer", () => {
  it("two concurrent claims of the same step: the first wins and the second changes nothing", () => {
    const { sqlite, db } = seedPendingEmailStep();

    const aChanges = runStatement(
      sqlite,
      buildEmailStepPatch(db, "step_e", terminal("email_sent", now)),
    );

    const bChanges = runStatement(
      sqlite,
      buildEmailStepPatch(db, "step_e", terminal("email_failed", later)),
    );

    expect(aChanges).toBe(1);
    expect(bChanges).toBe(0);

    // The loser did not overwrite the winner's terminal state.
    const row = readStep(sqlite);
    expect(row.result).toBe("email_sent");
    expect(row.executed_at).toBe(now.getTime());
  });

  it("a step still in BACKOFF is untouched by the claim: the retry transition still lands", () => {
    const { sqlite, db } = seedPendingEmailStep();

    // A transient send failure leaves executed_at NULL on purpose, so the step
    // stays pending for the next tick. The claim must not block that write, or
    // bounded retry would stop advancing its attempt count.
    const changes = runStatement(
      sqlite,
      buildEmailStepPatch(db, "step_e", {
        attemptCount: 1,
        lastAttemptError: "smtp timeout",
        nextRetryAt: later,
        executedAt: null,
        result: null,
      }),
    );

    expect(changes).toBe(1);
    const row = readStep(sqlite);
    expect(row.attempt_count).toBe(1);
    expect(row.executed_at).toBeNull();

    // And it is still claimable afterwards, so the next tick can finish it.
    const finish = runStatement(
      sqlite,
      buildEmailStepPatch(db, "step_e", terminal("email_sent", later)),
    );
    expect(finish).toBe(1);
    expect(readStep(sqlite).result).toBe("email_sent");
  });

  it("the retry patch claims the same way", () => {
    const { sqlite, db } = seedPendingEmailStep();

    const first = runStatement(
      sqlite,
      buildRetryStepPatch(db, "step_e", {
        executedAt: now,
        result: "retry_succeeded",
        retryResult: "retry_succeeded",
      }),
    );
    const second = runStatement(
      sqlite,
      buildRetryStepPatch(db, "step_e", {
        executedAt: later,
        result: "retry_failed",
        retryResult: "retry_failed",
      }),
    );

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(readStep(sqlite).result).toBe("retry_succeeded");
  });
});
