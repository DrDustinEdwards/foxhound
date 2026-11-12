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
// A hand-drawn diagram is a `:::figure` that names its light and dark files.
// The renderer takes that pair out and inlines one SVG (./diagrams). An
// <img> cannot read the page's colors; the inlined drawing's classes take
// their fills from the site's variables, so the same art follows the theme.

import { ContentError, RENDER_VERSION, render } from "@drdustinedwards/site-helpers/render/nomath";
import type { RenderPack } from "@drdustinedwards/site-helpers/render/packs";
import { keyOfAddress, keysAtAddresses } from "@dustinedwards/site-runtime/image";
import type { Root as HastRoot } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import { visit } from "unist-util-visit";

import type { Db } from "~/db";
import { MEDIA_ADDRESSES, images, mediaUrl } from "~/lib/media/images";
import { mediaRow, mediaRowsByKey, type MediaRow } from "~/lib/media/store.server";

import { BLOG_DIAGRAMS } from "./diagrams";
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

// A post's pictures are the media library's (/media/<key>, sized by the
// library's index in app/lib/carrel/media-adapter.server.ts). A library
// picture is written with site-runtime ./image's srcset and AVIF and WebP
// sources, at the post column's width, and links to its original. A diagram
// figure never reaches this: it is inlined first. A markdown image that still
// names a sized drawing (/diagrams/<name>-<width>x<height>.svg) keeps that
// size so the page can reserve it.
const DIAGRAM = /^\/diagrams\/[a-z0-9-]+-(\d+)x(\d+)\.svg$/;

type LibraryPicture = Pick<MediaRow, "key" | "width" | "height" | "focus" | "sha256">;

function mediaOptions(pictures: Map<string, LibraryPicture>) {
  const resolveImage = async (src: string): Promise<{ width: number; height: number }> => {
    const size = DIAGRAM.exec(src);
    if (size) return { width: Number(size[1]), height: Number(size[2]) };
    const key = keyOfAddress(src, MEDIA_ADDRESSES);
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
    const key = keyOfAddress(src, MEDIA_ADDRESSES);
    const picture = key ? pictures.get(key) : undefined;
    if (!picture) return null;
    const attrs = images.attributes(
      {
        src: mediaUrl(picture.key, picture.sha256),
        width: picture.width,
        height: picture.height,
        focus: picture.focus,
      },
      "content",
    );
    if (!attrs.srcset) return null;
    return {
      srcSet: attrs.srcset,
      sizes: attrs.sizes,
      href: mediaUrl(picture.key, picture.sha256),
      sources: attrs.sources.map((source) => ({ type: source.type, srcSet: source.srcset })),
    };
  };
  return {
    resolveImage,
    media: { keyOf: (src: string) => keyOfAddress(src, MEDIA_ADDRESSES), imageProps },
  };
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
  const key = keyOfAddress(post.coverImageUrl, MEDIA_ADDRESSES);
  const row = key ? await mediaRow(db, key) : null;
  const src = row ? mediaUrl(row.key, row.sha256) : post.coverImageUrl;
  const alt = post.coverImageAlt ?? post.title;
  return {
    alt,
    picture: images.attributes(
      row
        ? {
            src,
            width: row.width,
            height: row.height,
            focus: row.focus,
            placeholder: row.placeholder,
            color: row.color,
          }
        : { src, width: null, height: null },
      use,
    ),
    original: {
      url: src,
      width: row?.width ?? undefined,
      height: row?.height ?? undefined,
      type: row?.contentType,
      alt,
    },
    // The Article's image set: Google's 16:9, 4:3 and 1:1 crops at 1200 wide around the focal point (site-relative).
    article: row
      ? images.articleImages({ src, width: row.width, height: row.height, focus: row.focus })
      : [],
  };
}

// The pair the posts were given when the drawings moved to :::figure. Both
// files named one drawing; the slug is the drawing.
const DIAGRAM_FIGURE =
  /^:::figure\{src="\/diagrams\/([a-z0-9-]+)-light-(\d+)x(\d+)\.svg" dark="\/diagrams\/\1-dark-\2x\3\.svg" alt="[^"]*"\}\r?\n:::$/gm;

// The net-revenue-retention post answers 410, and its drawing is not shipped.
// An old body that still names the pair renders with the figure gone.
const RETIRED_DIAGRAMS = new Set(["nrr-calculation"]);

function diagramToken(index: number): string {
  return `XBLOGDIAGRAM${index}X`;
}

function inlineDiagram(slug: string): string {
  if (RETIRED_DIAGRAMS.has(slug)) return "";
  const svg = BLOG_DIAGRAMS[slug];
  if (!svg) {
    throw new ContentError("post", `${slug} is not a diagram this site draws`);
  }
  const titleId = `${slug}-title`;
  const descId = `${slug}-desc`;
  const drawing = svg
    .trim()
    .replace("<title>", `<title id="${titleId}">`)
    .replace("<desc>", `<desc id="${descId}">`);
  return `<figure class="blog-diagram" role="img" aria-labelledby="${titleId}" aria-describedby="${descId}">${drawing}</figure>`;
}

// Lift each diagram figure out before Prelum sees it. Prelum would draw the
// pair as two <img>s, and the sanitizer would drop an SVG written in the
// source. The tokens are stitched back as the inlined figure afterwards.
function takeDiagramFigures(body: string): { body: string; slugs: string[] } {
  const slugs: string[] = [];
  const next = body.replace(DIAGRAM_FIGURE, (_match, slug: string) => {
    const token = diagramToken(slugs.length);
    slugs.push(slug);
    return `\n\n${token}\n\n`;
  });
  return { body: next, slugs };
}

function stitchDiagramFigures(html: string, slugs: string[]): string {
  return slugs.reduce((out, slug, index) => {
    const token = diagramToken(index);
    const figure = inlineDiagram(slug);
    const wrapped = `<p>${token}</p>`;
    if (out.includes(wrapped)) return out.split(wrapped).join(figure);
    return out.split(token).join(figure);
  }, html);
}

export async function renderMarkdown(
  db: Db,
  body: string,
): Promise<{
  html: string;
  toc: TocItem[];
  faq: Array<{ question: string; answer: string }>;
  version: string;
}> {
  const diagrams = takeDiagramFigures(body);
  const keys = [...keysAtAddresses(diagrams.body, MEDIA_ADDRESSES)];
  const pictures = new Map((await mediaRowsByKey(db, keys)).map((row) => [row.key, row]));
  const { resolveImage, media } = mediaOptions(pictures);
  const postLink = async (slug: string) => {
    const target = await resolvePostLink(db, slug);
    return target && { url: `/blog/${target.slug}`, title: target.title };
  };
  const rendered = await render({
    file: "post",
    body: diagrams.body,
    resolveImage,
    options: { packs: [foxhoundPack], media, postLink },
  });
  const html = stitchDiagramFigures(rendered.html, diagrams.slugs);
  const { toc, faq } = rendered;
  // version goes on the body's wrapper (data-render-version), so prelum-content can see a page rendered by an older
  // pipeline, such as one the edge cache still holds after a Prelum update.
  return {
    html,
    toc: toc.map(({ depth, text, id }) => ({ level: depth === 2 ? 2 : 3, text, id })),
    faq,
    version: RENDER_VERSION,
  };
}
