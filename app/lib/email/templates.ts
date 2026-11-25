import { escapeHtml } from "@dustinedwards/site-runtime/html";
import type { NoticeDetail } from "@dustinedwards/site-runtime/sign-in";
import {
  alert,
  type AlertLevel,
  type Block,
  checkUrl,
  type Copy,
  emailChange,
  type FooterLine,
  htmlToBlocks,
  magicLink,
  notice,
  type Rendered,
  renderEmail,
  securityNotice,
  type Template,
} from "capsomer/email";

// The one email templates module: every mail is rendered here on Capsomer's shared email component, which
// writes the HTML and text parts from the same blocks and escapes every value. send.ts calls
// renderFoxhoundEmail for both send paths. Generated dunning bodies arrive as HTML (cached as ai_body_html
// and re-sent), so they are converted at this one seam, reading text and links only. A link must be https:
// or mailto:; inside a body a refused link is kept as its words (a throw would fail the cached step on
// every retry), but a refused URL Foxhound supplies (unsubscribe, tracking) throws and propagates to
// processEmailJob, which records it on the claim.

const FOXHOUND_EMAIL_FAMILY = "amber" as const;

/** The first-party engagement links a dunning send carries; the open feeds Intelligence only, the trap marks scanners. */
export interface EmailTracking {
  openUrl: string;
  honeypotUrl: string;
}

interface FoxhoundMailData {
  subjectLine: string;
  bodyHtml: string;
}

const foxhoundMail: Template<FoxhoundMailData> = {
  name: "foxhound-mail",
  subject: (d) => d.subjectLine,
  blocks: (d) => htmlToBlocks(d.bodyHtml),
};

/** A merchant notice as Capsomer's `notice` template takes it: plain strings, escaped by Capsomer. */
export interface EmailNotice {
  title: string;
  body: string[];
  action?: { label: string; url: string };
}

/** A mail written as Capsomer's blocks, with no heading added. */
const foxhoundBlocks: Template<{ subjectLine: string; content: Block[] }> = {
  name: "foxhound-blocks",
  subject: (d) => d.subjectLine,
  blocks: (d) => d.content,
};

type RenderContent =
  | { bodyHtml: string; notice?: never; blocks?: never }
  | { notice: EmailNotice; bodyHtml?: never; blocks?: never }
  | { blocks: Block[]; bodyHtml?: never; notice?: never };

export type RenderInput = RenderContent & {
  subject: string;
  brandName: string;
  to: string;
  footer?: FooterLine[];
  tracking?: EmailTracking | null;
};

export function renderFoxhoundEmail(input: RenderInput): Rendered {
  const common = {
    brand: { name: input.brandName, family: FOXHOUND_EMAIL_FAMILY },
    to: input.to,
    footer: input.footer,
  };
  // A notice uses Capsomer's `notice` template; its subject differs from its title, so it is passed as copy.
  const rendered = input.notice
    ? renderEmail(notice, { ...common, ...input.notice, copy: { subject: input.subject } })
    : input.blocks
      ? renderEmail(foxhoundBlocks, {
          ...common,
          subjectLine: input.subject,
          content: input.blocks,
        })
      : renderEmail(foxhoundMail, {
          ...common,
          subjectLine: input.subject,
          bodyHtml: input.bodyHtml,
        });
  if (!input.tracking) return rendered;
  // The pixel and trap go in the HTML part only; a text part would show them.
  const html = appendHoneypotLink(
    appendOpenPixel(rendered.html, input.tracking.openUrl),
    input.tracking.honeypotUrl,
  );
  return { ...rendered, html };
}

// Footer slot: one sentence ("You're receiving this from {senderName} ..."), then for a mail with an
// unsubscribe token the Unsubscribe link and postal address, else "Manage email settings" to /settings.

/** The footer sentence, with the sender name falling back to 'Support'. Pure. */
export function recoveryFooterNote(senderName: string | null | undefined, year: number): string {
  return `You're receiving this from ${footerSenderName(senderName)} about a recent payment. \u00a9 ${year}`;
}

