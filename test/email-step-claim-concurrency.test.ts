import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { buildEmailStepPatch } from "~/lib/engine/execute-step";
import { buildRetryStepPatch } from "~/lib/engine/retry-step";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Ruling 260, the double-send guard. buildEmailStepPatch used to claim on id
// alone (WHERE id = ?), while both retry patches claimed on id AND executed_at
// IS NULL. That was safe only while the 5-minute recovery cron was the SOLE
// caller under its lock. S7 Phase 2 adds a second caller, the manual "Trigger
// next step now" action, which runs on a request thread with no such lock, so
// two claimants of the same email step became reachable: the cron picking the
// step up on its tick while a merchant clicks the button.
//
// Without the claim, BOTH writes land: the second overwrites the first's
// terminal state, and because each caller sends its own email before patching,
// the customer receives the dunning email twice. Legacy guards exactly this and
// says why, in a comment written about its own manual trigger route: "the
// trigger route shares this executor with the hourly cron and runs without the
// cron lock, so a manual trigger racing the cron must not record the
// retry_attempted outcome twice" (lib/recovery-execution.ts).
//
// Proven against a REAL in-memory SQLite with the committed migrations applied,
// so what stops the second write is the actual WHERE clause running against the
// actual schema, not a SQL-shape assertion that would pass on a typo.

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

describe("ruling 260: the email step claim admits exactly one writer", () => {
  it("two concurrent claims of the same step: the first wins and the second changes nothing", () => {
    const { sqlite, db } = seedPendingEmailStep();

    // Racer A (say the cron tick) sends its email and claims the step.
    const aChanges = runStatement(
      sqlite,
      buildEmailStepPatch(db, "step_e", terminal("email_sent", now)),
    );

    // Racer B (the manual trigger) read the same unexecuted row before A
    // committed, so it proceeds to its own patch. This is the exact statement
    // the executor issues; the claim must refuse it.
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

  it("the loser cannot overwrite the cached copy either, whichever order they arrive in", () => {
    const { sqlite, db } = seedPendingEmailStep();

    runStatement(
      sqlite,
      buildEmailStepPatch(db, "step_e", terminal("email_sent", now), {
        subject: "Winner subject",
        bodyHtml: "<p>Winner</p>",
      }),
    );
    const loserChanges = runStatement(
      sqlite,
      buildEmailStepPatch(db, "step_e", terminal("email_sent", later), {
        subject: "Loser subject",
        bodyHtml: "<p>Loser</p>",
      }),
    );

    expect(loserChanges).toBe(0);
    const row = sqlite
      .prepare("select ai_subject from recovery_steps where id = 'step_e'")
      .get() as { ai_subject: string | null };
    expect(row.ai_subject).toBe("Winner subject");
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

  it("regression guard: the retry sibling already claimed this way and still does", () => {
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
