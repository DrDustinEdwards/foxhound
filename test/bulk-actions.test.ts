
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Db } from "~/db";
import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  BULK_ACTION_CONCURRENCY,
  BULK_ACTION_MAX_PER_SUBMISSION,
} from "~/lib/constants";
import { queryStepForManualTrigger, type DueStepRow } from "~/lib/cron/due-steps";
import { mapWithConcurrency, runBulkAction } from "~/lib/recovery/bulk-actions.server";
import {
  BULK_ACTION_INTENTS,
  failedIds,
  isBulkRefusal,
  orderForDisplay,
  toItemResult,
} from "~/lib/recovery/bulk-results";
import { manualActionIdempotencyKey, type ManualActionCommit } from "~/lib/recovery/manual-actions.server";
import { type ResendDeps, type TriggerDeps } from "~/lib/recovery/manual-action-deps.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// S6 bulk actions, Sessions 2 and 3 (274 decisions one, four and five).
//
// The layer under test is FAN-OUT AND AGGREGATION ONLY. Every per-payment
// semantic already belongs to dispatchManualAction and Sessions B, C and E
// proved it, so what is pinned here is what the bulk layer adds: that the
// client's id list is re-derived rather than trusted, that nothing is dropped on
// the way in or the way out, that the ceiling refuses instead of truncating,
// that the intent itself is gated, and that the failures come back nameable one
// by one rather than as a count.
//
// The end-to-end cases run the REAL dispatcher against a real in-memory SQLite
// with the committed migrations applied, so the aggregation is proven over
// actual gate outcomes rather than over stubbed ones. Trigger's loadStep is the
// REAL query too, which is what makes the brake case a measurement rather than
// an assertion about a stub.

const now = new Date("2026-08-13T00:00:00.000Z");


interface PaymentSeed {
  id: string;
  accountId?: string;
  status?: string;
  steps?: { id: string; stepType?: string; executedAt?: Date | null; result?: string | null }[];
}

/** acc_1 is the caller's account, acc_2 is somebody else's, so a cross-account
 *  id is a genuine probe rather than a made up string. */
function seed(payments: PaymentSeed[], opts: { paused?: boolean } = {}) {
  const { sqlite, db } = createInMemoryDb();
  for (const [id, name] of [
    ["acc_1", "Mine"],
    ["acc_2", "Theirs"],
  ] as const) {
    runStatement(
      sqlite,
      db.insert(accounts).values({ id, name, processingPaused: id === "acc_1" && !!opts.paused }),
    );
  }
  for (const p of payments) {
    runStatement(
      sqlite,
      db.insert(failedPayments).values({
        id: p.id,
        accountId: p.accountId ?? "acc_1",
        stripeEventId: `evt_${p.id}`,
        stripeInvoiceId: `in_${p.id}`,
        stripeCustomerId: `cus_${p.id}`,
        customerEmail: "customer@example.com",
        amountCents: 4200,
        currency: "usd",
        declineCategory: "soft",
        status: p.status ?? "active",
        detectedAt: now,
      }),
    );
    for (const step of p.steps ?? []) {
      runStatement(
        sqlite,
        db.insert(recoverySteps).values({
          id: step.id,
          accountId: p.accountId ?? "acc_1",
          failedPaymentId: p.id,
          stepType: step.stepType ?? "email_day1",
          scheduledAt: now,
          executedAt: step.executedAt ?? null,
          result: step.result ?? null,
          attemptCount: 0,
        }),
      );
    }
  }
  return { sqlite, db };
}

const ACTIVE_WITH_EMAIL: PaymentSeed = { id: "fp_step", steps: [{ id: "st_step" }] };
const ACTIVE_NO_STEP: PaymentSeed = { id: "fp_nostep" };
const RECOVERED: PaymentSeed = { id: "fp_recovered", status: "recovered" };
const THEIRS: PaymentSeed = { id: "fp_theirs", accountId: "acc_2" };

/** The same in-transaction commit Session B uses: the batch's real compiled
 *  statements against the real schema, recording every key it was handed. A
 *  constraint violation therefore throws exactly as the real committer's would,
 *  which is what makes the outcomes-key race below a real race. */
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

/** Seams that fail loudly, so a bulk action reaching a mailer or an executor it
 *  did not intend to gets an error rather than a silent pass. Cancel and
 *  mark_recovered send nothing and run nothing, which is also the assertion
 *  behind the claim that SEND-PRECEDES-PERSIST does not apply to them:
 *  there is no send to precede anything. */
