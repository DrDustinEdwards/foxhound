// The retry step: pays the failed invoice through the connected account, records the attempt, and
// reconciles a success into a recovery. The email step is in execute-step.ts.

import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { changedRows, type Db, getDb, recoverySteps } from "~/db";
import type { DeclineCategory } from "~/lib/constants";
import { executeMoneyWrite } from "~/lib/money/execute";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { isRetryable } from "~/lib/recovery/decline";
import { buildStopRecoveryBatch } from "~/lib/recovery/manual-action-batches.server";
import {
  reconcileRetryRecovery as reconcileRetryRecoveryReal,
  type RetryReconciliationInput,
} from "~/lib/recovery/record-recovery";
import {
  isIdempotencyConflict,
  readRetryDecline,
  type RetryDeclineReading,
  type RetryResult,
  type StepStatePatch,
} from "~/lib/recovery/step-state";
import { loadSlackCustomer, postToSlack, resolveSlackTarget } from "~/lib/notify/slack.server";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";
import { buildDeclineRefreshBatch } from "~/lib/webhooks/batches";
import { type CardChangeVerdict, checkCardChanged, retryNeedsChangedCard } from "./card-change";
import { decideRetryStep, type RetryAttempt } from "./step-runner";

// The live recovery-step executor: wraps the pure deciders (step-runner.ts) with real side effects and persistence.
// Money-path rules: the recovery_steps write is operational (plain db.batch); only reconcileRetryRecovery
// rides the per-account money-write DO. Exactly-once under overlapping or redelivered ticks: the charge
// carries a Stripe idempotency key, and the step patch is conditional (WHERE executed_at IS NULL). The
// invoice.payment_succeeded webhook is the SOLE recorder of a recovery and owner of the 'recovered' status
// flip; this executor never inserts a recovered_payments/outcomes row. reconcileRetryRecovery is an
// UPDATE-only correction for the reverse race (webhook lands before this step's patch), so it can never
// collide with the webhook's insert. See record-recovery.ts.

/** Everything the retry executor needs, loaded by the cron. connectionAccessToken is the ENCRYPTED token;
 *  it is decrypted here and never logged. */
export interface RetryStepContext {
  stepId: string;
  failedPaymentId: string;
  accountId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  connectionAccessToken: string;
  /** failed_payments.decline_category; an expired card's retry charges only a changed card (card-change.ts). */
  declineCategory: string;
  /** failed_payments.network_advice_code. "do_not_try_again" stops the retry whatever the category says. */
  networkAdviceCode?: string | null;
}

const RETRY_RESULT_DO_NOT_TRY_AGAIN = "retry_skipped_do_not_try_again";

/** Stripe idempotency key for a retry charge: stable per step, so a redelivered tick is deduped (no double charge). */
export function retryIdempotencyKey(stepId: string): string {
  return `foxhound_retry_${stepId}`;
}

/** The conditional operational patch for a retry step: sets the terminal result only if the step has not
 *  already been executed (claim-on-write). Plain db, not the money DO. */
export function buildRetryStepPatch(
  db: Db,
  stepId: string,
  patch: Pick<StepStatePatch, "executedAt" | "result"> & { retryResult: string },
) {
  return db
    .update(recoverySteps)
    .set({ executedAt: patch.executedAt, result: patch.result, retryResult: patch.retryResult })
    .where(and(eq(recoverySteps.id, stepId), isNull(recoverySteps.executedAt)));
}

/** The patch for a retry step that could not be attempted, carrying the bounded-retry state (attempt count,
 *  error, backoff). Same claim-on-write as buildRetryStepPatch. */
export function buildRetryAttemptPatch(db: Db, stepId: string, patch: StepStatePatch) {
  return db
    .update(recoverySteps)
    .set({
      attemptCount: patch.attemptCount,
      lastAttemptError: patch.lastAttemptError,
      nextRetryAt: patch.nextRetryAt,
      executedAt: patch.executedAt,
      result: patch.result,
      retryResult: patch.result,
    })
    .where(and(eq(recoverySteps.id, stepId), isNull(recoverySteps.executedAt)));
}

/** The reconcileRetryRecovery input for a landed silent retry. Pure. foxhound_retry's ref is the strongest
 *  proof of causation, so a reverse-race correction upgrades to the right attribution. */