/** The sender name a footer line shows: `sender_name || 'Support'`, trimmed. Pure. */
export function footerSenderName(senderName: string | null | undefined): string {
  return senderName?.trim() ? senderName.trim() : "Support";
}

/** The footer link on mail with no unsubscribe: "Manage email settings" to /settings. */
export function manageEmailSettingsLine(baseUrl: string): FooterLine {
  return { text: "Manage email settings", url: `${baseUrl}/settings` };
}

// Capsomer's own `magicLink` template as it stands. Its expiry line is true here: Better Auth consumes each on use.

export interface SignInLinkRenderInput {
  to: string;
  url: string;
  code: string;
  expiresIn: string;
}

/** Render the sign-in link on Capsomer's magicLink template. Throws on a link that is not https:. */
export function renderFoxhoundSignInLinkEmail(input: SignInLinkRenderInput): Rendered {
  return renderEmail(magicLink, {
    brand: { name: "Foxhound", family: FOXHOUND_EMAIL_FAMILY },
    to: input.to,
    url: input.url,
    code: input.code,
    expiresIn: input.expiresIn,
  });
}

/** Render a security notice on Capsomer's securityNotice template. `url` is where a merchant manages
 *  sign-in; the mail holds no link that signs in. */
export function renderFoxhoundSecurityNoticeEmail(
  to: string,
  detail: NoticeDetail,
  url: string,
): Rendered {
  return renderEmail(securityNotice, {
    brand: { name: "Foxhound", family: FOXHOUND_EMAIL_FAMILY },
    to,
    ...detail,
    url,
  });
}

/** Render one of an email change's two mails on Capsomer's emailChange template: `step` "current" asks the
 *  current address to approve, "new" asks the new address to confirm. */
export function renderFoxhoundEmailChangeEmail(input: {
  to: string;
  url: string;
  step: "current" | "new";
  newEmail?: string;
  expiresIn: string;
  copy: Copy;
}): Rendered {
  return renderEmail(emailChange, {
    brand: { name: "Foxhound", family: FOXHOUND_EMAIL_FAMILY },
    ...input,
  });
}

// The cron failure and stale alerts on Capsomer's `alert` template, as plain strings.

export interface EmailAlert {
  level: AlertLevel;
  title: string;
  intro: string;
  when: string;
  details: string[];
}

export function renderFoxhoundAlertEmail(input: {
  subject: string;
  to: string;
  alert: EmailAlert;
  footer?: FooterLine[];
}): Rendered {
  const a = input.alert;
  return renderEmail(alert, {
    brand: { name: "Foxhound", family: FOXHOUND_EMAIL_FAMILY },
    to: input.to,
    footer: input.footer,
    level: a.level,
    what: a.title,
    when: a.when,
    details: a.details,
    copy: { subject: input.subject, heading: a.title, intro: a.intro },
  });
}

// Capsomer's component carries no tracking; these are Foxhound's first-party signals, placed just before </body>.

function beforeBodyEnd(html: string, markup: string): string {
  const at = html.lastIndexOf("</body>");
  return at === -1 ? `${html}${markup}` : `${html.slice(0, at)}${markup}${html.slice(at)}`;
}

function appendOpenPixel(html: string, openUrl: string): string {
  const src = escapeHtml(checkUrl(openUrl));
  return beforeBodyEnd(html, `<img src="${src}" width="1" height="1" alt="" style="display:none">`);
}

/** Append the invisible honeypot link. Pure. display:none, aria-hidden and tabindex -1 together, so no
 *  person reaches it; a client that fetches it is following every link, as a link scanner does. Its text
 *  is deliberately dull, since bait wording hints at the trap. */
function appendHoneypotLink(html: string, honeypotUrl: string): string {
  const href = escapeHtml(checkUrl(honeypotUrl));
  return beforeBodyEnd(
    html,
    `<a href="${href}" style="display:none" aria-hidden="true" tabindex="-1">Account details</a>`,
  );
}
