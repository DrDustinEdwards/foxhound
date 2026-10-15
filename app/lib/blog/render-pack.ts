// Foxhound's render pack for Prelum (J19, Q2): the directives Recova's posts are
// written with, given Recova's meaning (Recova lib/markdown.ts, blob 62a2e55c),
// in the RenderPack shape Prelum's `render` takes (site-helpers render/packs).
//
//   ::postlink[slug] and ::postlink[slug|anchor text]   a link to a published
//       post, titled by the post unless anchor text is given; a slug that does
//       not resolve shows as inline code so an editor notices. Inline in prose
//       or on its own line. 45 of the 46 live posts use it.
//   :::diagram[slug]   Recova's hand-drawn diagram file, not Prelum's Mermaid
//       :::diagram. 8 live posts use it. The files are row F23 and do not exist
//       in Foxhound yet; a slug with no file renders nothing, which is Recova's
//       own production behaviour for a missing file.
//   :::tip, :::warning, :::note, :::danger, :::pullquote, :::toggle[Header],
//   :::faq, ::youtube[id], ::bookmark[url]   Recova's editor blocks, kept with
//       the classes app.css styles. No live post uses one, but an old body
//       that does must not fail to render.
//
// Two rehype steps keep what readers and links already rely on: Recova's
// heading ids (so every table-of-contents anchor and deep link stays where it
// was; Prelum's slugger would move some), and Recova's rule that a link off
// this site opens in a new tab.
//
// The source rewrites that make Recova's markdown safe to hand to Prelum's
// parser (its single-line :::diagram, prose colons, dollar amounts) are in
// render.server.ts, because a pack sees the parsed tree, not the source.

import type { RenderPack } from "@drdustinedwards/site-helpers/render/packs";
import { toString as hastToString } from "hast-util-to-string";
import { visit, SKIP } from "unist-util-visit";

import { parseFaqPairs } from "./faq";
import { generateSlug } from "./format";

export interface PostLinkTarget {
  slug: string;
  title: string;
}

export interface FoxhoundPackOptions {
  /** Published posts a ::postlink may point at, by slug. */
  postLinks: ReadonlyMap<string, PostLinkTarget>;
  /** Diagram slugs that have a file at /diagrams/<slug>.svg (row F23). */
  diagrams?: ReadonlySet<string>;
}

// The block names the pack draws. render.server.ts turns any other ":::name"
// into a note callout first, as Recova does.
export const PACK_CONTAINERS = ["tip", "warning", "note", "danger", "pullquote", "toggle", "faq"] as const;
export const PACK_LEAVES = ["postlink", "diagram", "youtube", "bookmark"] as const;

const CALLOUTS: Record<string, string> = {
  tip: "\u{1F4A1}",
  warning: "\u{26A0}\u{FE0F}",
  note: "\u{1F4DD}",
  danger: "\u{1F6A8}",
};

// Inline-friendly, as Recova's (not line-anchored, so it works mid-paragraph).
export const POSTLINK_RE = /::postlink\[([^|\]]+)(?:\|([^\]]+))?\]/g;

// Links to these hosts stay in the tab (Recova: recovamrr.com links stay in-tab).
const INTERNAL_HOSTNAMES = /(^|\.)foxhoundapp\.com($|\/|:)|(^|\.)recovamrr\.com($|\/|:)/i;

// The tree, typed only as far as this pack reads it. Prelum's own nodes and
// remark-directive's carry more; nothing here depends on it.
interface MdNode {
  type: string;
  name?: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
}

interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: unknown[];
}

function textOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

/** A directive's [label], which remark-directive puts first among its children. */
function labelOf(node: MdNode): { label: string; rest: MdNode[] } {
  const children = node.children ?? [];
  const first = children[0];
  if (first && first.data?.directiveLabel) {
    return { label: textOf(first), rest: children.slice(1) };
  }
  return { label: textOf(node), rest: children };
}

/** The raw source between a block's opening line and its closing ":::", as
 *  Recova's FENCED_BLOCK_RE captures it, with render.server.ts's escapes undone. */
function rawContent(body: string, node: MdNode): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return textOf(node);
  const lines = body.slice(start, end).split("\n").slice(1);
  if (lines.length > 0 && lines[lines.length - 1].trim() === ":::") lines.pop();
  return unescapeSource(lines.join("\n"));
}

