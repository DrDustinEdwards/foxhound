import { and, eq } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";
import { type Db, failedPayments, getDb } from "~/db";
import { FAILED_PAYMENT_STATUS_UNRECOVERED, RECOVERY_TICK_LIMIT } from "~/lib/constants";
import { executeEmailStep, type EmailStepContext } from "~/lib/engine/execute-step";
import { executeRetryStep, type RetryStepContext } from "~/lib/engine/retry-step";
import { stepAction } from "~/lib/engine/step-runner";
import { sendSequenceCompleteNotification } from "~/lib/recovery/sequence-complete-notification.server";
import type { CronJobResult } from "./run";
import {
  type DueStepRow,
  queryExhaustedSequences,
  buildExhaustedSequenceFlip,
  queryDueRecoverySteps,
  queryPendingRetryStepsForCustomer,
  chooseStepsPerPayment,
  toRetryContext,
  toEmailContext,
} from "./due-steps";
import {
  checkTickGuards,
  hasLostDispute,
  recordMissingTokenAttempt,
  suppressRetryForLostDispute,
  type TickGuards,
} from "./tick-guards";

import { errorMessage } from "@dustinedwards/site-runtime/log";

interface TickTally {
  due: number;
  chosen: number;
  retries: number;
  emails: number;
  recovered: number;
  skipped: number;
  /**
   * Steps skipped because their account stopped being eligible DURING this run
   * (almost always the emergency brake). Counted apart from `skipped` so a
   * brake engage reads as a deliberate stop, not as engine noise, and apart
   * from `failed` because nothing failed.
   */
  skippedIneligible: number;
  /** Retry steps held because Stripe has charges off on their connection. */
  heldChargesDisabled: number;
  failed: number;
  exhausted: number;
  backlog: boolean;
  /** The tick was disabled mid-run and stopped early. */
  halted: boolean;
}

/**
 * How many failing step ids the run message names before it truncates. Five is
 * enough to see whether a tick's failures share a cause and short enough that a
 * total outage does not write a message thousands of ids long. The count of the
 * rest is always appended, so the cap is never silent.
 */
export const FAILED_STEP_IDS_IN_MESSAGE = 5;

/**
 * Injectable seams for runRecoveryTick. Defaults are the real query +
 * executors.
 */
export interface RecoveryTickDeps {
  query: (env: Env, now: Date) => Promise<DueStepRow[]>;
  runRetry: (env: Env, ctx: RetryStepContext) => Promise<{ recovered: boolean }>;
  runEmail: (env: Env, ctx: EmailStepContext) => Promise<unknown>;
  /** Find and flip sequences that have run out. Default: the real sweep. */
  flipExhausted: (env: Env, now: Date) => Promise<ClaimedSequence[]>;
  /**
   * Record one failed attempt on a retry step with no usable connection.
   * Resolves to the terminal result once grace runs out, else null.
   */
  recordMissingToken: (
    env: Env,
    step: { stepId: string; attemptCount: number },
    now: Date,
  ) => Promise<string | null>;
  /**
   * Re-read the enabled flag + account eligibility before each step. Default:
   * the real batched read.
   */
  checkGuards: (env: Env, accountId: string) => Promise<TickGuards>;
  /**
   * Whether the customer has a lost dispute with the account. Default: the real
   * fail-open read.
   */
  hasLostDispute: (env: Env, accountId: string, stripeCustomerId: string) => Promise<boolean>;
  /** Stamp the step terminal and record the suppression. */
  suppressRetry: (
    env: Env,
    row: Pick<DueStepRow, "stepId" | "stepType" | "accountId" | "attemptCount"> & {
      stripeCustomerId: string;
    },
    now: Date,
  ) => Promise<void>;
}

/**
 * One retry step through the per-step guards: a missing connected token
 * (reported, so each caller decides what to record), then a lost dispute
 * (suppressed and recorded), then the executor, which holds the network's
 * do-not-try-again stop and the expired-card guard. The tick and the card
 * updater's retry-now both run retries through this, so their guards cannot
 * drift apart.
 */
async function runGuardedRetry(
  env: Env,
  row: DueStepRow,
  now: Date,
  io: {
    runRetry: RecoveryTickDeps["runRetry"];
    lostDispute: RecoveryTickDeps["hasLostDispute"];
    suppressRetry: RecoveryTickDeps["suppressRetry"];
  },
): Promise<"no_connection" | "dispute_lost" | { recovered: boolean }> {
  const ctx = toRetryContext(row);
  if (!ctx) return "no_connection";
  const customerId = row.stripeCustomerId;
  if (customerId && (await io.lostDispute(env, row.accountId, customerId))) {
    await io.suppressRetry(env, { ...row, stripeCustomerId: customerId }, now);
    return "dispute_lost";
  }
  return io.runRetry(env, ctx);
}

/**
 * Stripe's card updater refreshed this customer's card
 * (payment_method.automatically_updated), so each of the customer's active
 * failed payments runs its next pending retry step NOW rather than at its
 * scheduled time, on the new card. The step is the one the schedule would have
 * charged next, so a success is the same foxhound_retry it would have been,
 * only sooner, and a failure leaves the rest of the sequence as planned.
 */
