import { and, eq, inArray } from "drizzle-orm";
import { type Db, accounts, cronConfig, disputes, failedPayments, getDb } from "~/db";
import {
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  RECOVERY_TICK_CRON_NAME,
  RECOVERY_TICK_LIMIT,
  RETRY_TOKEN_MAX_ATTEMPTS,
} from "~/lib/constants";
import { executeEmailStep, type EmailStepContext } from "~/lib/engine/execute-step";
import {
  buildRetryAttemptPatch,
  executeRetryStep,
  type RetryStepContext,
} from "~/lib/engine/retry-step";
import { recordOutcome } from "~/lib/engine/outcomes";
import { stepAction } from "~/lib/engine/step-runner";
import { afterTransientFailureWith } from "~/lib/recovery/step-state";
import {
  sendSequenceCompleteNotification,
} from "~/lib/recovery/sequence-complete-notification.server";
import type { CronJobResult } from "./run";
import {
  accountProcessingEligibleCondition,
  queryExhaustedSequences,
  buildExhaustedSequenceFlip,
  type DueStepRow,
  queryDueRecoverySteps,
  queryPendingRetryStepsForCustomer,
  chooseStepsPerPayment,
  toRetryContext,
  toEmailContext,
} from "./due-steps";

/** What the loop re-checks before EACH step. */
export interface TickGuards {
  /** recovery-tick's cron_config flag. A missing row means enabled (gotcha #44). */
  tickEnabled: boolean;
  /** Whether this step's account is STILL processing-eligible right now. */
  accountEligible: boolean;
}

/**
 * Re-read both gates as of this instant, in ONE db.batch (a batch is a single
 * round trip, so this costs one subrequest per step rather than two).
 *
 * Both gates are evaluated at SELECT time by queryDueRecoverySteps, which was
 * enough to stop the next run and not the current one. A tick can hold up to
 * RECOVERY_TICK_LIMIT already-selected steps, and each retry step charges a real
 * card, so an operator who engaged the brake mid-run watched the panel confirm
 * "paused" while charges kept landing for minutes. The panel promised "stops all
 * retries and dunning sends"; this is what makes that promise true.
 *
 * The account predicate is the SAME accountProcessingEligibleCondition the
 * selection query uses, re-evaluated, so the two can never disagree about what
 * eligible means.
 */
export async function checkTickGuards(env: Env, accountId: string): Promise<TickGuards> {
  const db = getDb(env);
  const results = await db.batch([
    db
      .select({ enabled: cronConfig.enabled })
      .from(cronConfig)
      .where(eq(cronConfig.cronName, RECOVERY_TICK_CRON_NAME))
      .limit(1),
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), accountProcessingEligibleCondition()))
      .limit(1),
  ]);

  // Both halves fail CLOSED, which they did not before (review LOW-B). The
  // `?? true` below is correct for a genuinely ABSENT cron_config row (gotcha
  // #44: missing means enabled), but it used to also swallow a malformed or
  // unexpected result and read it as "enabled", i.e. fail-open, on the one
  // control whose job is stopping a loop that charges cards. The account half
  // meanwhile failed closed by accident (a non-array would throw on .length).
  // One guard should not fail in two directions, so the shape is now checked
  // and anything unexpected throws, which the caller treats as a halt.
  const [cfgRows, acctRows] = results as [unknown, unknown];
  if (!Array.isArray(cfgRows) || !Array.isArray(acctRows)) {
    throw new Error("checkTickGuards: unexpected batch result shape");
  }
  const cfg = cfgRows[0] as { enabled?: unknown } | undefined;
  if (cfg !== undefined && typeof cfg.enabled !== "boolean") {
    throw new Error("checkTickGuards: cron_config.enabled is not a boolean");
  }

  return {
    // Absent row means enabled; a present row must say so explicitly.
    tickEnabled: cfg === undefined ? true : (cfg.enabled as boolean),
    accountEligible: acctRows.length > 0,
  };
}

/** The terminal result stamped on a retry step that can never run: the account's
 *  connection is gone or was never stored, so there is no token to charge with. */
export const RETRY_RESULT_NO_CONNECTION = "retry_no_connection";

