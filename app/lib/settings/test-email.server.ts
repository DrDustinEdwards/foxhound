import { appOrigin } from "~/lib/app-origin";
import { getDb } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";
import type { EmailJob } from "~/lib/email/types";
import { buildTemplateEmail } from "~/lib/recovery/email-template";
import { getPrimarySenderConnection } from "~/lib/settings/queries.server";

// Your real recovery emails will look like this." No unsubscribe, no postal address, no tracking,
// no retry. IT IS A REAL SEND. NO AI SAMPLE. Kept only while the generation path cannot run (no
// Anthropic credit, core.md launch blockers). 2. A preview must not mint a card-update token or a
// tracked click. 4.

const SAMPLE_AMOUNT_FORMATTED = "$99.00";
const SAMPLE_DECLINE_CATEGORY = "soft";
const SAMPLE_CUSTOMER_NAME = "Alex";
/** The step the sample is: the first recovery email a customer gets. */
const SAMPLE_STEP = "email_day1";
const TEST_EMAIL_TEMPLATE = "settings_test";
const TEST_EMAIL_SUBJECT_PREFIX = "[PREVIEW] ";
const TEST_EMAIL_BANNER = "PREVIEW: This is a sample recovery email.";
const TEST_EMAIL_FOOTER =
  "This is a preview email sent from Foxhound. Your real recovery emails will look like this.";

/**
 * The subject, body and footer this control sends: the banner and the "[PREVIEW] " prefix around
 * the first recovery email, with its button on /settings/email.
 */
function buildTestEmailCopy(
  senderName: string | null,
  baseUrl: string,
): { subject: string; bodyHtml: string; footerNote: string } {
  const copy = buildTemplateEmail({
    merchantName: senderName ?? "your subscription",
    declineCategory: SAMPLE_DECLINE_CATEGORY,
    amountFormatted: SAMPLE_AMOUNT_FORMATTED,
    updateUrl: `${baseUrl}/settings/email`,
    stepType: SAMPLE_STEP,
    customerName: SAMPLE_CUSTOMER_NAME,
    senderName,
  });
  return {
    subject: `${TEST_EMAIL_SUBJECT_PREFIX}${copy.subject}`,
    // The banner is the mail's one heading: it is the first thing a reader meets and it says what
    // the mail is.
    bodyHtml: `<h1>${TEST_EMAIL_BANNER}</h1>\n${copy.bodyHtml}`,
    footerNote: TEST_EMAIL_FOOTER,
  };
}

/** The preview as a job for the send module. Pure. */
export function buildTestEmailJob(input: {
  accountId: string;
  to: string;
  senderName: string | null;
  replyTo: string | null;
  baseUrl: string;
  template: string;
  idempotencyKey: string;
}): EmailJob {
  return {
    accountId: input.accountId,
    to: input.to,
    // The point of the control: the merchant sees the From and Reply-To their
    // customers will see, from the fields they just saved.
    fromName: input.senderName,
    replyTo: input.replyTo,
    ...buildTestEmailCopy(input.senderName, input.baseUrl),
    template: input.template,
    audience: "preview",
    // Preview mail carries neither (EmailAudience "preview").
    unsubscribeToken: "",
    physicalAddress: "",
    idempotencyKey: input.idempotencyKey,
    cronRunId: null,
  };
}

export interface SendTestEmailResult {
  /** A named outcome, never null: sent, suppressed or failed. */
  result: EmailJobResult;
  sentTo: string;
}

/**
 * Send one preview recovery email to the signed-in merchant's own address. `to` is the SESSION
 * user's email and is never taken from the form, so this control cannot be pointed at a third
 * party.
 */
export async function sendTestEmail(
  env: Env,
  accountId: string,
  recipientEmail: string,
): Promise<SendTestEmailResult> {
  const db = getDb(env);
  const connection = await getPrimarySenderConnection(db, accountId);

  const job = buildTestEmailJob({
    accountId,
    to: recipientEmail,
    senderName: connection?.senderName ?? null,
    replyTo: connection?.replyToEmail ?? null,
    baseUrl: appOrigin(env),
    template: TEST_EMAIL_TEMPLATE,
    idempotencyKey: `settings-test:${accountId}:${crypto.randomUUID()}`,
  });

  const result = await processEmailJob(env, job, null);
  return { result, sentTo: recipientEmail };
}
