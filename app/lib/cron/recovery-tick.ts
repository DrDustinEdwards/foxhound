import { and, asc, eq, inArray, isNull, lte, notExists, notLike, or, type SQL } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, failedPayments, getDb, recoverySteps, stripeConnections } from "~/db";
import {
  DEMO_ACCOUNT_ID_PREFIX,
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  RECOVERY_TICK_LIMIT,
  RETRY_TOKEN_MAX_ATTEMPTS,
} from "~/lib/constants";
import {
  buildRetryAttemptPatch,
  executeEmailStep,
  executeRetryStep,
  type EmailStepContext,
  type RetryStepContext,
} from "~/lib/engine/execute-step";
import { stepAction } from "~/lib/engine/step-runner";
import { afterTransientFailureWith } from "~/lib/recovery/step-state";

import type { CronJobResult } from "./run";

// The recovery tick: the sweep that runs due recovery_steps. Registered through
// runCronJob (registry.ts), so cron-level overlap safety (the per-cron DO lock),
// the config-enabled gate, and the min-interval gate are all handled by the
// wrapper; this handler only does the per-step work.
//
// Safety model:
//   - Overlap: the cron mutex (runCronJob) prevents two whole ticks overlapping.
//   - Per-step exactly-once: the executors themselves are idempotent (Stripe
//     idempotency key on the charge, conditional executed_at claim); the
//     invoice.payment_succeeded webhook is the sole recovery recorder, and the
//     retry executor only reconciles attribution against it; see execute-step.ts.
//   - Failure isolation: each step runs in its own try/catch, so one Stripe error
//     or EMAIL throw never halts the sweep for the other steps/merchants.
//   - Stop condition: only steps whose parent failed_payment is still 'active' are
//     selected. A recovery (or a refund/dispute, which can only follow a recovery)
//     flips the parent off 'active', which halts its remaining steps. At most one
//     step per failed_payment runs per tick (silent-first ordering is baked into
//     the schedule, so earliest-due is correct ordering).
//   - Termination: every selected step must reach a terminal result or be
//     rescheduled. A step that is neither is re-selected every tick forever, and
//     its sequence can never finish. That was the null-token retry bug; see
//     recordMissingTokenAttempt, which reschedules with backoff for a bounded
//     number of attempts and only then goes terminal. The tick then flips
//     finished sequences to failed_unrecovered (flipExhaustedSequences), the
//     only writer of that status; 'recovered' still belongs solely to the webhook.
//   - Gating: demo accounts, processing-paused accounts, and cancelled accounts
//     (admin Pass 2: accounts.cancelledAt) are excluded in the query itself.
//     billing_exempt is NOT a processing gate: an exempt merchant still gets
//     their money recovered, they are only never billed Foxhound's fee (that
//     gate lives in the billing query, app/db/billable.ts). cancelledAt is
//     ALSO not a billing gate, deliberately: an already-matured, unbilled
//     recovery from before cancellation still bills at the next run.

/** Account-level PROCESSING gate: never process a demo account (non-negotiable
 *  #7), a processing-paused account, or a cancelled account (admin Pass 2).
 *  Distinct from the BILLING gate: a billing_exempt account is still processed
 *  (recovery moves the MERCHANT's money; only Foxhound's fee is waived), and a
 *  cancelled account's already-matured, unbilled recoveries still bill
 *  (cancelledAt is deliberately absent from app/db/billable.ts's
 *  accountBillingEligibleCondition; see app/lib/admin/merchants.server.ts's
 *  cancelMerchant). */
export function accountProcessingEligibleCondition(): SQL {
  return and(
    eq(accounts.processingPaused, false),
    isNull(accounts.cancelledAt),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  ) as SQL;
}

/** A step is due now: unexecuted, no result, not soft-deleted, and its effective
 *  time (next_retry_at if a send backoff rescheduled it, else scheduled_at) has
 *  arrived. Mirrors the pure scheduler.isStepDue, expressed as a SQL predicate. */
