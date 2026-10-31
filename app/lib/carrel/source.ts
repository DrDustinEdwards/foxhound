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
//   author: "Dustin Edwards"
//   tags: ["billing", "recovery"]
//   featured: false
//   ---
//   Body markdown.

import { jsonSource, JsonSourceError } from "@dustinedwards/site-api/frontmatter";

export interface PostSource {
  title: string;
  slug: string | null;
  excerpt: string;
  author: string;
  tags: string[];
  featured: boolean;
  body: string;
}

export { JsonSourceError as SourceError };

const FIELDS = { title: "text", slug: "text", excerpt: "text", author: "text", tags: "list", featured: "flag" } as const;
const SOURCE = jsonSource(FIELDS, { required: ["title"] });
/** A preview reads a draft that may have no title, or no front matter at all, yet. */
const PREVIEW_SOURCE = jsonSource(FIELDS);

export function serializePostSource({ body, slug, ...post }: PostSource): string {
  return SOURCE.write({ ...post, slug: slug || undefined }, body);
}

/** With `preview`, a missing title reads as "Untitled"; a save still refuses a source without one. */
export function parsePostSource(source: string, defaults: { author: string }, { preview = false } = {}): PostSource {
  const { values: v, body } = (preview ? PREVIEW_SOURCE : SOURCE).read(source);
  return {
    title: v.title?.trim() ? v.title : preview ? "Untitled" : "",
    slug: v.slug ?? null,
    excerpt: v.excerpt ?? "",
    author: v.author ?? defaults.author,
    tags: v.tags ?? [],
    featured: v.featured ?? false,
    body,
  };
}
