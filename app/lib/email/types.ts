// The queued email job: everything the consumer needs to render + send one
// message and log it. Produced by the recovery/win-back engine (Phase 4b/4e),
// consumed by the queue handler. Kept transport-agnostic; only send.ts touches
// the binding.
import type { Block } from "capsomer/email";

import type { EmailNotice, EmailTracking } from "./templates";

/**
 * Who the message is addressed to, which decides whether CAN-SPAM applies.
 *
 * "customer" is a MERCHANT-CUSTOMER send: commercial mail on the merchant's
 * behalf, and ARCHITECTURE.md non-negotiable #8 requires a postal address and a
 * one-click unsubscribe on every one.
 *
 * "merchant" is PLATFORM-TO-OUR-OWN-USER mail, like the recovery notification.
 * It carries no unsubscribe, for the same reason `sendTransactionalEmail` does
 * not: you cannot unsubscribe from a notice about your own account, and the
 * suppression table is keyed by ADDRESS, so an unsubscribe click on an
 * operational notice would silence that address for everything. Legacy sends
 * this notification with no unsubscribe link either.
 *
 * "preview" is a SAMPLE of customer mail sent to our own signed-in user at
 * their own request: the Send test email control on /settings/email (E3), whose
 * recipient is always the session user's address (RULES.md 4.7). It carries
 * what the customer mail it samples carries from the merchant, the From name
 * and the Reply-To, and its own footer note, but no unsubscribe and no postal
 * address, as Recova's preview carries none (app/(app)/settings/test-email/
 * route.ts, blob dcc3a06f): its reader is our user, not the merchant's
 * customer, and an unsubscribe there would silence that user's address for
 * everything (RULES.md 3.16). It is not held by the live-send gate either; see
 * processEmailJob.
 *
 * "digest" is the WEEKLY DIGEST and nothing else (E23): merchant mail that
 * carries Recova's unsubscribe, because Recova's digest does. Recova
 * suppression-checks it and wraps it with an unsubscribe token
 * (app/api/cron/weekly-digest/route.ts, blob b6ff2a8c), so its footer has the
 * Unsubscribe link and the postal address, and the send module holds it to the
 * same two guards as customer mail. No other merchant notice uses it (RULES.md
 * 3.16); a test holds the digest's two senders as its only users.
 *
 * The field is OPTIONAL and defaults to "customer" deliberately: an omitted
 * audience must never be the one that skips the CAN-SPAM guard.
 */
export type EmailAudience = "customer" | "merchant" | "preview" | "digest";

interface EmailJobFields {
  accountId: string | null;
  /** Links the send to its recovery step (one of recovery/winBack set, or neither for merchant notices). */
  recoveryStepId?: string | null;
  winBackStepId?: string | null;
  /** Recipient address (never persisted raw; email_sends stores a hash). */
  to: string;
  /** Display name for the From header (merchant sender name), optional. */
  fromName?: string | null;
  /**
   * The merchant's reply-to address (`stripe_connections.reply_to_email`, J03).
   * Customer and preview mail: buildEmailMessage sets Reply-To to it when it
   * is one address, and sets none otherwise, so a reply goes to the From.
   * Ignored on merchant mail.
   */
  replyTo?: string | null;
  subject: string;
  /** email_sends.template label (e.g. recovery_dunning, winback, merchant_notify). */
  template: string;
  /** CAN-SPAM one-click unsubscribe token (required for merchant-customer sends and the digest). */
  unsubscribeToken: string;
  /** CAN-SPAM sender postal address (required for merchant-customer sends and the digest). */
  physicalAddress: string;
  /**
   * Recova's footer sentence ("You're receiving this from ..."), first in the
   * footer slot. Customer mail: before the unsubscribe link and the postal
   * address (J85). Preview mail: the whole footer slot (E3). Merchant mail:
   * before Recova's "Manage email settings" link to /settings, as Recova's
   * wrapEmailHtml writes it for a mail with no unsubscribe (E10); a merchant
   * mail without a note has no footer line of its own.
   */
  footerNote?: string | null;
  /**
   * THE SEND CLAIM'S KEY. Stable per logical send, and REQUIRED: an empty one is
   * refused rather than sent unclaimed.
   *
   * This comment used to read "stable per logical send so a re-delivery is
   * recognizable by the caller", which described a dedupe that did not exist.
   * 376 item 15 measured it: the field was read by NOTHING, so nothing
   * recognised anything. 385 made it real, and this now describes what the code
   * does rather than what the field was named for.
   *
   * WHAT IT DOES NOW. `processEmailJob` inserts an `email_sends` row carrying
   * this key, with status `pending`, BEFORE calling the provider, under the
   * partial unique index `email_sends_idempotency_uq`. A second job with the same
   * key loses the insert and returns `duplicate` without sending. So the key is
   * not advisory: two jobs sharing one are one send.
   *
   * WHICH MAKES THE KEY'S SHAPE A CALLER'S DECISION WITH REAL CONSEQUENCES. A
   * key that varies per attempt (the recovery path's `stepId:attemptCount`)
   * permits a retry after a failure, because the retry carries a new key. A key
   * that is stable across attempts (the win-back path's `winback-step:stepId`)
   * does not: once its claim stands, that logical send is finished, whatever the
   * provider said. Both are defensible and they are not interchangeable.
   */
  idempotencyKey: string;
  /** The cron run that produced this send (313). Null for request-thread sends. */
  cronRunId?: string | null;
  /** Defaults to "customer", the CAN-SPAM-bearing case. */
  audience?: EmailAudience;
  /**
   * The open pixel and the scanner trap of a dunning send (J02). Carried beside
   * the body rather than inside it, so the frame places them in the HTML part
   * only and the text part never shows them. Absent on every other send.
   */
  tracking?: EmailTracking | null;
}

/**
 * A mail whose body the sender wrote as HTML (dunning, win-back, the dispute
 * notices), read by the frame for text and links.
 */
export interface EmailJob extends EmailJobFields {
  bodyHtml: string;
  notice?: never;
  blocks?: never;
}

/**
 * A merchant notice on Capsomer's `notice` template (E10): a title, paragraphs
 * and a button, each a plain string Capsomer escapes. No HTML body.
 */
export interface NoticeEmailJob extends EmailJobFields {
  notice: EmailNotice;
  bodyHtml?: never;
  blocks?: never;
}

/**
 * A mail written directly as Capsomer's blocks (E12, the expiring card alert,
 * which has no heading of its own; E23, the weekly digest): Recova's lines and
 * buttons, each a plain string Capsomer escapes. No HTML body.
 */
export interface BlocksEmailJob extends EmailJobFields {
  blocks: Block[];
  bodyHtml?: never;
  notice?: never;
}

/** Any kind of mail, as the send seam (processEmailJob, sendEmail) takes it. */
export type OutboundEmailJob = EmailJob | NoticeEmailJob | BlocksEmailJob;
