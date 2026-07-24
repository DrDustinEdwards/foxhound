import { EMAIL_AUTH_SENDER_ADDRESS, EMAIL_FROM_ADDRESS, UNSUBSCRIBE_PATH } from "~/lib/constants";

import type { EmailJob } from "./types";

// THE ONE send module (ARCHITECTURE.md non-negotiable #3: only this file touches
// the EMAIL binding). Everything else enqueues a job; the queue consumer calls
// through here. Message construction is pure and unit-tested; the binding call is
// the single seam finalized when Email Service is live (Phase 8).

const DEFAULT_FROM_NAME = "Billing";

/** Escape the few characters that would break an HTML attribute/text context. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  if (!job.physicalAddress || !job.physicalAddress.trim()) {
    throw new Error("email blocked: missing CAN-SPAM physical address");
  }
  if (!job.unsubscribeToken || !job.unsubscribeToken.trim()) {
    throw new Error("email blocked: missing unsubscribe token");
  }
  const unsubUrl = `${baseUrl}${UNSUBSCRIBE_PATH}/${encodeURIComponent(job.unsubscribeToken)}`;
  const footer =
    `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">` +
    `<p style="font-size:12px;color:#888">` +
    `<a href="${escapeHtml(unsubUrl)}">Unsubscribe</a><br>${escapeHtml(job.physicalAddress)}` +
    `</p>`;
  return {
    from: `${fromDisplayName(job.fromName)} <${EMAIL_FROM_ADDRESS}>`,
    to: job.to,
    subject: job.subject,
    html: `${job.bodyHtml}${footer}`,
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
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
  const result = await env.EMAIL.send({
    from: `${fromDisplayName(message.fromName ?? "Foxhound")} <${EMAIL_AUTH_SENDER_ADDRESS}>`,
    to: message.to,
    subject: message.subject,
    html: message.bodyHtml,
  });
  return { providerMessageId: (result && "id" in result ? result.id : null) ?? null };
}
