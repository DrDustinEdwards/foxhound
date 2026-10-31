// The write path for blog_posts / blog_post_versions. Its one caller is the
// Carrel site adapter (app/lib/carrel/adapter.server.ts): Carrel is the blog
// editor, and Foxhound's own /admin/blog editor is gone.
// The editor's list, version and related-post helpers went with it. The public
// read path (queries.server.ts) is untouched.

import { and, eq, inArray, ne, or } from "drizzle-orm";

import type { Db } from "~/db";
import { blogPostDrafts, blogPostLinks, blogPostLinksRemoved, blogPostVersions, blogPosts, blogSlugRedirects } from "~/db";

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
  authors: string[];
  series?: string | null;
  seriesPart?: number | null;
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
    author: byline(input.authors),
    authors: input.authors,
    series: input.series ?? null,
    seriesPart: input.seriesPart ?? null,
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

/** The authors as the byline reads them: "A", "A and B", "A, B and C". */
export function byline(authors: string[]): string {
  return authors.length < 2 ? (authors[0] ?? "") : `${authors.slice(0, -1).join(", ")} and ${authors.at(-1)}`;
}

/** Who made a change, what it was, and the whole post source before it (a revision). */
export interface VersionNote {
  savedBy: string;
  message: string;
  source: string;
}

function versionValues(row: typeof blogPosts.$inferSelect, note: VersionNote, at: Date, postId = row.id) {
  return { id: crypto.randomUUID(), postId, title: row.title, body: row.body, excerpt: row.excerpt, savedAt: at, ...note };
}

export interface UpdatePostInput {
  title: string;
  excerpt: string;
  body: string;
  authors: string[];
  series: string | null;
  seriesPart: number | null;
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

/** Saves the PRE-edit state as a version snapshot (`note.source`, every field), then applies the update.
 *  Every version is kept: site-api's contract (v0.17.0, "Revisions") has a
 *  site never prune one, so any publish can be undone; only a delete removes
 *  them. Plain operational writes (not a money write - content editing, no
 *  DO), matching the operational-write precedent (gotcha #25). */
export async function updatePostWithVersion(
  db: Db,
  postId: string,
  note: VersionNote,
  input: UpdatePostInput,
): Promise<void> {
  const existingRows = await db.select().from(blogPosts).where(eq(blogPosts.id, postId)).limit(1);
  const existing = existingRows[0];
  if (!existing) throw new Error("Post not found");

  const now = new Date();
  await db.insert(blogPostVersions).values(versionValues(existing, note, now));

  await db
    .update(blogPosts)
    .set({
      title: input.title,
      excerpt: input.excerpt,
      body: input.body,
      author: byline(input.authors),
      authors: input.authors,
      series: input.series,
      seriesPart: input.seriesPart,
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
 *  live before (Carrel's settable publish date: a backdate or a re-date). The
 *  state before it is kept as a revision, with `note`. */
export async function setPublished(
  db: Db,
  postId: string,
  published: boolean,
  note: VersionNote,
  { firstPublishedAt = new Date(), publishedAt }: { firstPublishedAt?: Date; publishedAt?: Date } = {},
): Promise<void> {
  const rows = await db.select().from(blogPosts).where(eq(blogPosts.id, postId)).limit(1);
  const current = rows[0];
  if (!current) throw new Error("Post not found");
  const now = new Date();
  await db.batch([
    db.insert(blogPostVersions).values(versionValues(current, note, now)),
    db
    .update(blogPosts)
    .set({
      published,
      // First publish stamps publishedAt; unpublishing never clears it (so a
      // later republish keeps its original publish date, matching how the
      // public blog's "showPublishedAt" toggle is meant to work).
      publishedAt: publishedAt ?? (published && !current.publishedAt ? firstPublishedAt : current.publishedAt),
      updatedAt: now,
    })
    .where(eq(blogPosts.id, postId)),
  ]);
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

/** Deletes the post for good, with its versions, its pending draft and the
 *  redirects that led to it, as one batch. The further-reading links to and
 *  from it leave blog_post_links, whose keys need both posts, for
 *  blog_post_links_removed, with each end's slug and title, so they can be
 *  listed after the post is gone. */
export async function deletePost(db: Db, postId: string, slug: string): Promise<void> {
  const involves = or(eq(blogPostLinks.sourceId, postId), eq(blogPostLinks.targetId, postId));
  const links = await db.select().from(blogPostLinks).where(involves);
  const ids = [...new Set(links.flatMap((l) => [l.sourceId, l.targetId]))];
  const ends = new Map(
    (ids.length
      ? await db.select({ id: blogPosts.id, slug: blogPosts.slug, title: blogPosts.title }).from(blogPosts).where(inArray(blogPosts.id, ids))
      : []
    ).map((p) => [p.id, p]),
  );
  const now = new Date();
  const kept = links.map((l) => ({
    id: crypto.randomUUID(),
    sourceId: l.sourceId,
    targetId: l.targetId,
    sourceSlug: ends.get(l.sourceId)?.slug ?? null,
    targetSlug: ends.get(l.targetId)?.slug ?? null,
    sourceTitle: ends.get(l.sourceId)?.title ?? null,
    targetTitle: ends.get(l.targetId)?.title ?? null,
    position: l.position,
    createdAt: l.createdAt,
    removedAt: now,
  }));
  const deletes = [
    db.delete(blogPostLinks).where(involves),
    db.delete(blogPostVersions).where(eq(blogPostVersions.postId, postId)),
    db.delete(blogPostDrafts).where(eq(blogPostDrafts.postId, postId)),
    db.delete(blogSlugRedirects).where(eq(blogSlugRedirects.toSlug, slug)),
    db.delete(blogPosts).where(eq(blogPosts.id, postId)),
  ] as const;
  // The kept links go in first, in the same batch as the deletes.
  await (kept.length ? db.batch([db.insert(blogPostLinksRemoved).values(kept), ...deletes]) : db.batch(deletes));
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
  { redirect, note }: { redirect: boolean; note: VersionNote },
): Promise<void> {
  const now = new Date();
  const moved = [
    db.insert(blogPosts).values({ ...row, id: newId, slug: `rename:${newId}`, updatedAt: now }),
    db.update(blogPostVersions).set({ postId: newId }).where(eq(blogPostVersions.postId, row.id)),
    db.insert(blogPostVersions).values(versionValues(row, note, now, newId)),
    db.update(blogPostDrafts).set({ postId: newId }).where(eq(blogPostDrafts.postId, row.id)),
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

/** A live post's pending draft (blog_post_drafts), or null. */
export async function getDraft(db: Db, postId: string): Promise<typeof blogPostDrafts.$inferSelect | null> {
  const rows = await db.select().from(blogPostDrafts).where(eq(blogPostDrafts.postId, postId)).limit(1);
  return rows[0] ?? null;
}

/** Keeps a live post's draft apart from its live row, which the page goes on serving; a later save replaces it. */
export async function putDraft(db: Db, postId: string, draft: { source: string; changeId: string; savedBy: string }): Promise<void> {
  const values = { ...draft, savedAt: new Date() };
  await db
    .insert(blogPostDrafts)
    .values({ postId, ...values })
    .onConflictDoUpdate({ target: blogPostDrafts.postId, set: values });
}

export async function dropDraft(db: Db, postId: string): Promise<void> {
  await db.delete(blogPostDrafts).where(eq(blogPostDrafts.postId, postId));
}
