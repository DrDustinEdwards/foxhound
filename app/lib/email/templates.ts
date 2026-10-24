import {
  alert,
  checkUrl,
  escapeHtml,
  notice,
  magicLink,
  renderEmail,
  type AlertLevel,
  type Block,
  type FooterLine,
  type Rendered,
  type Template,
} from "capsomer/email";

// THE ONE EMAIL TEMPLATES MODULE (J02). Every mail Foxhound sends is rendered
// here, on Capsomer's shared email component (RULES.md 3.16; Q3, Dustin "yes",
// 2026-10-14, message cmsg_01Nd8kh3hkgYNYpWXrNkvBQL1VeHhPyiYfFgdd86VozbJD).
// send.ts calls renderFoxhoundEmail for both sendEmail and sendTransactionalEmail,
// so the frame is applied in exactly one place. The sign-in link is the one
// exception to foxhoundMail: it is rendered on Capsomer's `magicLink` template by
// renderFoxhoundSignInLinkEmail below, still in this module.
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
// the render, and that throw is NOT caught here: it propagates through sendEmail
// into processEmailJob, which records it on the email_sends claim like any other
// send failure.

/** Foxhound's family in Capsomer: teal throughout (RULES.md 1.1). */
const FOXHOUND_EMAIL_FAMILY = "teal" as const;

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
export type RenderContent =
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
      ? renderEmail(foxhoundBlocks, { ...common, subjectLine: input.subject, content: input.blocks })
      : renderEmail(foxhoundMail, { ...common, subjectLine: input.subject, bodyHtml: input.bodyHtml });
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
// email settings" linking to APP_URL/settings. Recovery mail carries the first
// (J85); the merchant notices that went through wrapEmailHtml carry the second
// (E10, with 'Recova' as the sender name). Capsomer's footer slot holds both.

/**
 * Recova's footer sentence, with the sender name as Recova's From has it
 * (`sender_name || 'Support'`). Rows E4 to E6 carry it (J85), E10 with
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
// template's expiry line, "The link works once and expires in <expiresIn>.", is
// true here: Better Auth consumes the link's token on use.

export interface SignInLinkRenderInput {
  to: string;
  /** Better Auth's sign-in link, passed through untouched. */
  url: string;
  /** How long the link works, in words: "5 minutes". */
  expiresIn: string;
}

/** Render the sign-in link on Capsomer's magicLink template. Throws, through
 *  Capsomer's link check, on a link that is not https:. */
