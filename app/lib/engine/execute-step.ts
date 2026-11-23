import { appOrigin } from "~/lib/app-origin";
import { and, eq, isNull } from "drizzle-orm";
import { type Db, getDb, recoverySteps } from "~/db";
import {
  CARD_UPDATE_PATH,
  ENGAGEMENT_CLICK_PATH,
  ENGAGEMENT_HONEYPOT_PATH,
  ENGAGEMENT_OPEN_PATH,
} from "~/lib/constants";
import { signCardUpdateToken } from "~/lib/card-update/token";
import { processEmailJob, type EmailJobResult } from "~/lib/email/dispatch";
import { recoveryFooterNote } from "~/lib/email/templates";
import type { EmailJob } from "~/lib/email/types";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { signEngagementToken } from "~/lib/engagement/token";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import {
  applyCustomBody,
  generateDunningEmail,
  passesQualityGate,
  resolveContentPlan,
  type CachedStepContent,
  type EmailCopy,
  type GenerateEmailInput,
} from "~/lib/recovery/email-generation";
import { buildTemplateEmail } from "~/lib/recovery/email-template";
import { linksTo, storedCopyCarriesRecoveryLink } from "~/lib/recovery/update-link";
import type { StepStatePatch } from "~/lib/recovery/step-state";
import { loadSlackCustomer, postToSlack, resolveSlackTarget } from "~/lib/notify/slack.server";
import { decideEmailStep } from "./step-runner";

/** Slack posts for an email send. Both gate first (demo account, disabled toggle, missing webhook), so the
 *  customer lookup only runs for an account that will receive a post. */
async function notifySlackEmailSent(env: Env, ctx: EmailStepContext): Promise<void> {
  const target = await resolveSlackTarget(env, ctx.accountId);
  if (target.status !== "ready") return;
  const customer = await loadSlackCustomer(env, ctx.accountId, ctx.failedPaymentId, "there");
  if (!customer) return;
  await postToSlack(target.webhookUrl, {
    type: "email_sent",
    stepType: ctx.stepType,
    customerEmail: customer.customerEmail,
    customerName: customer.customerName,
    amount: formatMoney(ctx.amountCents, ctx.currency),
  });
}

export interface EmailStepContext {
  /** The cron run executing this step, stamped on email_sends; null for request-thread callers (manual actions, tests). */
  cronRunId?: string | null;
  stepId: string;
  accountId: string;
  failedPaymentId: string;
  stepType: string;
  attemptCount: number;
  declineCategory: string;
  customerEmail: string;
  /** failed_payments.customer_name, raw; templates greet with it, falling back to "there". */
  customerName?: string | null;
  amountCents: number;
  currency: string;
  /** Merchant name for the copy's voice, with a readable fallback ("your subscription"). NOT the From header: see senderName. */
  merchantName: string;
  /** The merchant's configured `sender_name`, raw, for the From header only. Kept separate from merchantName
   *  so the copy fallback never leaks into the From header. */
  senderName: string | null;
  /** The connection's `reply_to_email`, raw, for Reply-To only; unset means a reply goes to the From. */
  replyTo?: string | null;
  voiceDescription?: string | null;
  /** Merchant-context fields carried to the generation prompt. */
  merchantIndustry?: string | null;
  primaryCustomerType?: string | null;
  merchantMrrCents?: number | null;
  /** Per-category voices; `declineCategory` selects among them. */
  brandVoiceSoft?: string | null;
  brandVoiceExpired?: string | null;
  brandVoiceNetwork?: string | null;
  brandVoiceFraud?: string | null;
  voiceSamples?: readonly string[];
  cached: CachedStepContent;
}

/** The first-party tracking URLs for a recovery send. The card-update link is wrapped in a click-redirect
 *  so a click is the billable email_engaged signal. */