export function stepDueCondition(now: Date): SQL {
  return and(
    isNull(recoverySteps.executedAt),
    isNull(recoverySteps.result),
    isNull(recoverySteps.deletedAt),
    or(
      lte(recoverySteps.nextRetryAt, now),
      and(isNull(recoverySteps.nextRetryAt), lte(recoverySteps.scheduledAt, now)),
    ),
  ) as SQL;
}

// ============================================================================
// Exhausted sequences
// ============================================================================

/** A step that has not run yet. Same two columns stepDueCondition keys on, minus
 *  the timing clause: a step rescheduled by the send backoff is still pending
 *  (executed_at and result both null, next_retry_at set), so a sequence waiting
 *  on a backoff is NOT exhausted. */
function stepPendingCondition(): SQL {
  return and(
    isNull(recoverySteps.executedAt),
    isNull(recoverySteps.result),
    isNull(recoverySteps.deletedAt),
  ) as SQL;
}

/**
 * failed_payments whose recovery sequence has run out: still 'active', on a
 * processing-eligible account, with no step left to run.
 *
 * Nothing used to write this transition, so a payment that was dunned for thirty
 * days and never recovered stayed 'active' forever. Every status-keyed count
 * ("In recovery" on /recovery/payments, the demo-independent dashboard tiles)
 * drifted upward permanently and told the merchant a payment was being worked
 * when the engine had finished with it weeks earlier.
 *
 * The `exists` half matters: a failed_payment with zero steps has not exhausted
 * anything, it has not started. Intake always plans at least one step, so that
 * case is a partially-committed intake rather than a finished sequence, and
 * flipping it would hide a real problem.
 */
export async function queryExhaustedSequences(env: Env, limit: number): Promise<string[]> {
  const db = getDb(env);
  const rows = await db
    .select({ id: failedPayments.id })
    .from(failedPayments)
    .innerJoin(accounts, eq(accounts.id, failedPayments.accountId))
    .where(
      and(
        eq(failedPayments.status, "active"),
        isNull(failedPayments.deletedAt),
        accountProcessingEligibleCondition(),
        // At least one step exists...
        notExists(
          db
            .select({ one: recoverySteps.id })
            .from(recoverySteps)
            .where(
              and(
                eq(recoverySteps.failedPaymentId, failedPayments.id),
                isNull(recoverySteps.deletedAt),
                stepPendingCondition(),
              ),
            ),
        ),
      ),
    )
    .limit(limit);

  // ...and none of them is still pending. The "has any step at all" half is
  // applied here rather than as a second correlated subquery: the set is already
  // narrow, and a second EXISTS on the same table reads worse than this does.
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const withSteps = await db
    .selectDistinct({ id: recoverySteps.failedPaymentId })
    .from(recoverySteps)
    .where(
      and(inArray(recoverySteps.failedPaymentId, ids), isNull(recoverySteps.deletedAt)),
    );
  return withSteps.map((r) => r.id);
}

/**
 * The terminal flip, conditional on status='active' so it lands exactly once no
 * matter how many ticks observe the same exhausted sequence. OPERATIONAL: a
 * plain batch, never the money-write DO (gotcha 25). It records that outreach
 * finished; it moves no money and gates no billing. Note that an already-matured
 * unbilled recovery on this payment still bills, because app/db/billable.ts
 * keys on recovered_payments, not on this column.
 */
export function buildExhaustedSequenceFlip(db: Db, failedPaymentIds: string[], now: Date) {
  return db
    .update(failedPayments)
    .set({ status: FAILED_PAYMENT_STATUS_UNRECOVERED, resolvedAt: now })
    .where(
      and(inArray(failedPayments.id, failedPaymentIds), eq(failedPayments.status, "active")),
    );
}

/** One due step joined to the context the executors need. */
export interface DueStepRow {
  stepId: string;
  stepType: string;
  stepNumber: number | null;
  accountId: string;
  failedPaymentId: string;
  scheduledAt: Date;
  nextRetryAt: Date | null;
  attemptCount: number;
  customBody: string | null;
  aiSubject: string | null;
  aiBodyHtml: string | null;
  invoiceId: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  declineCategory: string;
  connectionAccessToken: string | null;
  merchantName: string | null;
  brandVoice: string | null;
}

