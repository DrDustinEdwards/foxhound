// The email job: everything needed to render, send and log one message. Transport-agnostic; only send.ts touches the binding.
import type { Block } from "capsomer/email";

import type { EmailNotice, EmailTracking } from "./templates";

/**
 * Who the message is addressed to, which decides whether CAN-SPAM applies.
 * "customer": commercial mail on a merchant's behalf; needs a postal address and one-click unsubscribe.
 * "merchant": platform-to-own-user notice; no unsubscribe, since the suppression table is keyed by address
 * and a click would silence that address for everything.
 * "preview": a sample sent to the signed-in user's own address; no unsubscribe or postal address, not held
 * by the live-send gate.
 * "digest": the weekly digest only; carries the unsubscribe and postal address like customer mail, but
 * its token switches off that account's digest rather than suppressing the address.
 * Optional and defaults to "customer": an omitted audience must never skip the CAN-SPAM guard.
 */
export type EmailAudience = "customer" | "merchant" | "preview" | "digest";

interface EmailJobFields {
  accountId: string | null;
  recoveryStepId?: string | null;
  winBackStepId?: string | null;
  to: string;
  fromName?: string | null;
  /** The merchant's reply-to; set on customer and preview mail when it is exactly one address, else none. */
  replyTo?: string | null;
  subject: string;
  template: string;
  unsubscribeToken: string;
  physicalAddress: string;
  /** The sender's footer sentence, first in the footer slot (before the unsubscribe link and postal address). */
  footerNote?: string | null;
  /**
   * The send claim's key: stable per logical send and required (an empty one is refused). processEmailJob
   * inserts an `email_sends` row with it before calling the provider, under the unique index
   * `email_sends_idempotency_uq`, so two jobs sharing a key are one send. Its shape is a caller decision:
   * a per-attempt key (`stepId:attemptCount`) permits retry after failure; a stable key
   * (`winback-step:stepId`) means once the claim stands that send is finished.
   */
  idempotencyKey: string;
  cronRunId?: string | null;
  audience?: EmailAudience;
  /** "skip" passes the per-account live-send gate. Only for platform-to-merchant mail whose caller already
   *  applied the demo and eligibility checks; never customer mail. */
  liveSendGate?: "skip";
  /** The open pixel and scanner trap of a dunning send; HTML part only. */
  tracking?: EmailTracking | null;
  /** Strings cut out of a provider's error before it is stored or returned (links, tokens), so a provider
   *  that echoes the message cannot leak a working link into a log. */
  redact?: string[];
}

export interface EmailJob extends EmailJobFields {
  bodyHtml: string;
  notice?: never;
  blocks?: never;
}

/** A merchant notice on Capsomer's `notice` template: plain strings, no HTML body. */
interface NoticeEmailJob extends EmailJobFields {
  notice: EmailNotice;
  bodyHtml?: never;
  blocks?: never;
}

/** A mail written directly as Capsomer's blocks (plain strings, no HTML body). */
interface BlocksEmailJob extends EmailJobFields {
  blocks: Block[];
  bodyHtml?: never;
  notice?: never;
}

export type OutboundEmailJob = EmailJob | NoticeEmailJob | BlocksEmailJob;
