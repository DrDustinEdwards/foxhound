import { EMAIL_AUTH_SENDER_ADDRESS, EMAIL_FROM_ADDRESS, UNSUBSCRIBE_PATH } from "~/lib/constants";

import type { Rendered } from "capsomer/email";

import { renderFoxhoundEmail } from "./templates";
import type { EmailAudience, EmailJob } from "./types";
import { isValidReplyToEmail } from "~/lib/settings/reply-to";

// THE ONE send module (ARCHITECTURE.md non-negotiable #3: only this file touches
// the EMAIL binding). Everything else enqueues a job; the queue consumer calls
// through here. Message construction is pure and unit-tested; the binding call is
// the single seam finalized when Email Service is live (Phase 8).
//
// THE FRAME (J02, RULES.md 3.16). Every message is rendered by templates.ts on
// Capsomer's shared email component, which gives an HTML part and a plain-text
// part from the same content. Both functions below go through it, so no mail
// leaves without both parts. A body link the frame refuses is kept as words; a
// refused URL Foxhound supplies itself (the unsubscribe base URL, tracking)
// throws from the render, before the binding is reached, and the throw is left
// to propagate exactly like the CAN-SPAM guards below.

// Legacy's From fallback, verbatim: `merchant.sender_name || 'Support'` in
// lib/recovery-execution.ts:197, and the same string again in its test-email
// route. It was "Billing" here, which no legacy surface produces.
const DEFAULT_FROM_NAME = "Support";

