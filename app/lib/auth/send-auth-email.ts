import { sendTransactionalEmail } from "~/lib/email/send";

// Transactional auth emails (verification, password reset), sent through the ONE
// email send module on the Cloudflare EMAIL binding (ARCHITECTURE.md #3). These
// are platform mail to our own users, so they carry no CAN-SPAM unsubscribe
// footer (transactional, not commercial). The action link is token-bearing and is
// NEVER logged; it goes only into the email body. If the EMAIL binding is not yet
// provisioned the send throws (surfaces to the caller) rather than leaking the
// link to logs.

export type AuthEmailKind = "email-verification" | "password-reset";

const COPY: Record<AuthEmailKind, { subject: string; heading: string; body: string; cta: string }> = {
  "email-verification": {
    subject: "Verify your email",
    heading: "Confirm your email",
    body: "Confirm your email address to finish setting up your Foxhound account.",
    cta: "Verify email",
  },
  "password-reset": {
    subject: "Reset your password",
    heading: "Reset your password",
    body: "We received a request to reset your Foxhound password. If this was not you, you can ignore this email.",
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

function renderAuthEmail(kind: AuthEmailKind, url: string): string {
  const c = COPY[kind];
  const href = escapeHtml(url);
  return (
    `<p style="font-size:16px;font-weight:600;margin:0 0 12px">${c.heading}</p>` +
    `<p style="font-size:14px;color:#444;margin:0 0 20px">${c.body}</p>` +
    `<p style="margin:0 0 20px"><a href="${href}" ` +
    `style="display:inline-block;padding:10px 18px;background:#111;color:#fff;` +
    `border-radius:6px;text-decoration:none;font-size:14px">${c.cta}</a></p>` +
    `<p style="font-size:12px;color:#888;margin:0">If the button does not work, paste this link into your browser:<br>${href}</p>`
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