export interface EngagementUrls {
  clickTrackedUpdateUrl: string;
  openUrl: string;
  honeypotUrl: string;
}

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
  const honeypotToken = await signEngagementToken(env, {
    stepId: ctx.stepId,
    accountId: ctx.accountId,
    kind: "honeypot",
  });
  return {
    clickTrackedUpdateUrl: `${baseUrl}${ENGAGEMENT_CLICK_PATH}/${clickToken}`,
    openUrl: `${baseUrl}${ENGAGEMENT_OPEN_PATH}/${openToken}`,
    honeypotUrl: `${baseUrl}${ENGAGEMENT_HONEYPOT_PATH}/${honeypotToken}`,
  };
}

const TEMPLATE_LABEL_GENERATED = "recovery_dunning";
/** email_sends.template label for a template-fallback send; distinct so the fallback rate is queryable off email_sends. */
export const TEMPLATE_LABEL_FALLBACK = "recovery_dunning_template";

// Re-exported so callers keep one import.
export { recoveryFooterNote };

export function buildRecoveryEmailJob(
  ctx: EmailStepContext,
  copy: EmailCopy,
  extras: {
    unsubscribeToken: string;
    physicalAddress: string;
    openUrl: string;
    honeypotUrl: string;
    usedTemplate?: boolean;
    now?: Date;
  },
): EmailJob {
  return {
    accountId: ctx.accountId,
    recoveryStepId: ctx.stepId,
    to: ctx.customerEmail,
    fromName: ctx.senderName,
    replyTo: ctx.replyTo ?? null,
    subject: copy.subject,
    bodyHtml: copy.bodyHtml,
    // Pixel and trap travel beside the body; templates.ts places them in the HTML part only.
    tracking: { openUrl: extras.openUrl, honeypotUrl: extras.honeypotUrl },
    template: extras.usedTemplate ? TEMPLATE_LABEL_FALLBACK : TEMPLATE_LABEL_GENERATED,
    unsubscribeToken: extras.unsubscribeToken,
    physicalAddress: extras.physicalAddress,
    footerNote: recoveryFooterNote(ctx.senderName, (extras.now ?? new Date()).getUTCFullYear()),
    // Stable per attempt: a backoff retry is a new attempt.
    idempotencyKey: `${ctx.stepId}:${ctx.attemptCount}`,
    cronRunId: ctx.cronRunId ?? null,
  };
}

/** Map a dispatch result to the SendAttempt the email decider reads. A suppressed recipient is a terminal success. */
export function sendResultToAttempt(result: EmailJobResult): {
  ok: boolean;
  permanent?: boolean;
  error?: string;
} {
  // `duplicate` is ok: the claim was already taken for this key, so the mail is accounted for. Reporting it
  // as a failure would retry with a fresh key (`stepId:attemptCount`) and send the very email the claim prevents.
  if (result.status === "sent" || result.status === "suppressed" || result.status === "duplicate") {
    return { ok: true };
  }
  return { ok: false, permanent: false, error: result.error ?? "send failed" };
}

/** The operational email-step patch: the state transition, plus caching the resolved copy onto
 *  ai_subject/ai_body_html so a backoff retry reuses it. Plain db, not the money DO. Claims the step
 *  conditionally (WHERE executed_at IS NULL) so no second caller (e.g. manual "Trigger next step now")
 *  can re-send an already-executed step; a step in backoff has executed_at NULL, so its transition lands. */
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
    .where(and(eq(recoverySteps.id, stepId), isNull(recoverySteps.executedAt)));
}

