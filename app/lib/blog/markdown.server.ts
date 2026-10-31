// Blog posts render through Prelum, the family's markdown pipeline
// (@drdustinedwards/site-helpers/render), as every site's writing does. The
// no-math build: posts quote prices, so `$` stays text.
//
// What only Foxhound writes is one site pack:
//
//   - `:::faq` holds `Q:` / `A:` lines, rendered as legacy's definition list
//     and read again by extractFaqPairs for the FAQPage JSON-LD.
//   - `::postlink[slug|text]` sits mid-sentence and links to another post,
//     looked up in D1; an unknown slug shows as code so it is seen.
//   - Heading ids come from legacy's generateSlug, so links to a section
//     made before the move still land.
//   - Links off this site open in a new tab, as legacy's did.
//
// The hand-drawn diagrams are plain `:::figure`s with a dark twin
// (public/diagrams/<slug>-light|dark-<w>x<h>.svg): an SVG in an <img> cannot
// read the page's data-theme, so app.css shows the one that matches.

import { ContentError, render } from "@drdustinedwards/site-helpers/render/nomath";
import type { RenderPack } from "@drdustinedwards/site-helpers/render/packs";
import type { Element, ElementContent, Root as HastRoot } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import type { PhrasingContent, Root as MdastRoot, Text } from "mdast";
import type {} from "mdast-util-directive";
import { visit } from "unist-util-visit";

import type { Db } from "~/db";
import { images, mediaKeyOf, mediaKeysIn, mediaUrl } from "~/lib/media/images";
import { mediaRow, mediaRowsByKey, type MediaRow } from "~/lib/media/store.server";

import { generateSlug } from "./format";
import { resolvePostLink, type BlogPostSummary } from "./queries.server";

export interface TocItem {
  level: 2 | 3;
  text: string;
  id: string;
}

// Hosts treated as "this site" for the new-tab rule. Includes the legacy
// domain so imported posts that still reference old recovamrr.com URLs don't
// get a needless target="_blank". Matched against the URL's host: the old
// renderer matched the whole href, so its own links opened in a new tab too.
const INTERNAL_HOST = /(^|\.)(foxhoundapp|recovamrr)\.com$/i;

function isExternal(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    return !INTERNAL_HOST.test(new URL(href).hostname);
  } catch {
    return true;
  }
}

// Not line-anchored: a post link sits inside a sentence. remark-directive
// leaves `::name` mid-paragraph as text, which is where this finds it.
const POSTLINK_RE = /::postlink\[([^|\]]+)(?:\|([^\]]+))?\]/g;

interface FaqPair {
  q: string;
  a: string;
}

function parseFaqPairs(content: string): FaqPair[] {
  const pairs: FaqPair[] = [];
  let currentQ: string | null = null;
  let currentA: string[] = [];

  function flush() {
    if (currentQ && currentA.length > 0) {
      pairs.push({ q: currentQ.trim(), a: currentA.join(" ").trim() });
    }
    currentQ = null;
    currentA = [];
  }

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("Q:")) {
      flush();
      currentQ = line.slice(2).trim();
    } else if (line.startsWith("A:")) {
      currentA = [line.slice(2).trim()];
    } else if (line === "") {
      // blank, ignore
    } else if (currentA.length > 0) {
      currentA.push(line);
    }
  }
  flush();
  return pairs;
}

// Scan a raw post body for every :::faq block and return the flattened Q/A
// list. Used by blog/post.tsx to build FAQPage JSON-LD directly from the raw
// body, decoupled from the renderer's HTML structure. Returns [] for posts
// with no :::faq blocks. Pure; does not require renderMarkdown to have run.
export function extractFaqPairs(body: string): Array<{ question: string; answer: string }> {
  const pairs: Array<{ question: string; answer: string }> = [];
  const blockRe = /^:::faq(?:\[[^\]]*\])?\n([\s\S]*?)\n:::$/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body)) !== null) {
    for (const p of parseFaqPairs(m[1])) {
      pairs.push({ question: p.q, answer: p.a });
    }
  }
  return pairs;
}

