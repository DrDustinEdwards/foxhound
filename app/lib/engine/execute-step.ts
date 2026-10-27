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
import { formatMoney } from "~/lib/money-format";
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

/**
 * Legacy's two Slack posts, wired at legacy's two sites.
 *
 * BOTH GATE FIRST. `resolveSlackTarget` refuses a demo account, a disabled
 * toggle (NULL included) and a missing webhook before anything else is read,
 * so the customer lookup below only happens for an account that will actually
 * receive a post.
 */
async function notifySlackEmailSent(env: Env, ctx: EmailStepContext): Promise<void> {
  const target = await resolveSlackTarget(env, ctx.accountId);
  if (target.status !== "ready") return;
  const customer = await loadSlackCustomer(env, ctx.failedPaymentId, "there");
  if (!customer) return;
  await postToSlack(target.webhookUrl, {
    type: "email_sent",
    stepType: ctx.stepType,
    customerEmail: customer.customerEmail,
    customerName: customer.customerName,
    amount: formatMoney(ctx.amountCents, ctx.currency),
  });
}

// ============================================================================
// Email step
// ============================================================================

/** Everything the email executor needs, loaded by the cron. */
export interface EmailStepContext {
  /** The cron run that is executing this step (313), stamped onto the
   *  email_sends row so a send can be attributed to its run. NULL for every
   *  non-cron caller, which is the enumeration recorded in canon: the manual
   *  "Trigger next step now" and "Resend last email" actions, the bulk actions,
   *  and any test driving the executor directly all run on a request thread with
   *  no cron run to name. */
  cronRunId?: string | null;
  stepId: string;
  accountId: string;
  failedPaymentId: string;
  stepType: string;
  /** Send-attempt count so far (drives the transient-failure backoff machine). */
  attemptCount: number;
  declineCategory: string;
  customerEmail: string;
  /** failed_payments.customer_name, raw and nullable. The day 1, 3 and 7
   *  templates greet with it, falling back to Recova's "there" (J85). Optional
   *  so a caller that has no name behaves as a payment with none. */
  customerName?: string | null;
  amountCents: number;
  currency: string;
  /** Merchant name for the COPY's voice. Carries a readable fallback
   *  ("your subscription") so a body sentence still scans when the merchant has
   *  set no sender name. NOT the From header: see senderName. */
  merchantName: string;
  /** The merchant's configured `sender_name`, RAW and nullable, for the From
   *  header only (S33).
   *
   *  THESE WERE ONE FIELD UNTIL S33 AND THAT WAS THE BUG. `fromName` was fed
   *  from merchantName, so with `sender_name` unset (it had no writer at all,
   *  because this settings surface is the writer) the copy fallback leaked into
   *  the From header and every recovery email came from a sender literally
   *  called "your subscription". Legacy keeps them separate too: its From uses
   *  `merchant.sender_name || 'Support'` (lib/recovery-execution.ts:197) while
   *  its prompt takes the sender name on its own. */
  senderName: string | null;
  /** The connection's `reply_to_email`, raw and nullable, for the Reply-To
   *  header only (J03). When it is unset send.ts sets no Reply-To, so a reply
   *  goes to the From, where Recova's `replyTo ?? fromAddress` also sends it. */
  replyTo?: string | null;
  /** Optional merchant-configured brand voice. */
  voiceDescription?: string | null;
  /** S27's merchant-context three, carried to the generation prompt. */
  merchantIndustry?: string | null;
  primaryCustomerType?: string | null;
  merchantMrrCents?: number | null;
  /** S31's four per-category voices. `declineCategory` above selects among
   *  them; the step's own category is what makes them reachable. */
  brandVoiceSoft?: string | null;
  brandVoiceExpired?: string | null;
  brandVoiceNetwork?: string | null;
  brandVoiceFraud?: string | null;
  /** The merchant's own past emails, read from the connection. */
  voiceSamples?: readonly string[];
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
  /** The invisible trap link (377(4) phase one). */
  honeypotUrl: string;
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

/** email_sends.template label for a generated dunning send. */
const TEMPLATE_LABEL_GENERATED = "recovery_dunning";
/** email_sends.template label for a deterministic-template dunning send. Distinct
 *  so the fallback RATE is queryable straight off email_sends without conflating
 *  it with a send failure, which is the only place the fallback is recorded. */
export const TEMPLATE_LABEL_FALLBACK = "recovery_dunning_template";

// Recova's footer sentence (lib/email.ts wrapEmailHtml, blob 3f882729) lives in
// the templates module now, beside the frame, because the merchant notices
// carry it too (E10). Re-exported so its callers keep one import.
export { recoveryFooterNote };

/** Build the queued EmailJob for a recovery send. Pure. */
export function buildRecoveryEmailJob(
  ctx: EmailStepContext,
  copy: EmailCopy,
  extras: {
    unsubscribeToken: string;
    physicalAddress: string;
    openUrl: string;
    honeypotUrl: string;
    usedTemplate?: boolean;
    /** The send time, for the footer's year. Defaults to now. */
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
    // The pixel and the trap travel beside the body, and the one templates
    // module (app/lib/email/templates.ts) places them in the HTML part only.
    tracking: { openUrl: extras.openUrl, honeypotUrl: extras.honeypotUrl },
    template: extras.usedTemplate ? TEMPLATE_LABEL_FALLBACK : TEMPLATE_LABEL_GENERATED,
    unsubscribeToken: extras.unsubscribeToken,
    physicalAddress: extras.physicalAddress,
    footerNote: recoveryFooterNote(ctx.senderName, (extras.now ?? new Date()).getUTCFullYear()),
    // Stable per send attempt: a backoff retry is a new attempt, so the count
    // distinguishes it from the prior try.
    idempotencyKey: `${ctx.stepId}:${ctx.attemptCount}`,
    cronRunId: ctx.cronRunId ?? null,
  };
}

/** Map a dispatch result to the SendAttempt the email decider reads. A suppressed
 *  recipient is a terminal success (do not keep retrying a suppressed address). */
export function sendResultToAttempt(result: EmailJobResult): {
  ok: boolean;
  permanent?: boolean;
  error?: string;
} {
  // `duplicate` IS OK, and treating it otherwise would be the defect (385). It
  // means the send claim was already taken for this exact key, so the mail is
  // accounted for. Reporting it as a failure would push the step into backoff
  // and retry with a FRESH key, since the recovery key is `stepId:attemptCount`,
  // and that retry would send the very email the claim exists to prevent.
  //
  // This is the one executor-semantics change 385 requires, and it is a widening
  // of the ok set rather than a change to any existing status: `sent`,
  // `suppressed`, `failed` and `blocked` all mean exactly what they meant.
  if (result.status === "sent" || result.status === "suppressed" || result.status === "duplicate") {
    return { ok: true };
  }
  return { ok: false, permanent: false, error: result.error ?? "send failed" };
}

/** The operational email-step patch: the state-machine transition, plus caching
 *  the resolved copy onto ai_subject/ai_body_html so a backoff retry reuses it
 *  instead of regenerating. Plain db, not the money DO.
 *
 *  Claims the step conditionally (WHERE executed_at IS NULL), the same
 *  claim-on-write buildRetryStepPatch and buildRetryAttemptPatch already carry.
 *  Ruling 260: until this claim existed, the email path was guarded only by the
 *  cron holding sole-caller status under its lock, so ANY second caller (the
 *  manual "Trigger next step now" action is the first) could re-send an email
 *  step that had already executed. The claim is a no-op for the cron, which was
 *  already serialized, and a guard for every other caller.
 *
 *  Still-retrying rows are unaffected: a step in backoff has executed_at NULL by
 *  construction, so the claim passes and the attempt-count/backoff transition
 *  lands exactly as before. Only an ALREADY-executed step is now refused. */
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

/**
 * The generation input for one step. PURE and exported so the assembly itself
 * is testable: `generateDunningEmail` needs ANTHROPIC_API_KEY, so a plant that
 * hand-built this object would prove the prompt builder works while leaving THIS
 * link, where the context is actually attached, uncovered. Measured: dropping
 * the three merchant-context fields here went green until the plant reached
 * through this function.
 */
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
  return generateDunningEmail(env, buildGenerateEmailInput(updateUrl, ctx));
}

