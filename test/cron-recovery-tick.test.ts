import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import { accounts, recoverySteps } from "~/db";
import * as schema from "~/db/schema";
import { SUBREQUEST_BUDGET } from "~/lib/admin/brake.server";
import { RECOVERY_TICK_LIMIT } from "~/lib/constants";
import {
  accountProcessingEligibleCondition,
  chooseStepsPerPayment,
  runRecoveryTick,
  stepDueCondition,
  type DueStepRow,
} from "~/lib/cron/recovery-tick";

const db = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

function row(overrides: Partial<DueStepRow> = {}): DueStepRow {
  return {
    stepId: "s1",
    stepType: "email_day1",
    stepNumber: 1,
    accountId: "acc_1",
    failedPaymentId: "fp_1",
    scheduledAt: new Date("2026-07-01T00:00:00.000Z"),
    nextRetryAt: null,
    attemptCount: 0,
    customBody: null,
    aiSubject: "S",
    aiBodyHtml: "<p>B</p>",
    invoiceId: "in_1",
    amountCents: 4200,
    currency: "usd",
    customerEmail: "c@example.com",
    declineCategory: "soft",
    connectionAccessToken: "iv:cipher",
    merchantName: "Acme",
    brandVoice: null,
    merchantIndustry: null,
    primaryCustomerType: null,
    merchantMrrCents: null,
    ...overrides,
  };
}

/** Permissive guard for tests about dispatch rather than gating. Passing it
 *  explicitly (rather than defaulting the guard open) keeps the real default
 *  fail-closed, which is the whole point of the mid-run check. */
const allowAll = async () => ({ tickEnabled: true, accountEligible: true });

describe("recovery tick: SQL gating predicates (compile against schema)", () => {
  it("processing gate excludes demo + paused accounts, but NOT billing_exempt", () => {
    const sql = sqlOf(db.select().from(accounts).where(accountProcessingEligibleCondition()));
    const where = sql.sql.split(/\bwhere\b/i)[1] ?? "";
    expect(where).toMatch(/processing_paused/i);
    expect(where).toMatch(/not like/i);
    expect(sql.params).toContain("demo_%");
    // billing_exempt is a BILLING gate, never a processing gate: an exempt
    // merchant still gets recovery processing, so it never appears in the WHERE.
    expect(where).not.toMatch(/billing_exempt/i);
  });

  it("due predicate requires an unexecuted, unresolved, live step whose time has come", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const sql = sqlOf(db.select().from(recoverySteps).where(stepDueCondition(now)));
    expect(sql.sql).toMatch(/executed_at.*is null/i);
    expect(sql.sql).toMatch(/result.*is null/i);
    expect(sql.sql).toMatch(/deleted_at.*is null/i);
    expect(sql.sql).toMatch(/next_retry_at/i);
    expect(sql.sql).toMatch(/scheduled_at/i);
  });
});

describe("recovery tick: one step per payment, silent-first", () => {
  it("keeps only the earliest-due step per failed payment", () => {
    const rows = [
      row({ stepId: "a_email", failedPaymentId: "fp_A", stepType: "email_day1", stepNumber: 2, scheduledAt: new Date("2026-07-02T00:00:00.000Z") }),
      row({ stepId: "a_retry", failedPaymentId: "fp_A", stepType: "retry_early", stepNumber: 1, scheduledAt: new Date("2026-07-01T00:00:00.000Z") }),
      row({ stepId: "b_email", failedPaymentId: "fp_B", stepType: "email_day3", stepNumber: 1, scheduledAt: new Date("2026-07-01T00:00:00.000Z") }),
    ];
    const chosen = chooseStepsPerPayment(rows);
    expect(chosen).toHaveLength(2);
    const byPayment = new Map(chosen.map((c) => [c.failedPaymentId, c.stepId]));
    // fp_A had a retry AND an email due; the earlier retry wins (silent-first).
    expect(byPayment.get("fp_A")).toBe("a_retry");
    expect(byPayment.get("fp_B")).toBe("b_email");
  });

  it("uses next_retry_at as the effective due time when a send was rescheduled", () => {
    const rows = [
      row({ stepId: "resched", failedPaymentId: "fp_C", scheduledAt: new Date("2026-07-01T00:00:00.000Z"), nextRetryAt: new Date("2026-07-05T00:00:00.000Z") }),
      row({ stepId: "fresh", failedPaymentId: "fp_C", scheduledAt: new Date("2026-07-03T00:00:00.000Z"), nextRetryAt: null, stepNumber: 2 }),
    ];
    // fresh's effective time (Jul 3) beats resched's next_retry_at (Jul 5).
    expect(chooseStepsPerPayment(rows).map((c) => c.stepId)).toEqual(["fresh"]);
  });
});

