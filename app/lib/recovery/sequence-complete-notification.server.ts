import { accounts } from "~/db";
import { recoveryFooterNote, type EmailNotice } from "~/lib/email/templates";

import {
  RECOVERY_NOTIFY_FROM_NAME,
  formatNotifyAmount,
  sendMerchantNotice,
  type RecoveryNotificationOutcome,
} from "./merchant-notification.server";

// THE SEQUENCE-COMPLETE NOTIFICATION. IT IS THE MIRROR OF THE RECOVERY NOTIFICATION and shares its
// machinery deliberately: the same From identity, the same amount formatter, the same merchant
// audience, the same discriminated outcome, the same "never throws". A payment the webhook already
// flipped to `recovered` is therefore never a candidate here, so a sequence that ends by recovery
// gets that notice and never this one.

const SEQUENCE_COMPLETE_TEMPLATE = "merchant_sequence_complete";

export interface SequenceCompleteContext {
  accountId: string;
  failedPaymentId: string;
}

function sequenceCompleteSubject(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
}): string {
  return `Recovery sequence ended: ${formatNotifyAmount(data.amountCents, data.currency)} from ${data.customerLabel} was not recovered`;
}

/**
 * Both sides plan steps out to `email_day30`, and Foxhound's `revoked` schedule is a single email.
 * PLAIN STRINGS, NOT MARKUP.
 */
function sequenceCompleteBody(data: {
  amountCents: number;
  currency: string;
  customerLabel: string;
  paymentUrl: string;
}): EmailNotice {
  const amount = formatNotifyAmount(data.amountCents, data.currency);
  return {
    title: "Recovery sequence complete.",
    body: [
      `The recovery sequence for ${data.customerLabel} (${amount}) has ended without a ` +
        `successful payment. You may want to manually reach out or write off this balance.`,
    ],
    action: { label: "View payment", url: data.paymentUrl },
  };
}

/** Everything the notice job says and carries, from the loaded data. */
export function sequenceCompleteContent(
  data: { amountCents: number; currency: string; customerLabel: string },
  paymentUrl: string,
  now: Date,
): { fromName: string; subject: string; notice: EmailNotice; footerNote: string } {
  return {
    fromName: RECOVERY_NOTIFY_FROM_NAME,
    subject: sequenceCompleteSubject(data),
    notice: sequenceCompleteBody({ ...data, paymentUrl }),
    footerNote: recoveryFooterNote(RECOVERY_NOTIFY_FROM_NAME, now.getUTCFullYear()),
  };
}

/**
 * Send the notification for one just-exhausted sequence. NEVER THROWS, and returns a discriminated
 * outcome: a refusal names itself so it cannot be confused with a swallowed crash.
 */
export function sendSequenceCompleteNotification(
  env: Env,
  ctx: SequenceCompleteContext,
): Promise<RecoveryNotificationOutcome> {
  return sendMerchantNotice(env, ctx, {
    label: "sequence-complete",
    template: SEQUENCE_COMPLETE_TEMPLATE,
    idempotencyPrefix: "sequence-complete",
    enabled: accounts.sequenceCompleteNotificationsEnabled,
    content: sequenceCompleteContent,
  });
}