/**
 * Record one failed attempt to run a retry step that has no usable connected
 * token, with BOUNDED GRACE: reschedule with backoff until
 * RETRY_TOKEN_MAX_ATTEMPTS, then stamp terminal.
 *
 * Two bugs bracket this function, and the fix for the first overshot into the
 * second. Originally the tick did `continue` with no write at all, leaving the
 * step unexecuted with a null result, which is exactly what stepDueCondition
 * selects: the same step was re-read and re-skipped every five minutes forever,
 * and its sequence could never exhaust. Stamping it terminal on the first tick
 * ended that loop but permanently forfeited the silent retry whenever the token
 * was only briefly missing (a merchant mid-reconnect, a rotated token), and
 * under silent-first ordering that is the FIRST and highest-value step for soft
 * and network declines. Review MEDIUM-2.
 *
 * So it now uses the same bounded-retry machinery an email send already had:
 * attempts 1..N-1 leave the step pending with next_retry_at set, attempt N goes
 * terminal on retry_no_connection and feeds the exhausted-sequence flip. A step
 * waiting on this backoff is still "pending", so its sequence is correctly NOT
 * flipped while the grace window is open.
 *
 * OPERATIONAL (plain batch, gotcha 25), conditional on executed_at IS NULL.
 * Returns the result it wrote, or null while still in grace.
 */
export async function recordMissingTokenAttempt(
  env: Env,
  step: { stepId: string; attemptCount: number },
  now: Date,
): Promise<string | null> {
  const patch = afterTransientFailureWith(step.attemptCount, "no connected stripe token", now, {
    maxAttempts: RETRY_TOKEN_MAX_ATTEMPTS,
    terminalResult: RETRY_RESULT_NO_CONNECTION,
  });
  const db = getDb(env);
  await db.batch([buildRetryAttemptPatch(db, step.stepId, patch)]);
  return patch.result;
}

/** The terminal result on a retry step skipped because the customer has a lost
 *  dispute with this account. */
const RETRY_RESULT_DISPUTE_LOST = "retry_skipped_dispute_lost";

/**
 * Whether this customer has a dispute with this account that the merchant lost.
 * Recova stopped card retries for such a customer (handleDisputeClosed set
 * customer_context.recovery_suppressed_retries, process-recovery skipped retry
 * steps on it): charging a customer who already won a chargeback invites the
 * next one. Read from the disputes table, not a customer_context flag, because
 * the Intelligence sync rebuilds that row and would drop a flag it does not own.
 *
 * FAILS OPEN, as Recova's check did: an error reads as "no lost dispute" and the
 * retry runs, so a read fault cannot silently stop recovery for everyone.
 */