export function buildRetryReconciliationInput(
  ctx: RetryStepContext,
  recoveredAt: Date,
): RetryReconciliationInput {
  return {
    accountId: ctx.accountId,
    failedPaymentId: ctx.failedPaymentId,
    stepId: ctx.stepId,
    recoveredAt,
  };
}

/**
 * Read the invoice, then pay it on the connected account with the retry idempotency key, classifying the
 * outcome into a RetryAttempt. The read comes first because the invoice may have moved since planning:
 * only an open or uncollectible invoice is charged, and only once Stripe has no attempt of its own
 * scheduled (Foxhound's retries stay behind Stripe's).
 */
export async function payInvoiceWithClient(
  stripe: Stripe,
  ctx: RetryStepContext,
): Promise<RetryAttempt> {
  try {
    const current = await stripe.invoices.retrieve(ctx.invoiceId);
    if (current.status !== "open" && current.status !== "uncollectible") {
      return { invoiceClosedStatus: current.status ?? "unknown" };
    }
    if (current.next_payment_attempt != null) return { stripeRetrying: true };
    const invoice = await stripe.invoices.pay(
      ctx.invoiceId,
      {},
      { idempotencyKey: retryIdempotencyKey(ctx.stepId) },
    );
    return { invoiceStatus: invoice.status ?? null };
  } catch (error) {
    return { threw: true, error };
  }
}

export interface RetryStepDeps {
  payInvoice: (env: Env, ctx: RetryStepContext) => Promise<RetryAttempt>;
  /** Persist the operational step patch (plain db.batch). Resolves false when the claim matched no row. */
  persistPatch: (
    env: Env,
    stepId: string,
    patch: Pick<StepStatePatch, "executedAt" | "result"> & { retryResult: string },
  ) => Promise<boolean>;
  /** Reconcile the foxhound_retry attribution against what the webhook already recorded, through the money DO. */
  reconcileRecovery: (env: Env, input: RetryReconciliationInput) => Promise<boolean>;
  /** Whether the card changed since the decline; asked only for a category whose retry needs it (expired). */
  checkCardChanged: (env: Env, ctx: RetryStepContext) => Promise<CardChangeVerdict>;
  /** Store a declined retry's decline on the failed payment, through the money DO. */
  recordDecline: (env: Env, ctx: RetryStepContext, reading: RetryDeclineReading) => Promise<void>;
  /** End recovery for a payment whose invoice was voided, through the money DO. */
  stopRecovery: (env: Env, ctx: RetryStepContext, now: Date) => Promise<void>;
}

async function defaultPayInvoice(env: Env, ctx: RetryStepContext): Promise<RetryAttempt> {
  const token = await decryptToken(env, ctx.connectionAccessToken);
  const stripe = getConnectedStripe(token);
  return payInvoiceWithClient(stripe, ctx);
}

async function defaultPersistPatch(
  env: Env,
  stepId: string,
  patch: Pick<StepStatePatch, "executedAt" | "result"> & { retryResult: string },
): Promise<boolean> {
  const db = getDb(env);
  const [result] = await db.batch([buildRetryStepPatch(db, stepId, patch)]);
  return changedRows(result) > 0;
}

async function defaultRecordDecline(
  env: Env,
  ctx: RetryStepContext,
  reading: RetryDeclineReading,
): Promise<void> {
  await executeMoneyWrite(env, {
    accountId: ctx.accountId,
    idempotencyKey: `retry-decline:${ctx.stepId}`,
    build: (db) =>
      buildDeclineRefreshBatch(db, {
        accountId: ctx.accountId,
        failedPaymentId: ctx.failedPaymentId,
        ...reading,
      }),
  });
}

async function defaultStopRecovery(env: Env, ctx: RetryStepContext, now: Date): Promise<void> {
  await executeMoneyWrite(env, {
    accountId: ctx.accountId,
    idempotencyKey: `invoice-void-stop:${ctx.failedPaymentId}`,
    build: (db) =>
      buildStopRecoveryBatch(db, {
        accountId: ctx.accountId,
        failedPaymentId: ctx.failedPaymentId,
        now,
      }),
  });
}

/** True for a decline no retry can fix, even if the step was planned earlier: an earlier retry's decline
 *  can move the row there. An expired card is not one (guarded on a changed card instead). */
function retryCannotHelp(declineCategory: string): boolean {
  return (
    !isRetryable(declineCategory as DeclineCategory) && !retryNeedsChangedCard(declineCategory)
  );
}

export interface RetryStepResult {
  action: "retry";
  executed: boolean;
  recovered: boolean;
  retryResult: string;
}

