import type { Rendered } from "capsomer/email";

import { sendRenderedTransactionalEmail, type TransactionalSendOutcome } from "~/lib/email/send";
import { renderFoxhoundSignInLinkEmail } from "~/lib/email/templates";

// The sign-in link, the one auth email: the family sign-in (site-runtime
// ./sign-in) has no passwords, so there is no reset or verification mail. Sent
// through the ONE email send module on the Cloudflare EMAIL binding
// (ARCHITECTURE.md #3). It is platform mail to our own users, so it carries no
// CAN-SPAM unsubscribe footer (transactional, not commercial). The link is
// token-bearing and is NEVER logged; it goes only into the email body.

/** How long the link works: Better Auth's magic-link default (expiresIn 300 in
 *  better-auth's plugins/magic-link), which the family sign-in keeps. */
export const SIGN_IN_LINK_EXPIRES_IN_SECONDS = 5 * 60;

/** The sign-in link as sendSignInLinkEmail sends it, on Capsomer's magic-link
 *  template in its own words. Pure; throws on a link Capsomer refuses. The
 *  admin preview reads it. */
export function renderSignInLinkEmail(to: string, url: string): Rendered {
  return renderFoxhoundSignInLinkEmail({ to, url, expiresIn: `${SIGN_IN_LINK_EXPIRES_IN_SECONDS / 60} minutes` });
}

export type SignInLinkOutcome =
  | TransactionalSendOutcome
  | { status: "failed"; reason: "link_refused" | "render_failed"; error: null };

/**
 * Send the sign-in link to `to`, carrying Better Auth's `url` untouched.
 * `token` is the one Better Auth hands the sendMagicLink hook. Never throws;
 * every refusal comes back by name:
 *   - link_refused: the link is not https:, which Capsomer refuses, so nothing
 *     is sent. Production's BETTER_AUTH_URL is https.
 *   - render_failed: any other throw from the render; nothing is sent.
 *   - email_binding_missing: no EMAIL binding.
 *   - provider_error: the binding threw; its message comes back with the link,
 *     the token and the recipient cut out.
 * The link is never logged here, and never put in an error.
 */
export async function sendSignInLinkEmail(
  env: Env,
  link: { to: string; url: string; token: string },
): Promise<SignInLinkOutcome> {
  const { to, url, token } = link;
  let rendered: Rendered;
  try {
    rendered = renderSignInLinkEmail(to, url);
  } catch {
    return { status: "failed", reason: isHttps(url) ? "render_failed" : "link_refused", error: null };
  }
  return sendRenderedTransactionalEmail(env, { to, rendered, redact: [url, token, to] });
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
