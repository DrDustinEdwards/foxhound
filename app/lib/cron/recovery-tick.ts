import { and, asc, eq, inArray, isNull, lte, notExists, notLike, or, type SQL } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, cronConfig, failedPayments, getDb, recoverySteps, stripeConnections } from "~/db";
import {
  DEMO_ACCOUNT_ID_PREFIX,
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  RECOVERY_TICK_CRON_NAME,
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
import { sendSequenceCompleteNotification } from "~/lib/recovery/sequence-complete-notification.server";

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
 * ("Active" on /recovery/payments, the demo-independent dashboard tiles)
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
  /** S27's merchant-context three, from `accounts`. Read into the generation
   *  prompt by `merchantContextLine`. */
  merchantIndustry: string | null;
  primaryCustomerType: string | null;
  merchantMrrCents: number | null;
  /** S31's four per-category voices, from `stripe_connections`. */
  brandVoiceSoft: string | null;
  brandVoiceExpired: string | null;
  brandVoiceNetwork: string | null;
  brandVoiceFraud: string | null;
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
      merchantIndustry: accounts.merchantIndustry,
      primaryCustomerType: accounts.primaryCustomerType,
      merchantMrrCents: accounts.merchantMrrSelfReported,
      brandVoiceSoft: stripeConnections.brandVoiceSoft,
      brandVoiceExpired: stripeConnections.brandVoiceExpired,
      brandVoiceNetwork: stripeConnections.brandVoiceNetwork,
      brandVoiceFraud: stripeConnections.brandVoiceFraud,
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

/**
 * The same joined row queryDueRecoverySteps builds, for ONE step chosen by a
 * MERCHANT rather than by the schedule (S7's "Trigger next step now").
 *
 * Three deliberate differences from the cron's own selection, each with a reason:
 *
 * `stepDueCondition` is NOT applied. A manual trigger is the merchant overriding
 * the schedule, so a step scheduled for tomorrow is still the one to fire; that
 * is legacy's behaviour and the entire point of the button. The step must still
 * be UNEXECUTED with no result, which the caller enforces through the shared
 * nextPendingStep selector, the same predicate the button renders from.
 *
 * The account scope is added, because this is reached from a request rather than
 * from a sweep and the payment must belong to the caller.
 *
 * `accountProcessingEligibleCondition` IS kept. The emergency brake pauses
 * PROCESSING, and executing a step is processing; a button that charges a card
 * while the brake is engaged would make the brake a lie. Note this is the ACCOUNT
 * gate only: the recovery-tick cron_config flag is deliberately NOT consulted,
 * because disabling the scheduler is a statement about automatic runs and a
 * merchant pressing a button is not one.
 */
export async function queryStepForManualTrigger(
  db: Db,
  accountId: string,
  stepId: string,
): Promise<DueStepRow | null> {
  const rows = await db
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
      merchantIndustry: accounts.merchantIndustry,
      primaryCustomerType: accounts.primaryCustomerType,
      merchantMrrCents: accounts.merchantMrrSelfReported,
      brandVoiceSoft: stripeConnections.brandVoiceSoft,
      brandVoiceExpired: stripeConnections.brandVoiceExpired,
      brandVoiceNetwork: stripeConnections.brandVoiceNetwork,
      brandVoiceFraud: stripeConnections.brandVoiceFraud,
    })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .innerJoin(accounts, eq(accounts.id, recoverySteps.accountId))
    .leftJoin(stripeConnections, eq(stripeConnections.id, failedPayments.stripeConnectionId))
    .where(
      and(
        eq(recoverySteps.id, stepId),
        eq(recoverySteps.accountId, accountId),
        eq(failedPayments.status, "active"),
        accountProcessingEligibleCondition(),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export function toRetryContext(row: DueStepRow): RetryStepContext | null {
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

export function toEmailContext(row: DueStepRow): EmailStepContext {
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
    // RAW for the From header: no copy fallback here, so send.ts applies the
    // From-appropriate default instead of a body-copy phrase (S33).
    senderName: row.merchantName,
    voiceDescription: row.brandVoice,
    merchantIndustry: row.merchantIndustry,
    primaryCustomerType: row.primaryCustomerType,
    merchantMrrCents: row.merchantMrrCents,
    brandVoiceSoft: row.brandVoiceSoft,
    brandVoiceExpired: row.brandVoiceExpired,
    brandVoiceNetwork: row.brandVoiceNetwork,
    brandVoiceFraud: row.brandVoiceFraud,
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

  // WHICH ids the claim actually took, not which it considered. The flip is
  // conditional on status='active', so a sequence another tick already flipped
  // is silently skipped, and the old `ids.length` counted it anyway. Reading
  // back on `resolved_at = now` identifies exactly this flip's rows, because
  // `now` is this tick's own timestamp and the claim is what wrote it.
  //
  // This is what the sequence-complete notification hangs off: it must fire
  // once per real transition, the same discipline the recovery notification
  // takes from executeMoneyWrite's `applied`.
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
        await runEmail(env, { ...toEmailContext(row), cronRunId });
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
  if (tally.halted) {
    // An operator disabled the tick mid-run. "Disabled" should mean the tick
    // does nothing further, and this sweep was still performing a write pass
    // after the halt (review LOW-C). It moves no money and it already excludes
    // brake-paused accounts, so the old behaviour was harmless, just not what
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
      `${tally.exhausted} exhausted${pausedNote}${sweepNote}${backlogNote}${haltedNote}`,
  };
}
