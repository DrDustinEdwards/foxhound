import { getDb } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";
import type { EmailJob } from "~/lib/email/types";
import { buildTemplateEmail } from "~/lib/recovery/email-template";
import { getPrimarySenderConnection } from "~/lib/settings/queries.server";

// S39 and E3, the "Send test email" control, ported from Recova's
// app/(app)/settings/test-email/route.ts (blob dcc3a06f, 11006 bytes, read
// whole with lib/email-colors.ts 8c23bd6f and lib/constants.ts a21b32b8).
//
// WHAT RECOVA SENDS, on every POST, with no toggle, to the signed-in user:
//   From      `${sender_name || 'Support'} <recovery@...>`
//   Reply-To  the primary connection's reply_to_email, when set
//   Subject   `[PREVIEW] ${subject}`
//   Body      a preview banner, the sample, then the footer "This is a preview
//             email sent from Recova. Your real recovery emails will look like
//             this."
//   No unsubscribe, no postal address, no tracking, no retry.
// Foxhound sends the same, with Foxhound's name in the footer, on Capsomer's
// email component in Foxhound's teal (Q3) with a text part beside the HTML.
//
// IT IS A REAL SEND. It goes through processEmailJob, as the recovery cron's
// sends do, so it passes the suppression gate and writes an email_sends row for
// whatever happens. Its audience is "preview" (app/lib/email/types.ts), which is
// what gives it Recova's footer in place of the CAN-SPAM one and lets it past
// the live-send gate, since it reaches no customer.
//
// DIFFERENCES FROM RECOVA, each named in the E3 pull request for Dustin:
//
// 1. NO AI SAMPLE. Recova asks Anthropic for a sample in the merchant's brand
//    voice and falls back to a fixed string. Foxhound previews the email it
//    would really send first today: email_day1 on Recova's own per-step words
//    (FALLBACK_TEMPLATES, app/lib/recovery/email-template.ts), with Recova's
//    sample customer, Alex. Kept only while the generation path cannot run
//    (no Anthropic credit, core.md launch blockers).
// 2. THE BANNER DOES NOT NAME THE BRAND VOICE. Recova's says "This is a sample
//    recovery email using your brand voice: ..."; a template sample does not use
//    the brand voice, so that clause would be false. Truthfulness, RULES.md 1.2.
//    Recova's em dash after PREVIEW is a colon (core.md: no em dashes).
// 3. THE BUTTON GOES TO /settings/email. Recova's fallback links to a
//    placeholder, https://billing.stripe.com/p/session/[LINK], which opens
//    nothing. A preview must not mint a card-update token or a tracked click.
// 4. THE ROUTE'S OWN ACTION, not a separate POST route, as S30 did.

const SAMPLE_AMOUNT_FORMATTED = "$99.00";
const SAMPLE_DECLINE_CATEGORY = "soft";
/** Recova's sample customer, "Name: Alex" in its prompt and "Hi Alex," in its fallback. */
const SAMPLE_CUSTOMER_NAME = "Alex";
/** The step the sample is: the first recovery email a customer gets. */
const SAMPLE_STEP = "email_day1";
export const TEST_EMAIL_TEMPLATE = "settings_test";
export const TEST_EMAIL_SUBJECT_PREFIX = "[PREVIEW] ";
/** Recova's preview banner, less the brand-voice clause (difference 2 above). */
export const TEST_EMAIL_BANNER = "PREVIEW: This is a sample recovery email.";
/** Recova's preview footer, Foxhound-branded. */
export const TEST_EMAIL_FOOTER = "This is a preview email sent from Foxhound. Your real recovery emails will look like this.";

/**
 * The subject, body and footer this control sends: the banner and the
 * "[PREVIEW] " prefix around the first recovery email, with its button on
 * /settings/email. Pure. The admin email preview sends the same mail through
 * buildTestEmailJob (app/lib/admin/email-send.server.ts).
 */
export function buildTestEmailCopy(
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
    // The banner is the mail's one heading: it is the first thing a reader
    // meets and it says what the mail is. Capsomer's info `note` block would
    // be nearer Recova's tinted bar, but the shell's reader makes no notes.
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
  /** A named outcome, never null (RULES.md 3.16): sent, suppressed or failed. */
  result: EmailJobResult;
  sentTo: string;
}

/**
 * Send one preview recovery email to the signed-in merchant's own address.
 *
 * `to` is the SESSION user's email and is never taken from the form, so this
 * control cannot be pointed at a third party (RULES.md 4.7). The idempotency
 * key is new on every click, because Recova sends on every click; it still
 * names the account so the row is recognizable in email_sends.
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
    baseUrl: env.BETTER_AUTH_URL ?? "",
    template: TEST_EMAIL_TEMPLATE,
    idempotencyKey: `settings-test:${accountId}:${crypto.randomUUID()}`,
  });

  const result = await processEmailJob(env, job, null);
  return { result, sentTo: recipientEmail };
}
