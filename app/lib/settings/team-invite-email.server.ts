import { escapeHtml } from "@dustinedwards/site-runtime/html";

import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";
import { redact } from "@dustinedwards/site-runtime/email";
import { recoveryFooterNote } from "~/lib/email/templates";
import type { EmailJob } from "~/lib/email/types";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// (c) {year}", then "Manage email settings" No heading, no unsubscribe, no postal address, no
// tracking. Foxhound sends the same words with Foxhound's name, on Capsomer's email component in
// amber with a text part beside the HTML, to the approved /invite/:token link.

const TEAM_INVITE_FROM_NAME = "Foxhound";
const TEAM_INVITE_SUBJECT = "You've been invited to join Foxhound";
/** email_sends.template of the team invite. */
const TEAM_INVITE_TEMPLATE = "team_invite";
const TEAM_NAME_FALLBACK = "a team";
const FOOTER_SENDER_FALLBACK = "Foxhound";

/** The subject and body of the invite. Pure. The team name is escaped: it is
 *  the merchant's own text, and the body is read as HTML. */
function buildTeamInviteCopy(
  accountName: string | null | undefined,
  inviteUrl: string,
): { subject: string; bodyHtml: string } {
  const team = escapeHtml(accountName?.trim() || TEAM_NAME_FALLBACK);
  return {
    subject: TEAM_INVITE_SUBJECT,
    bodyHtml: [
      `<p>You've been invited to join ${team} on Foxhound.</p>`,
      `<p><a href="${escapeHtml(inviteUrl)}">Accept Invite</a></p>`,
      `<p><small>This invite expires in 7 days.</small></p>`,
    ].join("\n"),
  };
}

/** The invite as a job for the send module. Pure. */
export function buildTeamInviteJob(input: {
  accountId: string;
  to: string;
  accountName: string | null | undefined;
  inviteUrl: string;
  /** The pending membership's id: one invite, one email. */
  memberId: string;
  /** The invite's token, cut out of any stored provider error with the link. */
  token: string;
  senderName: string | null | undefined;
  /** The footer's copyright year. */
  year: number;
}): EmailJob {
  return {
    accountId: input.accountId,
    to: input.to,
    fromName: TEAM_INVITE_FROM_NAME,
    ...buildTeamInviteCopy(input.accountName, input.inviteUrl),
    template: TEAM_INVITE_TEMPLATE,
    audience: "merchant",
    footerNote: recoveryFooterNote(input.senderName?.trim() || FOOTER_SENDER_FALLBACK, input.year),
    liveSendGate: "skip",
    // Merchant mail carries neither (EmailAudience "merchant").
    unsubscribeToken: "",
    physicalAddress: "",
    idempotencyKey: `team-invite:${input.memberId}`,
    cronRunId: null,
    // The link signs nobody in, but it is a working invite to this account
    // until it is accepted or expires, so it never reaches email_sends.error.
    redact: [input.inviteUrl, input.token],
  };
}

/**
 * Email one invite. Never throws: a refusal, and a database error on the way, come back as a named
 * outcome, because the invite is already written and the merchant still has its link on the page.
 */
export async function sendTeamInviteEmail(
  env: Env,
  input: Parameters<typeof buildTeamInviteJob>[0],
): Promise<EmailJobResult> {
  const job = buildTeamInviteJob(input);
  try {
    return await processEmailJob(env, job, null);
  } catch (err) {
    return {
      status: "failed",
      providerMessageId: null,
      error: redact(errorMessage(err), job.redact),
      retryable: false,
    };
  }
}

/** What the team page tells the owner when the email did not go, by outcome.
 *  Null when it went. */
export function teamInviteEmailNotice(status: EmailJobResult["status"]): string | null {
  if (status === "sent") return null;
  if (status === "suppressed") {
    return "That address is on the do-not-email list, so the invite was not emailed. Share the link instead.";
  }
  return "Could not send the invite email. Share the link instead.";
}
