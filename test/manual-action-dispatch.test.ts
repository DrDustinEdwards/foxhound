import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { queryStepForManualTrigger, type DueStepRow } from "~/lib/cron/recovery-tick";
import { buildEmailStepPatch } from "~/lib/engine/execute-step";
import {
  MANUAL_ACTION_INTENTS,
  MANUAL_ACTION_REQUIRES_ACTIVE,
  MANUAL_INTENTS,
  buildStopRecoveryBatch,
  dispatchManualAction,
  manualActionIdempotencyKey,
  noteContentToken,
  parseManualActionIntent,
  parseManualIntent,
  type ManualActionCommit,
  type TriggerDeps,
} from "~/lib/recovery/manual-actions.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// S7 Phase 2, Sessions A and B: the shared manual-action dispatcher. Legacy
// implements these as five route handlers that each re-write auth, account
// scoping, ownership and the status gate, and its copies HAVE drifted
// (parity/S7-PHASE2-SCOPE.md section 1.5). Foxhound has one dispatcher, so the
// gates are pinned once here.
//
// The two WIRED intents (note, cancel) commit through an injected
// ManualActionCommit. In production that is the per-account money-write Durable
// Object (262 decision four); here it runs the EXACT compiled statements against
// a real in-memory SQLite with the committed migrations applied, inside one
// transaction, so what is proven is the real SQL against the real schema.

const now = new Date("2026-08-12T00:00:00.000Z");
const later = new Date("2026-08-12T01:00:00.000Z");

interface StepSeed {
  id: string;
  stepType?: string;
  executedAt?: Date | null;
  result?: string | null;
  aiSubject?: string | null;
  aiBodyHtml?: string | null;
}

/** Two accounts. `fp_mine` belongs to acc_1, `fp_theirs` to acc_2. */
function seed(opts: { status?: string; steps?: StepSeed[]; notes?: string | null } = {}) {
  const { sqlite, db } = createInMemoryDb();
  for (const [id, name] of [
    ["acc_1", "Mine"],
    ["acc_2", "Theirs"],
  ] as const) {
    runStatement(sqlite, db.insert(accounts).values({ id, name }));
  }
  for (const [id, accountId] of [
    ["fp_mine", "acc_1"],
    ["fp_theirs", "acc_2"],
  ] as const) {
    runStatement(
      sqlite,
      db.insert(failedPayments).values({
        id,
        accountId,
        stripeEventId: `evt_${id}`,
        stripeInvoiceId: `in_${id}`,
        stripeCustomerId: `cus_${id}`,
        customerEmail: "customer@example.com",
        amountCents: 4200,
        currency: "usd",
        declineCategory: "soft",
        status: opts.status ?? "active",
        detectedAt: now,
        notes: opts.notes ?? null,
      }),
    );
  }
  for (const s of opts.steps ?? []) {
    runStatement(
      sqlite,
      db.insert(recoverySteps).values({
        id: s.id,
        accountId: "acc_1",
        failedPaymentId: "fp_mine",
        stepType: s.stepType ?? "email_day1",
        scheduledAt: now,
        executedAt: s.executedAt ?? null,
        result: s.result ?? null,
        aiSubject: s.aiSubject ?? null,
        aiBodyHtml: s.aiBodyHtml ?? null,
        attemptCount: 0,
      }),
    );
  }
  return { sqlite, db };
}

/** Runs the batch's compiled statements in ONE transaction, the way the money
 *  DO commits them. Records every key it saw so idempotency can be asserted. */
function inMemoryCommit(sqlite: Database.Database, db: Db, keys: string[] = []): ManualActionCommit {
  return async (_accountId, idempotencyKey, build) => {
    keys.push(idempotencyKey);
    const batch = build(db);
    sqlite.transaction(() => {
      for (const statement of batch) runStatement(sqlite, statement);
    })();
    return { applied: true };
  };
}

function readPayment(sqlite: Database.Database, id = "fp_mine") {
  return sqlite
    .prepare("select status, resolved_at, notes from failed_payments where id = ?")
    .get(id) as { status: string; resolved_at: number | null; notes: string | null };
}

