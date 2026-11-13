import { escapeHtml } from "@dustinedwards/site-runtime/html";
import type { NoticeDetail } from "@dustinedwards/site-runtime/sign-in";
import {
  alert,
  type AlertLevel,
  type Block,
  checkUrl,
  type Copy,
  emailChange,
  htmlToBlocks,
  type FooterLine,
  magicLink,
  notice,
  type Rendered,
  renderEmail,
  securityNotice,
  type Template,
} from "capsomer/email";

// THE ONE EMAIL TEMPLATES MODULE. Every mail Foxhound sends is rendered
// here, on Capsomer's shared email component (RULES.md 3.16; Q3, Dustin "yes",
// 2026-10-14, message cmsg_01Nd8kh3hkgYNYpWXrNkvBQL1VeHhPyiYfFgdd86VozbJD).
// send.ts calls renderFoxhoundEmail for both sendJobEmail and sendTransactionalEmail,
// so the frame is applied in exactly one place. The sign-in link and the
// security notice are the exceptions to foxhoundMail: they are rendered on
// Capsomer's `magicLink` and `securityNotice` templates below, still in this
// module.
//
// WHAT STAYS FOXHOUND'S. The senders still write their own content, in the same
// words as before; this module only turns that content into Capsomer's typed
// blocks. Capsomer then writes the HTML part and the plain-text part from the
// same blocks, so the two cannot disagree, and it escapes every value. Recova's
// lib/email.ts is the spec for what a mail says and carries, not for its frame.
//
// WHY THE CONTENT ARRIVES AS HTML. Generated dunning and win-back bodies come
// from the model as HTML, are cached on the step as HTML (ai_body_html) and are
// re-sent from there by the manual resend. Converting at the one send seam keeps
// every one of those paths, and every hand-written body, on the same road. The
// conversion reads text and links only: no markup the model wrote reaches the
// mail, because Capsomer escapes the text it is given.
//
// THE LINK RULE IS CAPSOMER'S. A link must be https: or mailto:. Inside a body,
// a link Capsomer would refuse is kept as its words with no button (see the
// reader below), because a generated body is cached and re-sent, and a throw
// would fail that step on every retry. A refused URL Foxhound itself supplies
// outside the body (the unsubscribe link, the tracking URLs) still throws inside
// the render, and that throw is NOT caught here: it propagates through sendJobEmail
// into processEmailJob, which records it on the email_sends claim like any other
// send failure.

/** Foxhound's family in Capsomer: amber throughout. */
const FOXHOUND_EMAIL_FAMILY = "amber" as const;

/** The first-party engagement links a dunning send carries (PRICING.md: the
 *  open feeds Intelligence only; the trap marks scanners, RULES.md 3.4). */
export interface EmailTracking {
  openUrl: string;
  honeypotUrl: string;
}

interface FoxhoundMailData {
  /** The subject as the sender wrote it. Capsomer folds it to one line. */
  subjectLine: string;
  /** The body as the sender wrote it. Read for text and links only. */
  bodyHtml: string;
}

/**
 * Foxhound's one template. Its blocks are the sender's own paragraphs, headings
 * and links, in the sender's order and wording.
 */
const foxhoundMail: Template<FoxhoundMailData> = {
  name: "foxhound-mail",
  subject: (d) => d.subjectLine,
  blocks: (d) => htmlToBlocks(d.bodyHtml),
};

/**
 * A merchant notice as Capsomer's `notice` template takes it: a title (the
 * mail's one heading), its paragraphs, and an optional button. Plain strings,
 * never markup: Capsomer escapes each one, so a customer name from Stripe is
 * shown exactly as written.
 */
export interface EmailNotice {
  title: string;
  body: string[];
  action?: { label: string; url: string };
}

/**
 * A mail the sender wrote as Capsomer's blocks, in the sender's order and
 * wording, with no heading added (E12: Recova's expiring card alert has none).
 */
const foxhoundBlocks: Template<{ subjectLine: string; content: Block[] }> = {
  name: "foxhound-blocks",
  subject: (d) => d.subjectLine,
  blocks: (d) => d.content,
};

/** The content of one mail: a body the sender wrote as HTML, a notice, or
 *  Capsomer's blocks. */
type RenderContent =
  | { bodyHtml: string; notice?: never; blocks?: never }
  | { notice: EmailNotice; bodyHtml?: never; blocks?: never }
  | { blocks: Block[]; bodyHtml?: never; notice?: never };

export type RenderInput = RenderContent & {
  subject: string;
  /** The name set in type at the top of the mail: the From display name. */
  brandName: string;
  to: string;
  /** The footer slot, under Capsomer's "This message was sent to" line. */
  footer?: FooterLine[];
  tracking?: EmailTracking | null;
};

/** Render one Foxhound mail to a subject, an HTML part and a text part. */
export function renderFoxhoundEmail(input: RenderInput): Rendered {
  const common = {
    brand: { name: input.brandName, family: FOXHOUND_EMAIL_FAMILY },
    to: input.to,
    footer: input.footer,
  };
  // A notice goes on Capsomer's own `notice` template, its subject passed as
  // copy because the subject and the title differ (E10: "Payment recovered:
  // $99.00 from Jane Buyer" over the title "Payment recovered.").
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
  // The pixel and the trap go into the HTML part only. In the text part a
  // reader would see them, and a text part cannot load an image anyway.
  const html = appendHoneypotLink(
    appendOpenPixel(rendered.html, input.tracking.openUrl),
    input.tracking.honeypotUrl,
  );
  return { ...rendered, html };
}

