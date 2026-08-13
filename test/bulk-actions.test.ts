import { readFileSync } from "node:fs";

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getBillableRecoveries } from "~/db/billable";
import type { Db } from "~/db";
import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  BULK_ACTION_CONCURRENCY,
  BULK_ACTION_CONFIRM_THRESHOLD,
  BULK_ACTION_MAX_PER_SUBMISSION,
  MANUAL_ATTRIBUTION_KIND,
} from "~/lib/constants";
import { queryStepForManualTrigger, type DueStepRow } from "~/lib/cron/recovery-tick";
import { mapWithConcurrency, runBulkAction } from "~/lib/recovery/bulk-actions.server";
import {
  BULK_ACTION_INTENTS,
  failedIds,
  isBulkActionIntent,
  isBulkRefusal,
  orderForDisplay,
  toItemResult,
} from "~/lib/recovery/bulk-results";
import {
  manualActionIdempotencyKey,
  type ManualActionCommit,
  type ResendDeps,
  type TriggerDeps,
} from "~/lib/recovery/manual-actions.server";

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

const ROUTE = readFileSync("app/routes/app/recovery/payments/index.tsx", "utf8");

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
 *  behind the claim that SEND-PRECEDES-PERSIST (268) does not apply to them:
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

  it("stops what it can and names why it could not stop the rest", async () => {
    const { sqlite, db } = seed(MIXED);
    const out = await run(sqlite, db, "cancel", [
      "fp_step",
      "fp_recovered",
      "fp_theirs",
      "fp_missing",
      "fp_nostep",
    ]);

    // Input order, one result per submitted id, nothing dropped either way.
    expect(results(out).map((r) => r.id)).toEqual([
      "fp_step",
      "fp_recovered",
      "fp_theirs",
      "fp_missing",
      "fp_nostep",
    ]);
    expect(results(out).map((r) => r.reason)).toEqual([
      null,
      "not_active",
      // Another account's payment is NOT FOUND, never "forbidden": the account
      // scoped read cannot see it, so bulk leaks no more than the single path.
      "not_found",
      "not_found",
      null,
    ]);
  });

  it("commits only the payments that passed, and leaves the others alone", async () => {
    const { sqlite, db } = seed(MIXED);
    await run(sqlite, db, "cancel", ["fp_step", "fp_recovered", "fp_theirs", "fp_nostep"]);

    expect(statusOf(sqlite, "fp_step")).toBe("cancelled");
    expect(statusOf(sqlite, "fp_nostep")).toBe("cancelled");
    expect(statusOf(sqlite, "fp_recovered")).toBe("recovered");
    // The cross-account id is the one that matters: a bulk write must not reach
    // outside the account however the ids were assembled in the browser.
    expect(statusOf(sqlite, "fp_theirs")).toBe("active");
  });

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

  it("re-running over an already stopped payment answers, it does not throw", async () => {
    const { sqlite, db } = seed(MIXED);
    await run(sqlite, db, "cancel", ["fp_step"]);
    const again = await run(sqlite, db, "cancel", ["fp_step"]);

    // Already cancelled is no longer active, which is the gate that answers.
    expect(results(again)).toEqual([
      { id: "fp_step", ok: false, reason: "not_active", detail: null },
    ]);
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

  it("and the same braked account still stops recovery, which is the positive control", async () => {
    // Without this the test above could not tell a working brake apart from a
    // seed that broke every intent. Executing a step is processing; stopping one
    // is not (267), so cancel passes on the very account trigger just refused.
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL], { paused: true });
    const out = await run(sqlite, db, "cancel", ["fp_step"]);
    expect(results(out)).toEqual([{ id: "fp_step", ok: true, reason: null, detail: null }]);
    expect(statusOf(sqlite, "fp_step")).toBe("cancelled");
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

  it("records AT MOST ONE outcome per payment across a bulk and a re-submit", async () => {
    // The guarantee is the shared outcomes key space (271), not a new guard the
    // bulk layer adds. Three payments, submitted twice.
    const { sqlite, db } = seed(THREE);
    await run(sqlite, db, "mark_recovered", ["fp_a", "fp_b", "fp_c"]);
    const second = await run(sqlite, db, "mark_recovered", ["fp_a", "fp_b", "fp_c"]);

    const rows = outcomeRows(sqlite);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(3);
    // The second pass answers rather than throwing or double-recording.
    expect(results(second).every((r) => !r.ok && r.reason === "not_active")).toBe(true);
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

  it("NO manual outcome is billable, asserted through the real billable query", async () => {
    const { sqlite, db } = seed(THREE);
    await run(sqlite, db, "mark_recovered", ["fp_a", "fp_b", "fp_c"]);

    const rows = outcomeRows(sqlite);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.attribution_kind === MANUAL_ATTRIBUTION_KIND)).toBe(true);

    // Far enough in the future that maturity cannot be what excludes them: the
    // ONLY thing keeping these out of the billable set is the attribution kind
    // (262 decision one). A test that used a near asOf could not tell the two
    // apart.
    const asOf = now.getTime() + 1000 * 60 * 60 * 24 * 365;
    expect(await getBillableRecoveries(db, "acc_1", asOf)).toEqual([]);
  });

  it("and a foxhound-attributed recovery on the same account IS billable", async () => {
    // The positive control for the assertion above. Same account, same maturity
    // window, same query; only the attribution kind differs.
    const { sqlite, db } = seed([{ id: "fp_a" }]);
    await run(sqlite, db, "mark_recovered", ["fp_a"]);
    runStatement(
      sqlite,
      db
        .update(failedPayments)
        .set({ status: "recovered" })
        .where(eq(failedPayments.id, "fp_a")),
    );
    sqlite
      .prepare("update recovered_payments set attribution_kind = 'foxhound_retry' where failed_payment_id = ?")
      .run("fp_a");

    const asOf = now.getTime() + 1000 * 60 * 60 * 24 * 365;
    expect(await getBillableRecoveries(db, "acc_1", asOf)).toHaveLength(1);
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

  it("refuses note too, so a bulk POST cannot blank N notes", async () => {
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
    const out = await run(sqlite, db, "note", ["fp_step"]);
    expect(isBulkRefusal(out)).toBe(true);
    if (!isBulkRefusal(out)) return;
    expect(out.refused).toBe("unknown_intent");
  });

  it("refuses a string that is no intent at all", async () => {
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
    const out = await run(sqlite, db, "", ["fp_step"]);
    expect(isBulkRefusal(out)).toBe(true);
  });

  it("the allow-list is legacy's own three, and the predicate agrees with it", () => {
    expect([...BULK_ACTION_INTENTS]).toEqual(["trigger", "mark_recovered", "cancel"]);
    expect(isBulkActionIntent("resend")).toBe(false);
    expect(isBulkActionIntent("note")).toBe(false);
    for (const intent of BULK_ACTION_INTENTS) expect(isBulkActionIntent(intent)).toBe(true);
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

  it("the ceiling is enforced on the SERVER, not only in the dialog", async () => {
    // The dialog is the reason a merchant does not hit this. The server check is
    // the reason a hand crafted POST does not either, and only the second one is
    // a guarantee. Both exist; this asserts the second.
    const { sqlite, db } = seed([ACTIVE_WITH_EMAIL]);
    expect(isBulkRefusal(await run(sqlite, db, "mark_recovered", ids(500)))).toBe(true);
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

  it("handles fewer items than the cap without spawning idle workers", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([1, 2], BULK_ACTION_CONCURRENCY, async (n) => {
      calls += 1;
      return n;
    });
    expect(out).toEqual([1, 2]);
    expect(calls).toBe(2);
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

  it("keeps every payment in the output, so nothing hides behind a count", () => {
    expect(orderForDisplay(mixed)).toHaveLength(mixed.length);
  });

  it("failedIds is exactly the set that stays selected", () => {
    expect(failedIds(mixed)).toEqual(["b", "d"]);
  });

  it("an outcome this intent should not produce is reported, never swallowed", () => {
    const odd = toItemResult("x", { ok: false, reason: "no_email_to_resend" });
    expect(odd).toEqual({ id: "x", ok: false, reason: "unexpected", detail: null });
  });

  it("carries the STORED result of a trigger rather than flattening it to ok", () => {
    const declined = toItemResult("x", {
      ok: true,
      intent: "trigger",
      action: "retry",
      result: "retry_card_declined",
      subject: null,
    });
    // A retry that ran and was declined is a true success whose detail says what
    // happened to the charge. Reporting a bare "Ran" would be the fold.
    expect(declined).toEqual({ id: "x", ok: true, reason: null, detail: "retry_card_declined" });
  });
});

describe("bulk actions: the list route wires all three intents", () => {
  it("posts to its own action with the intent named on the submit control", () => {
    expect(ROUTE).toContain("export async function action({ context, request }: Route.ActionArgs)");
    expect(ROUTE).toContain('const intent = String(form.get("intent") ?? "");');
    expect(ROUTE).toContain('const ids = form.getAll("ids").map(String).filter(Boolean);');
    expect(ROUTE).toContain("await runBulkAction({");
  });

  it("submits the ACTIONABLE set, so the count on the label is the set sent", () => {
    // The gate-versus-submit repair (274 decision two) only holds if the hidden
    // inputs come from `actionable` and not from the whole stored selection.
    expect(ROUTE).toContain("{actionable.map((id) => (");
    expect(ROUTE).toContain('<input key={id} type="hidden" name="ids" value={id} />');
  });

  it("renders one control per bulk intent, each carrying its own value", () => {
    const bar = ROUTE.slice(ROUTE.indexOf('aria-label="Bulk actions"'));
    const start = bar.indexOf("{actionable.length > 0 ? (");
    const end = bar.indexOf("Clear", start);
    const block = bar.slice(start, end);
    for (const intent of BULK_ACTION_INTENTS) {
      expect(block).toContain(`intent="${intent}"`);
    }
    expect(block.match(/<BulkIntentButton/g)).toHaveLength(BULK_ACTION_INTENTS.length);
    // No button is disabled for being unwired any more; the only disable left is
    // the in-flight one, which lives in the shared component.
    expect(block).not.toContain("disabled\n");
  });

  it("the shared control submits directly below the threshold and confirms above it", () => {
    expect(ROUTE).toContain('type={needsConfirm ? "button" : "submit"}');
    expect(ROUTE).toContain("onClick={needsConfirm ? onConfirm : undefined}");
  });

  it("names the exact count and the action for every intent, and states the ceiling", () => {
    expect(BULK_ACTION_CONFIRM_THRESHOLD).toBe(25);
    expect(BULK_ACTION_MAX_PER_SUBMISSION).toBe(100);
    expect(ROUTE).toContain("const needsConfirm = actionable.length > BULK_ACTION_CONFIRM_THRESHOLD;");
    expect(ROUTE).toContain("const overCeiling = actionable.length > BULK_ACTION_MAX_PER_SUBMISSION;");
    // The dialog's action name and count both come from the intent it was opened
    // for, so it can never name one action while its submit carries another.
    expect(ROUTE).toContain("{BULK_INTENTS[confirming].question} {actionable.length} payments?");
    expect(ROUTE).toContain("{BULK_INTENTS[confirming].label} for {actionable.length} payments");
    expect(ROUTE).toContain("{BULK_ACTION_MAX_PER_SUBMISSION} at a time.");
    expect(ROUTE).toContain("Nothing has been changed, and nothing will be trimmed to fit.");
    // Each intent supplies its own question and consequence: no shared verb.
    for (const intent of BULK_ACTION_INTENTS) {
      expect(ROUTE).toContain(`  ${intent}: {`);
    }
  });

  it("the result surface names the intent's own verb and carries the detail", () => {
    expect(ROUTE).toContain('aria-label="Bulk action result"');
    expect(ROUTE).toContain("bulkCopy(bulk.intent)?.didLabel");
    expect(ROUTE).toContain("bulkCopy(bulk.intent)?.didNotLabel");
    expect(ROUTE).toContain("{r.detail ? (");
    expect(ROUTE).toContain("onClick={() => setDismissedFor(bulk)}");
    // No auto-dismiss anywhere on this route: 274 decision one is explicit that
    // the itemisation waits for the merchant.
    expect(ROUTE).not.toContain("setTimeout");
  });

  it("every failure reason the dispatcher can produce has copy on this surface", () => {
    // A reason with no label would render blank, which is a fold by omission.
    for (const reason of [
      "not_found",
      "not_active",
      "already_resolved",
      "write_failed",
      "no_pending_step",
      "unknown_step_type",
      "processing_paused",
      "customer_unsubscribed",
      "send_retrying",
      "step_failed",
      "unexpected",
    ]) {
      expect(ROUTE).toContain(`  ${reason}: "`);
    }
  });

  it("the failed ids are the selection once a response lands", () => {
    expect(ROUTE).toContain(
      "sel.from !== bulk && applied ? new Set(failedIds(applied.results)) : sel.ids;",
    );
  });

  it("the demo gate from Session 1 is untouched", () => {
    expect(ROUTE).toContain("{!isDemo && selectionCount > 0 ? (");
    expect(ROUTE).toContain("colSpan={isDemo ? 6 : 7}");
  });
});
