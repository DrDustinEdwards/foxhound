import { appOrigin } from "~/lib/app-origin";
import { renderSignInLinkEmail } from "~/lib/auth/send-auth-email";
import { CRON_SCHEDULE_DAILY } from "~/lib/constants";
import {
  buildFailureAlertEmail,
  buildStaleAlertEmail,
  emailFailedAlertMessage,
  renderCronAlertEmail,
} from "~/lib/cron/alerts.server";
import {
  buildEmailMessage,
  buildRenderedTransactionalMessage,
  buildTransactionalMessage,
  sendJobEmail,
  sendRenderedTransactionalEmail,
  sendTransactionalEmail,
} from "~/lib/email/send";
import { SendGates } from "~/lib/email/dispatch";
import { errorMessage } from "@dustinedwards/site-runtime/log";

import type {
  AdminEmailAudience,
  AdminEmailType,
  PreparedEmail,
  PrepareInput,
} from "./email-catalog";
import { prepareCustomerEmail } from "./email-prepare-customer.server";
import { prepareMerchantEmail } from "./email-prepare-merchant.server";

// SEND OR PREVIEW ANY EMAIL, for the owner only (admin API routes /emails,
// /emails/preview and /emails/send). Dustin approved it on 2026-10-15, message
// cmsg_01Nd8kh3hkgYNYpWXrNkvBQLJoLik1xYvr9pCLcgZ3SSMJ, answering "ok" to:
// "build #1 and #2 together as one owner-only 'send or preview any email' tool
// behind your admin key". #1: after a deploy, send every email type to a test
// inbox to confirm delivery, links, unsubscribe and Reply-To. #2: render any
// email as a chosen merchant's customer would get it, without sending.

/**
 * Build one email exactly as its real sender builds it, with sample customer
 * data and the stand-in link. Throws, as the real path would, when a needed
 * secret is missing (the unsubscribe signing key).
 */
export async function prepareAdminEmail(env: Env, input: PrepareInput): Promise<PreparedEmail> {
  const { type, to, now } = input;
  const baseUrl = appOrigin(env);

  if (type.audience === "customer") {
    const prepared = await prepareCustomerEmail(env, input);
    if (prepared) return prepared;
  }

  if (type.audience === "merchant") {
    const prepared = await prepareMerchantEmail(env, input);
    if (prepared) return prepared;
  }

  if (type.type === "sign_in_link") {
    return {
      channel: "rendered",
      to,
      rendered: renderSignInLinkEmail(to, `${baseUrl}/login`, "000000"),
    };
  }
  // The operations mail, built by its own functions and rendered for the
  // caller's inbox instead of the support inbox (SUPPORT_EMAIL).
  if (type.type === "cron_failure") {
    const message = buildFailureAlertEmail(
      {
        cronName: "recovery-tick",
        runId: "run_sample",
        error: "Sample failure: D1_ERROR: database is locked",
        stack: null,
        lastSuccessAt: new Date(now.getTime() - 3_600_000),
      },
      now,
    );
    return { channel: "rendered", to, rendered: renderCronAlertEmail(to, message, baseUrl, now) };
  }
  if (type.type === "cron_stale") {
    const message = buildStaleAlertEmail(
      {
        cronName: "retention",
        lastRunAt: new Date(now.getTime() - 3 * 86_400_000),
        schedule: CRON_SCHEDULE_DAILY,
      },
      now,
    );
    return { channel: "rendered", to, rendered: renderCronAlertEmail(to, message, baseUrl, now) };
  }
  if (type.type === "email_failed_alert") {
    return {
      channel: "transactional",
      to,
      ...emailFailedAlertMessage(
        { accountId: "acct_sample", stepId: "step_sample", attempts: 5 },
        now,
      ),
    };
  }
  throw new Error(`no builder for ${type.type}`);
}

export interface EmailPreview {
  type: string;
  audience: AdminEmailAudience;
  from: string;
  to: string;
  reply_to: string | null;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

/**
 * The message the send module would hand the binding, without sending. Pure.
 */
export function previewAdminEmail(
  env: Env,
  type: AdminEmailType,
  prepared: PreparedEmail,
): EmailPreview {
  const message =
    prepared.channel === "job"
      ? buildEmailMessage({ ...prepared.job }, appOrigin(env))
      : prepared.channel === "rendered"
        ? buildRenderedTransactionalMessage({ to: prepared.to, rendered: prepared.rendered })
        : buildTransactionalMessage(prepared);
  return {
    type: type.type,
    audience: type.audience,
    from: message.from,
    to: message.to,
    reply_to: message.replyTo ?? null,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers ?? {},
  };
}

type AdminSendStatus = "sent" | "suppressed" | "failed";

export interface AdminSendResult {
  type: string;
  status: AdminSendStatus;
  provider_message_id: string | null;
  error: string | null;
}

/** Send one prepared email through the send module. Never throws. */
export async function sendAdminEmail(
  env: Env,
  type: AdminEmailType,
  prepared: PreparedEmail,
): Promise<AdminSendResult> {
  const done = (
    status: AdminSendStatus,
    providerMessageId: string | null = null,
    error: string | null = null,
  ): AdminSendResult => ({
    type: type.type,
    status,
    provider_message_id: providerMessageId,
    error,
  });
  try {
    if (prepared.channel === "job") {
      // The suppression gate every real customer and merchant send passes.
      const gates = await SendGates.read(env, [prepared.job]);
      if (gates.suppressed(prepared.job)) return done("suppressed");
      const { providerMessageId } = await sendJobEmail(env, prepared.job);
      return done("sent", providerMessageId);
    }
    if (prepared.channel === "transactional") {
      const { providerMessageId } = await sendTransactionalEmail(env, prepared);
      return done("sent", providerMessageId);
    }
    const outcome = await sendRenderedTransactionalEmail(env, {
      to: prepared.to,
      rendered: prepared.rendered,
      redact: [prepared.to],
    });
    return outcome.status === "sent"
      ? done("sent", outcome.providerMessageId)
      : done("failed", null, outcome.error ?? outcome.reason);
  } catch (err) {
    return done("failed", null, errorMessage(err));
  }
}
