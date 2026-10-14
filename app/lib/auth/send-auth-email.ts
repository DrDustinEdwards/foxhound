import { checkUrl } from "capsomer/email";

import {
  sendRenderedTransactionalEmail,
  sendTransactionalEmail,
  type TransactionalSendOutcome,
} from "~/lib/email/send";
import { renderFoxhoundResetEmail } from "~/lib/email/templates";

import { PASSWORD_RESET_EXPIRES_IN_SECONDS } from "./options";

// Transactional auth emails (verification, password reset), sent through the ONE
// email send module on the Cloudflare EMAIL binding (ARCHITECTURE.md #3). These
// are platform mail to our own users, so they carry no CAN-SPAM unsubscribe
// footer (transactional, not commercial). The action link is token-bearing and is
// NEVER logged; it goes only into the email body.
//
// The verification email still throws when the EMAIL binding is not provisioned
// (surfaces to the caller rather than leaking the link to logs). The password
// reset returns a named outcome instead (J82); auth.server.ts turns a refusal
// into a throw that names the reason and carries no link.

export type AuthEmailKind = "email-verification";

// Link expiry copy: Better Auth's default token lifetime for email verification
// is 3600 seconds (confirmed in the installed better-auth package source,
// email-verification.mjs), and authOptions sets no override, so the default
// applies. Update this string if it gets an explicit expiresIn override.
const LINK_EXPIRY_NOTE = "This link expires in 1 hour.";

const COPY: Record<AuthEmailKind, { subject: string; heading: string; body: string; cta: string }> = {
  "email-verification": {
    subject: "Verify your email",
    heading: "Confirm your email",
    body: `Confirm your email address to finish setting up your Foxhound account. ${LINK_EXPIRY_NOTE}`,
    cta: "Verify email",
  },
};

/** Escape text destined for HTML. The URL is a trusted Better Auth link but is
 *  attribute-escaped defensively. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Plain semantic HTML, no inline styles (J02). The frame, colours and type come
// from Capsomer's shared email component through app/lib/email/templates.ts,
// which reads this as a heading, a paragraph, a button and two lines of fine
// print, and writes the plain-text part from the same blocks. The wording is
// unchanged.
function renderAuthEmail(kind: AuthEmailKind, url: string): string {
  const c = COPY[kind];
  const href = escapeHtml(url);
  return (
    `<h1>${c.heading}</h1>` +
    `<p>${c.body}</p>` +
    `<p><a href="${href}">${c.cta}</a></p>` +
    `<p><small>If the button does not work, paste this link into your browser:<br>${href}</small></p>`
  );
}

export async function sendAuthEmail(
  env: Env,
  kind: AuthEmailKind,
  to: string,
  url: string,
): Promise<void> {
  const { subject } = COPY[kind];
  await sendTransactionalEmail(env, { to, subject, bodyHtml: renderAuthEmail(kind, url) });
}

// ---- the password reset (J82, parity row E1) ------------------------------------
//
// Built on Capsomer's `reset` template. Recova's reset mail was a Supabase
// dashboard template that is not in its repo, so its words are unknown; these
// are Foxhound's words as they stood before J82, kept, and nothing here claims
// parity. Two lines are the template's own and cannot be overridden: the expiry
// line, "The link works once and expires in 1 hour." (it replaced "This link
// expires in 1 hour."; "works once" is true because Better Auth consumes the
// reset token when the password is set), and the HTML part's lack of a "paste
// this link" line under the button (the text part still carries the link).

const PASSWORD_RESET_COPY = {
  subject: "Reset your password",
  heading: "Reset your password",
  intro: "We received a request to reset your Foxhound password.",
  button: "Reset password",
  ignore: "If this was not you, you can ignore this email.",
} as const;

/** A whole number of seconds in words: 3600 is "1 hour", 900 "15 minutes". */
function durationInWords(seconds: number): string {
  const [n, unit] =
    seconds % 3600 === 0 ? [seconds / 3600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export type PasswordResetOutcome =
  | TransactionalSendOutcome
  | { status: "failed"; reason: "link_refused"; error: null };

/** The token in a Better Auth reset link: the path segment after /reset-password/. */
function resetToken(url: string): string | null {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

/**
 * Send the password reset to `to`, carrying Better Auth's `url` untouched.
 * Never throws for a refused send; every refusal comes back by name:
 *   - link_refused: the link is not one Capsomer carries (not https:), so
 *     nothing is rendered or sent. Production's BETTER_AUTH_URL is https.
 *   - email_binding_missing: no EMAIL binding.
 *   - provider_error: the binding threw; its message comes back with the link
 *     and the token cut out.
 * The link is never logged here, and never put in an error.
 */
export async function sendPasswordResetEmail(env: Env, to: string, url: string): Promise<PasswordResetOutcome> {
  try {
    checkUrl(url);
  } catch {
    return { status: "failed", reason: "link_refused", error: null };
  }
  const rendered = renderFoxhoundResetEmail({
    to,
    url,
    expiresIn: durationInWords(PASSWORD_RESET_EXPIRES_IN_SECONDS),
    copy: PASSWORD_RESET_COPY,
  });
  const token = resetToken(url);
  return sendRenderedTransactionalEmail(env, {
    to,
    rendered,
    redact: token ? [url, token] : [url],
  });
}
