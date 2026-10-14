import { sendTransactionalEmail } from "~/lib/email/send";

// Transactional auth emails (verification, password reset), sent through the ONE
// email send module on the Cloudflare EMAIL binding (ARCHITECTURE.md #3). These
// are platform mail to our own users, so they carry no CAN-SPAM unsubscribe
// footer (transactional, not commercial). The action link is token-bearing and is
// NEVER logged; it goes only into the email body. If the EMAIL binding is not yet
// provisioned the send throws (surfaces to the caller) rather than leaking the
// link to logs.

export type AuthEmailKind = "email-verification" | "password-reset";

// Link expiry copy: Better Auth's default token lifetime for both flows is
// 3600 seconds (confirmed in the installed better-auth package source,
// email-verification.mjs and password.mjs), and authOptions.ts sets no
// override for either, so the default applies. Update this string if either
// gets an explicit expiresIn override.
const LINK_EXPIRY_NOTE = "This link expires in 1 hour.";

const COPY: Record<AuthEmailKind, { subject: string; heading: string; body: string; cta: string }> = {
  "email-verification": {
    subject: "Verify your email",
    heading: "Confirm your email",
    body: `Confirm your email address to finish setting up your Foxhound account. ${LINK_EXPIRY_NOTE}`,
    cta: "Verify email",
  },
  "password-reset": {
    subject: "Reset your password",
    heading: "Reset your password",
    body: `We received a request to reset your Foxhound password. If this was not you, you can ignore this email. ${LINK_EXPIRY_NOTE}`,
    cta: "Reset password",
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
