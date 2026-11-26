import { appOrigin } from "~/lib/app-origin";
import { primaryConnectionValue, senderNameOrAccountName } from "~/lib/stripe/connections.server";
import { and, eq, isNull, lte, or } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, getDb, stripeConnections, winBackSequences, winBackSteps } from "~/db";
import { signCardUpdateToken } from "~/lib/card-update/token";
import { processEmailJob, SendGates } from "~/lib/email/dispatch";
import { recoveryFooterNote } from "~/lib/email/templates";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { recordOutcome } from "~/lib/engine/outcomes";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";

import { passesQualityGate } from "~/lib/recovery/email-generation";
import {
  buildWinbackEmail,
  winbackSubject,
  WINBACK_FALLBACKS,
  WINBACK_TEMPLATE,
} from "~/lib/recovery/winback-email";
import { generateWinbackEmail } from "~/lib/recovery/winback-generation";
import { readVoiceSamples } from "~/lib/recovery/voice-samples";
import type { Block } from "capsomer/email";
import { linksTo, storedCopyCarriesResubscribeLink } from "~/lib/recovery/update-link";
import { isLastWinbackStep, WINBACK_STATUS } from "~/lib/recovery/winback";
import { HOUR_MS } from "~/lib/constants";
import { errorMessage } from "@dustinedwards/site-runtime/log";

/** One tick's cap, matching the recovery tick's shape. */
const WINBACK_SEND_LIMIT = 100;

export interface WinbackSendResult {
  sent: number;
  skipped: number;
}

export interface DueWinbackStep {
  stepId: string;
  sequenceId: string;
  accountId: string;
  stepNumber: number;
  customerEmail: string;
  customerName: string | null;
  planName: string | null;
  amountCents: number | null;
  notificationsEnabled: boolean | null;
  senderName: string | null;
  /** The primary connection's `reply_to_email`, for the Reply-To. */
  replyToEmail: string | null;
  cancelReason: string | null;
  /** The GENERAL brand voice. */
  brandVoice: string | null;
  /** The primary connection's `brand_voice_samples`, as stored. */
  brandVoiceSamples: string | null;
  cachedSubject: string | null;
  cachedBodyHtml: string | null;
  /**
   * When this step was scheduled, and when its sequence began (the
   * cancellation): the prompt states the delay between them.
   */
  scheduledAt: Date;
  sequenceCreatedAt: Date;
}

async function queryDueWinbackSteps(
  db: Db,
  now: Date,
  limit: number = WINBACK_SEND_LIMIT,
): Promise<DueWinbackStep[]> {
  const rows = await db
    .select({
      stepId: winBackSteps.id,
      sequenceId: winBackSequences.id,
      accountId: winBackSequences.accountId,
      stepNumber: winBackSteps.stepNumber,
      customerEmail: winBackSequences.customerEmail,
      customerName: winBackSequences.customerName,
      planName: winBackSequences.planName,
      amountCents: winBackSequences.amountCents,
      cancelReason: winBackSequences.cancelReason,
      cachedSubject: winBackSteps.aiSubject,
      cachedBodyHtml: winBackSteps.aiBodyHtml,
      scheduledAt: winBackSteps.scheduledAt,
      sequenceCreatedAt: winBackSequences.createdAt,
      notificationsEnabled: accounts.winbackNotificationsEnabled,
      brandVoice: primaryConnectionValue<string>(
        stripeConnections.brandVoice,
        winBackSequences.accountId,
      ),
      brandVoiceSamples: primaryConnectionValue<string>(
        stripeConnections.brandVoiceSamples,
        winBackSequences.accountId,
      ),
      senderName: senderNameOrAccountName(
        primaryConnectionValue<string>(stripeConnections.senderName, winBackSequences.accountId),
        accounts.name,
      ),
      replyToEmail: primaryConnectionValue<string>(
        stripeConnections.replyToEmail,
        winBackSequences.accountId,
      ),
    })
    .from(winBackSteps)
    .innerJoin(winBackSequences, eq(winBackSequences.id, winBackSteps.winBackSequenceId))
    .innerJoin(accounts, eq(accounts.id, winBackSequences.accountId))
    .where(
      and(
        isNull(winBackSteps.executedAt),
        isNull(winBackSteps.result),
        isNull(winBackSteps.deletedAt),
        lte(winBackSteps.scheduledAt, now),
        or(isNull(winBackSteps.nextRetryAt), lte(winBackSteps.nextRetryAt, now)),
        eq(winBackSequences.status, WINBACK_STATUS.ACTIVE),
        accountProcessingEligibleCondition(),
      ),
    )
    .limit(limit);
  return rows.filter((r): r is DueWinbackStep => r.accountId !== null);
}

