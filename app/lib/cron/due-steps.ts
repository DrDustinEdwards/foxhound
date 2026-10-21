// The recovery tick's reads (recovery-tick.ts split): which accounts may be
// processed, which steps are due, the per-payment step choice, exhausted
// sequences, and the row-to-context mapping the step executors take.

import { and, asc, eq, inArray, isNull, lte, notExists, notLike, or, type SQL } from "drizzle-orm";
import { type Db, accounts, failedPayments, getDb, recoverySteps, stripeConnections } from "~/db";
import {
  DEMO_ACCOUNT_ID_PREFIX,
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  RECOVERY_TICK_LIMIT,
} from "~/lib/constants";
import type { EmailStepContext } from "~/lib/engine/execute-step";
import type { RetryStepContext } from "~/lib/engine/retry-step";

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
  /** failed_payments.customer_name, for the day 1, 3 and 7 greeting (J85). */
  customerName: string | null;
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
  /** The payment's connection's `reply_to_email` (J03), for the Reply-To. */
  replyToEmail?: string | null;
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
      customerName: failedPayments.customerName,
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
      replyToEmail: stripeConnections.replyToEmail,
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
      customerName: failedPayments.customerName,
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
      replyToEmail: stripeConnections.replyToEmail,
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
    customerName: row.customerName,
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
    replyTo: row.replyToEmail ?? null,
    cached: {
      customBody: row.customBody,
      cachedSubject: row.aiSubject,
      cachedBodyHtml: row.aiBodyHtml,
    },
  };
}