function el(tagName: string, className: string, children: ElementContent[]): Element {
  return { type: "element", tagName, properties: { className: [className] }, children };
}

// The pairs are read from the block's source lines, not its parsed markdown,
// and shown as text: legacy escaped them, so `[a](b)` in an answer reads as
// written, and the JSON-LD (extractFaqPairs) says exactly what the page says.
function remarkFaq(body: string) {
  return (tree: MdastRoot) => {
    visit(tree, "containerDirective", (node, index, parent) => {
      if (node.name !== "faq" || !parent || index === undefined) return;
      const start = node.position?.start.offset ?? 0;
      const end = node.position?.end.offset ?? start;
      const lines = body.slice(start, end).split("\n");
      const content = lines.slice(1, lines.at(-1)?.trim() === ":::" ? -1 : undefined).join("\n");
      const pairs = parseFaqPairs(content);
      if (pairs.length === 0) {
        parent.children.splice(index, 1);
        return index;
      }
      const items = pairs.map(({ q, a }) =>
        el("div", "blog-faq-item", [
          el("dt", "blog-faq-question", [{ type: "text", value: q }]),
          el("dd", "blog-faq-answer", [{ type: "text", value: a }]),
        ]),
      );
      node.data = {
        hName: "div",
        hProperties: { className: ["blog-faq"], dataFaq: "true" },
        hChildren: [el("dl", "blog-faq-list", items)],
      };
    });
  };
}

function remarkPostLinks(db: Db) {
  return async (tree: MdastRoot) => {
    const found: Array<{ node: Text; parent: { children: PhrasingContent[] } }> = [];
    visit(tree, "text", (node, _index, parent) => {
      if (parent && node.value.includes("::postlink[")) {
        found.push({ node, parent: parent as { children: PhrasingContent[] } });
      }
    });

    const slugs = new Set<string>();
    for (const { node } of found) {
      for (const m of node.value.matchAll(POSTLINK_RE)) slugs.add(m[1].trim());
    }
    const targets = new Map(
      await Promise.all([...slugs].map(async (slug) => [slug, await resolvePostLink(db, slug)] as const)),
    );

    for (const { node, parent } of found) {
      const { value } = node;
      const parts: PhrasingContent[] = [];
      let at = 0;
      for (const m of value.matchAll(POSTLINK_RE)) {
        if (m.index > at) parts.push({ type: "text", value: value.slice(at, m.index) });
        const slug = m[1].trim();
        const display = m[2]?.trim() || null;
        const target = targets.get(slug);
        parts.push(
          target
            ? { type: "link", url: `/blog/${target.slug}`, children: [{ type: "text", value: display ?? target.title }] }
            : { type: "inlineCode", value: display ? `::postlink[${slug}|${display}]` : `::postlink[${slug}]` },
        );
        at = m.index + m[0].length;
      }
      if (at < value.length) parts.push({ type: "text", value: value.slice(at) });
      parent.children.splice(parent.children.indexOf(node), 1, ...parts);
    }
  };
}

// Before Prelum's own slugger, which keeps an id already set.
function rehypeHeadingIds() {
  return (tree: HastRoot) => {
    const used = new Map<string, number>();
    visit(tree, "element", (node) => {
      if (node.tagName !== "h2" && node.tagName !== "h3") return;
      const base = generateSlug(hastToString(node).trim()) || "section";
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      node.properties.id = count === 0 ? base : `${base}-${count + 1}`;
    });
  };
}

function rehypeExternalLinks() {
  return (tree: HastRoot) => {
    visit(tree, "element", (node) => {
      if (node.tagName === "a" && isExternal(String(node.properties.href ?? ""))) {
        node.properties.target = "_blank";
        node.properties.rel = ["noopener", "noreferrer"];
      }
    });
  };
}

