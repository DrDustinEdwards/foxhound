// The write path for blog_posts / blog_post_versions. Its one caller is the
// Carrel site adapter (app/lib/carrel/adapter.server.ts): Carrel is the blog
// editor, and Foxhound's own /admin/blog editor is gone.
// The editor's list, version and related-post helpers went with it. The public
// read path (queries.server.ts) is untouched.

import { and, eq, ne, or } from "drizzle-orm";

import type { Db } from "~/db";
import { blogPostLinks, blogPostVersions, blogPosts, blogSlugRedirects } from "~/db";

import { estimateReadingTime, generateSlug } from "./format";

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
  ogImageUrl?: string | null;
  ogImageAlt?: string | null;
  noindex?: boolean;
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
    ogImageUrl: input.ogImageUrl ?? null,
    ogImageAlt: input.ogImageAlt ?? null,
    noindex: input.noindex ?? false,
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
  ogImageUrl: string | null;
  ogImageAlt: string | null;
  noindex: boolean;
  showUpdatedAt: boolean;
  showPublishedAt: boolean;
}

/** Saves the PRE-edit state as a version snapshot, then applies the update.
 *  Every version is kept: site-api's contract (v0.17.0, "Revisions") has a
 *  site never prune one, so any publish can be undone; only a delete removes
 *  them. Plain operational writes (not a money write - content editing, no
 *  DO), matching the operational-write precedent (gotcha #25). */
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
      ogImageUrl: input.ogImageUrl,
      ogImageAlt: input.ogImageAlt,
      noindex: input.noindex,
      showUpdatedAt: input.showUpdatedAt,
      showPublishedAt: input.showPublishedAt,
      updatedAt: now,
    })
    .where(eq(blogPosts.id, postId));
}

/** `firstPublishedAt` is the date a first publication records: now by default,
 *  the time it was scheduled for when a schedule publishes it. `publishedAt`,
 *  where given, is the date the post is published under whether or not it was
 *  live before (Carrel's settable publish date: a backdate or a re-date). */
export async function setPublished(
  db: Db,
  postId: string,
  published: boolean,
  { firstPublishedAt = new Date(), publishedAt }: { firstPublishedAt?: Date; publishedAt?: Date } = {},
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
      publishedAt: publishedAt ?? (published && !current?.publishedAt ? firstPublishedAt : current?.publishedAt),
      updatedAt: new Date(),
    })
    .where(eq(blogPosts.id, postId));
}

/** Into the trash (`trashedAt` set) or back out of it. Either way the post is
 *  a draft: a trashed post is off the blog, and a restore never republishes. */
export async function setTrashed(db: Db, postId: string, trashed: boolean): Promise<void> {
  const now = new Date();
  await db
    .update(blogPosts)
    .set({ published: false, trashedAt: trashed ? now : null, updatedAt: now })
    .where(eq(blogPosts.id, postId));
}

/** Deletes the post for good, with its versions, the further-reading links to
 *  and from it, and the redirects that led to it, as one batch. */
export async function deletePost(db: Db, postId: string, slug: string): Promise<void> {
  await db.batch([
    db.delete(blogPostLinks).where(or(eq(blogPostLinks.sourceId, postId), eq(blogPostLinks.targetId, postId))),
    db.delete(blogPostVersions).where(eq(blogPostVersions.postId, postId)),
    db.delete(blogSlugRedirects).where(eq(blogSlugRedirects.toSlug, slug)),
    db.delete(blogPosts).where(eq(blogPosts.id, postId)),
  ]);
}

/**
 * Moves a post to `newId`, which becomes its slug too, so /blog/<newId> is its
 * address. One batch. The row is copied rather than its key updated, because
 * the version and link tables' foreign keys have no ON UPDATE: the copy goes
 * in under a slug no post can hold (a slug has no ":"), the children move to
 * it, the old row goes, and the copy takes its slug. With `redirect`, the old
 * address answers a 301 to the new one, and every older address that led to
 * the old one now leads straight to the new one.
 */
export async function renamePost(
  db: Db,
  row: typeof blogPosts.$inferSelect,
  newId: string,
  { redirect }: { redirect: boolean },
): Promise<void> {
  const now = new Date();
  const moved = [
    db.insert(blogPosts).values({ ...row, id: newId, slug: `rename:${newId}`, updatedAt: now }),
    db.update(blogPostVersions).set({ postId: newId }).where(eq(blogPostVersions.postId, row.id)),
    db.update(blogPostLinks).set({ sourceId: newId }).where(eq(blogPostLinks.sourceId, row.id)),
    db.update(blogPostLinks).set({ targetId: newId }).where(eq(blogPostLinks.targetId, row.id)),
    db.delete(blogPosts).where(eq(blogPosts.id, row.id)),
    db.update(blogPosts).set({ slug: newId }).where(eq(blogPosts.id, newId)),
    // A post renamed back to an address it had: the post answers it again.
    db.delete(blogSlugRedirects).where(eq(blogSlugRedirects.fromSlug, newId)),
  ] as const;
  if (!redirect) {
    await db.batch(moved);
    return;
  }
  await db.batch([
    ...moved,
    db.update(blogSlugRedirects).set({ toSlug: newId }).where(eq(blogSlugRedirects.toSlug, row.slug)),
    db
      .insert(blogSlugRedirects)
      .values({ fromSlug: row.slug, toSlug: newId, createdAt: now })
      .onConflictDoUpdate({ target: blogSlugRedirects.fromSlug, set: { toSlug: newId, createdAt: now } }),
  ]);
}