/** Exactly what stepDueCondition keys on: a step the tick would still run. */
function dueStepCount(sqlite: Database.Database) {
  const row = sqlite
    .prepare(
      "select count(*) as n from recovery_steps where executed_at is null and result is null and deleted_at is null",
    )
    .get() as { n: number };
  return row.n;
}

const PENDING: StepSeed = { id: "step_pending" };
const SENT_EMAIL: StepSeed = {
  id: "step_sent",
  executedAt: now,
  result: "email_sent",
  aiSubject: "Subject",
  aiBodyHtml: "<p>Body</p>",
};

/** Trigger deps that fail loudly. A test that reaches an executor it did not
 *  intend to exercise gets an error, never a silent pass. */
function unusedTriggerDeps(): TriggerDeps {
  return {
    loadStep: async () => {
      throw new Error("loadStep called unexpectedly");
    },
    runRetry: async () => {
      throw new Error("runRetry called unexpectedly");
    },
    runEmail: async () => {
      throw new Error("runEmail called unexpectedly");
    },
  };
}

function request(db: Db, commit: ManualActionCommit, over: Record<string, unknown> = {}) {
  return {
    db,
    accountId: "acc_1",
    failedPaymentId: "fp_mine",
    // Default to an intent that is known but writes nothing, so a test which
    // only cares about ownership cannot mutate anything on its way to the answer.
    intent: "mark_recovered",
    commit,
    trigger: unusedTriggerDeps(),
    now,
    ...over,
  } as Parameters<typeof dispatchManualAction>[0];
}

describe("manual actions: intent parsing", () => {
  it("the ACTION ROW is exactly legacy's four, in legacy's order", () => {
    expect([...MANUAL_ACTION_INTENTS]).toEqual(["trigger", "mark_recovered", "cancel", "resend"]);
    expect(parseManualActionIntent("note")).toBeNull();
  });

  it("the dispatcher additionally accepts note, which is not a row button", () => {
    expect([...MANUAL_INTENTS]).toEqual([
      "trigger",
      "mark_recovered",
      "cancel",
      "resend",
      "note",
    ]);
    expect(parseManualIntent("note")).toBe("note");
  });

  it("rejects anything else, including non-string form values", () => {
    for (const raw of ["override_next_email", "", "TRIGGER", null, undefined, 7, {}]) {
      expect(parseManualIntent(raw)).toBeNull();
    }
  });
});

describe("manual actions: ownership is the same 404 as a missing payment", () => {
  it("refuses another account's payment without distinguishing it from a missing one", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    const commit = inMemoryCommit(sqlite, db);

    expect(
      await dispatchManualAction(request(db, commit, { failedPaymentId: "fp_theirs" })),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await dispatchManualAction(request(db, commit, { failedPaymentId: "fp_nope" }))).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("an unowned payment is not mutated even when the intent is wired", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    const commit = inMemoryCommit(sqlite, db);

    await dispatchManualAction(
      request(db, commit, { failedPaymentId: "fp_theirs", intent: "cancel" }),
    );

    expect(readPayment(sqlite, "fp_theirs").status).toBe("active");
  });

  it("an unknown intent is refused BEFORE any payment is loaded", async () => {
    const { sqlite, db } = seed();
    const commit = inMemoryCommit(sqlite, db);
    // fp_nope does not exist; a not_found here would prove the intent check ran
    // second and turned an unknown action into an ownership probe.
    expect(
      await dispatchManualAction(
        request(db, commit, { failedPaymentId: "fp_nope", intent: "override_next_email" }),
      ),
    ).toEqual({ ok: false, reason: "unknown_intent" });
  });
});