function foxhoundPack(db: Db): RenderPack {
  return {
    name: "foxhound",
    directives: ["faq"],
    setup: ({ body }) => ({
      remark: [[remarkFaq, body], [remarkPostLinks, db]],
      rehype: [[rehypeHeadingIds], [rehypeExternalLinks]],
    }),
  };
}

// A post's images are the hand-drawn diagrams, which name their size
// (<name>-<width>x<height>.svg), and the media library's pictures, which the
// library's index sizes (/media/<key>, app/lib/carrel/media-adapter.server.ts).
// Either way the page reserves their space. A library picture is written with
// site-runtime ./image's srcset and AVIF and WebP sources, at the post column's
// width, and links to its original.
const DIAGRAM = /^\/diagrams\/[a-z0-9-]+-(\d+)x(\d+)\.svg$/;

type LibraryPicture = Pick<MediaRow, "key" | "width" | "height" | "focus" | "sha256">;

function mediaOptions(pictures: Map<string, LibraryPicture>) {
  const resolveImage = async (src: string): Promise<{ width: number; height: number }> => {
    const size = DIAGRAM.exec(src);
    if (size) return { width: Number(size[1]), height: Number(size[2]) };
    const key = mediaKeyOf(src);
    const picture = key ? pictures.get(key) : undefined;
    if (picture?.width && picture.height) return { width: picture.width, height: picture.height };
    throw new ContentError(
      "post",
      key
        ? `${src} is not in the media library; upload it there first`
        : `${src} is not an image this site serves; use a media library picture (/media/...) or a diagram in public/diagrams as <name>-<width>x<height>.svg`,
    );
  };
  const imageProps = (src: string) => {
    const key = mediaKeyOf(src);
    const picture = key ? pictures.get(key) : undefined;
    if (!picture) return null;
    const attrs = images.attributes({ src: mediaUrl(picture.key, picture.sha256), width: picture.width, height: picture.height, focus: picture.focus }, "content");
    if (!attrs.srcset) return null;
    return {
      srcSet: attrs.srcset,
      sizes: attrs.sizes,
      href: mediaUrl(picture.key, picture.sha256),
      sources: attrs.sources.map((source) => ({ type: source.type, srcSet: source.srcset })),
    };
  };
  return { resolveImage, media: { keyOf: mediaKeyOf, imageProps } };
}

/**
 * A post's cover: site-runtime ./image's attributes for `use`, and, for a media
 * library file, its versioned original at its real size, for the share card. A
 * cover from elsewhere is its own address, unsized. Null for a post with no cover.
 */
export async function coverPicture(
  db: Db,
  post: Pick<BlogPostSummary, "coverImageUrl" | "coverImageAlt" | "title">,
  use: "content" | "featured",
) {
  if (!post.coverImageUrl) return null;
  const key = mediaKeyOf(post.coverImageUrl);
  const row = key ? await mediaRow(db, key) : null;
  const src = row ? mediaUrl(row.key, row.sha256) : post.coverImageUrl;
  const alt = post.coverImageAlt ?? post.title;
  return {
    alt,
    picture: row ? images.attributes({ src, width: row.width, height: row.height, focus: row.focus }, use) : { src, sources: [] },
    original: { url: src, width: row?.width ?? undefined, height: row?.height ?? undefined, alt },
  };
}

export async function renderMarkdown(db: Db, body: string): Promise<{ html: string; toc: TocItem[] }> {
  const keys = mediaKeysIn(body);
  const pictures = new Map((keys.length > 0 ? await mediaRowsByKey(db, keys) : []).map((row) => [row.key, row]));
  const { resolveImage, media } = mediaOptions(pictures);
  const { html, toc } = await render({ file: "post", body, resolveImage, options: { packs: [foxhoundPack(db)], media } });
  return { html, toc: toc.map(({ depth, text, id }) => ({ level: depth === 2 ? 2 : 3, text, id })) };
}