async function stampStep(db: Db, stepId: string, result: string, now: Date): Promise<void> {
  await db
    .update(winBackSteps)
    .set({ executedAt: now, result })
    .where(and(eq(winBackSteps.id, stepId), isNull(winBackSteps.executedAt)));
}

/** THE SEND CLAIM. Returns whether this call took the claim. */
export async function claimStepSent(
  db: Db,
  stepId: string,
  now: Date,
  result: string = "email_sent_fallback",
): Promise<boolean> {
  await stampStep(db, stepId, result, now);
  const rows = await db
    .select({ executedAt: winBackSteps.executedAt })
    .from(winBackSteps)
    .where(eq(winBackSteps.id, stepId))
    .limit(1);
  return rows[0]?.executedAt?.getTime() === now.getTime();
}

/**
 * THE TERMINAL FLIP. An exhausted sequence stays RESUBSCRIBABLE, because step 3's own button must outlive the flip its own send causes.
 */
async function claimSequenceExhausted(db: Db, sequenceId: string, now: Date): Promise<void> {
  await db
    .update(winBackSequences)
    .set({ status: WINBACK_STATUS.EXHAUSTED, resolvedAt: now })
    .where(
      and(eq(winBackSequences.id, sequenceId), eq(winBackSequences.status, WINBACK_STATUS.ACTIVE)),
    );
}

export type WinbackCopy = {
  subject: string;
  result: "email_sent_ai" | "email_sent_fallback";
} & ({ bodyHtml: string; blocks?: never } | { blocks: Block[]; bodyHtml?: never });

export async function resolveWinbackCopy(
  env: Env,
  db: Db,
  step: DueWinbackStep,
  resubscribeUrl: string,
): Promise<WinbackCopy> {
  const template = (): WinbackCopy => {
    const blocks = buildWinbackEmail({
      stepNumber: step.stepNumber,
      customerName: step.customerName,
      planName: step.planName,
      senderName: step.senderName,
      resubscribeUrl,
    });
    if (!blocks.some((b) => b.type === "button" && b.url === resubscribeUrl)) {
      throw new Error("resubscribe link missing from the win-back template; not sending");
    }
    return {
      subject: winbackSubject({ stepNumber: step.stepNumber, planName: step.planName }),
      blocks,
      result: "email_sent_fallback",
    };
  };

  if (step.cachedSubject && step.cachedBodyHtml) {
    const carries = await storedCopyCarriesResubscribeLink(env, step.cachedBodyHtml, {
      baseUrl: appOrigin(env),
      mintedUrl: resubscribeUrl,
      sequenceId: step.sequenceId,
      stepNumber: step.stepNumber,
      accountId: step.accountId,
    });
    if (!carries) return template();
    return {
      subject: step.cachedSubject,
      bodyHtml: step.cachedBodyHtml,
      result: "email_sent_ai",
    };
  }

  if (!env.ANTHROPIC_API_KEY) return template();

  try {
    const generated = await generateWinbackEmail(
      env,
      {
        stepNumber: step.stepNumber,
        offsetHours: (step.scheduledAt.getTime() - step.sequenceCreatedAt.getTime()) / HOUR_MS,
        customerName: step.customerName || WINBACK_FALLBACKS.customerName,
        planName: step.planName || WINBACK_FALLBACKS.planName,
        cancelReason: step.cancelReason,
        brandVoice: step.brandVoice,
        voiceSamples: readVoiceSamples(step.brandVoiceSamples),
        senderName: step.senderName || WINBACK_FALLBACKS.senderName,
        resubscribeUrl,
      },
      {
        source: "winback_email",
        accountId: step.accountId,
        relatedId: step.stepId,
        outcomeFeature: "winback-email",
      },
    );
    if (!passesQualityGate(generated)) return template();
    if (!linksTo(generated.bodyHtml, resubscribeUrl)) return template();

    await db
      .update(winBackSteps)
      .set({ aiSubject: generated.subject, aiBodyHtml: generated.bodyHtml })
      .where(eq(winBackSteps.id, step.stepId));

    return { subject: generated.subject, bodyHtml: generated.bodyHtml, result: "email_sent_ai" };
  } catch (err) {
    console.error(`winback generation failed for step ${step.stepId}:`, errorMessage(err));
    return template();
  }
}