describe("manual actions: the status gate ports legacy's per-handler shape", () => {
  it("trigger, mark_recovered and cancel refuse a non-active payment", async () => {
    const { sqlite, db } = seed({ status: "recovered", steps: [PENDING, SENT_EMAIL] });
    const commit = inMemoryCommit(sqlite, db);

    for (const intent of ["trigger", "mark_recovered", "cancel"] as const) {
      expect(await dispatchManualAction(request(db, commit, { intent }))).toEqual({
        ok: false,
        reason: "not_active",
        intent,
      });
    }
    // And the refusal is real: nothing was written.
    expect(readPayment(sqlite).status).toBe("recovered");
    expect(dueStepCount(sqlite)).toBe(1);
  });

  it("note and resend do NOT check status, exactly as legacy's handlers do not", async () => {
    // Legacy's note route has no status gate, and its resend route never selects
    // the status column (scope 1.5 defect 2). Ruling 264 has RULED the check in
    // for resend and Session D flips it; this pins today's value so the flip is
    // a ruling rather than a drift.
    expect(MANUAL_ACTION_REQUIRES_ACTIVE.resend).toBe(false);
    expect(MANUAL_ACTION_REQUIRES_ACTIVE.note).toBe(false);

    const { sqlite, db } = seed({ status: "failed_unrecovered", steps: [SENT_EMAIL] });
    const commit = inMemoryCommit(sqlite, db);

    expect(
      await dispatchManualAction(request(db, commit, { intent: "note", note: "closed out" })),
    ).toEqual({ ok: true, intent: "note" });
    expect(readPayment(sqlite).notes).toBe("closed out");
  });
});

describe("manual actions: per-intent preconditions", () => {
  it("trigger needs a pending step", async () => {
    const a = seed({ steps: [SENT_EMAIL] });
    expect(
      await dispatchManualAction(request(a.db, inMemoryCommit(a.sqlite, a.db), { intent: "trigger" })),
    ).toEqual({ ok: false, reason: "no_pending_step" });
  });

  it("resend needs an executed email step carrying generated copy", async () => {
    const none = seed({ steps: [PENDING] });
    expect(
      await dispatchManualAction(
        request(none.db, inMemoryCommit(none.sqlite, none.db), { intent: "resend" }),
      ),
    ).toEqual({ ok: false, reason: "no_email_to_resend" });

    const retryOnly = seed({ steps: [{ ...SENT_EMAIL, id: "s2", stepType: "retry_day3" }] });
    expect(
      await dispatchManualAction(
        request(retryOnly.db, inMemoryCommit(retryOnly.sqlite, retryOnly.db), { intent: "resend" }),
      ),
    ).toEqual({ ok: false, reason: "no_email_to_resend" });

    const ok = seed({ steps: [SENT_EMAIL] });
    expect(
      await dispatchManualAction(
        request(ok.db, inMemoryCommit(ok.sqlite, ok.db), { intent: "resend" }),
      ),
    ).toEqual({ ok: false, reason: "not_wired", intent: "resend" });
  });

  it("mark_recovered carries no step precondition and is still unwired", async () => {
    const { sqlite, db } = seed();
    expect(
      await dispatchManualAction(
        request(db, inMemoryCommit(sqlite, db), { intent: "mark_recovered" }),
      ),
    ).toEqual({ ok: false, reason: "not_wired", intent: "mark_recovered" });
  });
});

describe("note save: legacy's contract, through the money DO seam", () => {
  it("writes the note, account-scoped", async () => {
    const { sqlite, db } = seed();
    expect(
      await dispatchManualAction(
        request(db, inMemoryCommit(sqlite, db), { intent: "note", note: "call the customer" }),
      ),
    ).toEqual({ ok: true, intent: "note" });
    expect(readPayment(sqlite).notes).toBe("call the customer");
  });

  it("an empty textarea clears the column to NULL, legacy's `note || null`", async () => {
    const { sqlite, db } = seed({ notes: "previous" });
    await dispatchManualAction(
      request(db, inMemoryCommit(sqlite, db), { intent: "note", note: "" }),
    );
    expect(readPayment(sqlite).notes).toBeNull();
  });

  it("whitespace-only text is preserved, also legacy's behaviour", async () => {
    const { sqlite, db } = seed();
    await dispatchManualAction(
      request(db, inMemoryCommit(sqlite, db), { intent: "note", note: "   " }),
    );
    expect(readPayment(sqlite).notes).toBe("   ");
  });

  it("a missing note field is treated as empty rather than crashing", async () => {
    const { sqlite, db } = seed({ notes: "previous" });
    expect(
      await dispatchManualAction(request(db, inMemoryCommit(sqlite, db), { intent: "note" })),
    ).toEqual({ ok: true, intent: "note" });
    expect(readPayment(sqlite).notes).toBeNull();
  });

  it("a failing commit answers write_failed rather than reporting success", async () => {
    const { db } = seed();
    const failing: ManualActionCommit = async () => {
      throw new Error("d1 unavailable");
    };
    expect(
      await dispatchManualAction(request(db, failing, { intent: "note", note: "x" })),
    ).toEqual({ ok: false, reason: "write_failed", intent: "note" });
  });

  it("the key collapses a resubmitted SAME note and varies when the text changes", async () => {
    const sameA = await noteContentToken("call the customer");
    const sameB = await noteContentToken("call the customer");
    const different = await noteContentToken("call the customer.");
    expect(sameA).toBe(sameB);
    expect(different).not.toBe(sameA);

    const { sqlite, db } = seed();
    const keys: string[] = [];
    const commit = inMemoryCommit(sqlite, db, keys);
    await dispatchManualAction(request(db, commit, { intent: "note", note: "one" }));
    await dispatchManualAction(request(db, commit, { intent: "note", note: "one" }));
    await dispatchManualAction(request(db, commit, { intent: "note", note: "two" }));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0].startsWith("manual:note:fp_mine:")).toBe(true);
  });
});