describe("recovery tick: dispatch, isolation, telemetry", () => {
  it("dispatches by step type, counts recoveries, and isolates a failing step", async () => {
    const due = [
      row({ stepId: "retry_ok", failedPaymentId: "fp_1", stepType: "retry_early" }),
      row({ stepId: "email_boom", failedPaymentId: "fp_2", stepType: "email_day1" }),
      row({ stepId: "email_ok", failedPaymentId: "fp_3", stepType: "email_day3" }),
    ];
    const retried: string[] = [];
    const emailed: string[] = [];
    const result = await runRecoveryTick({} as Env, {
      query: async () => due,
      checkGuards: allowAll,
      runRetry: async (_env, ctx) => {
        retried.push(ctx.stepId);
        return { recovered: true };
      },
      runEmail: async (_env, ctx) => {
        emailed.push(ctx.stepId);
        if (ctx.stepId === "email_boom") throw new Error("EMAIL binding down");
        return {};
      },
    });
    // The retry ran and recovered; the failing email was isolated; the sweep
    // continued to the third step.
    expect(retried).toEqual(["retry_ok"]);
    expect(emailed).toContain("email_ok");
    expect(result.rowsProcessed).toBe(2); // 1 retry + 1 successful email
    expect(result.message).toMatch(/1 retries \(1 recovered\)/);
    expect(result.message).toMatch(/1 failed/);
  });

  it("skips a retry step with no connected token instead of charging blind, and records the attempt", async () => {
    const due = [
      row({
        stepId: "no_token",
        stepType: "retry_early",
        connectionAccessToken: null,
        attemptCount: 1,
      }),
    ];
    let charged = false;
    const recorded: { stepId: string; attemptCount: number }[] = [];
    const result = await runRecoveryTick({} as Env, {
      query: async () => due,
      checkGuards: allowAll,
      runRetry: async () => {
        charged = true;
        return { recovered: false };
      },
      runEmail: async () => ({}),
      flipExhausted: async () => 0,
      recordMissingToken: async (_env, step) => {
        recorded.push(step);
        return null;
      },
    });
    expect(charged).toBe(false);
    expect(result.rowsProcessed).toBe(0);
    expect(result.message).toMatch(/1 skipped/);
    // Skipping with NO write at all is what made the step re-select forever.
    // The attempt count has to be threaded through or the grace never bounds.
    expect(recorded).toEqual([{ stepId: "no_token", attemptCount: 1 }]);
  });

  it("counts an unrecordable step as failed, not skipped, because it WILL come back", async () => {
    const due = [row({ stepId: "no_token", stepType: "retry_early", connectionAccessToken: null })];
    const result = await runRecoveryTick({} as Env, {
      query: async () => due,
      checkGuards: allowAll,
      runRetry: async () => ({ recovered: false }),
      runEmail: async () => ({}),
      flipExhausted: async () => 0,
      recordMissingToken: async () => {
        throw new Error("d1 unavailable");
      },
    });
    expect(result.message).toMatch(/0 skipped/);
    expect(result.message).toMatch(/1 failed/);
  });
});

describe("MEDIUM-1: the brake stops work already in flight, not just the next run", () => {
  const threeSteps = [
    row({ stepId: "s1", failedPaymentId: "fp_1", stepType: "retry_early" }),
    row({ stepId: "s2", failedPaymentId: "fp_2", stepType: "retry_early" }),
    row({ stepId: "s3", failedPaymentId: "fp_3", stepType: "retry_early" }),
  ];

  it("stops charging within ONE step when the account is paused mid-run", async () => {
    const charged: string[] = [];
    let checks = 0;
    const result = await runRecoveryTick({} as Env, {
      query: async () => threeSteps,
      flipExhausted: async () => 0,
      runRetry: async (_env, ctx) => {
        charged.push(ctx.stepId);
        return { recovered: false };
      },
      runEmail: async () => ({}),
      // The operator engages the brake after the first step has run.
      checkGuards: async () => {
        checks += 1;
        return { tickEnabled: true, accountEligible: checks <= 1 };
      },
    });

    // Exactly one charge landed. Before this guard, all three did, because
    // eligibility was only evaluated when the batch was selected.
    expect(charged).toEqual(["s1"]);
    expect(checks).toBe(3); // re-checked per step, not once per run
    // Audited as skipped, never failed: nothing went wrong, an operator stopped it.
    expect(result.message).toMatch(/2 skipped \(account paused mid-run\)/);
    expect(result.message).toMatch(/0 failed/);
  });

  it("exits cleanly when the tick is disabled mid-run, leaving the rest re-selectable", async () => {
    const charged: string[] = [];
    let checks = 0;
    const result = await runRecoveryTick({} as Env, {
      query: async () => threeSteps,
      flipExhausted: async () => 0,
      runRetry: async (_env, ctx) => {
        charged.push(ctx.stepId);
        return { recovered: false };
      },
      runEmail: async () => ({}),
      checkGuards: async () => {
        checks += 1;
        return { tickEnabled: checks <= 2, accountEligible: true };
      },
    });

    expect(charged).toEqual(["s1", "s2"]);
    expect(result.message).toMatch(/HALTED \(tick disabled mid-run\)/);
    expect(result.message).toMatch(/0 failed/);
    // The untouched steps carry no result and no executed_at, so the next
    // enabled tick re-selects them: a halt loses nothing.
    expect(result.message).not.toMatch(/skipped \(account paused mid-run\)/);
  });

  it("costs one batched read per step, so the guard cannot blow the subrequest budget alone", async () => {
    // checkTickGuards issues ONE db.batch (two statements) per step. Asserting
    // the call count keeps a future refactor from turning it into two round
    // trips, which at RECOVERY_TICK_LIMIT would double the tick's read cost.
    let checks = 0;
    await runRecoveryTick({} as Env, {
      query: async () => threeSteps,
      flipExhausted: async () => 0,
      runRetry: async () => ({ recovered: false }),
      runEmail: async () => ({}),
      checkGuards: async () => {
        checks += 1;
        return { tickEnabled: true, accountEligible: true };
      },
    });
    expect(checks).toBe(threeSteps.length);
  });
});