/** Fetch due steps for active failed payments on processing-eligible accounts,
 *  bounded to RECOVERY_TICK_LIMIT and earliest-scheduled first. */
export async function queryDueRecoverySteps(env: Env, now: Date): Promise<DueStepRow[]> {
  const db = getDb(env);
  return db
    .select({
      stepId: recoverySteps.id,
      stepType: recoverySteps.stepType,
      stepNumber: recoverySteps.stepNumber,
      accountId: recoverySteps.accountId,
      failedPaymentId: recoverySteps.failedPaymentId,
      scheduledAt: recoverySteps.scheduledAt,
      nextRetryAt: recoverySteps.nextRetryAt,
      attemptCount: recoverySteps.attemptCount,
      customBody: recoverySteps.customBody,
      aiSubject: recoverySteps.aiSubject,
      aiBodyHtml: recoverySteps.aiBodyHtml,
      invoiceId: failedPayments.stripeInvoiceId,
      amountCents: failedPayments.amountCents,
      currency: failedPayments.currency,
      customerEmail: failedPayments.customerEmail,
      declineCategory: failedPayments.declineCategory,
      connectionAccessToken: stripeConnections.stripeAccessToken,
      merchantName: stripeConnections.senderName,
      brandVoice: stripeConnections.brandVoice,
    })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .innerJoin(accounts, eq(accounts.id, recoverySteps.accountId))
    .leftJoin(stripeConnections, eq(stripeConnections.id, failedPayments.stripeConnectionId))
    .where(
      and(
        stepDueCondition(now),
        eq(failedPayments.status, "active"),
        accountProcessingEligibleCondition(),
      ),
    )
    .orderBy(asc(recoverySteps.scheduledAt))
    .limit(RECOVERY_TICK_LIMIT);
}

/** Effective due time of a row (next_retry_at wins over scheduled_at). */
function dueAtMs(row: DueStepRow): number {
  return (row.nextRetryAt ?? row.scheduledAt).getTime();
}

/**
 * Reduce the due steps to at most one per failed payment: the earliest-due step
 * (tiebreak by step number). Silent-first ordering is baked into the schedule, so
 * running the single earliest-due step per payment per tick honors it (a due
 * retry always precedes its payment's later emails). Pure.
 */
