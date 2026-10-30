import { escapeHtml } from "capsomer/email";

import { processEmailJob } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";
import { redactSecrets } from "~/lib/email/send";
import { recoveryFooterNote } from "~/lib/email/templates";
import type { EmailJob } from "~/lib/email/types";

// E2, the team invite email, ported from Recova's app/api/invite/route.ts
// (blob 960aefc6, 3735 bytes, read whole with lib/email.ts 3f882729,
// lib/email-colors.ts 8c23bd6f, lib/constants.ts a21b32b8 and
// lib/resend-retry.ts adcda147).
//
// WHAT RECOVA SENDS, after the pending account_members row is written, on every
// invite, with no toggle, to the address the owner entered:
//   From      FROM_RECOVERY, "Recova <recovery@...>"; no Reply-To
//   Subject   "You've been invited to join Recova"
//   Body      "You've been invited to join <strong>{account name || 'a team'}
//             </strong> on Recova.", an "Accept Invite" button to the invite
//             link, then "This invite expires in 7 days." in small muted type
//   Footer    wrapEmailHtml's, with no unsubscribe token: "You're receiving
//             this from {primary connection's sender_name || 'Recova'} about a
//             recent payment. (c) {year}", then "Manage email settings"
//   No heading, no unsubscribe, no postal address, no tracking.
// Foxhound sends the same words with Foxhound's name, on Capsomer's email
// component in amber with a text part beside the HTML, to the approved
// /invite/:token link (APPROVED-DIFFERENCES, Sign-in and invites, 2026-09-19).
//
// IT IS MERCHANT MAIL: our own user's teammate, not a
// merchant's customer, so no unsubscribe and no postal footer. Its footer note
// is Recova's sentence, which the merchant audience writes with "Manage email
// settings" after it, as wrapEmailHtml does (E10). It goes through
// processEmailJob, so it passes the suppression gate and writes an email_sends
// row for whatever happens. The live-send gate does not hold it
// (liveSendGate "skip"), as Recova's route has no such switch, and the invite
// reaches no customer.
//
// THE ONE DIFFERENCE IN BEHAVIOR. Recova logs a failed send and still answers
// success, so its page says "Invite sent" when nothing was sent. Foxhound
// returns the named outcome and the page says so (RULES.md 3.16; truthfulness,
// RULES.md 1.2). The invite itself stands either way, as in Recova.

/** Recova's FROM_RECOVERY name, Foxhound-branded. */
const TEAM_INVITE_FROM_NAME = "Foxhound";
/** Recova's subject, Foxhound-branded. */
const TEAM_INVITE_SUBJECT = "You've been invited to join Foxhound";
/** email_sends.template of the team invite. */
const TEAM_INVITE_TEMPLATE = "team_invite";
/** Recova's words for an account with no name. */
const TEAM_NAME_FALLBACK = "a team";
/** Recova's footer sender fallback (`sender_name || 'Recova'`), Foxhound-branded. */
const FOOTER_SENDER_FALLBACK = "Foxhound";

/** The subject and body of the invite. Pure. The team name is escaped: it is
 *  the merchant's own text, and the body is read as HTML. */
export function buildTeamInviteCopy(
  accountName: string | null | undefined,
  inviteUrl: string,
): { subject: string; bodyHtml: string } {
  const team = escapeHtml(accountName?.trim() || TEAM_NAME_FALLBACK);
  return {
    subject: TEAM_INVITE_SUBJECT,
    bodyHtml: [
      // No heading, as Recova's mail has none. Recova bolds the team name;
      // Capsomer has no bold run, so the name is plain text here.
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
  /** The primary live connection's sender name, for Recova's footer line. */
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
 * Email one invite. Never throws: a refusal, and a database error on the way,
 * come back as a named outcome, because the invite is already
 * written and the merchant still has its link on the page.
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
      error: redactSecrets(err instanceof Error ? err.message : String(err), job.redact),
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
