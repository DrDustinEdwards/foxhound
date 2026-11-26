// The recovery tick's reads: processable accounts, due steps, the per-payment step choice, exhausted sequences.

import { primaryConnectionValue, senderNameOrAccountName } from "~/lib/stripe/connections.server";
import { and, asc, eq, isNull, lte, notExists, notLike, or, type SQL } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";
import { type Db, accounts, failedPayments, getDb, recoverySteps, stripeConnections } from "~/db";
import {
  DEMO_ACCOUNT_ID_PREFIX,
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  RECOVERY_TICK_LIMIT,
} from "~/lib/constants";
import type { EmailStepContext } from "~/lib/engine/execute-step";
import type { RetryStepContext } from "~/lib/engine/retry-step";
import { isRetryStep } from "~/lib/recovery/schedule";
import { readVoiceSamples } from "~/lib/recovery/voice-samples";

// The recovery tick's sweep of due recovery_steps, run through runScheduledJobs (run.ts), which owns overlap, enabled and min-interval gating.
//   - Exactly-once: executors are idempotent (Stripe idempotency key, conditional executed_at claim); invoice.payment_succeeded is the sole recovery recorder (execute-step.ts).
//   - Isolation: each step has its own try/catch.
//   - Stop: only steps whose parent failed_payment is 'active' are selected, at most one per payment per tick (silent-first ordering is in the schedule).
//   - Termination: a step must reach a terminal result or be rescheduled, or it is re-selected forever (see recordMissingTokenAttempt). Finished sequences flip to failed_unrecovered (flipExhaustedSequences), its only writer.
//   - Gating: demo, processing-paused and canceled accounts are excluded in the query. billing_exempt is NOT a processing gate (only the fee is waived; see app/db/billable.ts), and cancelledAt is deliberately not a billing gate.

/** Account PROCESSING gate: never a demo, processing-paused or canceled account. Distinct from the billing gate (app/db/billable.ts). */
export function accountProcessingEligibleCondition(): SQL {
  return and(
    eq(accounts.processingPaused, false),
    isNull(accounts.cancelledAt),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  ) as SQL;
}

/** Due now: unexecuted, no result, not soft-deleted, effective time (next_retry_at, else scheduled_at) arrived. */
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

/** Not run yet: stepDueCondition minus timing, so a step waiting on a backoff is still pending. */
export function stepPendingCondition(): SQL {
  return and(
    isNull(recoverySteps.executedAt),
    isNull(recoverySteps.result),
    isNull(recoverySteps.deletedAt),
  ) as SQL;
}

/** failed_payments still 'active' on a processing-eligible account with no step left. */
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

  // None pending; "has any step" is applied here rather than as a second EXISTS.
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const withSteps = await db
    .selectDistinct({ id: recoverySteps.failedPaymentId })
    .from(recoverySteps)
    .where(and(inList(recoverySteps.failedPaymentId, ids), isNull(recoverySteps.deletedAt)));
  return withSteps.map((r) => r.id);
}

/** The terminal flip, conditional on status='active' so it lands once. Operational: a plain batch, no money. */
export function buildExhaustedSequenceFlip(db: Db, failedPaymentIds: string[], now: Date) {
  return db
    .update(failedPayments)
    .set({ status: FAILED_PAYMENT_STATUS_UNRECOVERED, resolvedAt: now })
    .where(and(inList(failedPayments.id, failedPaymentIds), eq(failedPayments.status, "active")));
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
  /** failed_payments.customer_name, for the day 1, 3 and 7 greeting. */
  customerName: string | null;
  declineCategory: string;
  connectionAccessToken: string | null;
  merchantName: string | null;
  brandVoice: string | null;
  merchantIndustry: string | null;
  primaryCustomerType: string | null;
  merchantMrrCents: number | null;
  brandVoiceSoft: string | null;
  brandVoiceExpired: string | null;
  brandVoiceNetwork: string | null;
  brandVoiceFraud: string | null;
  /** The account's primary connection's `brand_voice_samples`, as stored. */
  brandVoiceSamples?: string | null;
  /** The payment's connection's `reply_to_email`, for the Reply-To. */
  replyToEmail?: string | null;
  /** failed_payments.stripe_customer_id, for the lost-dispute retry check. */
  stripeCustomerId?: string | null;
  /**
   * The payment's connection's stored charges_enabled (account.updated). False
   * holds a retry step; NULL (never told) does not.
   */
  chargesEnabled?: boolean | null;
  /** failed_payments.network_advice_code, for the do-not-try-again stop. */
  networkAdviceCode?: string | null;
}

