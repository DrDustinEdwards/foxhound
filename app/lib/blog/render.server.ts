// Post bodies and excerpts render through Prelum (J19, Q2: Dustin "yes",
// 2026-10-14, message cmsg_01Nd8kh3hkgYNYpWXrNkvBQL26KKEsccUHePuPbEkrKY7v),
// with Foxhound's render pack (render-pack.ts) for Recova's ::postlink and
// :::diagram and its editor blocks. One renderer for every place a post is
// shown: /blog/:slug, the excerpts on /blog, /blog/tag/:tag and /blog/archive,
// the admin preview and Carrel's preview.
//
// Before Prelum parses a Recova body, recovaSource() rewrites the three things
// its parser would read differently from Recova's, each with an escape that
// renders as the original character:
//
//   1. Recova's :::diagram[slug] is one line with no closing fence. To
//      remark-directive that opens a block running to the end of the post, so
//      it becomes the one-line ::diagram[slug].
//   2. A dollar sign. Prelum reads $...$ as math; Recova had no math, and a
//      payments blog is full of "$49 and $99". Every $ outside code is escaped.
//   3. A colon before a word ("decline_code:insufficient_funds", "Note:this").
//      remark-directive reads it as a directive and Prelum refuses an unknown
//      one. Such a colon is escaped. An unknown ::name[x] becomes inline code
//      and an unknown :::name block a note callout, both as Recova draws them.
//
// Code spans and code blocks are never touched: their positions come from the
// same parser Prelum uses.

import { render } from "@drdustinedwards/site-helpers/render";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import type { Db } from "~/db";

import { foxhoundPack, PACK_CONTAINERS, PACK_LEAVES, POSTLINK_RE, type PostLinkTarget } from "./render-pack";
import { resolvePostLinks } from "./queries.server";

export interface TocItem {
  level: 2 | 3;
  text: string;
  id: string;
}

export interface BlogRenderOptions {
  /** Published posts a ::postlink may point at, by slug. */
  postLinks: ReadonlyMap<string, PostLinkTarget>;
  /** Diagram slugs with a file at /diagrams/<slug>.svg. Empty until row F23. */
  diagrams?: ReadonlySet<string>;
}

// Prelum's core directives, which it draws itself.
const CORE_CONTAINERS = ["details", "figure"];
const KNOWN_CONTAINERS = new Set<string>([...PACK_CONTAINERS, ...CORE_CONTAINERS]);
const KNOWN_LEAVES = new Set<string>(PACK_LEAVES);

// The parser Prelum's render builds, so positions here are positions there.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDirective);

interface Positioned {
  type: string;
  name?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(source: string, edits: Edit[]): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Spans of the source that are code, where a backslash would show. */
function codeRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  visit(parser.parse(source) as never, (raw: unknown) => {
    const node = raw as Positioned;
    if (node.type !== "code" && node.type !== "inlineCode" && node.type !== "html") return;
    const { start, end } = { start: node.position?.start.offset, end: node.position?.end.offset };
    if (start !== undefined && end !== undefined) ranges.push([start, end]);
  });
  return ranges;
}

const inRanges = (at: number, ranges: Array<[number, number]>) => ranges.some(([s, e]) => at >= s && at < e);

/** Recova markdown made safe to hand to Prelum's parser. See the header. */
export function recovaSource(body: string): string {
  // 1. Recova's single-line diagram, by Recova's own pattern.
  let source = body.replace(/^:::diagram\[([a-z0-9-]+)\]$/gm, "::diagram[$1]");

  // 2. Dollar signs, and the bar inside a ::postlink (a table would split on it).
  const code = codeRanges(source);
  const edits: Edit[] = [];
  for (let i = source.indexOf("$"); i !== -1; i = source.indexOf("$", i + 1)) {
    if (!inRanges(i, code) && source[i - 1] !== "\\") edits.push({ start: i, end: i, text: "\\" });
  }
  for (const m of source.matchAll(POSTLINK_RE)) {
    const at = m.index ?? 0;
    const bar = m[0].indexOf("|");
    if (bar !== -1 && !inRanges(at, code)) edits.push({ start: at + bar, end: at + bar, text: "\\" });
  }
  source = applyEdits(source, edits);

  // 3. Directives Recova never had. Each pass can expose another, so repeat
  //    until a parse finds none (bounded: every pass removes at least one).
  for (let pass = 0; pass < 20; pass++) {
    const found: Edit[] = [];
    visit(parser.parse(source) as never, (raw: unknown) => {
      const node = raw as Positioned;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const name = node.name ?? "";
      if (node.type === "textDirective") {
        found.push({ start, end: start, text: "\\" });
      } else if (node.type === "leafDirective" && !KNOWN_LEAVES.has(name)) {
        const text = source.slice(start, end);
        found.push(text.includes("`") ? { start, end: start, text: "\\" } : { start, end, text: `\`${text}\`` });
      } else if (node.type === "containerDirective" && !KNOWN_CONTAINERS.has(name)) {
        found.push({ start: start + 3, end: start + 3 + name.length, text: "note" });
      }
    });
    if (found.length === 0) break;
    // An edit inside another's span (a colon in an unknown shortcode's label)
    // waits for the next pass, after the outer one has rewritten the span.
    const outer = found.filter((e) => !found.some((o) => o !== e && o.end > o.start && e.start >= o.start && e.start <= o.end));
    source = applyEdits(source, outer);
  }
  return source;
}

/** Every slug a ::postlink in this text points at. */
export function postLinkSlugs(text: string): string[] {
  return [...text.matchAll(POSTLINK_RE)].map((m) => m[1].trim());
}

/** Renders one body. Pure: the caller supplies the published posts. */
export async function renderBlogMarkdown(body: string, options: BlogRenderOptions): Promise<{ html: string; toc: TocItem[] }> {
  const out = await render({
    file: "blog post",
    body: recovaSource(body),
    // No stored image sizes: an image keeps the attributes the post gives it.
    resolveImage: async () => ({}) as { width: number; height: number },
    options: { packs: [foxhoundPack(options)] },
  });
  return {
    html: out.html,
    toc: out.toc.map((t) => ({ level: t.depth === 2 ? 2 : 3, text: t.text, id: t.id })),
  };
}

/** A post body, its ::postlinks resolved against published rows. */
export async function renderPostBody(db: Db, body: string): Promise<{ html: string; toc: TocItem[] }> {
  const postLinks = await resolvePostLinks(db, postLinkSlugs(body));
  return renderBlogMarkdown(body, { postLinks });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** An excerpt rendered through Prelum and read back as text: the words a
 *  reader sees, with a ::postlink as its post's title. Cards are whole-card
 *  links, so the excerpt cannot carry a link of its own. */
export async function excerptText(excerpt: string, options: BlogRenderOptions): Promise<string> {
  const { html } = await renderBlogMarkdown(excerpt, options);
  const text = html.replace(/<a class="heading-anchor"[^>]*>[\s\S]*?<\/a>/g, "").replace(/<[^>]+>/g, "");
  return decodeEntities(text).trim();
}

/** The same list with every excerpt rendered, its ::postlinks resolved in one read. */
export async function withRenderedExcerpts<T extends { excerpt: string }>(db: Db, posts: T[]): Promise<T[]> {
  const slugs = posts.flatMap((p) => postLinkSlugs(p.excerpt));
  const postLinks = await resolvePostLinks(db, slugs);
  return Promise.all(posts.map(async (p) => ({ ...p, excerpt: await excerptText(p.excerpt, { postLinks }) })));
}
