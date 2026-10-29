// Blog data layer (D1/Drizzle). Public reads only: posts are written through
// Carrel's site adapter (admin-queries.server.ts), never from here. blog_posts / blog_post_links are GLOBAL
// tables (no account_id), so none of these queries take an accountId.
//
// Ported from legacy lib/blog.ts's read functions onto Drizzle/D1, filtered
// to published = true and ordered by published_at desc, matching legacy's
// anon-SSR-client (RLS-gated) read behavior.

import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { blogPostLinks, blogPosts } from "~/db";

export interface BlogPostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverImageUrl: string | null;
  coverImageAlt: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  author: string;
  tags: string[];
  featured: boolean;
  readingTimeMinutes: number;
}

export interface BlogPost extends BlogPostSummary {
  body: string;
  createdAt: Date;
  published: boolean;
  ogTitle: string | null;
  ogDescription: string | null;
  canonicalUrl: string | null;
  showUpdatedAt: boolean;
  showPublishedAt: boolean;
}

// Columns needed to build a summary. No body: reading time is precomputed at
// write time into reading_minutes (perf-audit fix, foxhound-audit-perf.md
// M-2), so a list/tag-archive read never pulls the full markdown body just
// to render a card. Only getPostBySlug (the single-post detail read) selects
// the full row, body included.
const SUMMARY_COLUMNS = {
  id: blogPosts.id,
  slug: blogPosts.slug,
  title: blogPosts.title,
  excerpt: blogPosts.excerpt,
  coverImageUrl: blogPosts.coverImageUrl,
  coverImageAlt: blogPosts.coverImageAlt,
  publishedAt: blogPosts.publishedAt,
  updatedAt: blogPosts.updatedAt,
  author: blogPosts.author,
  tags: blogPosts.tags,
  featured: blogPosts.featured,
  readingMinutes: blogPosts.readingMinutes,
};

type SummaryRow = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverImageUrl: string | null;
  coverImageAlt: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  author: string;
  tags: string[] | null;
  featured: boolean;
  readingMinutes: number;
};

function toSummary(r: SummaryRow): BlogPostSummary {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    coverImageUrl: r.coverImageUrl,
    coverImageAlt: r.coverImageAlt,
    publishedAt: r.publishedAt,
    updatedAt: r.updatedAt,
    author: r.author,
    tags: r.tags ?? [],
    featured: r.featured,
    readingTimeMinutes: r.readingMinutes,
  };
}

/** Most recent published posts, newest first. Mirrors legacy getBlogPosts. */
export async function listPublishedPosts(db: Db, limit?: number): Promise<BlogPostSummary[]> {
  const base = db
    .select(SUMMARY_COLUMNS)
    .from(blogPosts)
    .where(eq(blogPosts.published, true))
    .orderBy(desc(blogPosts.publishedAt));
  const rows = typeof limit === "number" ? await base.limit(limit) : await base;
  return rows.map(toSummary);
}

/** The set of tags carried by at least one published post. The archive
 *  renders a filter pill only for these, so a canonical tag with no content
 *  never offers a chip that leads to an empty page (Dustin, ruling 72
 *  session). CANONICAL_TAGS stays the full list, because the sitemap and
 *  llms.txt still enumerate it. Selects the one column it needs rather than
 *  reusing getAllPublishedPosts, and unions in JS rather than reaching for a
 *  json_each FROM clause, which Drizzle's builder cannot express and which
 *  CLAUDE.md's raw-dialect rule would bar anyway. */
export async function getPublishedTagSet(db: Db): Promise<string[]> {
  const rows = await db
    .select({ tags: blogPosts.tags })
    .from(blogPosts)
    .where(eq(blogPosts.published, true));
  const seen = new Set<string>();
  for (const row of rows) {
    for (const tag of row.tags ?? []) seen.add(tag);
  }
  return [...seen];
}

/** Every published post, newest first. Mirrors legacy getAllPublishedPosts;
 *  used by the sitemap and the feed. The tag archive uses
 *  getPublishedPostsByTag instead (SQL-filtered, perf-audit fix M-2), not
 *  this. Content volume here is small (dozens of posts, not thousands), so a
 *  full scan is the simplest correct query; there is no pagination need yet. */
export async function getAllPublishedPosts(db: Db): Promise<BlogPostSummary[]> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(blogPosts)
    .where(eq(blogPosts.published, true))
    .orderBy(desc(blogPosts.publishedAt));
  return rows.map(toSummary);
}

/** Published posts carrying `tag`, newest first, filtered in SQL (a
 *  json_each EXISTS predicate against the JSON-encoded tags column) rather
 *  than fetching every published post and filtering in memory (perf-audit
 *  fix, foxhound-audit-perf.md M-2: the tag archive used to read every
 *  post's full body via getAllPublishedPosts + filterPostsByTag just to
 *  render a handful of matching cards). */