export function chooseStepsPerPayment(rows: DueStepRow[]): DueStepRow[] {
  const best = new Map<string, DueStepRow>();
  for (const row of rows) {
    const current = best.get(row.failedPaymentId);
    if (
      !current ||
      dueAtMs(row) < dueAtMs(current) ||
      (dueAtMs(row) === dueAtMs(current) && (row.stepNumber ?? 0) < (current.stepNumber ?? 0))
    ) {
      best.set(row.failedPaymentId, row);
    }
  }
  return [...best.values()];
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

function toRetryContext(row: DueStepRow): RetryStepContext | null {
  if (!row.connectionAccessToken) return null; // cannot charge without the connected token
  return {
    stepId: row.stepId,
    failedPaymentId: row.failedPaymentId,
    accountId: row.accountId,
    invoiceId: row.invoiceId,
    amountCents: row.amountCents,
    currency: row.currency,
    connectionAccessToken: row.connectionAccessToken,
  };
}

function toEmailContext(row: DueStepRow): EmailStepContext {
  return {
    stepId: row.stepId,
    accountId: row.accountId,
    failedPaymentId: row.failedPaymentId,
    stepType: row.stepType,
    attemptCount: row.attemptCount,
    declineCategory: row.declineCategory,
    customerEmail: row.customerEmail,
    amountCents: row.amountCents,
    currency: row.currency,
    merchantName: row.merchantName ?? "your subscription",
    voiceDescription: row.brandVoice,
    cached: {
      customBody: row.customBody,
      cachedSubject: row.aiSubject,
      cachedBodyHtml: row.aiBodyHtml,
    },
  };
}

interface TickTally {
  due: number;
  chosen: number;
  retries: number;
  emails: number;
  recovered: number;
  skipped: number;
  failed: number;
  exhausted: number;
  backlog: boolean;
}

/** Injectable seams for runRecoveryTick. Defaults are the real query + executors. */
export interface RecoveryTickDeps {
  query: (env: Env, now: Date) => Promise<DueStepRow[]>;
  runRetry: (env: Env, ctx: RetryStepContext) => Promise<{ recovered: boolean }>;
  runEmail: (env: Env, ctx: EmailStepContext) => Promise<unknown>;
  /** Find and flip sequences that have run out. Default: the real sweep. */
  flipExhausted: (env: Env, now: Date) => Promise<number>;
  /** Record one failed attempt on a retry step with no usable connection.
   *  Resolves to the terminal result once grace runs out, else null. */
  recordMissingToken: (
    env: Env,
    step: { stepId: string; attemptCount: number },
    now: Date,
  ) => Promise<string | null>;
}

/**
 * Flip every exhausted sequence to failed_unrecovered. Runs AFTER the step loop
 * so a sequence whose last step just executed is caught in the same tick rather
 * than lingering 'active' for another five minutes.
 */
export async function flipExhaustedSequences(env: Env, now: Date): Promise<number> {
  const ids = await queryExhaustedSequences(env, RECOVERY_TICK_LIMIT);
  if (ids.length === 0) return 0;
  const db = getDb(env);
  await db.batch([buildExhaustedSequenceFlip(db, ids, now)]);
  return ids.length;
}

/** Run one recovery tick. Selects due steps, runs the earliest per payment through
 *  the right executor, isolates per-step failures, and returns cap telemetry. */
export async function runRecoveryTick(
  env: Env,
  deps: Partial<RecoveryTickDeps> = {},
): Promise<CronJobResult> {
  const query = deps.query ?? queryDueRecoverySteps;
  const runRetry = deps.runRetry ?? executeRetryStep;
  const runEmail = deps.runEmail ?? executeEmailStep;
  const flipExhausted = deps.flipExhausted ?? flipExhaustedSequences;
  const recordMissingToken = deps.recordMissingToken ?? recordMissingTokenAttempt;

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
    failed: 0,
    exhausted: 0,
    backlog: due.length >= RECOVERY_TICK_LIMIT,
  };

  for (const row of chosen) {
    const action = stepAction(row.stepType);
    try {
      if (action === "retry") {
        const ctx = toRetryContext(row);
        if (!ctx) {
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
        const result = await runRetry(env, ctx);
        tally.retries += 1;
        if (result.recovered) tally.recovered += 1;
      } else if (action === "email") {
        await runEmail(env, toEmailContext(row));
        tally.emails += 1;
      } else {
        tally.skipped += 1; // unknown step type (e.g. the card_update signal row)
      }
    } catch {
      // Isolate: one step's failure never halts the sweep for the others.
      tally.failed += 1;
    }
  }

  // Isolated like a per-step failure, but counted SEPARATELY: `failed` means
  // "steps that failed", and folding a bookkeeping sweep into it would make the
  // number mean two things. Never silent, though: the note is on the recorded
  // run message, so a sweep that is quietly always failing is visible in
  // cron_run_history rather than looking like a tick with nothing to flip.
  let sweepNote = "";
  try {
    tally.exhausted = await flipExhausted(env, now);
  } catch (err) {
    sweepNote = ", exhausted-sweep FAILED";
    console.error(
      "exhausted-sequence sweep failed:",
      err instanceof Error ? err.message : err,
    );
  }

  const executed = tally.retries + tally.emails;
  const backlogNote = tally.backlog ? ", BACKLOG (tick hit RECOVERY_TICK_LIMIT)" : "";
  return {
    rowsProcessed: executed,
    message:
      `${tally.due} due, ${tally.chosen} payments, ${tally.retries} retries ` +
      `(${tally.recovered} recovered), ${tally.emails} emails, ` +
      `${tally.skipped} skipped, ${tally.failed} failed, ` +
      `${tally.exhausted} exhausted${sweepNote}${backlogNote}`,
  };
}
