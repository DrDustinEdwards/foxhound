import {
  checkUrl,
  escapeHtml,
  renderEmail,
  type Block,
  type FooterLine,
  type Rendered,
  type Template,
} from "capsomer/email";

// THE ONE EMAIL TEMPLATES MODULE (J02). Every mail Foxhound sends is rendered
// here, on Capsomer's shared email component (RULES.md 3.16; Q3, Dustin "yes",
// 2026-10-14, message cmsg_01Nd8kh3hkgYNYpWXrNkvBQL1VeHhPyiYfFgdd86VozbJD).
// send.ts calls renderFoxhoundEmail for both sendEmail and sendTransactionalEmail,
// so the frame is applied in exactly one place.
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
// THE LINK RULE IS CAPSOMER'S. A link must be https: or mailto:; anything else
// throws inside renderEmail, and that throw is NOT caught here. It propagates
// through sendEmail into processEmailJob, which records it on the email_sends
// claim like any other send failure, so a link the frame cannot carry is a
// visible failed send and never a silent drop.

/** Foxhound's family in Capsomer: teal throughout (RULES.md 1.1). */
export const FOXHOUND_EMAIL_FAMILY = "teal" as const;

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
export const foxhoundMail: Template<FoxhoundMailData> = {
  name: "foxhound-mail",
  subject: (d) => d.subjectLine,
  blocks: (d) => htmlToBlocks(d.bodyHtml),
};

export interface RenderInput {
  subject: string;
  bodyHtml: string;
  /** The name set in type at the top of the mail: the From display name. */
  brandName: string;
  to: string;
  /** Customer mail only: the unsubscribe link and the postal address. */
  footer?: FooterLine[];
  tracking?: EmailTracking | null;
}

/** Render one Foxhound mail to a subject, an HTML part and a text part. */
export function renderFoxhoundEmail(input: RenderInput): Rendered {
  const rendered = renderEmail(foxhoundMail, {
    subjectLine: input.subject,
    bodyHtml: input.bodyHtml,
    brand: { name: input.brandName, family: FOXHOUND_EMAIL_FAMILY },
    to: input.to,
    footer: input.footer,
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
//   - h1 to h6: a heading. A paragraph whose only text is bold (the merchant
//     notices' "Payment recovered.") is a heading too, since Capsomer has no
//     bold run inside a paragraph.
//   - a link that is a block of its own: a button, label and address untouched.
//   - a link inside a sentence: the sentence keeps the link's words as plain
//     text, and a button with the same words and address follows the paragraph,
//     because Capsomer has no link inside a paragraph.
//   - <small> around a whole block: fine print.
//   - two pieces of a table cell split by <span> (the digest's label and value)
//     are kept apart by a space.
// What it drops: script, style, head and title with their content, comments,
// anything hidden (display:none, aria-hidden, the hidden attribute), and images
// (their alt text is kept as text).

type BlockKind = "paragraph" | "heading" | "fine";

interface Pending {
  kind: BlockKind;
  /** Text outside any link, and link labels, in order. */
  text: string;
  /** Text written outside <strong>/<b>, to tell an all-bold line. */
  plainText: string;
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
  "td",
  "th",
  "tr",
  "table",
  "tbody",
  "thead",
  "blockquote",
  "section",
  "article",
  "header",
  "footer",
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
const VOID_TAGS = new Set(["br", "hr", "img", "meta", "link", "input", "wbr", "col", "source"]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!m) return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "i").test(attrs) ? "" : null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

function isHidden(attrs: string): boolean {
  const style = (attr(attrs, "style") ?? "").replace(/\s+/g, "").toLowerCase();
  if (style.includes("display:none") || style.includes("visibility:hidden")) return true;
  if ((attr(attrs, "aria-hidden") ?? "").toLowerCase() === "true") return true;
  return attr(attrs, "hidden") !== null;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Turn a body written as HTML into Capsomer blocks, in order. Pure. */
export function htmlToBlocks(html: string): Block[] {
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROPPED_WITH_CONTENT, "");
  const blocks: Block[] = [];

  let pending: Pending | null = null;
  let headingDepth = 0;
  let strongDepth = 0;
  let smallDepth = 0;
  let cellDepth = 0;
  let hiddenTag: string | null = null;
  let hiddenDepth = 0;
  let link: { url: string; label: string } | null = null;

  const open = (): Pending => {
    pending ??= {
      kind: headingDepth > 0 ? "heading" : "paragraph",
      text: "",
      plainText: "",
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
    if (strongDepth === 0) p.plainText += text;
    if (text.trim() && smallDepth === 0) p.allSmall = false;
  };

  const flush = (): void => {
    const p = pending;
    pending = null;
    if (!p) return;
    const text = squash(p.text);
    const links = p.links
      .map((l) => ({ label: squash(l.label), url: l.url }))
      .filter((l) => l.label || l.url);
    // A block that is nothing but one link is a button.
    if (links.length === 1 && text === links[0].label && text) {
      blocks.push({ type: "button", label: links[0].label, url: links[0].url });
      return;
    }
    if (text) {
      let kind: BlockKind = p.kind;
      if (kind === "paragraph" && p.allSmall) kind = "fine";
      else if (kind === "paragraph" && !squash(p.plainText) && links.length === 0) kind = "heading";
      blocks.push({ type: kind, text });
    }
    const seen = new Set<string>();
    for (const l of links) {
      const label = l.label || l.url;
      const key = `${label}\n${l.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push({ type: "button", label, url: l.url });
    }
  };

  let last = 0;
  for (const m of source.matchAll(TAG)) {
    const [whole, slash, rawName, attrs, selfClose] = m;
    const name = rawName.toLowerCase();
    const closing = slash === "/";
    const between = source.slice(last, m.index);
    last = m.index + whole.length;

    if (hiddenTag) {
      if (name === hiddenTag && !VOID_TAGS.has(name)) hiddenDepth += closing ? -1 : selfClose ? 0 : 1;
      if (hiddenDepth === 0) hiddenTag = null;
      continue;
    }
    addText(between);

    if (!closing && isHidden(attrs)) {
      if (!VOID_TAGS.has(name) && !selfClose) {
        hiddenTag = name;
        hiddenDepth = 1;
      }
      continue;
    }

    if (name === "a") {
      if (!closing) {
        const href = attr(attrs, "href");
        if (href !== null && href.trim()) link = { url: href.trim(), label: "" };
      } else if (link) {
        const done: { url: string; label: string } = link;
        link = null;
        const p = open();
        p.text += done.label;
        if (strongDepth === 0) p.plainText += done.label;
        if (done.label.trim() && smallDepth === 0) p.allSmall = false;
        p.links.push(done);
      }
      continue;
    }
    if (name === "img") {
      const alt = attr(attrs, "alt");
      if (alt && alt.trim()) addText(` ${alt} `);
      continue;
    }
    if (name === "strong" || name === "b") {
      strongDepth = Math.max(0, strongDepth + (closing ? -1 : 1));
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
      // A link left open across a block boundary is closed as plain text.
      if (link) {
        const dangling: { url: string; label: string } = link;
        link = null;
        addText(dangling.label);
      }
      flush();
      if (/^h[1-6]$/.test(name)) headingDepth = Math.max(0, headingDepth + (closing ? -1 : 1));
      if (name === "td" || name === "th") cellDepth = Math.max(0, cellDepth + (closing ? -1 : 1));
    }
  }
  if (!hiddenTag) addText(source.slice(last));
  if (link) {
    const dangling: { url: string; label: string } = link;
    link = null;
    addText(dangling.label);
  }
  flush();
  return blocks;
}