/** Escape a display name for use in a From header, stripping quotes and controls. */
function fromDisplayName(name: string | null | undefined): string {
  const cleaned = (name ?? DEFAULT_FROM_NAME).replace(/["\r\n]/g, "").trim();
  return cleaned.length > 0 ? cleaned : DEFAULT_FROM_NAME;
}

/**
 * Build the ready-to-send message from a job. Pure. Enforces CAN-SPAM
 * (ARCHITECTURE.md non-negotiable #8): a merchant-customer send MUST carry a
 * physical postal address and a one-click unsubscribe. Missing either throws, so
 * a non-compliant send can never reach the binding.
 */
export function buildEmailMessage(job: EmailJob, baseUrl: string): EmailSendMessage {
  // FAIL CLOSED: an absent audience is treated as the customer case, so a job
  // that forgets the field gets the CAN-SPAM guard rather than skipping it.
  const audience: EmailAudience = job.audience ?? "customer";

  // Merchant mail is platform-to-our-own-user mail: no postal footer, no
  // unsubscribe, exactly as sendTransactionalEmail already does and exactly as
  // legacy sends its merchant notification. See the EmailAudience doc for why an
  // unsubscribe there would be actively harmful.
  let unsubUrl: string | null = null;
  if (audience === "customer") {
    if (!job.physicalAddress || !job.physicalAddress.trim()) {
      throw new Error("email blocked: missing CAN-SPAM physical address");
    }
    if (!job.unsubscribeToken || !job.unsubscribeToken.trim()) {
      throw new Error("email blocked: missing unsubscribe token");
    }
    unsubUrl = `${baseUrl}${UNSUBSCRIBE_PATH}/${encodeURIComponent(job.unsubscribeToken)}`;
  }

  const fromName = fromDisplayName(job.fromName);
  // On customer mail the CAN-SPAM lines go in Capsomer's footer slot, under its
  // "This message was sent to" line: the one-click unsubscribe link, then the
  // postal address. The text part carries both, the link on its own line. A
  // job's footer note (Recova's "You're receiving this from" sentence on
  // recovery mail, J85) goes first in the slot.
  //
  // Preview mail (E3) puts only its note in the slot: Recova's preview footer
  // sentence, with no unsubscribe and no postal address, as Recova's has none.
  const note = job.footerNote ? [job.footerNote] : [];
  const rendered = renderFoxhoundEmail({
    subject: job.subject,
    bodyHtml: job.bodyHtml,
    brandName: fromName,
    to: job.to,
    footer: unsubUrl
      ? [...note, { text: "Unsubscribe", url: unsubUrl }, job.physicalAddress]
      : audience === "preview" && note.length > 0
        ? note
        : undefined,
    tracking: job.tracking,
  });
  const message: EmailSendMessage = {
    from: `${fromName} <${EMAIL_FROM_ADDRESS}>`,
    to: job.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
  // REPLY-TO (J03): a customer who replies reaches the merchant's own inbox,
  // from Recova's `replyTo: replyTo ?? fromAddress` (lib/recovery-execution.ts).
  // Customer mail, and the preview of it (E3), as in Recova, whose test-email
  // route passes the same reply_to_email; its merchant notices carry none.
  //
  // SET ONLY WHEN THE MERCHANT SAVED AN ADDRESS, a bare one. Recova's fallback
  // to the From changes nothing for the recipient (a reply goes to the From
  // either way), and it would put a "Name <addr>" string on every customer
  // email that the binding has not been shown live to accept. A stored value
  // that is not exactly one address (a line break would be a header
  // injection) is dropped the same way rather than reaching the binding.
  if (audience === "customer" || audience === "preview") {
    const replyTo = job.replyTo?.trim() ?? "";
    if (replyTo && isValidReplyToEmail(replyTo)) message.replyTo = replyTo;
  }
  if (unsubUrl) {
    message.headers = {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }
  return message;
}

/**
 * Send one message through the Email Service binding. The single binding seam;
 * throws if the binding is not configured (Dustin provisions it). Returns the
 * provider message id when the binding surfaces one.
 */
export async function sendEmail(
  env: Env,
  job: EmailJob,
): Promise<{ providerMessageId: string | null }> {
  if (!env.EMAIL) {
    throw new Error("EMAIL binding is not configured");
  }
  const baseUrl = env.BETTER_AUTH_URL ?? "";
  const message = buildEmailMessage(job, baseUrl);
  const result = await env.EMAIL.send(message);
  return { providerMessageId: (result && "id" in result ? result.id : null) ?? null };
}

/**
 * Send a TRANSACTIONAL platform email (auth verification, alerts, the audit) through
 * the same single binding seam. Transactional platform mail to our own users is
 * NOT commercial mail, so it deliberately carries no CAN-SPAM unsubscribe/postal
 * footer (you cannot unsubscribe from a password reset). Still the only path to
 * the binding: keeps "one send module" intact. Throws if the binding is
 * unconfigured, so a send failure surfaces rather than silently dropping.
 */
export async function sendTransactionalEmail(
  env: Env,
  message: { to: string; subject: string; bodyHtml: string; fromName?: string | null },
): Promise<{ providerMessageId: string | null }> {
  const { fromName, rendered } = renderTransactional(message);
  const sent = await sendThroughAuthSender(env, { to: message.to, rendered, fromName });
  // Same behaviour as before the shared seam: a missing binding and a provider
  // throw both reach the caller as throws, the provider's own error unchanged.
  if (sent.status === "sent") return { providerMessageId: sent.providerMessageId };
  if (sent.reason === "email_binding_missing") throw new Error("EMAIL binding is not configured");
  throw sent.cause;
}

/** The From name and the rendered parts of a transactional mail. Pure. */
function renderTransactional(message: { to: string; subject: string; bodyHtml: string; fromName?: string | null }): {
  fromName: string;
  rendered: Rendered;
} {
  const fromName = fromDisplayName(message.fromName ?? "Foxhound");
  const rendered = renderFoxhoundEmail({
    subject: message.subject,
    bodyHtml: message.bodyHtml,
    brandName: fromName,
    to: message.to,
  });
  return { fromName, rendered };
}

/** The auth sender's message for already-rendered mail, exactly as
 *  sendThroughAuthSender hands it to the binding. Pure. */
function authSenderMessage(to: string, rendered: Rendered, fromName: string): EmailSendMessage {
  return {
    from: `${fromName} <${EMAIL_AUTH_SENDER_ADDRESS}>`,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
}

/**
 * The message sendTransactionalEmail would hand the binding, built without
 * sending. Pure. For the admin preview (app/lib/admin/email-send.server.ts), so
 * a preview is the same function's output and not a copy of it.
 */
export function buildTransactionalMessage(message: {
  to: string;
  subject: string;
  bodyHtml: string;
  fromName?: string | null;
}): EmailSendMessage {
  const { fromName, rendered } = renderTransactional(message);
  return authSenderMessage(message.to, rendered, fromName);
}

/** The message sendRenderedTransactionalEmail would hand the binding. Pure. */
export function buildRenderedTransactionalMessage(message: { to: string; rendered: Rendered }): EmailSendMessage {
  return authSenderMessage(message.to, message.rendered, "Foxhound");
}

type BindingSendResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; reason: "email_binding_missing" }
  | { status: "failed"; reason: "provider_error"; cause: unknown };

/** The one place transactional mail meets env.EMAIL: the auth sender's From,
 *  no headers, and the provider's message id when it gives one. Never throws. */
async function sendThroughAuthSender(
  env: Env,
  message: { to: string; rendered: Rendered; fromName: string },
): Promise<BindingSendResult> {
  if (!env.EMAIL) return { status: "failed", reason: "email_binding_missing" };
  try {
    const result = await env.EMAIL.send(authSenderMessage(message.to, message.rendered, message.fromName));
    return { status: "sent", providerMessageId: (result && "id" in result ? result.id : null) ?? null };
  } catch (cause) {
    return { status: "failed", reason: "provider_error", cause };
  }
}

/**
 * What a transactional send that does not throw comes back with. The names
 * reuse email_sends' statuses ("sent", "failed"); `reason` says which refusal.
 */
export type TransactionalSendOutcome =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; reason: "email_binding_missing" | "provider_error"; error: string | null };

/**
 * Send a transactional mail that is already rendered (the password reset, on
 * Capsomer's reset template, J82) through the same seam as
 * sendTransactionalEmail: From "Foxhound" at the auth sender, no footer, no
 * unsubscribe, no tracking. It never throws: a refusal comes back named. Every
 * string in `redact` (the reset link, its token, the recipient) is cut out of a
 * provider's error before it is returned, so a provider that echoes the message
 * cannot put the link into a log.
 */
export async function sendRenderedTransactionalEmail(
  env: Env,
  message: { to: string; rendered: Rendered; redact?: string[] },
): Promise<TransactionalSendOutcome> {
  const sent = await sendThroughAuthSender(env, { to: message.to, rendered: message.rendered, fromName: "Foxhound" });
  if (sent.status === "sent") return sent;
  if (sent.reason === "email_binding_missing") return { status: "failed", reason: sent.reason, error: null };
  let error = sent.cause instanceof Error ? sent.cause.message : String(sent.cause);
  for (const secret of message.redact ?? []) {
    if (secret) error = error.split(secret).join("[redacted]");
  }
  return { status: "failed", reason: "provider_error", error };
}