export async function retryOnUpdatedCard(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
  deps: Partial<
    Pick<RecoveryTickDeps, "runRetry" | "checkGuards" | "hasLostDispute" | "suppressRetry">
  > = {},
): Promise<number> {
  const io = {
    runRetry: deps.runRetry ?? executeRetryStep,
    lostDispute: deps.hasLostDispute ?? hasLostDispute,
    suppressRetry: deps.suppressRetry ?? suppressRetryForLostDispute,
  };
  let attempted = 0;
  try {
    const guards = await (deps.checkGuards ?? checkTickGuards)(env, accountId);
    if (!guards.tickEnabled || !guards.accountEligible) return 0;
    const rows = chooseStepsPerPayment(
      await queryPendingRetryStepsForCustomer(getDb(env), accountId, stripeCustomerId),
    );
    const now = new Date();
    for (const row of rows) {
      try {
        const result = await runGuardedRetry(env, row, now, io);
        if (typeof result === "object") attempted += 1;
      } catch (err) {
        console.error("card updater retry failed:", row.stepId, errorMessage(err));
      }
    }
  } catch (err) {
    console.error("card updater retry lookup failed:", errorMessage(err));
  }
  return attempted;
}

/**
 * Flip every exhausted sequence to failed_unrecovered. Runs AFTER the step loop
 * so a sequence whose last step just executed is caught in the same tick rather
 * than lingering 'active' for another five minutes.
 */
export interface ClaimedSequence {
  failedPaymentId: string;
  accountId: string;
}

export async function flipExhaustedSequences(env: Env, now: Date): Promise<ClaimedSequence[]> {
  const ids = await queryExhaustedSequences(env, RECOVERY_TICK_LIMIT);
  if (ids.length === 0) return [];
  const db = getDb(env);
  await db.batch([buildExhaustedSequenceFlip(db, ids, now)]);

  return readClaimedSequences(db, ids, now);
}

/**
 * WHICH ids the flip actually took, not which it considered.
 *
 * EXPORTED because the narrowing is otherwise unprovable: inside
 * `flipExhaustedSequences` every candidate is claimed, since the query and the
 * flip run back to back on one thread, so a mutation that returns all
 * candidates cannot be caught through the public function.
 */
function readClaimedSequences(db: Db, ids: string[], now: Date): Promise<ClaimedSequence[]> {
  return db
    .select({ failedPaymentId: failedPayments.id, accountId: failedPayments.accountId })
    .from(failedPayments)
    .where(
      and(
        inList(failedPayments.id, ids),
        eq(failedPayments.status, FAILED_PAYMENT_STATUS_UNRECOVERED),
        eq(failedPayments.resolvedAt, now),
      ),
    );
}

/**
 * Run one recovery tick. Selects due steps, runs the earliest per payment
 * through the right executor, isolates per-step failures, and returns cap
 * telemetry.
 */
