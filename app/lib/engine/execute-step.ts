import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db } from "~/db";
import { getDb, recoverySteps } from "~/db";
import {
  CARD_UPDATE_PATH,
  ENGAGEMENT_CLICK_PATH,
  ENGAGEMENT_OPEN_PATH,
} from "~/lib/constants";
import { signCardUpdateToken } from "~/lib/card-update/token";
import { processEmailJob, type EmailJobResult } from "~/lib/email/dispatch";
import type { EmailJob } from "~/lib/email/types";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { signEngagementToken } from "~/lib/engagement/token";
import { formatMoney } from "~/lib/money-format";
import {
  applyCustomBody,
  generateDunningEmail,
  resolveContentPlan,
  type CachedStepContent,
  type EmailCopy,
} from "~/lib/recovery/email-generation";
import { recordRecovery as recordRecoveryReal } from "~/lib/recovery/record-recovery";
import type { RecordRecoveryInput } from "~/lib/recovery/record-recovery";
import type { StepStatePatch } from "~/lib/recovery/step-state";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

import { decideEmailStep, decideRetryStep, type RetryAttempt } from "./step-runner";

// The LIVE recovery-step executors: the seam that wraps the pure deciders
// (step-runner.ts) with the real side effects (a connected-account
// stripe.invoices.pay, the EMAIL-binding send) and the persistence. The
// deciders stay pure and unit-proven; this module is the thin, injectable IO
// composition the tick cron dispatches to.
//
// Money-path rules honored here:
//   - The recovery_steps write is OPERATIONAL (plain per-request db.batch), not a
//     money write; only recordRecovery (recovered_payments + outcomes) rides the
//     per-account money-write DO.
//   - Exactly-once under overlap / at-least-once cron delivery:
//       * the retry charge carries a Stripe idempotency key, so Stripe itself
//         refuses a second charge for the same step (no double charge);
//       * the step patch is a conditional update (WHERE executed_at IS NULL), so a
//         redelivered tick cannot re-write an already-executed step;
//       * the foxhound_retry recovery is keyed on failed_payment_id, the SAME key
//         the invoice.payment_succeeded webhook uses (webhooks/batches.ts
//         buildRecoverBatch), so the executor's record and the webhook's record
//         collapse to one recovered_payments row through the DO.
//   - The executor never flips failed_payments to 'recovered': that status flip is
//     owned by the invoice.payment_succeeded webhook (the race rule). The executor
//     only causes the real-world event and records the evidence + attribution.

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

/** The recordRecovery input for a landed silent retry. Pure. Attribution is
 *  foxhound_retry (the strongest proof of causation, PRICING.md), ref is the
 *  step, and the idempotency key is the failed_payment id so this record and the
 *  webhook's record are the SAME logical recovery (collapse to one row). */