describe("trigger: legacy's six statuses, ported", () => {
  /** A DueStepRow good enough for both context mappers. */
  function stepRow(over: Partial<DueStepRow> = {}): DueStepRow {
    return {
      stepId: "step_pending",
      stepType: "email_day1",
      stepNumber: 1,
      accountId: "acc_1",
      failedPaymentId: "fp_mine",
      scheduledAt: now,
      nextRetryAt: null,
      attemptCount: 0,
      customBody: null,
      aiSubject: null,
      aiBodyHtml: null,
      invoiceId: "in_1",
      amountCents: 4200,
      currency: "usd",
      customerEmail: "customer@example.com",
      declineCategory: "soft",
      connectionAccessToken: "iv:cipher",
      merchantName: "Acme",
      brandVoice: null,
      ...over,
    } as DueStepRow;
  }

  function triggerReq(
    db: Db,
    sqlite: Database.Database,
    deps: Partial<TriggerDeps>,
    steps: StepSeed[] = [PENDING],
  ) {
    void steps;
    return request(db, inMemoryCommit(sqlite, db), {
      intent: "trigger",
      trigger: { ...unusedTriggerDeps(), ...deps },
    });
  }

  it("a step that is neither an email nor a retry is a 400, before any executor runs", async () => {
    const { sqlite, db } = seed({ steps: [{ id: "step_pending", stepType: "card_update_signal" }] });
    expect(await dispatchManualAction(triggerReq(db, sqlite, {}))).toEqual({
      ok: false,
      reason: "unknown_step_type",
      stepType: "card_update_signal",
    });
  });

  it("a paused or braked account refuses rather than executing", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    expect(
      await dispatchManualAction(triggerReq(db, sqlite, { loadStep: async () => null })),
    ).toEqual({ ok: false, reason: "processing_paused" });
  });

  it("the real loader applies the account scope and the brake", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    // Owner reaches it.
    expect(await queryStepForManualTrigger(db, "acc_1", "step_pending")).not.toBeNull();
    // Another account does not, even with the right step id.
    expect(await queryStepForManualTrigger(db, "acc_2", "step_pending")).toBeNull();
    // Brake engaged: processing_paused excludes the account.
    runStatement(sqlite, db.update(accounts).set({ processingPaused: true }).where(eq(accounts.id, "acc_1")));
    expect(await queryStepForManualTrigger(db, "acc_1", "step_pending")).toBeNull();
  });

  it("the loader ignores the SCHEDULE, so a not-yet-due step can still be fired", async () => {
    // Legacy's whole point: the merchant overrides the cadence. The cron's own
    // query would exclude this row; this one must not.
    const future = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const { sqlite, db } = seed();
    runStatement(
      sqlite,
      db.insert(recoverySteps).values({
        id: "step_future",
        accountId: "acc_1",
        failedPaymentId: "fp_mine",
        stepType: "email_day7",
        scheduledAt: future,
        attemptCount: 0,
      }),
    );
    expect(await queryStepForManualTrigger(db, "acc_1", "step_future")).not.toBeNull();
  });

  it("a retry with no connected token refuses and writes nothing", async () => {
    const { sqlite, db } = seed({ steps: [{ id: "step_pending", stepType: "retry_4hr" }] });
    expect(
      await dispatchManualAction(
        triggerReq(db, sqlite, {
          loadStep: async () => stepRow({ stepType: "retry_4hr", connectionAccessToken: null }),
        }),
      ),
    ).toEqual({ ok: false, reason: "step_failed", result: "retry_no_connection" });
    expect(dueStepCount(sqlite)).toBe(1); // untouched, so reconnect-and-retry works
  });

  it("a succeeded retry is a 200 carrying the STORED result", async () => {
    const { sqlite, db } = seed({ steps: [{ id: "step_pending", stepType: "retry_4hr" }] });
    expect(
      await dispatchManualAction(
        triggerReq(db, sqlite, {
          loadStep: async () => stepRow({ stepType: "retry_4hr" }),
          runRetry: async () => {
            runStatement(
              sqlite,
              db
                .update(recoverySteps)
                .set({ executedAt: now, result: "retry_succeeded", retryResult: "retry_succeeded" })
                .where(eq(recoverySteps.id, "step_pending")),
            );
            return { action: "retry", executed: true, recovered: true, retryResult: "retry_succeeded" };
          },
        }),
      ),
    ).toEqual({
      ok: true,
      intent: "trigger",
      action: "retry",
      result: "retry_succeeded",
      subject: null,
    });
  });

  it("a DECLINED retry is still a 200, exactly as legacy's prefix rule gives", async () => {
    const { sqlite, db } = seed({ steps: [{ id: "step_pending", stepType: "retry_4hr" }] });
    const out = await dispatchManualAction(
      triggerReq(db, sqlite, {
        loadStep: async () => stepRow({ stepType: "retry_4hr" }),
        runRetry: async () => {
          runStatement(
            sqlite,
            db
              .update(recoverySteps)
              .set({ executedAt: now, result: "retry_card_declined", retryResult: "retry_card_declined" })
              .where(eq(recoverySteps.id, "step_pending")),
          );
          return {
            action: "retry",
            executed: true,
            recovered: false,
            retryResult: "retry_card_declined",
          };
        },
      }),
    );
    expect(out).toMatchObject({ ok: true, action: "retry", result: "retry_card_declined" });
  });

  it("a sent email is a 200 carrying the stored subject", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    const out = await dispatchManualAction(
      triggerReq(db, sqlite, {
        loadStep: async () => stepRow(),
        runEmail: async () => {
          runStatement(
            sqlite,
            db
              .update(recoverySteps)
              .set({ executedAt: now, result: "email_sent", aiSubject: "Your payment failed" })
              .where(eq(recoverySteps.id, "step_pending")),
          );
          return {
            action: "email",
            sent: true,
            result: "email_sent",
            usedTemplate: false,
            templateReason: null,
            suppressed: false,
          };
        },
      }),
    );
    expect(out).toEqual({
      ok: true,
      intent: "trigger",
      action: "email",
      result: "email_sent",
      subject: "Your payment failed",
    });
  });

  it("a SUPPRESSED recipient is 409, even though the step lands on email_sent", async () => {
    // Foxhound has no distinct stored result for suppression: processEmailJob
    // treats it as a terminal success. Reading the stored row alone would report
    // a send that never happened, which is why the executor's flag is checked.
    const { sqlite, db } = seed({ steps: [PENDING] });
    const out = await dispatchManualAction(
      triggerReq(db, sqlite, {
        loadStep: async () => stepRow(),
        runEmail: async () => {
          runStatement(
            sqlite,
            db
              .update(recoverySteps)
              .set({ executedAt: now, result: "email_sent" })
              .where(eq(recoverySteps.id, "step_pending")),
          );
          return {
            action: "email",
            sent: true,
            result: "email_sent",
            usedTemplate: false,
            templateReason: null,
            suppressed: true,
          };
        },
      }),
    );
    expect(out).toEqual({ ok: false, reason: "customer_unsubscribed" });
  });

  it("a transient send failure is 503: the step stayed unexecuted for the backoff", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    const out = await dispatchManualAction(
      triggerReq(db, sqlite, {
        loadStep: async () => stepRow(),
        // The state machine leaves executed_at and result NULL and sets a backoff.
        runEmail: async () => ({
          action: "email",
          sent: false,
          result: null,
          usedTemplate: false,
          templateReason: null,
          suppressed: false,
        }),
      }),
    );
    expect(out).toEqual({ ok: false, reason: "send_retrying" });
  });

  it("a terminal send failure is 502 carrying the stored result", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    const out = await dispatchManualAction(
      triggerReq(db, sqlite, {
        loadStep: async () => stepRow(),
        runEmail: async () => {
          runStatement(
            sqlite,
            db
              .update(recoverySteps)
              .set({ executedAt: now, result: "email_failed" })
              .where(eq(recoverySteps.id, "step_pending")),
          );
          return {
            action: "email",
            sent: false,
            result: "email_failed",
            usedTemplate: false,
            templateReason: null,
            suppressed: false,
          };
        },
      }),
    );
    expect(out).toEqual({ ok: false, reason: "step_failed", result: "email_failed" });
  });

  it("an executor that throws is 502 rather than a crash", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    const out = await dispatchManualAction(
      triggerReq(db, sqlite, {
        loadStep: async () => stepRow(),
        runEmail: async () => {
          throw new Error("stripe exploded");
        },
      }),
    );
    expect(out).toEqual({ ok: false, reason: "step_failed", result: null });
  });
});

