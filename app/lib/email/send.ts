import { EMAIL_AUTH_SENDER_ADDRESS, EMAIL_FROM_ADDRESS, UNSUBSCRIBE_PATH } from "~/lib/constants";

import { renderFoxhoundEmail } from "./templates";
import type { EmailAudience, EmailJob } from "./types";

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
  // postal address. The text part carries both, the link on its own line.
  const rendered = renderFoxhoundEmail({
    subject: job.subject,
    bodyHtml: job.bodyHtml,
    brandName: fromName,
    to: job.to,
    footer: unsubUrl ? [{ text: "Unsubscribe", url: unsubUrl }, job.physicalAddress] : undefined,
    tracking: job.tracking,
  });
  const message: EmailSendMessage = {
    from: `${fromName} <${EMAIL_FROM_ADDRESS}>`,
    to: job.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
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
 * Send a TRANSACTIONAL platform email (auth verification, password reset) through
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
  if (!env.EMAIL) {
    throw new Error("EMAIL binding is not configured");
  }
  const fromName = fromDisplayName(message.fromName ?? "Foxhound");
  const rendered = renderFoxhoundEmail({
    subject: message.subject,
    bodyHtml: message.bodyHtml,
    brandName: fromName,
    to: message.to,
  });
  const result = await env.EMAIL.send({
    from: `${fromName} <${EMAIL_AUTH_SENDER_ADDRESS}>`,
    to: message.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
  return { providerMessageId: (result && "id" in result ? result.id : null) ?? null };
}