function loudTriggerDeps(): TriggerDeps {
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

function loudResendDeps(): ResendDeps {
  return {
    send: async () => {
      throw new Error("resend.send called unexpectedly");
    },
  };
}

/** Trigger deps whose loadStep is the REAL account-scoped query, so the brake is
 *  exercised by the condition the cron uses rather than by a stub choosing to
 *  return null. The executors are stubs that write what a real executor would
 *  write, since executor semantics are 267's and are not under test here. */
function realLoadStepDeps(
  sqlite: Database.Database,
  db: Db,
  over: Partial<TriggerDeps> = {},
): TriggerDeps {
  return {
    loadStep: (accountId, stepId) => queryStepForManualTrigger(db, accountId, stepId),
    runRetry: async () => {
      throw new Error("runRetry called unexpectedly");
    },
    runEmail: async (ctx) => {
      runStatement(
        sqlite,
        db
          .update(recoverySteps)
          .set({ executedAt: now, result: "email_sent", aiSubject: "Your payment failed" })
          .where(eq(recoverySteps.id, (ctx as unknown as DueStepRow).stepId)),
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
    ...over,
  };
}

function statusOf(sqlite: Database.Database, id: string): string {
  return (sqlite.prepare("select status from failed_payments where id = ?").get(id) as {
    status: string;
  }).status;
}

function outcomeRows(sqlite: Database.Database) {
  return sqlite
    .prepare("select idempotency_key, attribution_kind, outcome from outcomes order by idempotency_key")
    .all() as { idempotency_key: string; attribution_kind: string; outcome: string }[];
}

function run(
  sqlite: Database.Database,
  db: Db,
  intent: string,
  ids: string[],
  opts: { keys?: string[]; trigger?: TriggerDeps; accountId?: string } = {},
) {
  return runBulkAction({
    db,
    accountId: opts.accountId ?? "acc_1",
    intent,
    ids,
    commit: inMemoryCommit(sqlite, db, opts.keys ?? []),
    trigger: opts.trigger ?? loudTriggerDeps(),
    resend: loudResendDeps(),
    now,
  });
}

/** Narrow past the refusal union so a test can read `.results` without every
 *  assertion carrying the same guard. Fails the test if it WAS a refusal. */
function results(outcome: Awaited<ReturnType<typeof runBulkAction>>) {
  expect(isBulkRefusal(outcome)).toBe(false);
  if (isBulkRefusal(outcome)) throw new Error("refused");
  return outcome.results;
}

describe("bulk actions: a mixed selection is answered payment by payment", () => {
  const MIXED = [ACTIVE_WITH_EMAIL, ACTIVE_NO_STEP, RECOVERED, THEIRS];

  it("adds NO key scheme: each payment keeps the key the single path assigns", async () => {
    const { sqlite, db } = seed(MIXED);
    const keys: string[] = [];
    await run(sqlite, db, "cancel", ["fp_step", "fp_nostep"], { keys });

    expect(keys).toEqual([
      manualActionIdempotencyKey("cancel", "fp_step"),
      manualActionIdempotencyKey("cancel", "fp_nostep"),
    ]);
    // No batch-level, submission-level or fan-out-level key anywhere.
    expect(keys.some((k) => k.includes("bulk"))).toBe(false);
  });

  it("submitting the same id twice does it once, not twice", async () => {
    const { sqlite, db } = seed(MIXED);
    const keys: string[] = [];
    const out = await run(sqlite, db, "cancel", ["fp_step", "fp_step"], { keys });

    expect(results(out)).toHaveLength(1);
    expect(keys).toHaveLength(1);
  });
});

describe("bulk trigger: every executor status keeps its own name (267)", () => {
  it("runs what can run and names each refusal distinctly, with no folding", async () => {
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL, ACTIVE_NO_STEP, RECOVERED, THEIRS]);
    const out = await run(
      sqlite,
      db,
      "trigger",
      ["fp_step", "fp_nostep", "fp_recovered", "fp_theirs", "fp_missing"],
      { trigger: realLoadStepDeps(sqlite, db) },
    );

    expect(results(out)).toEqual([
      // The step ran, and the report carries what was STORED, not a bare ok.
      { id: "fp_step", ok: true, reason: null, detail: "email_sent" },
      { id: "fp_nostep", ok: false, reason: "no_pending_step", detail: null },
      { id: "fp_recovered", ok: false, reason: "not_active", detail: null },
      { id: "fp_theirs", ok: false, reason: "not_found", detail: null },
      { id: "fp_missing", ok: false, reason: "not_found", detail: null },
    ]);
    // Five submitted, five reported: legacy would have said "1 succeeded, 4
    // failed" and destroyed which four (scope 1.6).
    expect(new Set(results(out).map((r) => r.reason)).size).toBe(4);
  });

  it("a suppressed recipient is customer_unsubscribed, not a reported send", async () => {
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
    const out = await run(sqlite, db, "trigger", ["fp_step"], {
      trigger: realLoadStepDeps(sqlite, db, {
        runEmail: async () => ({
          action: "email",
          sent: false,
          result: null,
          usedTemplate: false,
          templateReason: null,
          suppressed: true,
        }),
      }),
    });
    expect(results(out)).toEqual([
      { id: "fp_step", ok: false, reason: "customer_unsubscribed", detail: null },
    ]);
  });

  it("a step left unexecuted is send_retrying, distinct from a failure", async () => {
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
    const out = await run(sqlite, db, "trigger", ["fp_step"], {
      trigger: realLoadStepDeps(sqlite, db, {
        // Writes nothing, so the stored result stays null: the send-attempt
        // state machine left it retryable and the tick still owns it.
        runEmail: async () => ({
          action: "email",
          sent: false,
          result: null,
          usedTemplate: false,
          templateReason: null,
          suppressed: false,
        }),
      }),
    });
    expect(results(out)).toEqual([
      { id: "fp_step", ok: false, reason: "send_retrying", detail: null },
    ]);
  });

  it("a retry with no connected account is step_failed CARRYING its reason", async () => {
    const { sqlite, db } = seed([{ id: "fp_step", steps: [{ id: "st_step", stepType: "retry_4hr" }] }]);
    const out = await run(sqlite, db, "trigger", ["fp_step"], {
      trigger: {
        ...realLoadStepDeps(sqlite, db),
        loadStep: async () =>
          ({
            stepId: "st_step",
            stepType: "retry_4hr",
            stepNumber: 1,
            accountId: "acc_1",
            failedPaymentId: "fp_step",
            scheduledAt: now,
            nextRetryAt: null,
            attemptCount: 0,
            customBody: null,
            aiSubject: null,
            aiBodyHtml: null,
            invoiceId: "in_fp_step",
            amountCents: 4200,
            currency: "usd",
            customerEmail: "customer@example.com",
            declineCategory: "soft",
            connectionAccessToken: null,
            merchantName: "Acme",
            brandVoice: null,
          }) as unknown as DueStepRow,
      },
    });
    // The detail is the whole point: "failed" alone would be the fold.
    expect(results(out)).toEqual([
      { id: "fp_step", ok: false, reason: "step_failed", detail: "retry_no_connection" },
    ]);
  });

  it("THE BRAKE IS ACCOUNT-WIDE, so it is never one row of a mixed selection", async () => {
    // 276 measured that processing_paused is returned at exactly one site, inside
    // triggerNextStep. It is reached because the account-eligibility condition in
    // the REAL loadStep query excludes a paused account, which means the brake
    // cannot refuse SOME payments in a submission and allow others: for one
    // account it is all or nothing. The brief's mixed-selection proof case
    // included "braked" as a member alongside the others; it is not expressible.
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL, { id: "fp_two", steps: [{ id: "st_two" }] }], {
      paused: true,
    });
    const out = await run(sqlite, db, "trigger", ["fp_step", "fp_two"], {
      trigger: realLoadStepDeps(sqlite, db),
    });
    expect(results(out)).toEqual([
      { id: "fp_step", ok: false, reason: "processing_paused", detail: null },
      { id: "fp_two", ok: false, reason: "processing_paused", detail: null },
    ]);
  });
});