export async function runRecoveryTick(
  env: Env,
  deps: Partial<RecoveryTickDeps> = {},
  /**
   * The cron run this tick belongs to, stamped onto every email_sends row it
   * produces. Null when the tick is driven from a test or any non-cron caller,
   * which is exactly what the nullable column records.
   */
  cronRunId: string | null = null,
): Promise<CronJobResult> {
  const query = deps.query ?? queryDueRecoverySteps;
  const runRetry = deps.runRetry ?? executeRetryStep;
  const runEmail = deps.runEmail ?? executeEmailStep;
  const flipExhausted = deps.flipExhausted ?? flipExhaustedSequences;
  const recordMissingToken = deps.recordMissingToken ?? recordMissingTokenAttempt;
  const checkGuards = deps.checkGuards ?? checkTickGuards;
  const lostDispute = deps.hasLostDispute ?? hasLostDispute;
  const suppressRetry = deps.suppressRetry ?? suppressRetryForLostDispute;

  const now = new Date();
  const due = await query(env, now);
  const chosen = chooseStepsPerPayment(due);
  const tally: TickTally = {
    due: due.length,
    chosen: chosen.length,
    retries: 0,
    emails: 0,
    recovered: 0,
    skipped: 0,
    skippedIneligible: 0,
    heldChargesDisabled: 0,
    failed: 0,
    exhausted: 0,
    backlog: due.length >= RECOVERY_TICK_LIMIT,
    halted: false,
  };
  /**
   * Every step that threw this tick, kept so the run's recorded message can
   * NAME them rather than only count them.
   */
  const failedSteps: {
    stepId: string;
    failedPaymentId: string;
    stepType: string;
    errorClass: string;
    message: string;
  }[] = [];

  for (const row of chosen) {
    // Re-checked per step, not per run. Both gates were evaluated when the
    // batch was selected; without this, engaging the brake or disabling the
    // tick took effect only from the NEXT run, while this one kept charging
    // cards.
    const guards = await checkGuards(env, row.accountId);
    if (!guards.tickEnabled) {
      // Exit cleanly and leave the remaining steps untouched. They are still
      // unexecuted with no result, so the next enabled tick re-selects them:
      // nothing is lost, and nothing is stamped as failed.
      tally.halted = true;
      break;
    }
    if (!guards.accountEligible) {
      tally.skippedIneligible += 1;
      continue;
    }

    const action = stepAction(row.stepType);
    try {
      if (action === "retry") {
        if (row.chargesEnabled === false) {
          // Stripe has turned off charges on this connection (account.updated),
          // so the charge would fail and burn the step. Left pending with no
          // write, as a disabled tick leaves it: the next tick tries again, and
          // runs it once Stripe reports charges back on.
          tally.heldChargesDisabled += 1;
          continue;
        }
        const result = await runGuardedRetry(env, row, now, {
          runRetry,
          lostDispute,
          suppressRetry,
        });
        if (result === "no_connection") {
          // No connected token: cannot safely charge. Record the attempt with
          // bounded grace rather than either leaving it pending (re-selects
          // forever) or killing it outright (forfeits the silent retry on a
          // brief reconnect).
          await recordMissingToken(
            env,
            { stepId: row.stepId, attemptCount: row.attemptCount },
            now,
          );
          tally.skipped += 1;
          continue;
        }
        if (result === "dispute_lost") {
          tally.skipped += 1;
          continue;
        }
        tally.retries += 1;
        if (result.recovered) tally.recovered += 1;
      } else if (action === "email") {
        await runEmail(env, { ...toEmailContext(row), cronRunId });
        tally.emails += 1;
      } else {
        tally.skipped += 1; // unknown step type (e.g. the card_update signal row)
      }
    } catch (err) {
      // Isolate: one step's failure never halts the sweep for the others.
      tally.failed += 1;
      failedSteps.push({
        stepId: row.stepId,
        failedPaymentId: row.failedPaymentId,
        stepType: row.stepType,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        message: errorMessage(err),
      });
      console.error("recovery step failed:", JSON.stringify(failedSteps[failedSteps.length - 1]));
    }
  }

  // Isolated like a per-step failure, but counted SEPARATELY: `failed` means
  // "steps that failed", and folding a bookkeeping sweep into it would make the
  // number mean two things. Never silent, though: the note is on the recorded
  // run message, so a sweep that is quietly always failing is visible in
  // cron_run_log rather than looking like a tick with nothing to flip.
  let sweepNote = "";
  if (tally.halted) {
    // An operator disabled the tick mid-run. "Disabled" should mean the tick
    // does nothing further, and this sweep was still performing a write pass
    // after the halt. Skipped and reported, never silent.
    sweepNote = ", exhausted-sweep skipped (halted)";
  } else {
    try {
      const claimed = await flipExhausted(env, now);
      tally.exhausted = claimed.length;
      // THE SEQUENCE-COMPLETE NOTIFICATION, after the terminal claim commits
      // and only for the sequences this tick actually claimed. Never throws
      // (its own catch), because the terminal state and its outcome are already
      // written and a mail failure must not unwind them or fail the tick.
      for (const sequence of claimed) {
        await sendSequenceCompleteNotification(env, sequence);
      }
    } catch (err) {
      sweepNote = ", exhausted-sweep FAILED";
      console.error("exhausted-sequence sweep failed:", errorMessage(err));
    }
  }

  const executed = tally.retries + tally.emails;
  // THE FAILING STEPS, NAMED IN THE RUN'S OWN RECORD.
  const failedNote = failedSteps.length
    ? `, failed: ${failedSteps
        .slice(0, FAILED_STEP_IDS_IN_MESSAGE)
        .map((f) => `${f.stepId}(${f.errorClass})`)
        .join(" ")}${
        failedSteps.length > FAILED_STEP_IDS_IN_MESSAGE
          ? ` +${failedSteps.length - FAILED_STEP_IDS_IN_MESSAGE} more`
          : ""
      }`
    : "";
  const backlogNote = tally.backlog ? ", BACKLOG (tick hit RECOVERY_TICK_LIMIT)" : "";
  // Both stop conditions are named in the run message, so cron_run_log shows a
  // deliberate halt as a halt rather than as a quiet short run.
  const haltedNote = tally.halted ? ", HALTED (tick disabled mid-run)" : "";
  const pausedNote =
    tally.skippedIneligible > 0
      ? `, ${tally.skippedIneligible} skipped (account paused mid-run)`
      : "";
  const heldNote =
    tally.heldChargesDisabled > 0
      ? `, ${tally.heldChargesDisabled} retries held (Stripe charges off)`
      : "";
  return {
    rowsProcessed: executed,
    message:
      `${tally.due} due, ${tally.chosen} payments, ${tally.retries} retries ` +
      `(${tally.recovered} recovered), ${tally.emails} emails, ` +
      `${tally.skipped} skipped, ${tally.failed} failed, ` +
      `${tally.exhausted} exhausted${pausedNote}${heldNote}${failedNote}${sweepNote}${backlogNote}${haltedNote}`,
  };
}
