// Blog posts render through Prelum, the family's markdown pipeline
// (@drdustinedwards/site-helpers/render), as every site's writing does. The
// no-math build: posts quote prices, so `$` stays text.
//
// Prelum's own blocks carry the `:::faq` list (its pairs feed the FAQPage
// JSON-LD) and `::postlink[slug|text]`, looked up in D1 (an unknown slug shows
// as code so it is seen). What only Foxhound writes is one site pack:
//
//   - Heading ids come from legacy's generateSlug, so links to a section
//     made before the move still land.
//   - Links off this site open in a new tab, as legacy's did.
//
// The hand-drawn diagrams are plain `:::figure`s with a dark twin
// (public/diagrams/<slug>-light|dark-<w>x<h>.svg): an SVG in an <img> cannot
// read the page's data-theme, so app.css shows the one that matches.

import { ContentError, RENDER_VERSION, render } from "@drdustinedwards/site-helpers/render/nomath";
import type { RenderPack } from "@drdustinedwards/site-helpers/render/packs";
import type { Root as HastRoot } from "hast";
import { toString as hastToString } from "hast-util-to-string";
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

const foxhoundPack: RenderPack = {
  name: "foxhound",
  directives: [],
  setup: () => ({
    remark: [],
    rehype: [[rehypeHeadingIds]],
  }),
};

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
 * A post's cover: site-runtime ./image's attributes for `use` (with the stored
 * placeholder and color it shows while it loads), and, for a media library file,
 * its versioned original at its real size, for the share card. A cover from
 * elsewhere is its own address, unsized. Null for a post with no cover.
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
    picture: images.attributes(
      row
        ? { src, width: row.width, height: row.height, focus: row.focus, placeholder: row.placeholder, color: row.color }
        : { src, width: null, height: null },
      use,
    ),
    original: { url: src, width: row?.width ?? undefined, height: row?.height ?? undefined, type: row?.contentType, alt },
  };
}

export async function renderMarkdown(
  db: Db,
  body: string,
): Promise<{ html: string; toc: TocItem[]; faq: Array<{ question: string; answer: string }>; version: string }> {
  const keys = mediaKeysIn(body);
  const pictures = new Map((keys.length > 0 ? await mediaRowsByKey(db, keys) : []).map((row) => [row.key, row]));
  const { resolveImage, media } = mediaOptions(pictures);
  const postLink = async (slug: string) => {
    const target = await resolvePostLink(db, slug);
    return target && { url: `/blog/${target.slug}`, title: target.title };
  };
  const { html, toc, faq } = await render({ file: "post", body, resolveImage, options: { packs: [foxhoundPack], media, postLink } });
  // version goes on the body's wrapper (data-render-version), so prelum-content can see a page rendered by an older
  // pipeline, such as one the edge cache still holds after a Prelum update.
  return { html, toc: toc.map(({ depth, text, id }) => ({ level: depth === 2 ? 2 : 3, text, id })), faq, version: RENDER_VERSION };
}