describe("bulk mark recovered: through the spine's own recorder (271)", () => {
  const THREE = [
    { id: "fp_a" },
    { id: "fp_b" },
    { id: "fp_c" },
    RECOVERED,
    THEIRS,
  ];

  it("records the ones it can and names why it could not record the rest", async () => {
    const { sqlite, db } = seed(THREE);
    const out = await run(sqlite, db, "mark_recovered", [
      "fp_a",
      "fp_recovered",
      "fp_theirs",
      "fp_missing",
      "fp_b",
    ]);

    expect(results(out)).toEqual([
      { id: "fp_a", ok: true, reason: null, detail: null },
      { id: "fp_recovered", ok: false, reason: "not_active", detail: null },
      { id: "fp_theirs", ok: false, reason: "not_found", detail: null },
      { id: "fp_missing", ok: false, reason: "not_found", detail: null },
      { id: "fp_b", ok: true, reason: null, detail: null },
    ]);
    expect(statusOf(sqlite, "fp_a")).toBe("recovered");
    expect(statusOf(sqlite, "fp_theirs")).toBe("active");
  });

  it("a payment whose outcome key is ALREADY TAKEN answers already_resolved", async () => {
    // The webhook-won race: the outcomes row exists while the payment is still
    // active. Reproduced by recording it, then putting the payment back to
    // active, so the second attempt passes the status gate and dies on the
    // shared unique index exactly as it would against the real webhook.
    const { sqlite, db } = seed([{ id: "fp_a" }]);
    await run(sqlite, db, "mark_recovered", ["fp_a"]);
    expect(outcomeRows(sqlite)).toHaveLength(1);
    runStatement(
      sqlite,
      db.update(failedPayments).set({ status: "active" }).where(eq(failedPayments.id, "fp_a")),
    );

    const out = await run(sqlite, db, "mark_recovered", ["fp_a"]);
    expect(results(out)).toEqual([
      { id: "fp_a", ok: false, reason: "already_resolved", detail: null },
    ]);
    // Still exactly one, so the rollback took the whole batch with it.
    expect(outcomeRows(sqlite)).toHaveLength(1);
  });
});