// Sample emails are saved on the account's primary connection (/settings/brand-voice), read from there whichever connection the payment used.
const primarySamples = primaryConnectionValue<string>(
  stripeConnections.brandVoiceSamples,
  recoverySteps.accountId,
);

/** One recovery step joined to its payment, account and connection. */
function selectStepRows(db: Db) {
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
      merchantName: senderNameOrAccountName(stripeConnections.senderName, accounts.name),
      brandVoice: stripeConnections.brandVoice,
      merchantIndustry: accounts.merchantIndustry,
      primaryCustomerType: accounts.primaryCustomerType,
      merchantMrrCents: accounts.merchantMrrSelfReported,
      brandVoiceSoft: stripeConnections.brandVoiceSoft,
      brandVoiceExpired: stripeConnections.brandVoiceExpired,
      brandVoiceNetwork: stripeConnections.brandVoiceNetwork,
      brandVoiceFraud: stripeConnections.brandVoiceFraud,
      brandVoiceSamples: primarySamples,
      replyToEmail: stripeConnections.replyToEmail,
      stripeCustomerId: failedPayments.stripeCustomerId,
      chargesEnabled: stripeConnections.chargesEnabled,
      networkAdviceCode: failedPayments.networkAdviceCode,
    })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .innerJoin(accounts, eq(accounts.id, recoverySteps.accountId))
    .leftJoin(stripeConnections, eq(stripeConnections.id, failedPayments.stripeConnectionId));
}

/** Due steps for active failed payments, up to RECOVERY_TICK_LIMIT, earliest first. */
export async function queryDueRecoverySteps(env: Env, now: Date): Promise<DueStepRow[]> {
  return selectStepRows(getDb(env))
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

/** At most one step per failed payment: earliest-due, tiebreak by step number. Pure. */
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

/** The joined row queryDueRecoverySteps builds, for ONE step a merchant chose. The caller enforces it is unexecuted via nextPendingStep. */
export async function queryStepForManualTrigger(
  db: Db,
  accountId: string,
  stepId: string,
): Promise<DueStepRow | null> {
  const rows = await selectStepRows(db)
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

/** Pending RETRY steps of one customer's active failed payments, for the card updater's retry-now. stepDueCondition is not applied (it runs early); the processing gate is. */
export async function queryPendingRetryStepsForCustomer(
  db: Db,
  accountId: string,
  stripeCustomerId: string,
): Promise<DueStepRow[]> {
  const rows = await selectStepRows(db)
    .where(
      and(
        eq(recoverySteps.accountId, accountId),
        eq(failedPayments.stripeCustomerId, stripeCustomerId),
        eq(failedPayments.status, "active"),
        isNull(failedPayments.deletedAt),
        stepPendingCondition(),
        accountProcessingEligibleCondition(),
      ),
    )
    .orderBy(asc(recoverySteps.scheduledAt));
  return rows.filter((row) => isRetryStep(row.stepType));
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
    declineCategory: row.declineCategory,
    networkAdviceCode: row.networkAdviceCode ?? null,
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
    // Raw for the From header: send.ts applies the default.
    senderName: row.merchantName,
    voiceDescription: row.brandVoice,
    merchantIndustry: row.merchantIndustry,
    primaryCustomerType: row.primaryCustomerType,
    merchantMrrCents: row.merchantMrrCents,
    brandVoiceSoft: row.brandVoiceSoft,
    brandVoiceExpired: row.brandVoiceExpired,
    brandVoiceNetwork: row.brandVoiceNetwork,
    brandVoiceFraud: row.brandVoiceFraud,
    voiceSamples: readVoiceSamples(row.brandVoiceSamples),
    replyTo: row.replyToEmail ?? null,
    cached: {
      customBody: row.customBody,
      cachedSubject: row.aiSubject,
      cachedBodyHtml: row.aiBodyHtml,
    },
  };
}
