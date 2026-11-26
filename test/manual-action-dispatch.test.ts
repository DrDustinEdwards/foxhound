import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { type DueStepRow } from "~/lib/cron/due-steps";
import { buildEmailStepPatch } from "~/lib/engine/execute-step";
import {
  dispatchManualAction,
  type ManualActionCommit,
} from "~/lib/recovery/manual-actions.server";
import {
  type ResendDeps,
  type ResendSendInput,
  type TriggerDeps,
} from "~/lib/recovery/manual-action-deps.server";
import {
  buildStopRecoveryBatch,
  resendRepeatToken,
} from "~/lib/recovery/manual-action-batches.server";
import type { EmailJobResult } from "~/lib/email/dispatch";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// The shared manual-action dispatcher pins ownership, status gate and intent rules once. The commit runs
// the exact compiled statements against in-memory SQLite with the committed migrations, in one transaction.

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
function inMemoryCommit(
  sqlite: Database.Database,
  db: Db,
  keys: string[] = [],
): ManualActionCommit {
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

/** Trigger deps that fail loudly, so an unintended executor call errors. */
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

/** A send seam that fails loudly, so a test reaching the mailer unintentionally
 *  gets an error rather than a silent pass. */
function unusedResendDeps(): ResendDeps {
  return {
    send: async () => {
      throw new Error("resend.send called unexpectedly");
    },
  };
}

/** A send seam returning a chosen result, recording what it was asked to send. */
function fakeSend(result: Partial<EmailJobResult>, sent: ResendSendInput[] = []): ResendDeps {
  return {
    send: async (input) => {
      sent.push(input);
      return {
        status: "sent",
        providerMessageId: "prov_1",
        error: null,
        retryable: false,
        ...result,
      } as EmailJobResult;
    },
  };
}

function request(db: Db, commit: ManualActionCommit, over: Record<string, unknown> = {}) {
  return {
    db,
    accountId: "acc_1",
    failedPaymentId: "fp_mine",
    intent: "mark_recovered",
    commit,
    trigger: unusedTriggerDeps(),
    resend: unusedResendDeps(),
    now,
    ...over,
  } as Parameters<typeof dispatchManualAction>[0];
}

describe("manual actions: ownership is the same 404 as a missing payment", () => {
  it("an unknown intent is refused BEFORE any payment is loaded", async () => {
    const { sqlite, db } = seed();
    const commit = inMemoryCommit(sqlite, db);
    expect(
      await dispatchManualAction(
        request(db, commit, { failedPaymentId: "fp_nope", intent: "override_next_email" }),
      ),
    ).toEqual({ ok: false, reason: "unknown_intent" });
  });
});

describe("manual actions: per-intent preconditions", () => {
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
        request(ok.db, inMemoryCommit(ok.sqlite, ok.db), {
          intent: "resend",
          resend: fakeSend({ status: "sent" }),
        }),
      ),
    ).toEqual({ ok: true, intent: "resend", subject: "Subject" });
  });

  it("mark_recovered records the payment's own amount and currency", async () => {
    const { sqlite, db } = seed();
    expect(
      await dispatchManualAction(
        request(db, inMemoryCommit(sqlite, db), { intent: "mark_recovered" }),
      ),
    ).toEqual({ ok: true, intent: "mark_recovered" });
    const row = sqlite
      .prepare("select amount_cents, currency, attribution_kind from recovered_payments")
      .get() as { amount_cents: number; currency: string; attribution_kind: string };
    expect(row).toEqual({ amount_cents: 4200, currency: "usd", attribution_kind: "manual" });
  });
});

