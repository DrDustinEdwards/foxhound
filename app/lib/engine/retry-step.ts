// The retry step (execute-step.ts split): pays the failed invoice through the
// connected account, records the attempt, and reconciles a success into a
// recovery. The email step stays in execute-step.ts.

import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { type Db, getDb, recoverySteps } from "~/db";
import { formatMoney } from "~/lib/money-format";
import {
  reconcileRetryRecovery as reconcileRetryRecoveryReal,
  type RetryReconciliationInput,
} from "~/lib/recovery/record-recovery";
import type { RetryResult, StepStatePatch } from "~/lib/recovery/step-state";
import { loadSlackCustomer, postToSlack, resolveSlackTarget } from "~/lib/notify/slack.server";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";
import { type CardChangeVerdict, checkCardChanged, retryNeedsChangedCard } from "./card-change";
import { decideRetryStep, type RetryAttempt } from "./step-runner";

// The LIVE recovery-step executors: the seam that wraps the pure deciders
// (step-runner.ts) with the real side effects (a connected-account
// stripe.invoices.pay, the EMAIL-binding send) and the persistence. The
// deciders stay pure and unit-proven; this module is the thin, injectable IO
// composition the tick cron dispatches to.
//
// Money-path rules honored here:
//   - The recovery_steps write is OPERATIONAL (plain per-request db.batch), not a
//     money write; only reconcileRetryRecovery rides the per-account money-write DO.
//   - Exactly-once under overlap / at-least-once cron delivery:
//       * the retry charge carries a Stripe idempotency key, so Stripe itself
//         refuses a second charge for the same step (no double charge);
//       * the step patch is a conditional update (WHERE executed_at IS NULL), so a
//         redelivered tick cannot re-write an already-executed step.
//   - The invoice.payment_succeeded webhook (webhooks/batches.ts buildRecoverBatch)
//     is the SOLE recorder of a recovery and the sole owner of the failed_payments
//     'recovered' status flip (the race rule). The executor here never inserts a
//     recovered_payments/outcomes row; it only causes the real-world event and, on
//     success, calls reconcileRetryRecovery - an UPDATE-only correction for the
//     narrow reverse-race window where the webhook records (and flips status)
//     before this step's patch lands, so it cannot yet see the succeeded retry and
//     falls back to a lesser attribution. Update-only means it can never collide
//     with the webhook's insert, so it can never cause the whole-batch rollback
//     that used to strand failed_payments in 'active' (fixed review Finding 1) and
//     it upgrades a wrongly-free baseline recording to foxhound_retry when the
//     race goes the other way (fixed review Finding 2). See record-recovery.ts.

// ============================================================================
// Retry step
// ============================================================================

/** Everything the retry executor needs, loaded by the cron (joined step +
 *  failed_payment + connection). connectionAccessToken is the ENCRYPTED token;
 *  it is decrypted here and NEVER logged (ARCHITECTURE.md non-negotiable #5). */
export interface RetryStepContext {
  stepId: string;
  failedPaymentId: string;
  accountId: string;
  /** The connected-account invoice to re-attempt payment on. */
  invoiceId: string;
  amountCents: number;
  currency: string;
  /** Encrypted stripe_connections.stripe_access_token for the connected account. */
  connectionAccessToken: string;
  /** failed_payments.decline_category. Required, so every caller says it: an
   *  expired card's retry charges only a changed card (card-change.ts). */
  declineCategory: string;
}

/** Stripe idempotency key for a retry charge: stable per step, so a redelivered
 *  tick that re-attempts the charge is deduped by Stripe (no double charge). */
export function retryIdempotencyKey(stepId: string): string {
  return `foxhound_retry_${stepId}`;
}

/** The conditional operational patch for a retry step: sets the terminal result,
 *  but only if the step has not already been executed (claim-on-write, so a
 *  concurrent/redelivered run cannot double-write). Plain db, not the money DO. */
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

/** The operational patch for a retry step that could not be ATTEMPTED, carrying
 *  the full bounded-retry state (attempt count, error, backoff) rather than just
 *  a terminal result. Same conditional claim-on-write as buildRetryStepPatch, so
 *  a redelivered tick cannot double-write. retryResult mirrors result and stays
 *  null while the step is still being retried. */