export interface EmailStepResult {
  action: "email";
  sent: boolean;
  result: string | null;
  /** True when the deterministic template was sent instead of generated copy. */
  usedTemplate: boolean;
  /** Why the template was used, or null when generated/cached copy was sent. */
  templateReason: TemplateReason | null;
  /**
   * True when the recipient was SUPPRESSED and no mail left the building.
   *
   * The step still lands on a successful result, which is correct for the
   * sequence: a suppressed recipient is a terminal success, not a failure to
   * retry (processEmailJob's own contract). But "we did not email them because
   * they unsubscribed" and "we emailed them" are different answers to a merchant
   * who just pressed Trigger next step now, and legacy answers the first with a
   * distinct 409. Foxhound had no way to tell them apart, because
   * sendResultToAttempt collapses `sent` and `suppressed` to the same ok.
   *
   * ADDITIVE and read-only: no write, no money path, no DO hop changes. The
   * recovery tick types its runEmail seam as Promise<unknown> and ignores the
   * return value entirely, so the cron cannot see this field and its behavior
   * is bit-for-bit unchanged.
   */
  suppressed: boolean;
}

/** Build the deterministic fallback for this step, honoring a merchant custom
 *  body exactly as generated copy would. */
function templateCopyFor(ctx: EmailStepContext, updateUrl: string, customBody: string | null): EmailCopy {
  return applyCustomBody(
    buildTemplateEmail({
      merchantName: ctx.merchantName,
      declineCategory: ctx.declineCategory,
      amountFormatted: formatMoney(ctx.amountCents, ctx.currency),
      updateUrl,
      // Recova's per-step words for the steps that have them (J85).
      stepType: ctx.stepType,
      customerName: ctx.customerName ?? null,
      senderName: ctx.senderName,
    }),
    customBody,
  );
}