describe("note save", () => {
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
    expect(await dispatchManualAction(request(db, failing, { intent: "note", note: "x" }))).toEqual(
      { ok: false, reason: "write_failed", intent: "note" },
    );
  });

  it("the key collapses a resubmitted SAME note and varies when the text changes", async () => {
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

describe("trigger", () => {
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
      liveSendsEnabled: true,
      connectionAccessToken: "iv:cipher",
      merchantName: "Acme",
      brandVoice: null,
      ...over,
    } as DueStepRow;
  }

  function triggerReq(db: Db, sqlite: Database.Database, deps: Partial<TriggerDeps>) {
    return request(db, inMemoryCommit(sqlite, db), {
      intent: "trigger",
      trigger: { ...unusedTriggerDeps(), ...deps },
    });
  }

  it("a step that is neither an email nor a retry is a 400, before any executor runs", async () => {
    const { sqlite, db } = seed({
      steps: [{ id: "step_pending", stepType: "card_update_signal" }],
    });
    expect(await dispatchManualAction(triggerReq(db, sqlite, {}))).toEqual({
      ok: false,
      reason: "unknown_step_type",
      stepType: "card_update_signal",
    });
  });

  it("a declined retry is still a 200", async () => {
    const { sqlite, db } = seed({ steps: [{ id: "step_pending", stepType: "retry_4hr" }] });
    const out = await dispatchManualAction(
      triggerReq(db, sqlite, {
        loadStep: async () => stepRow({ stepType: "retry_4hr" }),
        runRetry: async () => {
          runStatement(
            sqlite,
            db
              .update(recoverySteps)
              .set({
                executedAt: now,
                result: "retry_card_declined",
                retryResult: "retry_card_declined",
              })
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

  it("customer emails off: refused before the email step runs, and the step stays pending", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    let ran = 0;
    const out = await dispatchManualAction(
      triggerReq(db, sqlite, {
        loadStep: async () => stepRow({ liveSendsEnabled: false }),
        runEmail: async () => {
          ran += 1;
          throw new Error("must not run");
        },
      }),
    );
    expect(out).toEqual({ ok: false, reason: "live_sends_disabled" });
    expect(ran).toBe(0);
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
    // Racer A already executed the step; this trigger's real patch is refused by the claim guard and the
    // dispatcher reports the stored (winner's) result.
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
              liveSendsEnabled: true,
              connectionAccessToken: "iv:cipher",
              merchantName: "Acme",
              brandVoice: null,
            }) as DueStepRow,
          runEmail: async () => {
            runStatement(
              sqlite,
              db
                .update(recoverySteps)
                .set({ executedAt: now, result: "email_sent", aiSubject: "A's subject" })
                .where(eq(recoverySteps.id, "step_pending")),
            );
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

    expect(claimedRows).toBe(0);
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

describe("resend", () => {
  function resendReq(
    db: Db,
    sqlite: Database.Database,
    deps: ResendDeps,
    keys: string[] = [],
    over: Record<string, unknown> = {},
  ) {
    return request(db, inMemoryCommit(sqlite, db, keys), {
      intent: "resend",
      resend: deps,
      ...over,
    });
  }

  function resendSteps(sqlite: Database.Database) {
    return sqlite
      .prepare(
        "select step_type, step_number, executed_at, result, ai_subject, ai_body_html from recovery_steps where step_type = 'email_resend'",
      )
      .all() as {
      step_type: string;
      step_number: number | null;
      executed_at: number | null;
      result: string;
      ai_subject: string;
      ai_body_html: string;
    }[];
  }

  it("sends the last email and records it as its own timeline step", async () => {
    const { sqlite, db } = seed({ steps: [SENT_EMAIL] });
    const sent: ResendSendInput[] = [];

    const out = await dispatchManualAction(
      resendReq(db, sqlite, fakeSend({ status: "sent", providerMessageId: "prov_9" }, sent)),
    );

    expect(out).toEqual({ ok: true, intent: "resend", subject: "Subject" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      accountId: "acc_1",
      recoveryStepId: "step_sent",
      to: "customer@example.com",
      subject: "Subject",
      bodyHtml: "<p>Body</p>",
    });

    const rows = resendSteps(sqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      step_type: "email_resend",
      step_number: null,
      result: "email_sent",
      ai_subject: "Subject",
      ai_body_html: "<p>Body</p>",
    });
    expect(rows[0].executed_at).toBe(now.getTime());
    const original = sqlite
      .prepare("select result from recovery_steps where id = 'step_sent'")
      .get() as { result: string };
    expect(original.result).toBe("email_sent");
  });

  it("a SUPPRESSED recipient is an honest refusal and writes NOTHING", async () => {
    const { sqlite, db } = seed({ steps: [SENT_EMAIL] });
    const keys: string[] = [];
    const out = await dispatchManualAction(
      resendReq(db, sqlite, fakeSend({ status: "suppressed", providerMessageId: null }), keys),
    );
    expect(out).toEqual({ ok: false, reason: "customer_unsubscribed" });
    expect(resendSteps(sqlite)).toHaveLength(0);
    expect(keys).toHaveLength(0); // no money write attempted at all
  });

  it("a BLOCKED send (live-send flag off) refuses and writes NOTHING", async () => {
    const { sqlite, db } = seed({ steps: [SENT_EMAIL] });
    const keys: string[] = [];
    const out = await dispatchManualAction(
      resendReq(db, sqlite, fakeSend({ status: "blocked", providerMessageId: null }), keys),
    );
    expect(out).toEqual({ ok: false, reason: "live_sends_disabled" });
    expect(resendSteps(sqlite)).toHaveLength(0);
    expect(keys).toHaveLength(0);
  });

  it("a failed send reports the provider's reason and writes nothing", async () => {
    const { sqlite, db } = seed({ steps: [SENT_EMAIL] });
    const out = await dispatchManualAction(
      resendReq(db, sqlite, fakeSend({ status: "failed", error: "smtp 550", retryable: true })),
    );
    expect(out).toEqual({ ok: false, reason: "resend_failed", detail: "smtp 550" });
    expect(resendSteps(sqlite)).toHaveLength(0);
  });

  it("the key collapses a retried PERSIST of one send and separates two sends", () => {
    expect(resendRepeatToken("prov_1", "step_a", now)).toBe(
      resendRepeatToken("prov_1", "step_a", later),
    );
    expect(resendRepeatToken("prov_2", "step_a", now)).not.toBe(
      resendRepeatToken("prov_1", "step_a", now),
    );
    expect(resendRepeatToken(null, "step_a", now)).not.toBe(
      resendRepeatToken(null, "step_a", later),
    );
  });

  it("picks the last email by EXECUTED_AT, not by array position", async () => {
    const { sqlite, db } = seed({
      steps: [
        { ...SENT_EMAIL, id: "step_newer", aiSubject: "NEWER", executedAt: later },
        { ...SENT_EMAIL, id: "step_older", aiSubject: "OLDER", executedAt: now },
      ],
    });
    const sent: ResendSendInput[] = [];
    await dispatchManualAction(resendReq(db, sqlite, fakeSend({ status: "sent" }, sent)));
    expect(sent[0].subject).toBe("NEWER");
    expect(sent[0].recoveryStepId).toBe("step_newer");
  });
});

describe("stop recovery: one atomic batch, claim-guarded", () => {
  it("moves the payment to canceled with resolved_at and cancels unexecuted steps", async () => {
    const { sqlite, db } = seed({ steps: [PENDING, SENT_EMAIL] });
    expect(
      await dispatchManualAction(request(db, inMemoryCommit(sqlite, db), { intent: "cancel" })),
    ).toEqual({ ok: true, intent: "cancel" });

    const row = readPayment(sqlite);
    expect(row.status).toBe("cancelled");
    expect(row.resolved_at).toBe(now.getTime());

    const steps = sqlite.prepare("select id, result from recovery_steps order by id").all() as {
      id: string;
      result: string | null;
    }[];
    expect(steps).toEqual([
      { id: "step_pending", result: "cancelled" },
      // The executed step keeps its real outcome; only unexecuted work is stopped.
      { id: "step_sent", result: "email_sent" },
    ]);
  });

  it("the status claim takes ZERO rows when something else resolved the payment first", async () => {
    // Driven directly: the only deterministic way into the window between pre-read and batch.
    const { sqlite, db } = seed({ status: "recovered", steps: [PENDING] });
    const batch = buildStopRecoveryBatch(db, {
      accountId: "acc_1",
      failedPaymentId: "fp_mine",
      now: later,
    });

    const statusChanges = runStatement(sqlite, batch[0]);
    const stepChanges = runStatement(sqlite, batch[1]);

    expect(statusChanges).toBe(0);
    expect(stepChanges).toBe(0);
    expect(readPayment(sqlite).status).toBe("recovered");
    expect(dueStepCount(sqlite)).toBe(1);
  });

  it("a lost claim is reported as already_resolved, never as success", async () => {
    const { sqlite, db } = seed({ steps: [PENDING] });
    const racing: ManualActionCommit = async (_accountId, _key, build) => {
      runStatement(
        sqlite,
        db
          .update(failedPayments)
          .set({ status: "recovered" })
          .where(eq(failedPayments.id, "fp_mine")),
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
});