/** Undoes the three escapes render.server.ts writes into the source. */
export function unescapeSource(s: string): string {
  return s.replace(/\\([$:|])/g, "$1");
}

function element(tagName: string, properties: Record<string, unknown>, children: unknown[] = []): HastElement {
  return { type: "element", tagName, properties, children };
}

function hText(value: string) {
  return { type: "text", value };
}

/** A block whose tag and attributes are set directly; its children render as usual. */
function block(hName: string, hProperties: Record<string, unknown>, children: MdNode[]): MdNode {
  return { type: "fhBlock", data: { hName, hProperties }, children };
}

function postLinkNodes(slug: string, display: string | null, postLinks: ReadonlyMap<string, PostLinkTarget>): MdNode {
  const target = postLinks.get(slug);
  if (target) {
    return { type: "link", url: `/blog/${target.slug}`, children: [{ type: "text", value: display ?? target.title }] };
  }
  return { type: "inlineCode", value: display ? `::postlink[${slug}|${display}]` : `::postlink[${slug}]` };
}

function parsePostLink(arg: string): { slug: string; display: string | null } {
  const bar = arg.indexOf("|");
  const slug = (bar === -1 ? arg : arg.slice(0, bar)).trim();
  const display = bar === -1 ? "" : arg.slice(bar + 1).trim();
  return { slug, display: display.length > 0 ? display : null };
}

function extractYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const path = u.pathname.split("/").filter(Boolean);
      if (path.length >= 2 && /^(embed|shorts|v)$/.test(path[0]) && /^[a-zA-Z0-9_-]{11}$/.test(path[1])) {
        return path[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Recova's blocks and shortcodes, drawn in place. */
function remarkRecova(body: string, options: FoxhoundPackOptions) {
  const diagrams = options.diagrams ?? new Set<string>();
  return (tree: MdNode) => {
    visit(tree as never, (raw: unknown, index: number | undefined, parent: unknown) => {
      const node = raw as MdNode;
      const host = parent as MdNode | undefined;
      if (index === undefined || !host?.children) return;

      if (node.type === "containerDirective") {
        const name = node.name ?? "";
        if (name in CALLOUTS) {
          const { rest } = labelOf(node);
          host.children[index] = block("div", { className: ["blog-callout", `blog-callout-${name}`] }, [
            { type: "fhBlock", data: { hName: "span", hProperties: { className: ["blog-callout-icon"], ariaHidden: "true" }, hChildren: [hText(CALLOUTS[name])] } },
            block("div", { className: ["blog-callout-content"] }, rest),
          ]);
          return;
        }
        if (name === "pullquote") {
          host.children[index] = {
            type: "fhBlock",
            data: { hName: "blockquote", hProperties: { className: ["blog-pullquote"] }, hChildren: [hText(rawContent(body, node).trim())] },
          };
          return [SKIP, index];
        }
        if (name === "toggle") {
          const { label, rest } = labelOf(node);
          host.children[index] = block("details", { className: ["blog-toggle"] }, [
            { type: "fhBlock", data: { hName: "summary", hProperties: { className: ["blog-toggle-header"] }, hChildren: [hText(label.trim())] } },
            block("div", { className: ["blog-toggle-content"] }, rest),
          ]);
          return;
        }
        if (name === "faq") {
          const pairs = parseFaqPairs(rawContent(body, node));
          if (pairs.length === 0) {
            host.children.splice(index, 1);
            return [SKIP, index];
          }
          const items = pairs.map(({ q, a }) =>
            element("div", { className: ["blog-faq-item"] }, [
              element("dt", { className: ["blog-faq-question"] }, [hText(q)]),
              element("dd", { className: ["blog-faq-answer"] }, [hText(a)]),
            ]),
          );
          host.children[index] = {
            type: "fhBlock",
            data: {
              hName: "div",
              hProperties: { className: ["blog-faq"], dataFaq: "true" },
              hChildren: [element("dl", { className: ["blog-faq-list"] }, items)],
            },
          };
          return [SKIP, index];
        }
        return;
      }

      if (node.type === "leafDirective") {
        const name = node.name ?? "";
        const { label } = labelOf(node);
        if (name === "postlink") {
          const { slug, display } = parsePostLink(label);
          host.children[index] = { type: "paragraph", children: [postLinkNodes(slug, display, options.postLinks)] };
          return [SKIP, index];
        }
        if (name === "diagram") {
          const slug = label.trim();
          if (!diagrams.has(slug)) {
            host.children.splice(index, 1);
            return [SKIP, index];
          }
          host.children[index] = {
            type: "fhBlock",
            data: {
              hName: "figure",
              hProperties: { className: ["blog-diagram"] },
              hChildren: [element("img", { src: `/diagrams/${slug}.svg`, alt: `Diagram: ${slug.replace(/-/g, " ")}`, className: ["diagram-image"] })],
            },
          };
          return [SKIP, index];
        }
        if (name === "youtube") {
          const id = extractYouTubeId(label);
          if (!id) {
            host.children.splice(index, 1);
            return [SKIP, index];
          }
          host.children[index] = {
            type: "fhBlock",
            data: {
              hName: "div",
              hProperties: { className: ["blog-embed", "blog-embed-youtube"] },
              hChildren: [
                element("iframe", {
                  src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`,
                  title: "YouTube video",
                  loading: "lazy",
                  allowFullScreen: true,
                  frameBorder: "0",
                }),
              ],
            },
          };
          return [SKIP, index];
        }
        if (name === "bookmark") {
          // Foxhound's simplified bookmark: no live fetch of the page's tags.
          const url = label.trim();
          let text = url;
          let className: string[] | undefined;
          try {
            text = new URL(url).host.replace(/^www\./, "");
            className = ["blog-bookmark-link"];
          } catch {
            // Not a URL: shown as written.
          }
          host.children[index] = {
            type: "fhBlock",
            data: {
              hName: "a",
              hProperties: { href: url, target: "_blank", rel: ["noopener", "noreferrer"], ...(className ? { className } : {}) },
              hChildren: [hText(text)],
            },
          };
          return [SKIP, index];
        }
        return;
      }

      if (node.type === "text" && typeof node.value === "string" && node.value.includes("::postlink[")) {
        const out: MdNode[] = [];
        let last = 0;
        for (const m of node.value.matchAll(POSTLINK_RE)) {
          const at = m.index ?? 0;
          if (at > last) out.push({ type: "text", value: node.value.slice(last, at) });
          const display = m[2]?.trim() ?? "";
          out.push(postLinkNodes(m[1].trim(), display.length > 0 ? display : null, options.postLinks));
          last = at + m[0].length;
        }
        if (last < node.value.length) out.push({ type: "text", value: node.value.slice(last) });
        host.children.splice(index, 1, ...out);
        return [SKIP, index + out.length];
      }
      return;
    });
  };
}

/** Recova's heading ids: its generateSlug over the heading's HTML, counted
 *  across h2 and h3, a repeat taking -2, -3. Set before Prelum's slugger,
 *  which leaves an id alone. */
function rehypeRecovaHeadingIds() {
  return (tree: unknown) => {
    const used = new Map<string, number>();
    visit(tree as never, "element", (raw: unknown) => {
      const node = raw as HastElement;
      if (node.tagName !== "h2" && node.tagName !== "h3") return;
      // Recova slugged the heading's HTML, entities and all, so "A & B" is
      // "a-amp-b"; the escape is redone here so the id is the one it published.
      const html = hastToString(node as never).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const base = generateSlug(html.trim()) || "section";
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      node.properties.id = count === 0 ? base : `${base}-${count + 1}`;
    });
  };
}

/** Recova's link rule: off this site opens in a new tab, this site stays. */
function rehypeExternalLinks() {
  return (tree: unknown) => {
    visit(tree as never, "element", (raw: unknown) => {
      const node = raw as HastElement;
      if (node.tagName !== "a") return;
      const href = typeof node.properties.href === "string" ? node.properties.href : "";
      if (!/^https?:\/\//i.test(href) || INTERNAL_HOSTNAMES.test(href)) return;
      node.properties.target = "_blank";
      node.properties.rel = ["noopener", "noreferrer"];
    });
  };
}

export function foxhoundPack(options: FoxhoundPackOptions): RenderPack {
  return {
    name: "foxhound",
    directives: [...PACK_CONTAINERS, ...PACK_LEAVES],
    setup({ body }) {
      return {
        remark: [[remarkRecova, body, options]],
        rehype: [[rehypeRecovaHeadingIds], [rehypeExternalLinks]],
      };
    },
  };
}