/** Execute one retry step: live charge -> pure decision -> operational persist -> (on success) the
 *  foxhound_retry money-write. A failed retry resolves the step; only email sends have a backoff. */
export async function executeRetryStep(
  env: Env,
  ctx: RetryStepContext,
  deps: Partial<RetryStepDeps> = {},
): Promise<RetryStepResult> {
  const payInvoice = deps.payInvoice ?? defaultPayInvoice;
  const persistPatch = deps.persistPatch ?? defaultPersistPatch;
  const reconcileRecovery = deps.reconcileRecovery ?? reconcileRetryRecoveryReal;
  const checkChanged = deps.checkCardChanged ?? checkCardChanged;
  const recordDecline = deps.recordDecline ?? defaultRecordDecline;
  const stopRecovery = deps.stopRecovery ?? defaultStopRecovery;

  const now = new Date();
  const skip = async (skipped: RetryResult): Promise<RetryStepResult> => {
    const claimed = await persistPatch(env, ctx.stepId, {
      executedAt: now,
      result: skipped,
      retryResult: skipped,
    });
    return { action: "retry", executed: claimed, recovered: false, retryResult: skipped };
  };
  // The card network said never to retry; a retry against that advice can cost a network fee. No charge.
  if (ctx.networkAdviceCode === "do_not_try_again") return skip(RETRY_RESULT_DO_NOT_TRY_AGAIN);
  // A hard decline, before any charge: an earlier retry's decline may have moved the row to a category no retry fixes.
  if (retryCannotHelp(ctx.declineCategory)) return skip("retry_skipped_hard_decline");
  // Expired-card guard: an unchanged (or unreadable) card ends the step with no charge.
  if (retryNeedsChangedCard(ctx.declineCategory)) {
    const verdict = await checkChanged(env, ctx);
    if (verdict !== "changed") {
      return skip(
        verdict === "unchanged" ? "retry_skipped_card_unchanged" : "retry_skipped_unverified",
      );
    }
  }
  const attempt = await payInvoice(env, ctx);
  // Another run is charging this step under the same idempotency key; its outcome is the step's.
  if (attempt.threw && isIdempotencyConflict(attempt.error)) {
    return { action: "retry", executed: false, recovered: false, retryResult: "retry_in_progress" };
  }
  if (attempt.stripeRetrying) return skip("retry_skipped_stripe_retrying");
  if (attempt.invoiceClosedStatus !== undefined) {
    const result = await skip("retry_skipped_invoice_closed");
    // A void invoice can never be paid, so recovery ends. A paid one is left to invoice.payment_succeeded.
    if (result.executed && attempt.invoiceClosedStatus === "void")
      await stopRecovery(env, ctx, now);
    return result;
  }
  const decision = decideRetryStep(attempt, now);
  // The retry's own decline is stored before the step is marked, so a failed write leaves the step pending
  // and the rerun replays the same Stripe response under the idempotency key.
  const reading = attempt.threw ? readRetryDecline(attempt.error) : null;
  if (reading) await recordDecline(env, ctx, reading);
  // The claim: zero rows means another run executed this step first and owns reconciliation and Slack.
  if (!(await persistPatch(env, ctx.stepId, decision.patch))) {
    console.error("retry step already executed by another run:", ctx.stepId);
    return {
      action: "retry",
      executed: false,
      recovered: false,
      retryResult: decision.retryResult,
    };
  }
  if (decision.recovered) {
    await reconcileRecovery(env, buildRetryReconciliationInput(ctx, now));
    // Slack fires only on a succeeded retry, after reconciliation so a Slack outage cannot cost a recorded recovery. Never throws.
    await notifySlackRecovered(env, ctx);
  }
  return {
    action: "retry",
    executed: true,
    recovered: decision.recovered,
    retryResult: decision.retryResult,
  };
}

async function notifySlackRecovered(env: Env, ctx: RetryStepContext): Promise<void> {
  const target = await resolveSlackTarget(env, ctx.accountId);
  if (target.status !== "ready") return;
  const customer = await loadSlackCustomer(env, ctx.failedPaymentId, "Customer");
  if (!customer) return;
  await postToSlack(target.webhookUrl, {
    type: "payment_recovered",
    stepType: "retry",
    customerEmail: customer.customerEmail,
    customerName: customer.customerName,
    amount: formatMoney(ctx.amountCents, ctx.currency),
  });
}