describe("bulk actions: the intent itself is gated, not just the volume", () => {
  it("refuses an intent outside the bulk set before touching anything", async () => {
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
    const keys: string[] = [];
    // resend is a REAL dispatcher intent, which is what makes this reachable
    // rather than hypothetical. With the gate removed and a payment carrying a
    // previously sent email step, the send seam is reached once per payment;
    // that was measured directly rather than argued. This seeded payment has no
    // resendable step, so what it pins is the REFUSAL arriving before the
    // dispatcher is consulted at all, which is where a gate has to sit.
    const out = await run(sqlite, db, "resend", ["fp_step"], { keys });

    expect(isBulkRefusal(out)).toBe(true);
    if (!isBulkRefusal(out)) return;
    expect(out.refused).toBe("unknown_intent");
    expect(keys).toHaveLength(0);
  });
});

describe("bulk actions: the ceiling refuses, it never truncates (274 decision four)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `fp_${i}`);

  for (const intent of BULK_ACTION_INTENTS) {
    it(`refuses one over the ceiling for ${intent}, and touches nothing`, async () => {
      const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
      const keys: string[] = [];
      const out = await run(sqlite, db, intent, ids(BULK_ACTION_MAX_PER_SUBMISSION + 1), { keys });

      expect(isBulkRefusal(out)).toBe(true);
      if (!isBulkRefusal(out)) return;
      expect(out.refused).toBe("over_ceiling");
      // The exact number submitted, so the surface can say it rather than say
      // "too many", and the ceiling travels with it.
      expect(out.submitted).toBe(BULK_ACTION_MAX_PER_SUBMISSION + 1);
      expect(out.ceiling).toBe(BULK_ACTION_MAX_PER_SUBMISSION);
      // Not one write, not the first hundred: the whole submission is refused.
      expect(keys).toHaveLength(0);
    });
  }

  it("accepts exactly the ceiling, so the boundary is not off by one", async () => {
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
    const out = await run(sqlite, db, "cancel", ids(BULK_ACTION_MAX_PER_SUBMISSION));
    expect(results(out)).toHaveLength(BULK_ACTION_MAX_PER_SUBMISSION);
  });

  it("refuses an empty submission rather than reporting a successful nothing", async () => {
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
    const out = await run(sqlite, db, "cancel", []);

    expect(isBulkRefusal(out)).toBe(true);
    if (!isBulkRefusal(out)) return;
    expect(out.refused).toBe("empty");
    expect(out.submitted).toBe(0);
  });
});

describe("bulk actions: the fan-out is bounded and order-preserving", () => {
  it("never exceeds the cap and still returns results in INPUT order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    const out = await mapWithConcurrency(items, BULK_ACTION_CONCURRENCY, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Longer waits for the earlier items, so completion order is not input
      // order and an implementation that pushed as it finished would be caught.
      await new Promise((resolve) => setTimeout(resolve, n < 10 ? 4 : 0));
      inFlight -= 1;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(BULK_ACTION_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(out).toEqual(items.map((n) => n * 2));
  });
});

describe("bulk actions: the surface itemises, and failures come first", () => {
  const mixed = [
    { id: "a", ok: true, reason: null, detail: null },
    { id: "b", ok: false, reason: "not_active" as const, detail: null },
    { id: "c", ok: true, reason: null, detail: "email_sent" },
    { id: "d", ok: false, reason: "step_failed" as const, detail: "retry_no_connection" },
  ];

  it("orders failures first, each group in input order", () => {
    expect(orderForDisplay(mixed).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("failedIds is exactly the set that stays selected", () => {
    expect(failedIds(mixed)).toEqual(["b", "d"]);
  });

  it("an outcome this intent should not produce is reported, never swallowed", () => {
    const odd = toItemResult("x", { ok: false, reason: "no_email_to_resend" });
    expect(odd).toEqual({ id: "x", ok: false, reason: "unexpected", detail: null });
  });
});
