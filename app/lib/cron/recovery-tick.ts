import { and, asc, eq, isNull, lte, notLike, or, type SQL } from "drizzle-orm";

import { accounts, failedPayments, getDb, recoverySteps, stripeConnections } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX, RECOVERY_TICK_LIMIT } from "~/lib/constants";
import {
  executeEmailStep,
  executeRetryStep,
  type EmailStepContext,
  type RetryStepContext,
} from "~/lib/engine/execute-step";
import { stepAction } from "~/lib/engine/step-runner";

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
  backlog: boolean;
}

/** Injectable seams for runRecoveryTick. Defaults are the real query + executors. */
export interface RecoveryTickDeps {
  query: (env: Env, now: Date) => Promise<DueStepRow[]>;
  runRetry: (env: Env, ctx: RetryStepContext) => Promise<{ recovered: boolean }>;
  runEmail: (env: Env, ctx: EmailStepContext) => Promise<unknown>;
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
    backlog: due.length >= RECOVERY_TICK_LIMIT,
  };

  for (const row of chosen) {
    const action = stepAction(row.stepType);
    try {
      if (action === "retry") {
        const ctx = toRetryContext(row);
        if (!ctx) {
          tally.skipped += 1; // no connected token; cannot safely charge
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

  const executed = tally.retries + tally.emails;
  const backlogNote = tally.backlog ? ", BACKLOG (tick hit RECOVERY_TICK_LIMIT)" : "";
  return {
    rowsProcessed: executed,
    message:
      `${tally.due} due, ${tally.chosen} payments, ${tally.retries} retries ` +
      `(${tally.recovered} recovered), ${tally.emails} emails, ` +
      `${tally.skipped} skipped, ${tally.failed} failed${backlogNote}`,
  };
}