/** Why the deterministic template was used, when it was. `missing_update_link`
 *  means the copy that would have gone out did not link the update page. */
type TemplateReason = "generation_failed" | "quality_gate" | "missing_update_link";

type ResolvedCopy = { copy: EmailCopy; usedTemplate: boolean; templateReason: TemplateReason | null };

/**
 * Resolve the copy to send, falling back to the deterministic template when
 * generation cannot produce usable copy.
 *
 * This exists because a generation failure used to share a catch block with send
 * failures, so a model outage produced NO email and rescheduled the step on the
 * send backoff. On a revenue-recovery product that is the wrong direction: a
 * plain, correct template beats silence. An Anthropic outage should not halt
 * recovery for every affected merchant on every affected step.
 *
 * Two distinct fallback triggers, both landing here:
 *   - generation THREW (unset or unfunded key, model outage, malformed output)
 *   - generation returned copy that FAILS the brand-voice quality gate
 *
 * On a gate failure the choice is regenerate / fall back / block. Falling back is
 * right for the same reason as the throw case, and regenerating is actively worse
 * here: the likeliest violation is `timing_leak`, which the sanitizers cannot fix
 * by design and which reflects a systematic prompt weakness rather than a dice
 * roll, so a second call would probably re-fail while doubling latency and spend
 * inside a 5-minute tick that may be processing many steps. Blocking reproduces
 * exactly the defect this commit's predecessor fixed.
 *
 * The one exception lives INSIDE the seam, not here: legacy's timing-word guard
 * (job J01) retries once when the SUBJECT says "today" or "tonight", then
 * hard-strips what still leaks, so those nine phrases rarely reach this gate.
 * See applyTimingWordGuard in recovery/email-generation.ts.
 *
 * The gate runs on the GENERATED copy, before applyCustomBody. The gate exists to
 * police model output; a merchant-authored custom body is their own voice and
 * their own choice, and rejecting it for an em dash would be the tool overruling
 * the user. So a merchant body is applied on top of whichever source wins.
 *
 * Genuine SEND failures (EMAIL binding, queue, suppression lookup) are NOT
 * handled here and keep their existing backoff. That separation is the point.
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
    // Deliberately swallowed. The generation error is not recorded on
    // last_attempt_error because this step is not failing: it is sending the
    // template. The fallback is observable through email_sends.template instead,
    // so the fallback RATE is queryable without conflating it with a send failure.
    return {
      copy: templateCopyFor(ctx, updateUrl, plan.customBody),
      usedTemplate: true,
      templateReason: "generation_failed",
    };
  }

  // THE GATE. Until this landed, passesQualityGate and findBrandVoiceViolations
  // were written, unit tested, and called by nothing in the send path, so
  // ungated model copy would have reached a merchant's own customers, in that
  // merchant's voice, the moment PHYSICAL_ADDRESS was set. Dunning bodies are the
  // only ungrounded AI output with no other backstop: disputes carry mandatory
  // merchant approval and the Intelligence narrative is merchant-read-only.
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
 * THE UPDATE-LINK CHECK, after the copy is resolved and before the send. No
 * dunning email leaves without its update link, because a body without it
 * loses the recovery and the billable click while the send still succeeds.
 *
 * Fresh copy (generated, or the template) must link the URL minted for this
 * send exactly. Copy read back from the step row (cached or custom body) may
 * instead carry a link an earlier attempt minted for the same step and payment
 * that is still live, because a card-update token carries its issue time and so
 * a retry's freshly minted link never matches the stored one byte for byte.
 *
 * Copy that fails is replaced by the BARE template, without the merchant's
 * custom body, because a custom body is exactly the body that failed. The
 * template links the minted URL by construction; if it ever did not, this
 * throws, the executor records a transient failure, and nothing is sent.
 */