describe("trigger: the concurrent-claim race", () => {
  it("a second trigger claims ZERO rows and reports the winner's stored result", async () => {
    // Ruling 260's guard, exercised at the TRIGGER level rather than at the
    // patch builder. Racer A (say the cron tick) already executed the step. This
    // trigger's executor runs its REAL patch through buildEmailStepPatch, whose
    // WHERE executed_at IS NULL refuses the write. The dispatcher then reports
    // what is STORED, which is A's result, not this caller's own decision.
    const { sqlite, db } = seed({ steps: [PENDING] });
    let claimedRows = -1;
    const out = await dispatchManualAction(
      request(db, inMemoryCommit(sqlite, db), {
        intent: "trigger",
        trigger: {
          ...unusedTriggerDeps(),
          loadStep: async () =>
            ({
              stepId: "step_pending",
              stepType: "email_day1",
              stepNumber: 1,
              accountId: "acc_1",
              failedPaymentId: "fp_mine",
              scheduledAt: now,
              nextRetryAt: null,
              attemptCount: 0,
              customBody: null,
              aiSubject: null,
              aiBodyHtml: null,
              invoiceId: "in_1",
              amountCents: 4200,
              currency: "usd",
              customerEmail: "customer@example.com",
              declineCategory: "soft",
              connectionAccessToken: "iv:cipher",
              merchantName: "Acme",
              brandVoice: null,
            }) as DueStepRow,
          runEmail: async () => {
            // THE RACE WINDOW. The dispatcher has already read this step as
            // pending and handed it to the executor. Racer A (a cron tick) now
            // executes and persists it before this caller's own persist lands.
            runStatement(
              sqlite,
              db
                .update(recoverySteps)
                .set({ executedAt: now, result: "email_sent", aiSubject: "A's subject" })
                .where(eq(recoverySteps.id, "step_pending")),
            );
            // The loser's REAL persist, through the real claim-guarded builder.
            claimedRows = runStatement(
              sqlite,
              buildEmailStepPatch(
                db,
                "step_pending",
                {
                  attemptCount: 1,
                  lastAttemptError: null,
                  nextRetryAt: null,
                  executedAt: later,
                  result: "email_failed",
                },
                { subject: "B's subject", bodyHtml: "<p>B</p>" },
              ),
            );
            return {
              action: "email",
              sent: false,
              result: "email_failed",
              usedTemplate: false,
              templateReason: null,
              suppressed: false,
            };
          },
        },
      }),
    );

    // The claim refused the second write.
    expect(claimedRows).toBe(0);
    // And the answer is the WINNER's, not the loser's own decision.
    expect(out).toEqual({
      ok: true,
      intent: "trigger",
      action: "email",
      result: "email_sent",
      subject: "A's subject",
    });

    const row = sqlite
      .prepare("select result, ai_subject from recovery_steps where id = 'step_pending'")
      .get() as { result: string; ai_subject: string };
    expect(row.result).toBe("email_sent");
    expect(row.ai_subject).toBe("A's subject");
  });
});

