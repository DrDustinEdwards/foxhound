import { SIGN_IN_EXPIRES_IN_WORDS, type NoticeDetail } from "@dustinedwards/site-runtime/sign-in";
import type { Rendered } from "capsomer/email";

import { sendRenderedTransactionalEmail, type TransactionalSendOutcome } from "~/lib/email/send";
import { renderFoxhoundSecurityNoticeEmail, renderFoxhoundSignInLinkEmail } from "~/lib/email/templates";

// The sign-in link and its code, and the security notice: the family sign-in
// (site-runtime ./sign-in) has no passwords, so there is no reset or
// verification mail. The code is for the tab that asked, when the link opens
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
export const SIGN_IN_SETTINGS_PATH = "/settings/account";

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

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