export interface EmailStepDeps {
  send: (env: Env, job: EmailJob) => Promise<EmailJobResult>;
  persistPatch: (
    env: Env,
    stepId: string,
    patch: StepStatePatch,
    cache?: EmailCopy,
  ) => Promise<void>;
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

/** The generation input for one step. Pure and exported so the assembly where merchant context is
 *  attached is testable without ANTHROPIC_API_KEY. */
export function buildGenerateEmailInput(
  updateUrl: string,
  ctx: EmailStepContext,
): GenerateEmailInput {
  return {
    merchant: {
      merchantName: ctx.merchantName,
      voiceDescription: ctx.voiceDescription,
      industry: ctx.merchantIndustry,
      customerType: ctx.primaryCustomerType,
      mrrCents: ctx.merchantMrrCents,
      voiceSoft: ctx.brandVoiceSoft,
      voiceExpired: ctx.brandVoiceExpired,
      voiceNetwork: ctx.brandVoiceNetwork,
      voiceFraud: ctx.brandVoiceFraud,
      voiceSamples: ctx.voiceSamples ?? [],
    },
    stepType: ctx.stepType,
    declineCategory: ctx.declineCategory,
    amountFormatted: formatMoney(ctx.amountCents, ctx.currency),
    updateUrl,
  };
}

function defaultGenerate(env: Env, updateUrl: string, ctx: EmailStepContext): Promise<EmailCopy> {
  return generateDunningEmail(env, buildGenerateEmailInput(updateUrl, ctx), {
    source: "recovery_email",
    accountId: ctx.accountId,
    relatedId: ctx.failedPaymentId,
  });
}

export interface EmailStepResult {
  action: "email";
  sent: boolean;
  result: string | null;
  usedTemplate: boolean;
  templateReason: TemplateReason | null;
  /** True when the recipient was suppressed and no mail left. The step still lands as a terminal success,
   *  but a merchant pressing "Trigger next step now" needs "not emailed, unsubscribed" told apart from
   *  "emailed". Read-only: the cron ignores this field. */
  suppressed: boolean;
}

/** Build the deterministic fallback for this step, honoring a merchant custom body. */
function templateCopyFor(
  ctx: EmailStepContext,
  updateUrl: string,
  customBody: string | null,
): EmailCopy {
  return applyCustomBody(
    buildTemplateEmail({
      merchantName: ctx.merchantName,
      declineCategory: ctx.declineCategory,
      amountFormatted: formatMoney(ctx.amountCents, ctx.currency),
      updateUrl,
      stepType: ctx.stepType,
      customerName: ctx.customerName ?? null,
      senderName: ctx.senderName,
    }),
    customBody,
  );
}

/** Why the deterministic template was used. `missing_update_link`: the copy did not link the update page. */
type TemplateReason = "generation_failed" | "quality_gate" | "missing_update_link";

type ResolvedCopy = {
  copy: EmailCopy;
  usedTemplate: boolean;
  templateReason: TemplateReason | null;
};

/**
 * Resolve the copy to send, falling back to the deterministic template when generation cannot produce
 * usable copy: a model outage must not halt recovery or reschedule on the send backoff, since a plain
 * template beats silence. Fallback triggers: generation threw, or the copy fails the brand-voice quality
 * gate (regenerating would likely re-fail, e.g. `timing_leak`, while doubling latency in the 5-minute
 * tick). The gate runs on generated copy before applyCustomBody: a merchant's own body is not policed.
 * Genuine send failures are not handled here and keep their backoff.
 */
async function resolveCopyForSend(
  env: Env,
  ctx: EmailStepContext,
  updateUrl: string,
  generate: EmailStepDeps["generate"],
): Promise<ResolvedCopy> {
  const plan = resolveContentPlan(ctx.cached);
  if (plan.source === "cache") {
    return { copy: plan.copy, usedTemplate: false, templateReason: null };
  }

  let generated: EmailCopy;
  try {
    generated = await generate(env, updateUrl, ctx);
  } catch {
    // Swallowed on purpose: the step is not failing, it is sending the template. The fallback is observable
    // through email_sends.template.
    return {
      copy: templateCopyFor(ctx, updateUrl, plan.customBody),
      usedTemplate: true,
      templateReason: "generation_failed",
    };
  }

  // The quality gate: dunning bodies are the only ungrounded AI output with no other backstop (disputes need
  // merchant approval, the narrative is merchant-read-only).
  if (!passesQualityGate(generated)) {
    return {
      copy: templateCopyFor(ctx, updateUrl, plan.customBody),
      usedTemplate: true,
      templateReason: "quality_gate",
    };
  }

  return {
    copy: applyCustomBody(generated, plan.customBody),
    usedTemplate: false,
    templateReason: null,
  };
}

/**
 * No dunning email leaves without its update link (a body without it loses the recovery and the
 * billable click while the send succeeds). Fresh copy must link the URL minted for this send exactly;
 * copy read back from the step row may carry a link an earlier attempt minted for the same step that is
 * still live (a token carries its issue time, so a retry's link never matches byte for byte). Failing
 * copy is replaced by the BARE template without the custom body; if that ever fails to link, this
 * throws and nothing is sent.
 */
async function withUpdateLink(
  env: Env,
  ctx: EmailStepContext,
  baseUrl: string,
  updateUrl: string,
  resolved: ResolvedCopy,
): Promise<ResolvedCopy> {
  // The body came off the step row when a custom body exists or the plan sent cached copy.
  const fromStorage =
    ctx.cached.customBody != null || resolveContentPlan(ctx.cached).source === "cache";
  const carries = fromStorage
    ? await storedCopyCarriesRecoveryLink(env, resolved.copy.bodyHtml, {
        baseUrl,
        mintedUrl: updateUrl,
        stepId: ctx.stepId,
        accountId: ctx.accountId,
        failedPaymentId: ctx.failedPaymentId,
      })
    : linksTo(resolved.copy.bodyHtml, updateUrl);
  if (carries) return resolved;

  const template = templateCopyFor(ctx, updateUrl, null);
  if (!linksTo(template.bodyHtml, updateUrl)) {
    throw new Error("update link missing from the template; not sending");
  }
  return { copy: template, usedTemplate: true, templateReason: "missing_update_link" };
}

/** Execute one email step: resolve content -> send via the one send module -> pure decision (with
 *  backoff) -> operational persist. A signing or send failure is a transient failure so the sweep continues. */
export async function executeEmailStep(
  env: Env,
  ctx: EmailStepContext,
  deps: Partial<EmailStepDeps> = {},
): Promise<EmailStepResult> {
  const send = deps.send ?? defaultSend;
  const persistPatch = deps.persistPatch ?? defaultPersistEmailPatch;
  const generate = deps.generate ?? defaultGenerate;

  const now = new Date();
  const baseUrl = appOrigin(env);

  let attempt: { ok: boolean; permanent?: boolean; error?: string };
  let resolvedCopy: EmailCopy | undefined;
  let usedTemplate = false;
  let templateReason: TemplateReason | null = null;
  let suppressed = false;
  try {
    const urls = await buildEngagementUrls(env, ctx, baseUrl);
    // Token signing must succeed before either path: the template needs the same click-tracked CTA.
    const resolved = await withUpdateLink(
      env,
      ctx,
      baseUrl,
      urls.clickTrackedUpdateUrl,
      await resolveCopyForSend(env, ctx, urls.clickTrackedUpdateUrl, generate),
    );
    usedTemplate = resolved.usedTemplate;
    templateReason = resolved.templateReason;
    resolvedCopy = resolved.copy;
    const unsubscribeToken = await signUnsubscribeToken(env, {
      email: ctx.customerEmail,
      accountId: ctx.accountId,
    });
    const job = buildRecoveryEmailJob(ctx, resolved.copy, {
      unsubscribeToken,
      physicalAddress: env.PHYSICAL_ADDRESS ?? "",
      honeypotUrl: urls.honeypotUrl,
      openUrl: urls.openUrl,
      usedTemplate,
      now,
    });
    const sendResult = await send(env, job);
    suppressed = sendResult.status === "suppressed";
    attempt = sendResultToAttempt(sendResult);
  } catch (err) {
    // Isolate: a signing or send throw is a transient failure for this step only; it must not halt the sweep.
    attempt = {
      ok: false,
      permanent: false,
      error: err instanceof Error ? err.message : "send error",
    };
  }

  const patch = decideEmailStep({ attemptCount: ctx.attemptCount }, attempt, now);
  await persistPatch(env, ctx.stepId, patch, resolvedCopy);
  // Slack after the step is persisted, only on a successful send; a Slack failure cannot unwind the send.
  if (attempt.ok) {
    await notifySlackEmailSent(env, ctx);
  }
  return {
    action: "email",
    sent: attempt.ok,
    result: patch.result,
    usedTemplate,
    templateReason,
    suppressed,
  };
}