describe("stop recovery: one atomic batch, claim-guarded", () => {
  it("moves the payment to cancelled with resolved_at and cancels unexecuted steps", async () => {
    const { sqlite, db } = seed({ steps: [PENDING, SENT_EMAIL] });
    expect(
      await dispatchManualAction(request(db, inMemoryCommit(sqlite, db), { intent: "cancel" })),
    ).toEqual({ ok: true, intent: "cancel" });

    const row = readPayment(sqlite);
    expect(row.status).toBe("cancelled");
    expect(row.resolved_at).toBe(now.getTime());

    const steps = sqlite
      .prepare("select id, result from recovery_steps order by id")
      .all() as { id: string; result: string | null }[];
    expect(steps).toEqual([
      { id: "step_pending", result: "cancelled" },
      // The executed step keeps its real outcome; only unexecuted work is stopped.
      { id: "step_sent", result: "email_sent" },
    ]);
  });

  it("the sequence actually stops: no step is due for the tick afterwards", async () => {
    const { sqlite, db } = seed({ steps: [PENDING, { id: "step_two" }] });
    expect(dueStepCount(sqlite)).toBe(2);

    await dispatchManualAction(request(db, inMemoryCommit(sqlite, db), { intent: "cancel" }));

    // stepDueCondition requires result IS NULL, so a cancelled step is never
    // selected again. This is what makes Stop recovery actually stop.
    expect(dueStepCount(sqlite)).toBe(0);
  });

  it("the status claim takes ZERO rows when something else resolved the payment first", async () => {
    // The race the claim exists for: the dispatcher's pre-read saw 'active', and
    // a concurrent writer resolved the payment before this batch ran. Driving the
    // batch directly is the only way to reach that window deterministically.
    const { sqlite, db } = seed({ status: "recovered", steps: [PENDING] });
    const batch = buildStopRecoveryBatch(db, {
      accountId: "acc_1",
      failedPaymentId: "fp_mine",
      now: later,
    });

    const statusChanges = runStatement(sqlite, batch[0]);
    const stepChanges = runStatement(sqlite, batch[1]);

    expect(statusChanges).toBe(0);
    // And the second statement is conditioned on the first having landed, so a
    // lost claim does NOT cancel the steps of a payment it never stopped.
    expect(stepChanges).toBe(0);
    expect(readPayment(sqlite).status).toBe("recovered");
    expect(dueStepCount(sqlite)).toBe(1);
  });

  it("a lost claim is reported as already_resolved, never as success", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    // Commit that lets the race happen inside the write window: the payment is
    // resolved by someone else, then the batch runs and its claim finds nothing.
    const racing: ManualActionCommit = async (_accountId, _key, build) => {
      runStatement(
        sqlite,
        db.update(failedPayments).set({ status: "recovered" }).where(eq(failedPayments.id, "fp_mine")),
      );
      const batch = build(db);
      sqlite.transaction(() => {
        for (const statement of batch) runStatement(sqlite, statement);
      })();
      return { applied: true };
    };

    expect(await dispatchManualAction(request(db, racing, { intent: "cancel" }))).toEqual({
      ok: false,
      reason: "already_resolved",
      intent: "cancel",
    });
    expect(readPayment(sqlite).status).toBe("recovered");
    expect(dueStepCount(sqlite)).toBe(1);
  });

  it("a failing commit answers write_failed rather than reporting success", async () => {
    const { db } = seed({ steps: [PENDING] });
    const failing: ManualActionCommit = async () => {
      throw new Error("d1 unavailable");
    };
    expect(await dispatchManualAction(request(db, failing, { intent: "cancel" }))).toEqual({
      ok: false,
      reason: "write_failed",
      intent: "cancel",
    });
  });

  it("cancel's key is once-ever per payment, so a double submit collapses", () => {
    expect(manualActionIdempotencyKey("cancel", "fp_1")).toBe("manual:cancel:fp_1");
    expect(manualActionIdempotencyKey("cancel", "fp_1")).toBe(
      manualActionIdempotencyKey("cancel", "fp_1"),
    );
    expect(manualActionIdempotencyKey("cancel", "fp_1").startsWith("recovery:")).toBe(false);
  });
});
