// The write path for blog_posts / blog_post_versions. Its one caller is the
// Carrel site adapter (app/lib/carrel/adapter.server.ts): Carrel is the blog
// editor, and Foxhound's own /admin/blog editor is gone.
// The editor's list, version and related-post helpers went with it. The public
// read path (queries.server.ts) is untouched.

import { and, desc, eq, ne } from "drizzle-orm";

import type { Db } from "~/db";
import { blogPostVersions, blogPosts } from "~/db";

import { estimateReadingTime, generateSlug } from "./format";

/** Keep at most this many saved versions per post (SCHEMA.md: "version
 *  retention: keep last 10 per post"). Enforced on every update, not just at
 *  read time, so the table never grows unbounded per post. */
const BLOG_VERSION_RETENTION = 10;

/** A slug candidate derived from a title, deduped against existing slugs by
 *  appending -2, -3, ... Bounded loop (100 tries) so a pathological input
 *  can never spin forever. */
export async function uniqueSlugFromTitle(db: Db, title: string, excludePostId?: string): Promise<string> {
  const base = generateSlug(title) || "post";
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const where = excludePostId
      ? and(eq(blogPosts.slug, candidate), ne(blogPosts.id, excludePostId))
      : eq(blogPosts.slug, candidate);
    const existing = await db.select({ id: blogPosts.id }).from(blogPosts).where(where).limit(1);
    if (existing.length === 0) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export interface CreatePostInput {
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  author: string;
  tags: string[];
  featured: boolean;
  coverImageUrl?: string | null;
  coverImageAlt?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  canonicalUrl?: string | null;
  /** Caller-chosen id (the Carrel adapter, whose create names the id). */
  id?: string;
}

export async function createPost(db: Db, input: CreatePostInput): Promise<string> {
  const id = input.id ?? crypto.randomUUID();
  const now = new Date();
  await db.insert(blogPosts).values({
    id,
    slug: input.slug,
    title: input.title,
    excerpt: input.excerpt,
    body: input.body,
    author: input.author,
    tags: input.tags,
    featured: input.featured,
    readingMinutes: estimateReadingTime(input.body),
    published: false,
    publishedAt: null,
    coverImageUrl: input.coverImageUrl ?? null,
    coverImageAlt: input.coverImageAlt ?? null,
    ogTitle: input.ogTitle ?? null,
    ogDescription: input.ogDescription ?? null,
    canonicalUrl: input.canonicalUrl ?? null,
    showUpdatedAt: true,
    showPublishedAt: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export interface UpdatePostInput {
  title: string;
  excerpt: string;
  body: string;
  author: string;
  tags: string[];
  featured: boolean;
  coverImageUrl: string | null;
  coverImageAlt: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  canonicalUrl: string | null;
  showUpdatedAt: boolean;
  showPublishedAt: boolean;
}

/** Saves the PRE-edit state as a version snapshot, then applies the update,
 *  then prunes versions beyond BLOG_VERSION_RETENTION. Three plain
 *  operational writes (not a money write - content editing, no DO), matching
 *  the operational-write precedent (gotcha #25) elsewhere in this codebase. */
export async function updatePostWithVersion(
  db: Db,
  postId: string,
  savedBy: string,
  input: UpdatePostInput,
): Promise<void> {
  const existingRows = await db.select().from(blogPosts).where(eq(blogPosts.id, postId)).limit(1);
  const existing = existingRows[0];
  if (!existing) throw new Error("Post not found");

  const now = new Date();
  await db.insert(blogPostVersions).values({
    id: crypto.randomUUID(),
    postId,
    title: existing.title,
    body: existing.body,
    excerpt: existing.excerpt,
    savedAt: now,
    savedBy,
  });

  await db
    .update(blogPosts)
    .set({
      title: input.title,
      excerpt: input.excerpt,
      body: input.body,
      author: input.author,
      tags: input.tags,
      featured: input.featured,
      readingMinutes: estimateReadingTime(input.body),
      coverImageUrl: input.coverImageUrl,
      coverImageAlt: input.coverImageAlt,
      ogTitle: input.ogTitle,
      ogDescription: input.ogDescription,
      canonicalUrl: input.canonicalUrl,
      showUpdatedAt: input.showUpdatedAt,
      showPublishedAt: input.showPublishedAt,
      updatedAt: now,
    })
    .where(eq(blogPosts.id, postId));

  const versions = await db
    .select({ id: blogPostVersions.id })
    .from(blogPostVersions)
    .where(eq(blogPostVersions.postId, postId))
    .orderBy(desc(blogPostVersions.savedAt));
  const toDelete = versionIdsToPrune(
    versions.map((v) => v.id),
    BLOG_VERSION_RETENTION,
  );
  for (const id of toDelete) {
    await db.delete(blogPostVersions).where(eq(blogPostVersions.id, id));
  }
}

/** Pure: given version ids newest-first, which ids exceed the retention
 *  count. Split out so the retention boundary (off-by-one on exactly
 *  `retention` versions, 0 versions, fewer than `retention`) is
 *  unit-testable without a database. */
function versionIdsToPrune(idsNewestFirst: string[], retention: number): string[] {
  return idsNewestFirst.slice(retention);
}

/** `firstPublishedAt` is the date a first publication records: now by default,
 *  the time it was scheduled for when a schedule publishes it. */
export async function setPublished(
  db: Db,
  postId: string,
  published: boolean,
  firstPublishedAt: Date = new Date(),
): Promise<void> {
  const rows = await db.select({ publishedAt: blogPosts.publishedAt }).from(blogPosts).where(eq(blogPosts.id, postId)).limit(1);
  const current = rows[0];
  await db
    .update(blogPosts)
    .set({
      published,
      // First publish stamps publishedAt; unpublishing never clears it (so a
      // later republish keeps its original publish date, matching how the
      // public blog's "showPublishedAt" toggle is meant to work).
      publishedAt: published && !current?.publishedAt ? firstPublishedAt : current?.publishedAt,
      updatedAt: new Date(),
    })
    .where(eq(blogPosts.id, postId));
}
