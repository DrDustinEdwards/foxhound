import { escapeHtml } from "capsomer/email";

import { processEmailJob, TEAM_INVITE_TEMPLATE } from "~/lib/email/dispatch";
import type { EmailJobResult } from "~/lib/email/dispatch";
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
//   No unsubscribe, no postal address, no tracking.
// Foxhound sends the same words with Foxhound's name, on Capsomer's email
// component in teal with a text part beside the HTML (J02), to the approved
// /invite/:token link (APPROVED-DIFFERENCES, Sign-in and invites, 2026-09-19).
//
// IT IS MERCHANT MAIL (RULES.md 3.16): our own user's teammate, not a
// merchant's customer, so no unsubscribe and no postal footer. It goes through
// processEmailJob, so it passes the suppression gate and writes an email_sends
// row for whatever happens. The live-send gate does not hold it
// (heldByLiveSendGate), as Recova's route has no such switch.
//
// THE ONE DIFFERENCE IN BEHAVIOUR. Recova logs a failed send and still answers
// success, so its page says "Invite sent" when nothing was sent. Foxhound
// returns the named outcome and the page says so (RULES.md 3.16; truthfulness,
// RULES.md 1.2). The invite itself stands either way, as in Recova.

/** Recova's FROM_RECOVERY name, Foxhound-branded. */
export const TEAM_INVITE_FROM_NAME = "Foxhound";
/** Recova's subject, Foxhound-branded. */
export const TEAM_INVITE_SUBJECT = "You've been invited to join Foxhound";
/** Recova's words for an account with no name. */
const TEAM_NAME_FALLBACK = "a team";

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
      // The invitation is the mail's one heading (WCAG 2.2 AA, the job's
      // check): Recova's mail has none, and this is its first sentence in its
      // own words. Capsomer has no bold run, so the team name is plain text in
      // it; the heading's weight carries what Recova's <strong> did.
      `<h1>You've been invited to join <strong>${team}</strong> on Foxhound.</h1>`,
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
}): EmailJob {
  return {
    accountId: input.accountId,
    to: input.to,
    fromName: TEAM_INVITE_FROM_NAME,
    ...buildTeamInviteCopy(input.accountName, input.inviteUrl),
    template: TEAM_INVITE_TEMPLATE,
    audience: "merchant",
    // Merchant mail carries neither (EmailAudience "merchant").
    unsubscribeToken: "",
    physicalAddress: "",
    idempotencyKey: `team-invite:${input.memberId}`,
    cronRunId: null,
  };
}

/**
 * Email one invite. Never throws: a refusal, and a database error on the way,
 * come back as a named outcome (RULES.md 3.16), because the invite is already
 * written and the merchant still has its link on the page.
 */
export async function sendTeamInviteEmail(
  env: Env,
  input: Parameters<typeof buildTeamInviteJob>[0],
): Promise<EmailJobResult> {
  try {
    return await processEmailJob(env, buildTeamInviteJob(input), null);
  } catch (err) {
    return {
      status: "failed",
      providerMessageId: null,
      error: err instanceof Error ? err.message : String(err),
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