describe("MEDIUM-1: the guard fails CLOSED", () => {
  it("aborts the tick rather than charging when it cannot read the gates", async () => {
    // Deliberately outside the per-step try/catch. If the guard read fails we do
    // not know whether the brake is engaged, and on a loop that charges cards the
    // safe answer to "I cannot tell" is to stop. A transient D1 error costs one
    // tick; the steps are untouched and the next tick re-selects them.
    const charged: string[] = [];
    await expect(
      runRecoveryTick({} as Env, {
        query: async () => [row({ stepId: "s1", stepType: "retry_early" })],
        flipExhausted: async () => 0,
        runRetry: async (_env, ctx) => {
          charged.push(ctx.stepId);
          return { recovered: false };
        },
        runEmail: async () => ({}),
        checkGuards: async () => {
          throw new Error("d1 unavailable");
        },
      }),
    ).rejects.toThrow(/d1 unavailable/);
    expect(charged).toEqual([]);
  });
});

describe("RECOVERY_TICK_LIMIT is inside an honest subrequest budget", () => {
  // Asserted arithmetic, not a comment. 500 was never reachable: a full batch
  // would have spent thousands of subrequests against a ~1000 ceiling. It only
  // ever looked safe because a full batch has never occurred on a platform with
  // one seeded demo account.
  //
  // Conservative per-step cost, itemised in the constant's own comment: the
  // guard read, the Stripe or AI call, the send, and the state write.
  const PER_STEP_SUBREQUESTS = 5;

  it("pins the limit, so raising it silently fails CI", () => {
    expect(RECOVERY_TICK_LIMIT).toBe(100);
  });

  it("a full batch fits, and the old value did not", () => {
    expect(RECOVERY_TICK_LIMIT * PER_STEP_SUBREQUESTS).toBeLessThan(SUBREQUEST_BUDGET);
    expect(500 * PER_STEP_SUBREQUESTS).toBeGreaterThan(SUBREQUEST_BUDGET);
  });

  it("leaves headroom for the fixed per-run costs on top of the steps", () => {
    // Selection query + exhausted sweep (2 queries) + one cron_run_history write.
    const fixed = 4;
    expect(RECOVERY_TICK_LIMIT * PER_STEP_SUBREQUESTS + fixed).toBeLessThan(SUBREQUEST_BUDGET);
  });
});

describe("LOW-C: a halted tick does nothing further", () => {
  it("skips the exhausted sweep when the tick was disabled mid-run", async () => {
    let swept = 0;
    const result = await runRecoveryTick({} as Env, {
      query: async () => [row({ stepId: "s1", stepType: "retry_early" })],
      runRetry: async () => ({ recovered: false }),
      runEmail: async () => ({}),
      flipExhausted: async () => {
        swept += 1;
        return 3;
      },
      checkGuards: async () => ({ tickEnabled: false, accountEligible: true }),
    });

    expect(swept).toBe(0);
    expect(result.message).toMatch(/exhausted-sweep skipped \(halted\)/);
  });

  it("still runs the sweep on a normal tick", async () => {
    let swept = 0;
    await runRecoveryTick({} as Env, {
      query: async () => [row({ stepId: "s1", stepType: "retry_early" })],
      runRetry: async () => ({ recovered: false }),
      runEmail: async () => ({}),
      flipExhausted: async () => {
        swept += 1;
        return 0;
      },
      checkGuards: allowAll,
    });
    expect(swept).toBe(1);
  });
});