async function withUpdateLink(
  env: Env,
  ctx: EmailStepContext,
  baseUrl: string,
  updateUrl: string,
  resolved: ResolvedCopy,
): Promise<ResolvedCopy> {
  // The body came off the step row when a custom body exists (it wins over
  // every source) or when the plan sent cached copy.
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

/**
 * Execute one email step: resolve content (custom body / cached AI / generate,
 * falling back to the template) -> send via the one send module -> pure decision
 * (with the send-attempt backoff) -> operational persist. A token-signing or send
 * failure is isolated as a transient failure so the sweep continues for other
 * steps/merchants. Clicks on the send's CTA are attributable (the CTA is a
 * click-tracked card-update link).
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
  let usedTemplate = false;
  let templateReason: TemplateReason | null = null;
  let suppressed = false;
  try {
    const urls = await buildEngagementUrls(env, ctx, baseUrl);
    // Token signing must succeed before either path: the template needs the same
    // click-tracked CTA the generated copy would carry, so there is no useful
    // email to send without it. A signing failure stays a transient failure.
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
    // Isolate: a token-signing or send throw is a transient failure for THIS step
    // only, rescheduled by the backoff machine; it must not halt the sweep.
    // A GENERATION throw no longer reaches here; it falls back to the template.
    attempt = { ok: false, permanent: false, error: err instanceof Error ? err.message : "send error" };
  }

  const patch = decideEmailStep({ attemptCount: ctx.attemptCount }, attempt, now);
  await persistPatch(env, ctx.stepId, patch, resolvedCopy);
  // SLACK, legacy's `email_sent` post, after the step is persisted and only on
  // a send that succeeded. A Slack failure cannot unwind the send or change the
  // step's result.
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