export async function getPublishedPostsByTag(db: Db, tag: string): Promise<BlogPostSummary[]> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(blogPosts)
    .where(
      and(
        eq(blogPosts.published, true),
        sql`EXISTS (SELECT 1 FROM json_each(${blogPosts.tags}) WHERE value = ${tag})`,
      ),
    )
    .orderBy(desc(blogPosts.publishedAt));
  return rows.map(toSummary);
}

/** Most-recently-published featured post, or null. Mirrors legacy getFeaturedPost. */
export async function getFeaturedPost(db: Db): Promise<BlogPostSummary | null> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(blogPosts)
    .where(and(eq(blogPosts.published, true), eq(blogPosts.featured, true)))
    .orderBy(desc(blogPosts.publishedAt))
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : null;
}

/** Batch-fetch published posts by slug, returned in the order `slugs`
 *  specifies (an editorial sort), not DB order. Missing slugs are skipped.
 *  Mirrors legacy getPostsBySlug. */
export async function getPostsBySlug(db: Db, slugs: string[]): Promise<BlogPostSummary[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(blogPosts)
    .where(and(eq(blogPosts.published, true), inArray(blogPosts.slug, slugs)));
  const bySlug = new Map(rows.map((r) => [r.slug, toSummary(r)]));
  return slugs.flatMap((s) => {
    const p = bySlug.get(s);
    return p ? [p] : [];
  });
}

/** A single published post by slug, full body included, or null. Mirrors
 *  legacy getBlogPost. */
export async function getPostBySlug(db: Db, slug: string): Promise<BlogPost | null> {
  const rows = await db
    .select()
    .from(blogPosts)
    .where(and(eq(blogPosts.slug, slug), eq(blogPosts.published, true)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ...toSummary(r),
    body: r.body,
    createdAt: r.createdAt,
    published: r.published,
    ogTitle: r.ogTitle,
    ogDescription: r.ogDescription,
    canonicalUrl: r.canonicalUrl,
    showUpdatedAt: r.showUpdatedAt,
    showPublishedAt: r.showPublishedAt,
  };
}

// Adjacent-post helpers for the prev/next nav on post detail. Sort key is
// the composite (published_at, id) so posts sharing an exact publish
// timestamp still produce a stable, total ordering (mirrors legacy's
// .or() + dual .order() pair).

/** The published post immediately before `publishedAt`/`postId` in the
 *  chronological order, or null if this is the oldest post. */
export async function getPreviousPost(
  db: Db,
  publishedAt: Date,
  postId: string,
): Promise<BlogPostSummary | null> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(blogPosts)
    .where(
      and(
        eq(blogPosts.published, true),
        or(
          lt(blogPosts.publishedAt, publishedAt),
          and(eq(blogPosts.publishedAt, publishedAt), lt(blogPosts.id, postId)),
        ),
      ),
    )
    .orderBy(desc(blogPosts.publishedAt), desc(blogPosts.id))
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : null;
}

/** The published post immediately after `publishedAt`/`postId`, or null if
 *  this is the newest post. */
export async function getNextPost(
  db: Db,
  publishedAt: Date,
  postId: string,
): Promise<BlogPostSummary | null> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(blogPosts)
    .where(
      and(
        eq(blogPosts.published, true),
        or(
          gt(blogPosts.publishedAt, publishedAt),
          and(eq(blogPosts.publishedAt, publishedAt), gt(blogPosts.id, postId)),
        ),
      ),
    )
    .orderBy(asc(blogPosts.publishedAt), asc(blogPosts.id))
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : null;
}

/** Curated "Further reading" links for a post, in editor-set order.
 *  Mirrors legacy getPostLinks; only resolves to published targets. */
export async function getPostLinks(db: Db, postId: string): Promise<BlogPostSummary[]> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(blogPostLinks)
    .innerJoin(blogPosts, eq(blogPosts.id, blogPostLinks.targetId))
    .where(and(eq(blogPostLinks.sourceId, postId), eq(blogPosts.published, true)))
    .orderBy(asc(blogPostLinks.position));
  return rows.map(toSummary);
}

/** Resolve `::postlink[slug]` markdown references to a current title+slug.
 *  Only resolves to published posts; unresolved slugs are the renderer's
 *  problem (falls back to inline <code>). Mirrors legacy resolvePostLink. */
export async function resolvePostLink(
  db: Db,
  slug: string,
): Promise<{ slug: string; title: string } | null> {
  const rows = await db
    .select({ slug: blogPosts.slug, title: blogPosts.title })
    .from(blogPosts)
    .where(and(eq(blogPosts.slug, slug), eq(blogPosts.published, true)))
    .limit(1);
  return rows[0] ?? null;
}