export function renderFoxhoundSignInLinkEmail(input: SignInLinkRenderInput): Rendered {
  return renderEmail(magicLink, {
    brand: { name: "Foxhound", family: FOXHOUND_EMAIL_FAMILY },
    to: input.to,
    url: input.url,
    expiresIn: input.expiresIn,
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
 * Append the invisible honeypot link (ruling 377(4) phase one). Pure.
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
export function appendHoneypotLink(html: string, honeypotUrl: string): string {
  const href = escapeHtml(checkUrl(honeypotUrl));
  return beforeBodyEnd(
    html,
    `<a href="${href}" style="display:none" aria-hidden="true" tabindex="-1">Account details</a>`,
  );
}

// ---- body HTML to Capsomer blocks ------------------------------------------------
//
// A small reader for the HTML Foxhound's senders and the model write, not a
// general parser. What it keeps, and why:
//   - p, div, li, td, th, blockquote: one paragraph each. A <br> starts a new
//     paragraph, because Capsomer's paragraph has no line break inside it (so
//     "Thanks,<br>Acme" becomes two short paragraphs, same words).
//   - h1 to h6: a heading. Nothing else becomes a heading; bold text is kept as
//     plain text in its paragraph, since Capsomer has no bold run.
//   - a link that is a block of its own: a button, label and address untouched.
//   - a link inside a sentence: the sentence keeps the link's words as plain
//     text, and a button with the same words and address follows the paragraph,
//     because Capsomer has no link inside a paragraph.
//   - a link Capsomer would refuse (anything but https: or mailto:, so tel:,
//     http:, "#", a relative path, an unfilled {{placeholder}}, javascript:,
//     data:): its words stay as text and no button is made. A generated body is
//     cached and reused on every retry, so a throw here would fail the step on
//     every attempt and never reach the template fallback (RULES.md 3.15).
//     Links Foxhound supplies outside the body (the unsubscribe link, the
//     tracking URLs) still throw when refused.
//   - <small> around a whole block: fine print.
//   - two pieces of a table cell split by <span> (the digest's label and value)
//     are kept apart by a space.
// What it drops: script, style, head and title with their content, comments,
// anything hidden (a hidden attribute, aria-hidden="true", or a style of
// display:none or visibility:hidden), and images (their alt text is kept).

type BlockKind = "paragraph" | "heading" | "fine";

interface Pending {
  kind: BlockKind;
  /** Text outside any link, and link labels, in order. */
  text: string;
  links: { label: string; url: string }[];
  /** True while every piece so far sat inside <small>. */
  allSmall: boolean;
}

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "td",
  "th",
  "tr",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "blockquote",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "nav",
  "pre",
  "hr",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const DROPPED_WITH_CONTENT = /<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const VOID_TAGS = new Set(["br", "hr", "img", "meta", "link", "input", "wbr", "col", "source", "area", "base", "embed", "param", "track"]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// ---- entities --------------------------------------------------------------------

const LATIN1_A0 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr " +
  "deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml " +
  "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml " +
  "eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

const NAMED: Record<string, string> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  apos: "'",
  COPY: "\u00a9",
  REG: "\u00ae",
  trade: "\u2122",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  lsaquo: "\u2039",
  rsaquo: "\u203a",
  ndash: "\u2013",
  mdash: "\u2014",
  minus: "\u2212",
  hellip: "\u2026",
  bull: "\u2022",
  dagger: "\u2020",
  Dagger: "\u2021",
  permil: "\u2030",
  prime: "\u2032",
  Prime: "\u2033",
  euro: "\u20ac",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200c",
  zwj: "\u200d",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193",
  check: "\u2713",
  OElig: "\u0152",
  oelig: "\u0153",
  Scaron: "\u0160",
  scaron: "\u0161",
  Yuml: "\u0178",
  fnof: "\u0192",
  circ: "\u02c6",
  tilde: "\u02dc",
};
LATIN1_A0.split(" ").forEach((name, i) => {
  NAMED[name] = String.fromCodePoint(0xa0 + i);
});

/** Decode numeric references (decimal and hex) and the named set above. An
 *  unknown or invalid reference is left exactly as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const hex = ref[1] === "x" || ref[1] === "X";
      const code = parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(NAMED, ref) ? NAMED[ref] : whole;
  });
}

// ---- attributes and hiding -------------------------------------------------------

/** Attribute names (lower case) to decoded values, quoted or unquoted. A bare
 *  name has the value "". The first of a repeated name wins, as in HTML. */
function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

function isHidden(attrs: Map<string, string>): boolean {
  if (attrs.has("hidden")) return true;
  if ((attrs.get("aria-hidden") ?? "").trim().toLowerCase() === "true") return true;
  const style = (attrs.get("style") ?? "").replace(/\s+/g, "").toLowerCase();
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** The URL if Capsomer would carry it as a button, else null. */
function acceptedUrl(href: string): string | null {
  try {
    return checkUrl(href);
  } catch {
    return null;
  }
}

// Elements whose end tag may be left out, and what ends them implicitly: the
// start tags that close one as a sibling, and the elements that, open inside
// it, make such a start tag a nested child instead of a sibling.
const P_CLOSERS = [
  "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "menu", "nav", "ol", "p", "pre", "section",
  "table", "ul",
];
const OPTIONAL_END: Record<string, { closers: Set<string>; scopes: Set<string> }> = {
  p: { closers: new Set(P_CLOSERS), scopes: new Set() },
  li: { closers: new Set(["li"]), scopes: new Set(["ul", "ol"]) },
  dt: { closers: new Set(["dt", "dd"]), scopes: new Set(["dl"]) },
  dd: { closers: new Set(["dt", "dd"]), scopes: new Set(["dl"]) },
  td: { closers: new Set(["td", "th", "tr", "tbody", "thead", "tfoot"]), scopes: new Set(["table"]) },
  th: { closers: new Set(["td", "th", "tr", "tbody", "thead", "tfoot"]), scopes: new Set(["table"]) },
  tr: { closers: new Set(["tr", "tbody", "thead", "tfoot"]), scopes: new Set(["table"]) },
  option: { closers: new Set(["option", "optgroup"]), scopes: new Set(["select"]) },
};

interface HiddenSkip {
  tag: string;
  /** Elements opened inside the hidden one and not yet closed. */
  stack: string[];
}

/**
 * Feed one tag to a hidden skip. Returns "skip" while the tag is inside the
 * hidden element, "end" when the tag ends it and is itself consumed (its own
 * end tag), and "end-reprocess" when the tag ends it implicitly and must then be
 * read as an ordinary tag (a sibling start tag or a parent's end tag).
 */
function feedHidden(h: HiddenSkip, name: string, closing: boolean, selfClose: boolean): "skip" | "end" | "end-reprocess" {
  const optional = OPTIONAL_END[h.tag];
  if (closing) {
    const at = h.stack.lastIndexOf(name);
    if (at !== -1) {
      h.stack.length = at;
      return "skip";
    }
    if (name === h.tag) return "end";
    // An end tag for something not opened inside: a parent closing, which
    // implicitly ends an optional-end element. Anything else is a stray tag.
    return optional ? "end-reprocess" : "skip";
  }
  if (optional && optional.closers.has(name) && !h.stack.some((t) => optional.scopes.has(t) || t === h.tag)) {
    return "end-reprocess";
  }
  if (!VOID_TAGS.has(name) && !selfClose) h.stack.push(name);
  return "skip";
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Turn a body written as HTML into Capsomer blocks, in order. Pure. */
export function htmlToBlocks(html: string): Block[] {
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROPPED_WITH_CONTENT, "");
  const blocks: Block[] = [];

  let pending: Pending | null = null;
  let headingDepth = 0;
  let smallDepth = 0;
  let cellDepth = 0;
  let hidden: HiddenSkip | null = null;
  let link: { url: string; label: string } | null = null;

  const open = (): Pending => {
    pending ??= {
      kind: headingDepth > 0 ? "heading" : "paragraph",
      text: "",
      links: [],
      allSmall: true,
    };
    return pending;
  };

  const addText = (raw: string): void => {
    const text = decodeEntities(raw);
    if (link) {
      link.label += text;
      return;
    }
    if (!text.trim() && !pending) return;
    const p = open();
    p.text += text;
    if (text.trim() && smallDepth === 0) p.allSmall = false;
  };

  /** Close the open link, keeping its words in the block and its button. */
  const closeLink = (): void => {
    if (!link) return;
    const done: { url: string; label: string } = link;
    link = null;
    const p = open();
    p.text += done.label;
    if (done.label.trim() && smallDepth === 0) p.allSmall = false;
    p.links.push(done);
  };

  const flush = (): void => {
    const p = pending;
    pending = null;
    if (!p) return;
    const text = squash(p.text);
    const links = p.links.map((l) => ({ label: squash(l.label), url: l.url })).filter((l) => l.label);
    // A block that is nothing but one link is a button.
    if (links.length === 1 && text === links[0].label) {
      blocks.push({ type: "button", label: links[0].label, url: links[0].url });
      return;
    }
    if (text) blocks.push({ type: p.kind === "paragraph" && p.allSmall ? "fine" : p.kind, text });
    const seen = new Set<string>();
    for (const l of links) {
      const key = `${l.label}\n${l.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push({ type: "button", label: l.label, url: l.url });
    }
  };

  let last = 0;
  for (const m of source.matchAll(TAG)) {
    const [whole, slash, rawName, rawAttrs, selfClose] = m;
    const name = rawName.toLowerCase();
    const closing = slash === "/";
    const between = source.slice(last, m.index);
    last = m.index + whole.length;

    if (hidden) {
      const step = feedHidden(hidden, name, closing, selfClose === "/");
      if (step !== "end-reprocess") {
        if (step === "end") hidden = null;
        continue;
      }
      // Ended implicitly: the text before this tag was still hidden, and the
      // tag itself is read below as an ordinary tag.
      hidden = null;
    } else {
      addText(between);
    }

    const attrs = parseAttrs(rawAttrs);
    if (!closing && isHidden(attrs)) {
      // A hidden block element still ends the block before it.
      if (BLOCK_TAGS.has(name)) {
        closeLink();
        flush();
      }
      // A void or self-closing element has no content to skip.
      if (!VOID_TAGS.has(name) && selfClose !== "/") hidden = { tag: name, stack: [] };
      continue;
    }

    if (name === "a") {
      // A second <a> before the first one closed ends the first, words kept.
      closeLink();
      if (!closing) {
        const url = acceptedUrl((attrs.get("href") ?? "").trim());
        if (url) link = { url, label: "" };
      }
      continue;
    }
    if (name === "img") {
      const alt = attrs.get("alt");
      if (alt && alt.trim()) addText(` ${alt} `);
      continue;
    }
    if (name === "small") {
      smallDepth = Math.max(0, smallDepth + (closing ? -1 : 1));
      continue;
    }
    if (name === "span" && cellDepth > 0) {
      addText(" ");
      continue;
    }
    if (BLOCK_TAGS.has(name)) {
      closeLink();
      flush();
      if (/^h[1-6]$/.test(name)) headingDepth = Math.max(0, headingDepth + (closing ? -1 : 1));
      if (name === "td" || name === "th") cellDepth = Math.max(0, cellDepth + (closing ? -1 : 1));
    }
  }
  if (!hidden) addText(source.slice(last));
  closeLink();
  flush();
  return blocks;
}