// ---- Recova's footer line ---------------------------------------------------------
//
// Recova's shell (lib/email.ts wrapEmailHtml, blob 3f882729) puts one sentence
// in every footer: "You're receiving this from {senderName} about a recent
// payment. &copy; {year}". Under it, a mail with an unsubscribe token gets the
// Unsubscribe link and the postal address; a mail without one gets "Manage
// email settings" linking to APP_URL/settings. Recovery mail carries the first;
// the merchant notices that went through wrapEmailHtml carry the second
// (E10, with 'Recova' as the sender name). Capsomer's footer slot holds both.

/**
 * Recova's footer sentence, with the sender name as Recova's From has it
 * (`sender_name || 'Support'`). Rows E4 to E6 carry it, E10 with
 * "Foxhound". Pure.
 */
export function recoveryFooterNote(senderName: string | null | undefined, year: number): string {
  return `You're receiving this from ${footerSenderName(senderName)} about a recent payment. \u00a9 ${year}`;
}

/** The sender name a footer line shows: Recova's `sender_name || 'Support'`,
 *  trimmed. The one authority for that fallback in footer lines (E4 to E6,
 *  E9). Pure. */
export function footerSenderName(senderName: string | null | undefined): string {
  return senderName?.trim() ? senderName.trim() : "Support";
}

/** Recova's footer link on mail with no unsubscribe: "Manage email settings",
 *  to the settings hub (Recova's APP_URL/settings; Foxhound's /settings). */
export function manageEmailSettingsLine(baseUrl: string): FooterLine {
  return { text: "Manage email settings", url: `${baseUrl}/settings` };
}

// ---- the sign-in link -----------------------------------------------------------
//
// Capsomer's own `magicLink` template, used as it stands, in its own words (the
// family's one sign-in mail). Recova had no sign-in link: it had passwords. The
// template's expiry line, "The link and the code work once and expire in
// <expiresIn>.", is true here: Better Auth consumes each on use.

export interface SignInLinkRenderInput {
  to: string;
  /** Better Auth's sign-in link, passed through untouched. */
  url: string;
  /** The six-digit code for the tab that asked. */
  code: string;
  /** How long the link and code work, in words: "10 minutes". */
  expiresIn: string;
}

/** Render the sign-in link on Capsomer's magicLink template. Throws, through
 *  Capsomer's link check, on a link that is not https:. */
export function renderFoxhoundSignInLinkEmail(input: SignInLinkRenderInput): Rendered {
  return renderEmail(magicLink, {
    brand: { name: "Foxhound", family: FOXHOUND_EMAIL_FAMILY },
    to: input.to,
    url: input.url,
    code: input.code,
    expiresIn: input.expiresIn,
  });
}

/** Render a security notice (site-runtime ./sign-in's `sendSecurityNotice`
 *  detail, taken as it is) on Capsomer's securityNotice template. `url` is the
 *  page where a merchant manages sign-in; the mail holds no link that signs in. */
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

/** Render one of an email change's two mails on Capsomer's emailChange
 *  template: `step` "current" asks the current address to approve (and names
 *  `newEmail`), "new" asks the new address to confirm. The words are `copy`'s
 *  (send-auth-email.ts). */
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

// ---- operator alerts (E26, E27) ------------------------------------------------
//
// The cron failure and stale alerts, on Capsomer's own `alert` template: the
// title as the one heading, the first sentence in the level's note (Capsomer
// puts the level in front of it as a word), then the detail lines. Plain
// strings, never markup: Capsomer escapes each one. From "Foxhound", as
// Recova's FROM_HELLO is "Recova".

export interface EmailAlert {
  level: AlertLevel;
  title: string;
  /** The first sentence, shown in the level's note after the level word. */
  intro: string;
  /** When it happened, in words; Capsomer's default intro uses it. */
  when: string;
  details: string[];
}

/** Render one operator alert on Capsomer's alert template. Pure. */
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

// ---- engagement markup ---------------------------------------------------------
//
// Moved here from engine/execute-step.ts so the frame and the hidden markup are
// assembled in one module. Capsomer's component carries no tracking of its own
// (email.md: "No tracking pixel and no click-tracking rewrite"); these are
// Foxhound's first-party signals (CLAUDE.md: engagement comes from Foxhound's own
// tracking routes), placed inside the rendered document just before </body>.
// Each URL passes Capsomer's own link check and escape.

/** Place markup just before </body>, or at the end of a fragment. */
function beforeBodyEnd(html: string, markup: string): string {
  const at = html.lastIndexOf("</body>");
  return at === -1 ? `${html}${markup}` : `${html.slice(0, at)}${markup}${html.slice(at)}`;
}

/** Append the first-party open pixel. Pure. */
export function appendOpenPixel(html: string, openUrl: string): string {
  const src = escapeHtml(checkUrl(openUrl));
  return beforeBodyEnd(html, `<img src="${src}" width="1" height="1" alt="" style="display:none">`);
}

/**
 * Append the invisible honeypot link. Pure.
 *
 * A person cannot see it, reach it with a keyboard, or hear it: it is
 * display:none, aria-hidden and tabindex -1 together, because any one of those
 * alone leaves a route to it. A client that fetches it is following every link
 * in the message, which is what a link scanner does and what a reader does not.
 *
 * ITS TEXT IS DELIBERATELY DULL. Anything that reads as bait ("do not click")
 * is a hint to whoever is reading the source, and the trap works by being
 * uninteresting.
 */
function appendHoneypotLink(html: string, honeypotUrl: string): string {
  const href = escapeHtml(checkUrl(honeypotUrl));
  return beforeBodyEnd(
    html,
    `<a href="${href}" style="display:none" aria-hidden="true" tabindex="-1">Account details</a>`,
  );
}