export function buildRetryAttemptPatch(
  db: Db,
  stepId: string,
  patch: StepStatePatch,
) {
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

/** The reconcileRetryRecovery input for a landed silent retry. Pure. Identifies
 *  the failed payment and the step that just succeeded (foxhound_retry's ref,
 *  the strongest proof of causation, PRICING.md), so a reverse-race correction
 *  upgrades to the right attribution. */
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

/** Run a connected-account invoice payment with the retry idempotency key,
 *  classifying the outcome into a RetryAttempt. Isolated so a fake Stripe client
 *  can drive it in tests without a live charge. */
export async function payInvoiceWithClient(
  stripe: Stripe,
  ctx: RetryStepContext,
): Promise<RetryAttempt> {
  try {
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

/** Injectable seams for executeRetryStep. Defaults are the real IO. */
export interface RetryStepDeps {
  /** Perform the live charge. Default: decrypt token, connected Stripe, invoices.pay. */
  payInvoice: (env: Env, ctx: RetryStepContext) => Promise<RetryAttempt>;
  /** Persist the operational step patch. Default: plain db.batch (not the money DO). */
  persistPatch: (
    env: Env,
    stepId: string,
    patch: Pick<StepStatePatch, "executedAt" | "result"> & { retryResult: string },
  ) => Promise<void>;
  /** Reconcile the foxhound_retry attribution against whatever the webhook
   *  already recorded, through the money DO. Default: reconcileRetryRecovery. */
  reconcileRecovery: (env: Env, input: RetryReconciliationInput) => Promise<boolean>;
  /** Whether the card changed since the decline, asked only for a category
   *  whose retry needs it (expired). Default: checkCardChanged, read-only. */
  checkCardChanged: (env: Env, ctx: RetryStepContext) => Promise<CardChangeVerdict>;
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
): Promise<void> {
  const db = getDb(env);
  await db.batch([buildRetryStepPatch(db, stepId, patch)]);
}

export interface RetryStepResult {
  action: "retry";
  executed: boolean;
  recovered: boolean;
  retryResult: string;
}

/**
 * Execute one retry step: live charge -> pure decision -> operational persist ->
 * (on success) the foxhound_retry money-write. A failed retry resolves the step
 * and the sequence moves on (no backoff); only email sends have a send-attempt
 * backoff. See the module header for the exactly-once guarantees.
 */
export async function executeRetryStep(
  env: Env,
  ctx: RetryStepContext,
  deps: Partial<RetryStepDeps> = {},
): Promise<RetryStepResult> {
  const payInvoice = deps.payInvoice ?? defaultPayInvoice;
  const persistPatch = deps.persistPatch ?? defaultPersistPatch;
  const reconcileRecovery = deps.reconcileRecovery ?? reconcileRetryRecoveryReal;
  const checkChanged = deps.checkCardChanged ?? checkCardChanged;

  const now = new Date();
  // THE EXPIRED-CARD GUARD, before any charge. An unchanged (or unreadable)
  // card ends the step with no charge; the sequence moves on to its next step.
  if (retryNeedsChangedCard(ctx.declineCategory)) {
    const verdict = await checkChanged(env, ctx);
    if (verdict !== "changed") {
      const skipped: RetryResult =
        verdict === "unchanged" ? "retry_skipped_card_unchanged" : "retry_skipped_unverified";
      await persistPatch(env, ctx.stepId, { executedAt: now, result: skipped, retryResult: skipped });
      return { action: "retry", executed: true, recovered: false, retryResult: skipped };
    }
  }
  const attempt = await payInvoice(env, ctx);
  const decision = decideRetryStep(attempt, now);
  await persistPatch(env, ctx.stepId, decision.patch);
  if (decision.recovered) {
    await reconcileRecovery(env, buildRetryReconciliationInput(ctx, now));
    // SLACK, legacy's `payment_recovered` post. It fires ONLY on a succeeded
    // retry, which is legacy's own extra condition, and it runs after the
    // reconciliation so a Slack outage cannot cost a recorded recovery. It
    // never throws: every path returns a discriminated outcome.
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
    // Legacy passes step.step_type here too, though the title ignores it.
    stepType: "retry",
    customerEmail: customer.customerEmail,
    customerName: customer.customerName,
    amount: formatMoney(ctx.amountCents, ctx.currency),
  });
}