/** One tick: send every due win-back step. */
export async function runWinbackSends(env: Env, now: Date): Promise<WinbackSendResult> {
  const db = getDb(env);
  const result: WinbackSendResult = { sent: 0, skipped: 0 };
  const due = await queryDueWinbackSteps(db, now);
  if (due.length === 0) return result;
  // Both send gates for every due step in one read, not two reads per step.
  const gates = await SendGates.read(
    env,
    due.map((step) => ({ to: step.customerEmail, accountId: step.accountId })),
  );

  for (const step of due) {
    // NULL is ON.
    if (step.notificationsEnabled === false) {
      await stampStep(db, step.stepId, "skipped_notifications_disabled", now);
      result.skipped += 1;
      continue;
    }

    try {
      const token = await signCardUpdateToken(env, {
        winBackSequenceId: step.sequenceId,
        winBackStepNumber: step.stepNumber,
        accountId: step.accountId,
      });
      const resubscribeUrl = `${appOrigin(env)}/p/${token}`;
      const copy = await resolveWinbackCopy(env, db, step, resubscribeUrl);
      const outcome = await processEmailJob(
        env,
        {
          accountId: step.accountId,
          to: step.customerEmail,
          fromName: step.senderName,
          replyTo: step.replyToEmail,
          subject: copy.subject,
          ...(copy.blocks ? { blocks: copy.blocks } : { bodyHtml: copy.bodyHtml }),
          footerNote: recoveryFooterNote(step.senderName, now.getUTCFullYear()),
          template: WINBACK_TEMPLATE,
          // CUSTOMER audience: footer, unsubscribe headers and the suppression
          // gate all apply, because this is commercial mail sent on the
          // merchant's behalf.
          unsubscribeToken: await signUnsubscribeToken(env, {
            email: step.customerEmail,
            accountId: step.accountId,
          }),
          physicalAddress: env.PHYSICAL_ADDRESS ?? "",
          idempotencyKey: `winback-step:${step.stepId}`,
          winBackStepId: step.stepId,
          cronRunId: null,
        },
        null,
        gates,
      );

      if (outcome.status === "suppressed") {
        await stampStep(db, step.stepId, "skipped_unsubscribed", now);
        result.skipped += 1;
        continue;
      }
      // A duplicate is a claim row an earlier run left (it sent, or may have, and died before the stamp),
      // so it is stamped like a send; leaving it due would re-select it every tick and block the sequence.
      if (outcome.status !== "sent" && outcome.status !== "duplicate") {
        // NOT STAMPED, and this is where the win-back deliberately differs from
        // the expiring-card alert. That alert stamps a blocked send because
        // leaving it unstamped burns a Stripe call every night forever; a
        // win-back step costs one query.
        result.skipped += 1;
        continue;
      }

      const claimed = await claimStepSent(db, step.stepId, now, copy.result);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      await recordOutcome(env, {
        accountId: step.accountId,
        product: "recovery",
        eventType: "winback_email_sent",
        outcome: "sent",
        eventData: {
          stepNumber: step.stepNumber,
          amountCents: step.amountCents,
        },
        idempotencyKey: `winback-email:${step.stepId}`,
        outcomeAt: now,
      });

      if (isLastWinbackStep(step.stepNumber)) {
        await claimSequenceExhausted(db, step.sequenceId, now);
      }
      result.sent += 1;
    } catch (err) {
      console.error(`winback send failed for step ${step.stepId}:`, errorMessage(err));
      result.skipped += 1;
    }
  }
  return result;
}

export function describeWinbackRun(result: WinbackSendResult): string {
  return `${result.sent} sent, ${result.skipped} skipped`;
}
