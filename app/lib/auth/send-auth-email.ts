import { SIGN_IN_EXPIRES_IN_WORDS, type NoticeDetail } from "@dustinedwards/site-runtime/sign-in";
import type { Rendered } from "capsomer/email";

import { sendRenderedTransactionalEmail, type TransactionalSendOutcome } from "~/lib/email/send";
import {
  renderFoxhoundEmailChangeEmail,
  renderFoxhoundSecurityNoticeEmail,
  renderFoxhoundSignInLinkEmail,
} from "~/lib/email/templates";

// The sign-in link and its code, the security notice, and the two mails of an
// email change: the family sign-in (site-runtime ./sign-in) has no passwords,
// so there is no reset mail. The code is for the tab that asked, when the link opens
// in another browser (the mail app's, a phone). Sent
// through the ONE email send module on the Cloudflare EMAIL binding
// (ARCHITECTURE.md #3). It is platform mail to our own users, so it carries no
// CAN-SPAM unsubscribe footer (transactional, not commercial). The link and
// the code each sign in, so they are NEVER logged; they go only into the body.

/** The sign-in link as sendSignInLinkEmail sends it, on Capsomer's magic-link
 *  template in its own words, with the family sign-in's expiry. Pure; throws
 *  on a link Capsomer refuses. The admin preview reads it. */
export function renderSignInLinkEmail(to: string, url: string, code: string): Rendered {
  return renderFoxhoundSignInLinkEmail({ to, url, code, expiresIn: SIGN_IN_EXPIRES_IN_WORDS });
}

export type SignInLinkOutcome =
  | TransactionalSendOutcome
  | { status: "failed"; reason: "link_refused" | "render_failed"; error: null };

/**
 * Send the sign-in link and code to `to`, carrying Better Auth's `url`
 * untouched. `token` and `code` are the ones site-runtime's sendMagicLink hook
 * hands over. Never throws;
 * every refusal comes back by name:
 *   - link_refused: the link is not https:, which Capsomer refuses, so nothing
 *     is sent. Production's BETTER_AUTH_URL is https.
 *   - render_failed: any other throw from the render; nothing is sent.
 *   - email_binding_missing: no EMAIL binding.
 *   - provider_error: the binding threw; its message comes back with the link,
 *     the token, the code and the recipient cut out.
 * The link is never logged here, and never put in an error.
 */
export async function sendSignInLinkEmail(
  env: Env,
  link: { to: string; url: string; token: string; code: string },
): Promise<SignInLinkOutcome> {
  const { to, url, token, code } = link;
  let rendered: Rendered;
  try {
    rendered = renderSignInLinkEmail(to, url, code);
  } catch {
    return { status: "failed", reason: isHttps(url) ? "render_failed" : "link_refused", error: null };
  }
  return sendRenderedTransactionalEmail(env, { to, rendered, redact: [url, token, code, to] });
}

/** Where a merchant manages how they sign in; the notice's button opens it. */
const SIGN_IN_SETTINGS_PATH = "/settings/account";

/**
 * Mail a security notice (a passkey added, a session ended, ...) to `to`, the
 * way the sign-in link goes. site-runtime calls this after the change is made
 * and logs a throw as `security_notice_failed` without undoing the change, so a
 * refusal is thrown by name, with the recipient cut out of the provider's words.
 */
export async function sendSecurityNoticeEmail(env: Env, to: string, detail: NoticeDetail): Promise<void> {
  const rendered = renderFoxhoundSecurityNoticeEmail(to, detail, `${env.BETTER_AUTH_URL}${SIGN_IN_SETTINGS_PATH}`);
  const sent = await sendRenderedTransactionalEmail(env, { to, rendered, redact: [to] });
  if (sent.status !== "sent") {
    throw new Error(`security notice email not sent: ${sent.reason}${sent.error ? ` (${sent.error})` : ""}`);
  }
}

/** How long each email-change link works: Better Auth's emailVerification
 *  expiresIn, and the words the mails say. */
export const EMAIL_CHANGE_EXPIRES_IN_SECONDS = 60 * 60;
const EMAIL_CHANGE_EXPIRES_IN_WORDS = "1 hour";

/** Which step of an email change a link confirms: "confirmed" from the current
 *  address, which then mails the new one; "changed" from the new address,
 *  which makes the change. */
type EmailChangeStep = "confirmed" | "changed";

/** The page an email-change link opens (app/routes/auth/email-confirm.tsx).
 *  Better Auth's own link is a GET that acts, so a mail scanner opening every
 *  link would confirm the change for the person; this page acts only on its
 *  button's POST, as /sign-in/confirm does for the sign-in link. Only the
 *  token is carried over from Better Auth's URL. */
function emailChangeConfirmURL(env: Env, token: string, step: EmailChangeStep): string {
  const url = new URL("/email/confirm", env.BETTER_AUTH_URL);
  url.searchParams.set("token", token);
  url.searchParams.set("step", step);
  return url.toString();
}

/**
 * Mail the CURRENT address to confirm a change to `newEmail` (E1). Better
 * Auth calls this from /change-email; `url` is its own link, never sent or
 * logged, and the mail carries the confirm page's link with the same token.
 * A refused send is thrown by name, as the sign-in link's is.
 */
export async function sendEmailChangeConfirmation(
  env: Env,
  change: { to: string; newEmail: string; url: string; token: string },
): Promise<void> {
  const link = emailChangeConfirmURL(env, change.token, "confirmed");
  const rendered = renderFoxhoundEmailChangeEmail({
    to: change.to,
    url: link,
    expiresIn: EMAIL_CHANGE_EXPIRES_IN_WORDS,
    copy: {
      subject: "Confirm the change to your Foxhound email address",
      heading: "Change your email address?",
      intro: `Someone signed in to Foxhound asked to change this account's address from ${change.to} to ${change.newEmail}. Confirm it here, and we then send a link to the new address to finish.`,
      button: "Confirm the change",
      ignore: "If this was not you, do not confirm it, and sign out your other devices from Foxhound's account settings. Your address stays as it is.",
    },
  });
  await sendOrThrow(env, change.to, rendered, [change.url, change.token, link, change.newEmail]);
}

/** Mail the NEW address the link that makes the change, once the current one
 *  has confirmed it. Better Auth's sendVerificationEmail; /send-verification-
 *  email is off (auth.server.ts), so an email change is the only caller. */
export async function sendNewEmailVerification(env: Env, change: { to: string; url: string; token: string }): Promise<void> {
  const link = emailChangeConfirmURL(env, change.token, "changed");
  const rendered = renderFoxhoundEmailChangeEmail({
    to: change.to,
    url: link,
    expiresIn: EMAIL_CHANGE_EXPIRES_IN_WORDS,
    copy: {
      subject: "Confirm your new Foxhound email address",
      heading: "Confirm your new email address",
      intro: `Confirm ${change.to} as the address you sign in to Foxhound with.`,
      button: "Confirm email address",
      ignore: "If you did not ask for this, ignore this message. Nothing changes.",
    },
  });
  await sendOrThrow(env, change.to, rendered, [change.url, change.token, link]);
}

async function sendOrThrow(env: Env, to: string, rendered: Rendered, secrets: string[]): Promise<void> {
  const sent = await sendRenderedTransactionalEmail(env, { to, rendered, redact: [...secrets, to] });
  if (sent.status !== "sent") {
    throw new Error(`email change mail not sent: ${sent.reason}${sent.error ? ` (${sent.error})` : ""}`);
  }
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
