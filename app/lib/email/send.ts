import { appOrigin } from "~/lib/app-origin";
import {
  EMAIL_AUTH_SENDER_ADDRESS,
  EMAIL_FROM_ADDRESS,
  UNSUBSCRIBE_PATH,
} from "~/lib/email/constants";

import { sendEmail as send } from "@dustinedwards/site-runtime/email";
import type { Rendered } from "capsomer/email";

import { manageEmailSettingsLine, renderFoxhoundEmail } from "./templates";
import type { EmailAudience, OutboundEmailJob } from "./types";
import { isValidReplyToEmail } from "~/lib/settings/reply-to";

// The one send module: only this file touches the EMAIL binding. Every message is rendered by templates.ts
// on Capsomer's email component (HTML and text parts from the same content). A refused URL Foxhound
// supplies itself throws from the render, before the binding, like the CAN-SPAM guards below.

const DEFAULT_FROM_NAME = "Support";

function fromDisplayName(name: string | null | undefined): string {
  const cleaned = (name ?? DEFAULT_FROM_NAME).replace(/["\r\n]/g, "").trim();
  return cleaned.length > 0 ? cleaned : DEFAULT_FROM_NAME;
}

/** Build the message from a job. Pure. A merchant-customer send must carry a postal address and a
 *  one-click unsubscribe; missing either throws, so a non-compliant send never reaches the binding. */
export function buildEmailMessage(job: OutboundEmailJob, baseUrl: string): EmailSendMessage {
  // Fail closed: an absent audience is the customer case, so it gets the CAN-SPAM guard.
  const audience: EmailAudience = job.audience ?? "customer";

  // Merchant mail carries no postal footer or unsubscribe (see EmailAudience); the weekly digest takes both guards.
  let unsubUrl: string | null = null;
  if (audience === "customer" || audience === "digest") {
    if (!job.physicalAddress || !job.physicalAddress.trim()) {
      throw new Error("email blocked: missing CAN-SPAM physical address");
    }
    if (!job.unsubscribeToken || !job.unsubscribeToken.trim()) {
      throw new Error("email blocked: missing unsubscribe token");
    }
    unsubUrl = `${baseUrl}${UNSUBSCRIBE_PATH}/${encodeURIComponent(job.unsubscribeToken)}`;
  }

  const fromName = fromDisplayName(job.fromName);
  // Customer mail: the footer note, then the unsubscribe link, then the postal address. Preview: note only.
  // Digest: as customer. Merchant: note then "Manage email settings"; no note, no footer line.
  const note = job.footerNote ? [job.footerNote] : [];
  const footer = unsubUrl
    ? [...note, { text: "Unsubscribe", url: unsubUrl }, job.physicalAddress]
    : note.length > 0 && audience === "preview"
      ? note
      : note.length > 0 && audience === "merchant"
        ? [...note, manageEmailSettingsLine(baseUrl)]
        : undefined;
  const frame = {
    subject: job.subject,
    brandName: fromName,
    to: job.to,
    footer,
    tracking: job.tracking,
  };
  const rendered = renderFoxhoundEmail(
    job.notice
      ? { ...frame, notice: job.notice }
      : job.blocks
        ? { ...frame, blocks: job.blocks }
        : { ...frame, bodyHtml: job.bodyHtml },
  );
  const message: EmailSendMessage = {
    from: `${fromName} <${EMAIL_FROM_ADDRESS}>`,
    to: job.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
  // Reply-To only when the merchant saved exactly one bare address; anything else (a line break would be
  // header injection) is dropped before the binding.
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

/** Send one message through the Email Service binding. Throws when not sent. Returns the message id,
 *  which bounce events carry as payload.messageId (events.ts). */
export async function sendJobEmail(
  env: Env,
  job: OutboundEmailJob,
): Promise<{ providerMessageId: string | null }> {
  if (!env.EMAIL) {
    throw new Error("EMAIL binding is not configured");
  }
  const baseUrl = appOrigin(env);
  const sent = await send(env.EMAIL, buildEmailMessage(job, baseUrl), { secrets: job.redact });
  if (!sent.sent) throw new Error(sent.error);
  return { providerMessageId: sent.messageId };
}

/** Send transactional platform mail (auth, cron alerts) through the same binding seam. Not commercial,
 *  so no unsubscribe or postal footer. Throws if the binding is unconfigured. */
export async function sendTransactionalEmail(
  env: Env,
  message: { to: string; subject: string; bodyHtml: string; fromName?: string | null },
): Promise<{ providerMessageId: string | null }> {
  const { fromName, rendered } = renderTransactional(message);
  const sent = await sendThroughAuthSender(env, { to: message.to, rendered, fromName });
  if (sent.status === "sent") return { providerMessageId: sent.providerMessageId };
  throw new Error(sent.error ?? "EMAIL binding is not configured");
}

function renderTransactional(message: {
  to: string;
  subject: string;
  bodyHtml: string;
  fromName?: string | null;
}): {
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

function authSenderMessage(to: string, rendered: Rendered, fromName: string): EmailSendMessage {
  return {
    from: `${fromName} <${EMAIL_AUTH_SENDER_ADDRESS}>`,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
}

export function buildTransactionalMessage(message: {
  to: string;
  subject: string;
  bodyHtml: string;
  fromName?: string | null;
}): EmailSendMessage {
  const { fromName, rendered } = renderTransactional(message);
  return authSenderMessage(message.to, rendered, fromName);
}

export function buildRenderedTransactionalMessage(message: {
  to: string;
  rendered: Rendered;
}): EmailSendMessage {
  return authSenderMessage(message.to, message.rendered, "Foxhound");
}

/** The one place transactional mail meets env.EMAIL. Never throws; `secrets` and the recipient are cut out of a refusal's error. */
async function sendThroughAuthSender(
  env: Env,
  message: { to: string; rendered: Rendered; fromName: string; secrets?: string[] },
): Promise<TransactionalSendOutcome> {
  if (!env.EMAIL) return { status: "failed", reason: "email_binding_missing", error: null };
  const sent = await send(
    env.EMAIL,
    authSenderMessage(message.to, message.rendered, message.fromName),
    { secrets: message.secrets },
  );
  if (sent.sent) return { status: "sent", providerMessageId: sent.messageId };
  return { status: "failed", reason: "provider_error", error: sent.error };
}

/** What a transactional send that does not throw returns; `reason` says which refusal. */
export type TransactionalSendOutcome =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; reason: "email_binding_missing" | "provider_error"; error: string | null };

/** Send already-rendered transactional mail (the password reset) through the same seam. Never throws:
 *  a refusal comes back named, with every `redact` string cut out of the error. */
export async function sendRenderedTransactionalEmail(
  env: Env,
  message: { to: string; rendered: Rendered; redact?: string[] },
): Promise<TransactionalSendOutcome> {
  return sendThroughAuthSender(env, {
    to: message.to,
    rendered: message.rendered,
    fromName: "Foxhound",
    secrets: message.redact,
  });
}
