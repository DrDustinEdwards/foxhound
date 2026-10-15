import { getDb } from "~/db";
import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { buildTemplateEmail } from "~/lib/recovery/email-template";
import { getPrimarySenderConnection } from "~/lib/settings/queries.server";

// S39, the "Send test email" control, ported from legacy's
// app/(app)/settings/test-email/route.ts (blob dcc3a06f).
//
// THE POINT OF THIS CONTROL IS THAT IT IS NOT A SIMULATION. It goes through
// processEmailJob, the same function the recovery cron's defaultSend calls, so
// it passes the suppression gate, the per-account live-send gate, and
// buildEmailMessage's CAN-SPAM guard, and it writes an email_sends row for
// whatever happens. A merchant who clicks it and gets "blocked" has learned a
// true thing about their account.
//
// THREE DIVERGENCES FROM LEGACY, each classed:
//
// 1. NO AI GENERATION. Legacy calls Anthropic and falls back to a fixed string
//    on error. Foxhound previews `buildTemplateEmail`, its own deterministic
//    dunning template. Class (c) truthfulness: ANTHROPIC_API_KEY has no credit
//    (core.md blocker 2), so the AI path would fail on every click and the
//    merchant would be shown the fallback while being told it was a sample of
//    their AI copy. Previewing the template shows them what would actually send
//    today.
// 2. THE ROUTE'S OWN ACTION, not a separate POST route. Same class (a)
//    divergence S30 took and for the same reason: it avoids building ledger row
//    S39 as a side effect of this row.
// 3. `replyTo` IS PASSED, as legacy's is (`profile?.reply_to_email ||
//    undefined`), so the preview carries the Reply-To customers will get (J03).
//
// The sample customer is legacy's: a soft decline on a $99 plan.

const SAMPLE_AMOUNT_FORMATTED = "$99.00";
const SAMPLE_DECLINE_CATEGORY = "soft";
export const TEST_EMAIL_TEMPLATE = "settings_test";
export const TEST_EMAIL_SUBJECT_PREFIX = "[PREVIEW] ";

/** Legacy's preview banner, which is what stops a merchant mistaking the sample
 *  for a real customer send sitting in their own inbox.
 *
 *  PLAIN SEMANTIC HTML, no inline colours. Legacy's is a tinted bar built from
 *  its EMAIL_COLORS module; Foxhound has no such module (the same wall
 *  buildDigestEmail hit, app/lib/audit/digest.server.ts:107) and minting one is
 *  not this row. check-tokens enforces that structurally: raw hex outside the
 *  token file and px font sizes both fail the build, and this banner failed it
 *  once already. The words carry the warning instead of the colour. */
function previewBanner(): string {
  return (
    `<p><strong>PREVIEW.</strong> This is a sample recovery email. ` +
    `Your real recovery emails look like this.</p>`
  );
}

/**
 * The subject and body this control sends: the banner, the "[PREVIEW] "
 * prefix and the sample soft decline, with the button on /settings/email.
 * Pure. The admin email preview sends the same copy (app/lib/admin/email-send.server.ts).
 */
export function buildTestEmailCopy(senderName: string | null, baseUrl: string): { subject: string; bodyHtml: string } {
  const copy = buildTemplateEmail({
    merchantName: senderName ?? "your subscription",
    declineCategory: SAMPLE_DECLINE_CATEGORY,
    amountFormatted: SAMPLE_AMOUNT_FORMATTED,
    updateUrl: `${baseUrl}/settings/email`,
  });
  return { subject: `${TEST_EMAIL_SUBJECT_PREFIX}${copy.subject}`, bodyHtml: `${previewBanner()}${copy.bodyHtml}` };
}

export interface SendTestEmailResult {
  result: EmailJobResult;
  sentTo: string;
}

/**
 * Send one preview recovery email to the signed-in merchant's own address.
 *
 * `to` is the SESSION user's email and is never taken from the form, so this
 * control cannot be pointed at a third party. The idempotency key carries the
 * account and the address so a double-click is recognizable in email_sends.
 */
export async function sendTestEmail(
  env: Env,
  accountId: string,
  recipientEmail: string,
): Promise<SendTestEmailResult> {
  const db = getDb(env);
  const connection = await getPrimarySenderConnection(db, accountId);

  const copy = buildTestEmailCopy(connection?.senderName ?? null, env.BETTER_AUTH_URL ?? "");

  const unsubscribeToken = await signUnsubscribeToken(env, {
    email: recipientEmail,
    accountId,
  });

  const result = await processEmailJob(
    env,
    {
      accountId,
      to: recipientEmail,
      // The whole reason this control exists: the merchant sees the From header
      // their customers will see, produced by the same field they just saved.
      fromName: connection?.senderName ?? null,
      // And the Reply-To they will see, as legacy's test route passes one (J03).
      replyTo: connection?.replyToEmail ?? null,
      subject: copy.subject,
      bodyHtml: copy.bodyHtml,
      template: TEST_EMAIL_TEMPLATE,
      unsubscribeToken,
      physicalAddress: env.PHYSICAL_ADDRESS ?? "",
      idempotencyKey: `settings-test:${accountId}:${recipientEmail}`,
      cronRunId: null,
    },
    null,
  );

  return { result, sentTo: recipientEmail };
}
