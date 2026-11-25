import { appOrigin } from "~/lib/app-origin";
import { DAY_MS } from "~/lib/constants";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { recoveryFooterNote } from "~/lib/email/templates";
import { buildTemplateEmail } from "~/lib/recovery/email-template";
import {
  buildExpiringCardEmail,
  buildNoPaymentMethodEmail,
  expiringCardSubject,
  noPaymentMethodSubject,
} from "~/lib/recovery/expiring-card-email";
import { resendFooterNote } from "~/lib/recovery/manual-action-deps.server";
import { buildWinbackEmail, winbackSubject } from "~/lib/recovery/winback-email";
import { buildTestEmailJob } from "~/lib/settings/test-email.server";

import {
  RECOVERY_STEPS,
  ADMIN_EMAIL_STAND_IN_PATH,
  type PreparedEmail,
  type PrepareInput,
} from "./email-catalog";
import { SAMPLE_AMOUNT } from "./email-samples";

/** The customer mail types; null when the type is not one of them. */
export async function prepareCustomerEmail(
  env: Env,
  input: PrepareInput,
): Promise<PreparedEmail | null> {
  const { type, to, merchant, now } = input;
  const baseUrl = appOrigin(env);
  const standIn = `${baseUrl}${ADMIN_EMAIL_STAND_IN_PATH}`;
  const senderName = merchant?.senderName ?? null;
  if (!merchant) throw new Error("customer mail needs a merchant");
  const base = {
    accountId: merchant.accountId,
    to,
    fromName: senderName,
    replyTo: merchant.replyTo,
    unsubscribeToken: await signUnsubscribeToken(env, {
      email: to,
      accountId: merchant.accountId,
    }),
    physicalAddress: env.PHYSICAL_ADDRESS ?? "",
    template: `admin_test:${type.type}`,
    idempotencyKey: `admin-test:${crypto.randomUUID()}`,
    cronRunId: null,
    audience: "customer" as const,
  };
  const job = (
    content: { subject: string; footerNote?: string } & (
      | { bodyHtml: string }
      | { blocks: ReturnType<typeof buildExpiringCardEmail> }
    ),
  ): PreparedEmail => ({
    channel: "job",
    audience: "customer",
    job: { ...base, ...content },
  });

  const step = RECOVERY_STEPS[type.type];
  if (step) {
    const copy = buildTemplateEmail({
      merchantName: senderName ?? "your subscription",
      declineCategory: step.declineCategory,
      amountFormatted: SAMPLE_AMOUNT,
      updateUrl: standIn,
      stepType: step.stepType,
      customerName: null,
      senderName,
    });
    return job({ ...copy, footerNote: recoveryFooterNote(senderName, now.getUTCFullYear()) });
  }
  const winback = /^winback_step([123])$/.exec(type.type);
  if (winback) {
    const stepNumber = Number(winback[1]);
    return job({
      subject: winbackSubject({ stepNumber, planName: null }),
      blocks: buildWinbackEmail({
        stepNumber,
        customerName: null,
        planName: null,
        senderName,
        resubscribeUrl: standIn,
      }),
      footerNote: recoveryFooterNote(senderName, now.getUTCFullYear()),
    });
  }
  if (type.type === "expiring_card") {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const card = { cardBrand: "Visa", cardLast4: "4242" };
    return job({
      subject: expiringCardSubject(card),
      blocks: buildExpiringCardEmail({
        ...card,
        customerName: null,
        expiresMonth: next.getUTCMonth() + 1,
        expiresYear: next.getUTCFullYear(),
        senderName,
        updateUrl: standIn,
      }),
      footerNote: recoveryFooterNote(senderName, now.getUTCFullYear()),
    });
  }
  if (type.type === "expiring_card_no_payment_method") {
    // The trial-end month stands in for the row's month and year, as on a
    // real 'no_payment_method' alert.
    const trialEnd = new Date(now.getTime() + 3 * DAY_MS);
    return job({
      subject: noPaymentMethodSubject(),
      blocks: buildNoPaymentMethodEmail({
        customerName: null,
        trialEndsMonth: trialEnd.getUTCMonth() + 1,
        trialEndsYear: trialEnd.getUTCFullYear(),
        senderName,
        updateUrl: standIn,
      }),
      footerNote: recoveryFooterNote(senderName, now.getUTCFullYear()),
    });
  }
  if (type.type === "recovery_resend") {
    // The manual resend sends the step's stored subject and body with its own
    // footer line (manual-action-deps.server.ts); the first email's template
    // stands in for the stored copy.
    const copy = buildTemplateEmail({
      merchantName: senderName ?? "your subscription",
      declineCategory: "soft",
      amountFormatted: SAMPLE_AMOUNT,
      updateUrl: standIn,
      stepType: "email_day1",
      customerName: null,
      senderName,
    });
    return job({ ...copy, footerNote: resendFooterNote(senderName, now.getUTCFullYear()) });
  }
  if (type.type === "settings_test") {
    return {
      channel: "job",
      audience: "preview",
      job: buildTestEmailJob({
        accountId: merchant.accountId,
        to,
        senderName,
        replyTo: merchant.replyTo,
        baseUrl,
        template: base.template,
        idempotencyKey: base.idempotencyKey,
      }),
    };
  }
  return null;
}