export function buildRetryRecoveryInput(ctx: RetryStepContext, recoveredAt: Date): RecordRecoveryInput {
  return {
    accountId: ctx.accountId,
    failedPaymentId: ctx.failedPaymentId,
    amountCents: ctx.amountCents,
    currency: ctx.currency,
    recoveredAt,
    attribution: { kind: "foxhound_retry", ref: ctx.stepId },
    recoveredByStepId: ctx.stepId,
    recoveryMethod: "foxhound_retry",
    idempotencyKey: ctx.failedPaymentId,
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
  /** Record the foxhound_retry recovery through the money DO. Default: recordRecovery. */
  recordRecovery: (env: Env, input: RecordRecoveryInput) => Promise<boolean>;
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
  const recordRecovery = deps.recordRecovery ?? recordRecoveryReal;

  const now = new Date();
  const attempt = await payInvoice(env, ctx);
  const decision = decideRetryStep(attempt, now);
  await persistPatch(env, ctx.stepId, decision.patch);
  if (decision.recovered) {
    await recordRecovery(env, buildRetryRecoveryInput(ctx, now));
  }
  return {
    action: "retry",
    executed: true,
    recovered: decision.recovered,
    retryResult: decision.retryResult,
  };
}

// ============================================================================
// Email step
// ============================================================================

/** Everything the email executor needs, loaded by the cron. */
export interface EmailStepContext {
  stepId: string;
  accountId: string;
  failedPaymentId: string;
  stepType: string;
  /** Send-attempt count so far (drives the transient-failure backoff machine). */
  attemptCount: number;
  declineCategory: string;
  customerEmail: string;
  amountCents: number;
  currency: string;
  /** Merchant display name for the From header and the copy's voice. */
  merchantName: string;
  /** Optional merchant-configured brand voice. */
  voiceDescription?: string | null;
  /** Cached content on the recovery_steps row (custom body / prior AI copy). */
  cached: CachedStepContent;
}

/** The first-party tracking URLs for a recovery send. The card-update link is
 *  wrapped in a click-redirect so a click is the email_engaged attribution
 *  signal (PRICING.md: click bills, open feeds Intelligence only). */
export interface EngagementUrls {
  /** The click-tracked card-update URL to use as the email's primary CTA. */
  clickTrackedUpdateUrl: string;
  /** The open-pixel URL (Intelligence only, never billable). */
  openUrl: string;
}

/** Sign the card-update + engagement tokens and assemble the tracking URLs. */
export async function buildEngagementUrls(
  env: Env,
  ctx: EmailStepContext,
  baseUrl: string,
): Promise<EngagementUrls> {
  const cardToken = await signCardUpdateToken(env, {
    failedPaymentId: ctx.failedPaymentId,
    accountId: ctx.accountId,
  });
  const cardUpdateUrl = `${baseUrl}${CARD_UPDATE_PATH}/${cardToken}`;
  const clickToken = await signEngagementToken(env, {
    stepId: ctx.stepId,
    accountId: ctx.accountId,
    kind: "click",
    url: cardUpdateUrl,
  });
  const openToken = await signEngagementToken(env, {
    stepId: ctx.stepId,
    accountId: ctx.accountId,
    kind: "open",
  });
  return {
    clickTrackedUpdateUrl: `${baseUrl}${ENGAGEMENT_CLICK_PATH}/${clickToken}`,
    openUrl: `${baseUrl}${ENGAGEMENT_OPEN_PATH}/${openToken}`,
  };
}

/** Append the first-party open pixel to a body. Pure. */
export function appendOpenPixel(bodyHtml: string, openUrl: string): string {
  return `${bodyHtml}<img src="${openUrl}" width="1" height="1" alt="" style="display:none">`;
}

/** Build the queued EmailJob for a recovery send. Pure. */
export function buildRecoveryEmailJob(
  ctx: EmailStepContext,
  copy: EmailCopy,
  extras: { unsubscribeToken: string; physicalAddress: string; openUrl: string },
): EmailJob {
  return {
    accountId: ctx.accountId,
    recoveryStepId: ctx.stepId,
    to: ctx.customerEmail,
    fromName: ctx.merchantName,
    subject: copy.subject,
    bodyHtml: appendOpenPixel(copy.bodyHtml, extras.openUrl),
    template: "recovery_dunning",
    unsubscribeToken: extras.unsubscribeToken,
    physicalAddress: extras.physicalAddress,
    // Stable per send attempt: a backoff retry is a new attempt, so the count
    // distinguishes it from the prior try.
    idempotencyKey: `${ctx.stepId}:${ctx.attemptCount}`,
  };
}

/** Map a dispatch result to the SendAttempt the email decider reads. A suppressed
 *  recipient is a terminal success (do not keep retrying a suppressed address). */
export function sendResultToAttempt(result: EmailJobResult): {
  ok: boolean;
  permanent?: boolean;
  error?: string;
} {
  if (result.status === "sent" || result.status === "suppressed") return { ok: true };
  return { ok: false, permanent: false, error: result.error ?? "send failed" };
}

/** The operational email-step patch: the state-machine transition, plus caching
 *  the resolved copy onto ai_subject/ai_body_html so a backoff retry reuses it
 *  instead of regenerating. Plain db, not the money DO. */
export function buildEmailStepPatch(
  db: Db,
  stepId: string,
  patch: StepStatePatch,
  cache?: EmailCopy,
) {
  return db
    .update(recoverySteps)
    .set({
      attemptCount: patch.attemptCount,
      lastAttemptError: patch.lastAttemptError,
      nextRetryAt: patch.nextRetryAt,
      executedAt: patch.executedAt,
      result: patch.result,
      ...(cache ? { aiSubject: cache.subject, aiBodyHtml: cache.bodyHtml } : {}),
    })
    .where(eq(recoverySteps.id, stepId));
}

/** Injectable seams for executeEmailStep. Defaults are the real IO. */
export interface EmailStepDeps {
  /** Resolve + send. Default: content resolution + processEmailJob (suppression + send + log). */
  send: (env: Env, job: EmailJob) => Promise<EmailJobResult>;
  /** Persist the operational step patch. Default: plain db.update. */
  persistPatch: (env: Env, stepId: string, patch: StepStatePatch, cache?: EmailCopy) => Promise<void>;
  /** Generate dunning copy. Default: generateDunningEmail (Anthropic seam). */
  generate: (env: Env, updateUrl: string, ctx: EmailStepContext) => Promise<EmailCopy>;
}

function defaultSend(env: Env, job: EmailJob): Promise<EmailJobResult> {
  return processEmailJob(env, job, null);
}

async function defaultPersistEmailPatch(
  env: Env,
  stepId: string,
  patch: StepStatePatch,
  cache?: EmailCopy,
): Promise<void> {
  const db = getDb(env);
  await db.batch([buildEmailStepPatch(db, stepId, patch, cache)]);
}

function defaultGenerate(env: Env, updateUrl: string, ctx: EmailStepContext): Promise<EmailCopy> {
  return generateDunningEmail(env, {
    merchant: { merchantName: ctx.merchantName, voiceDescription: ctx.voiceDescription },
    stepType: ctx.stepType,
    declineCategory: ctx.declineCategory,
    amountFormatted: formatMoney(ctx.amountCents, ctx.currency),
    updateUrl,
  });
}

export interface EmailStepResult {
  action: "email";
  sent: boolean;
  result: string | null;
}

/**
 * Execute one email step: resolve content (custom body / cached AI / generate) ->
 * send via the one send module -> pure decision (with the send-attempt backoff) ->
 * operational persist. A content-resolution or send failure is isolated as a
 * transient failure so the sweep continues for other steps/merchants. Clicks on
 * the send's CTA are attributable (the CTA is a click-tracked card-update link).
 */
export async function executeEmailStep(
  env: Env,
  ctx: EmailStepContext,
  deps: Partial<EmailStepDeps> = {},
): Promise<EmailStepResult> {
  const send = deps.send ?? defaultSend;
  const persistPatch = deps.persistPatch ?? defaultPersistEmailPatch;
  const generate = deps.generate ?? defaultGenerate;

  const now = new Date();
  const baseUrl = env.BETTER_AUTH_URL ?? "";

  let attempt: { ok: boolean; permanent?: boolean; error?: string };
  let resolvedCopy: EmailCopy | undefined;
  try {
    const urls = await buildEngagementUrls(env, ctx, baseUrl);
    const plan = resolveContentPlan(ctx.cached);
    const copy =
      plan.source === "cache"
        ? plan.copy
        : applyCustomBody(await generate(env, urls.clickTrackedUpdateUrl, ctx), plan.customBody);
    resolvedCopy = copy;
    const unsubscribeToken = await signUnsubscribeToken(env, {
      email: ctx.customerEmail,
      accountId: ctx.accountId,
    });
    const job = buildRecoveryEmailJob(ctx, copy, {
      unsubscribeToken,
      physicalAddress: env.PHYSICAL_ADDRESS ?? "",
      openUrl: urls.openUrl,
    });
    attempt = sendResultToAttempt(await send(env, job));
  } catch (err) {
    // Isolate: a generation/token/send throw is a transient failure for THIS step
    // only, rescheduled by the backoff machine; it must not halt the sweep.
    attempt = { ok: false, permanent: false, error: err instanceof Error ? err.message : "send error" };
  }

  const patch = decideEmailStep({ attemptCount: ctx.attemptCount }, attempt, now);
  await persistPatch(env, ctx.stepId, patch, resolvedCopy);
  return { action: "email", sent: attempt.ok, result: patch.result };
}
