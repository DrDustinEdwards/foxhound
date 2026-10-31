// The markdown "source" Carrel reads and writes for one blog post.
// Carrel sees one markdown document per post, so the post's
// non-body fields travel as a small front matter block. Every value is a JSON
// literal on one line, so the round trip is lossless and needs no YAML parser. The reader and
// writer are site-api's jsonSource, given this field list:
//
//   ---
//   title: "Why cards fail"
//   slug: "why-cards-fail"
//   excerpt: "..."
//   authors: ["Dustin Edwards"]
//   series: "Recovery basics"
//   seriesPart: 2
//   tags: ["billing", "recovery"]
//   featured: false
//   searchTitle: "Why cards fail, and what to do"
//   ---
//   Body markdown.
//
// The search fields carry site-api's shared names over the blog_posts columns: searchTitle is og_title, description
// is og_description, canonical is canonical_url, noindex is noindex. A blank one is left out and clears its column.
// So do the post fields (site-api's POST_FIELDS): authors, series and seriesPart. A source written before authors
// carries the one name under `author`, which is still read (never written).

import { jsonSource, JsonSourceError } from "@dustinedwards/site-api/frontmatter";

export interface PostSource {
  title: string;
  slug: string | null;
  excerpt: string;
  authors: string[];
  series?: string | null;
  seriesPart?: number | null;
  tags: string[];
  featured: boolean;
  searchTitle?: string | null;
  description?: string | null;
  canonical?: string | null;
  image?: string | null;
  imageAlt?: string | null;
  noindex?: boolean;
  body: string;
}

export { JsonSourceError as SourceError };

const FIELDS = {
  title: "text",
  slug: "text",
  excerpt: "text",
  authors: "list",
  series: "text",
  seriesPart: "text",
  /** The key before authors: read, never written. */
  author: "text",
  tags: "list",
  featured: "flag",
  searchTitle: "text",
  description: "text",
  canonical: "text",
  image: "text",
  imageAlt: "text",
  noindex: "flag",
} as const;
const SOURCE = jsonSource(FIELDS, { required: ["title"] });
/** A preview reads a draft that may have no title, or no front matter at all, yet. */
const PREVIEW_SOURCE = jsonSource(FIELDS);

export function serializePostSource({ body, slug, series, seriesPart, searchTitle, description, canonical, image, imageAlt, noindex, ...post }: PostSource): string {
  return SOURCE.write(
    {
      ...post,
      slug: slug || undefined,
      series: series || undefined,
      // A number in the source, as site-api's setPostFields writes it; the reader takes either.
      seriesPart: (seriesPart ?? undefined) as unknown as string | undefined,
      searchTitle: searchTitle || undefined,
      description: description || undefined,
      canonical: canonical || undefined,
      image: image || undefined,
      imageAlt: imageAlt || undefined,
      noindex: noindex || undefined,
    },
    body,
  );
}

function partOf(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const part = Number(raw);
  if (!Number.isInteger(part) || part < 1) throw new JsonSourceError(["seriesPart must be a whole number, 1 or more."]);
  return part;
}

/** With `preview`, a missing title reads as "Untitled"; a save still refuses a source without one. No authors (and no
 *  older `author`) reads as `defaults.authors`. */
export function parsePostSource(source: string, defaults: { authors: string[] }, { preview = false } = {}): PostSource {
  const { values: v, body } = (preview ? PREVIEW_SOURCE : SOURCE).read(source);
  const authors = v.authors ?? (v.author?.trim() ? [v.author.trim()] : []);
  return {
    title: v.title?.trim() ? v.title : preview ? "Untitled" : "",
    slug: v.slug ?? null,
    excerpt: v.excerpt ?? "",
    authors: authors.length ? authors : defaults.authors,
    series: v.series?.trim() || null,
    seriesPart: partOf(v.seriesPart),
    tags: v.tags ?? [],
    featured: v.featured ?? false,
    searchTitle: v.searchTitle?.trim() || null,
    description: v.description?.trim() || null,
    canonical: v.canonical?.trim() || null,
    image: v.image?.trim() || null,
    imageAlt: v.imageAlt?.trim() || null,
    noindex: v.noindex ?? false,
    body,
  };
}