async function hasLostDispute(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
): Promise<boolean> {
  try {
    const rows = await getDb(env)
      .select({ id: disputes.id })
      .from(disputes)
      .where(
        and(
          eq(disputes.accountId, accountId),
          eq(disputes.stripeCustomerId, stripeCustomerId),
          eq(disputes.state, "resolved_lost"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    console.error("lost-dispute check failed, retry proceeds:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * End a retry step without charging because of a lost dispute: the step goes
 * terminal (claim-on-write, so a redelivered tick cannot double-write) and the
 * suppression is recorded as Recova's recovery_retry_suppressed outcome, keyed
 * on the step so a replay collapses. Emails in the sequence are unaffected.
 */
async function suppressRetryForLostDispute(
  env: Env,
  row: Pick<DueStepRow, "stepId" | "stepType" | "accountId" | "attemptCount"> & { stripeCustomerId: string },
  now: Date,
): Promise<void> {
  const db = getDb(env);
  await db.batch([
    buildRetryAttemptPatch(db, row.stepId, {
      attemptCount: row.attemptCount,
      lastAttemptError: null,
      nextRetryAt: null,
      executedAt: now,
      result: RETRY_RESULT_DISPUTE_LOST,
    }),
  ]);
  await recordOutcome(env, {
    accountId: row.accountId,
    product: "recovery",
    eventType: "recovery_retry_suppressed",
    eventData: {
      step_id: row.stepId,
      step_type: row.stepType,
      stripe_customer_id: row.stripeCustomerId,
      reason: "dispute_lost",
    },
    outcome: "suppressed",
    outcomeAt: now,
    idempotencyKey: `recovery_retry_suppressed_${row.stepId}`,
  });
}

interface TickTally {
  due: number;
  chosen: number;
  retries: number;
  emails: number;
  recovered: number;
  skipped: number;
  /** Steps skipped because their account stopped being eligible DURING this run
   *  (almost always the emergency brake). Counted apart from `skipped` so a
   *  brake engage reads as a deliberate stop, not as engine noise, and apart
   *  from `failed` because nothing failed. */
  skippedIneligible: number;
  failed: number;
  exhausted: number;
  backlog: boolean;
  /** The tick was disabled mid-run and stopped early. */
  halted: boolean;
}

/** How many failing step ids the run message names before it truncates. Five is
 *  enough to see whether a tick's failures share a cause and short enough that a
 *  total outage does not write a message thousands of ids long. The count of the
 *  rest is always appended, so the cap is never silent. */
export const FAILED_STEP_IDS_IN_MESSAGE = 5;

/** Injectable seams for runRecoveryTick. Defaults are the real query + executors. */
export interface RecoveryTickDeps {
  query: (env: Env, now: Date) => Promise<DueStepRow[]>;
  runRetry: (env: Env, ctx: RetryStepContext) => Promise<{ recovered: boolean }>;
  runEmail: (env: Env, ctx: EmailStepContext) => Promise<unknown>;
  /** Find and flip sequences that have run out. Default: the real sweep. */
  flipExhausted: (env: Env, now: Date) => Promise<ClaimedSequence[]>;
  /** Record one failed attempt on a retry step with no usable connection.
   *  Resolves to the terminal result once grace runs out, else null. */
  recordMissingToken: (
    env: Env,
    step: { stepId: string; attemptCount: number },
    now: Date,
  ) => Promise<string | null>;
  /** Re-read the enabled flag + account eligibility before each step. Default:
   *  the real batched read. */
  checkGuards: (env: Env, accountId: string) => Promise<TickGuards>;
  /** Whether the customer has a lost dispute with the account. Default: the
   *  real fail-open read. */
  hasLostDispute: (env: Env, accountId: string, stripeCustomerId: string) => Promise<boolean>;
  /** Stamp the step terminal and record the suppression. */
  suppressRetry: (
    env: Env,
    row: Pick<DueStepRow, "stepId" | "stepType" | "accountId" | "attemptCount"> & { stripeCustomerId: string },
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
 *
 * Every guard the tick applies holds: the tick's enabled flag and the account
 * gate (brake, cancellation, demo), only payments that are 'active' (so never
 * one Stripe is still retrying, and never one recovered or cancelled), and
 * runGuardedRetry's lost-dispute, do-not-try-again and expired-card guards. A
 * step with no connected token is left for the tick, which owns the bounded
 * grace. The executor's step claim and Stripe idempotency key make a race with
 * a concurrent tick on the same step harmless.
 *
 * Never throws: a failure here leaves the step pending for its scheduled run.
 * Returns how many retries were attempted.
 */
export async function retryOnUpdatedCard(
  env: Env,
  accountId: string,
  stripeCustomerId: string,
  deps: Partial<Pick<RecoveryTickDeps, "runRetry" | "checkGuards" | "hasLostDispute" | "suppressRetry">> = {},
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
        console.error("card updater retry failed:", row.stepId, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("card updater retry lookup failed:", err instanceof Error ? err.message : err);
  }
  return attempted;
}

/**
 * Flip every exhausted sequence to failed_unrecovered. Runs AFTER the step loop
 * so a sequence whose last step just executed is caught in the same tick rather
 * than lingering 'active' for another five minutes.
 *
 * The limit is RECOVERY_TICK_LIMIT, the SAME constant that caps due steps, so
 * this sweep's bound moves whenever that one does (review LOW-1: the drop from
 * 500 to 100 quietly cut this sweep fivefold too, and only the step cap was
 * documented). Deliberate rather than incidental: both bounds keep one
 * invocation inside one subrequest budget. Unflipped sequences stay 'active' and
 * are re-selected next tick, so a backlog drains rather than being lost.
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
 * The flip is conditional on `status='active'`, so a sequence another tick
 * already claimed is silently skipped while the old `ids.length` counted it
 * anyway. Narrowing on `resolved_at = now` identifies exactly this flip's rows,
 * because `now` is this tick's own timestamp and the claim is what wrote it.
 *
 * EXPORTED because the narrowing is otherwise unprovable: inside
 * `flipExhaustedSequences` every candidate is claimed, since the query and the
 * flip run back to back on one thread, so a mutation that returns all
 * candidates cannot be caught through the public function. Reached directly, a
 * row that is in `ids` but carries a different `resolved_at` shows the
 * difference (337 binding 4).
 *
 * This is what the sequence-complete notification hangs off: it must fire once
 * per real transition, the same discipline the recovery notification takes from
 * executeMoneyWrite's `applied`.
 */
function readClaimedSequences(
  db: Db,
  ids: string[],
  now: Date,
): Promise<ClaimedSequence[]> {
  return db
    .select({ failedPaymentId: failedPayments.id, accountId: failedPayments.accountId })
    .from(failedPayments)
    .where(
      and(
        inArray(failedPayments.id, ids),
        eq(failedPayments.status, FAILED_PAYMENT_STATUS_UNRECOVERED),
        eq(failedPayments.resolvedAt, now),
      ),
    );
}

/** Run one recovery tick. Selects due steps, runs the earliest per payment through
 *  the right executor, isolates per-step failures, and returns cap telemetry. */
export async function runRecoveryTick(
  env: Env,
  deps: Partial<RecoveryTickDeps> = {},
  /** The cron run this tick belongs to (313), stamped onto every email_sends row
   *  it produces. Null when the tick is driven from a test or any non-cron
   *  caller, which is exactly what the nullable column records. */
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
    failed: 0,
    exhausted: 0,
    backlog: due.length >= RECOVERY_TICK_LIMIT,
    halted: false,
  };
  /** Every step that threw this tick, kept so the run's recorded message can
   *  NAME them rather than only count them. */
  const failedSteps: {
    stepId: string;
    failedPaymentId: string;
    stepType: string;
    errorClass: string;
    message: string;
  }[] = [];

  for (const row of chosen) {
    // Re-checked per step, not per run. Both gates were evaluated when the batch
    // was selected; without this, engaging the brake or disabling the tick took
    // effect only from the NEXT run, while this one kept charging cards.
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
        const result = await runGuardedRetry(env, row, now, { runRetry, lostDispute, suppressRetry });
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
      // AND SAY WHICH ONE (376's verify-first list, session 85). This used to be
      // a bare `catch {}` that incremented a counter, so a tick reporting "3
      // failed" named no step, no payment and no error: the only way to find out
      // was to re-run the sweep by hand and hope it failed the same way. The
      // error was not even bound to a name, so nothing could have been logged
      // without editing this line.
      //
      // THE CLASS, NOT JUST THE MESSAGE. A message tells you what went wrong
      // once; the class tells you whether tonight's three failures are one fault
      // or three, which is the first question on reading a tick that failed.
      failedSteps.push({
        stepId: row.stepId,
        failedPaymentId: row.failedPaymentId,
        stepType: row.stepType,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      });
      console.error("recovery step failed:", JSON.stringify(failedSteps[failedSteps.length - 1]));
    }
  }

  // Isolated like a per-step failure, but counted SEPARATELY: `failed` means
  // "steps that failed", and folding a bookkeeping sweep into it would make the
  // number mean two things. Never silent, though: the note is on the recorded
  // run message, so a sweep that is quietly always failing is visible in
  // cron_run_history rather than looking like a tick with nothing to flip.
  let sweepNote = "";
  if (tally.halted) {
    // An operator disabled the tick mid-run. "Disabled" should mean the tick
    // does nothing further, and this sweep was still performing a write pass
    // after the halt (review LOW-C). It moves no money and it already excludes
    // brake-paused accounts, so the old behavior was harmless, just not what
    // the word means. Skipped and reported, never silent.
    sweepNote = ", exhausted-sweep skipped (halted)";
  } else {
    try {
      const claimed = await flipExhausted(env, now);
      tally.exhausted = claimed.length;
      // THE SEQUENCE-COMPLETE NOTIFICATION, after the terminal claim commits and
      // only for the sequences this tick actually claimed. Never throws (its own
      // catch), because the terminal state and its outcome are already written
      // and a mail failure must not unwind them or fail the tick.
      for (const sequence of claimed) {
        await sendSequenceCompleteNotification(env, sequence);
      }
    } catch (err) {
      sweepNote = ", exhausted-sweep FAILED";
      console.error(
        "exhausted-sequence sweep failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const executed = tally.retries + tally.emails;
  // THE FAILING STEPS, NAMED IN THE RUN'S OWN RECORD. `console.error` above
  // reaches wrangler tail, which is a live stream nobody is watching at 03:00;
  // cron_run_history is what somebody actually reads the next morning, and a row
  // saying "3 failed" with no ids sends them back to the logs they no longer
  // have.
  //
  // BOUNDED, AND THE TRUNCATION SAYS SO. A tick can select up to
  // RECOVERY_TICK_LIMIT steps, so an outage that fails all of them would
  // otherwise write a message thousands of ids long. The first few identify the
  // fault; the count identifies the scale. A silent cap would read as "only
  // these failed", which is worse than a number.
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
  // Both stop conditions are named in the run message, so cron_run_history shows
  // a deliberate halt as a halt rather than as a quiet short run.
  const haltedNote = tally.halted ? ", HALTED (tick disabled mid-run)" : "";
  const pausedNote =
    tally.skippedIneligible > 0
      ? `, ${tally.skippedIneligible} skipped (account paused mid-run)`
      : "";
  return {
    rowsProcessed: executed,
    message:
      `${tally.due} due, ${tally.chosen} payments, ${tally.retries} retries ` +
      `(${tally.recovered} recovered), ${tally.emails} emails, ` +
      `${tally.skipped} skipped, ${tally.failed} failed, ` +
      `${tally.exhausted} exhausted${pausedNote}${failedNote}${sweepNote}${backlogNote}${haltedNote}`,
  };
}
