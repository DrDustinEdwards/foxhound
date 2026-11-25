import {
  ContentTag,
  contentVersion,
  RefusedError,
  type ContentSummary,
  type ListQuery,
} from "@dustinedwards/site-api";
import { blogPosts } from "~/db";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";

import { parsePostSource, SourceError, type PostSource } from "./source";

export const CARREL_SITE = {
  id: "foxhound",
  name: "Foxhound",
  origin: SITE_ORIGIN,
} as const;

const KIND = "post";
/** The signed-in person Carrel sends with a write. */
export type Actor = { name: string };
const DEFAULT_AUTHOR = "Foxhound";

export type PostRow = typeof blogPosts.$inferSelect;
export interface Pending {
  publishAt: string;
  changeId: string;
}
export interface Post {
  row: PostRow;
  pending: Pending | null;
  version: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function versionOf(row: PostRow, pending: Pending | null): Promise<string> {
  // A post with search fields set carries their hash, so a source read before
  // Carrel saw them is a conflict, not a save that clears them.
  const search = [
    row.ogTitle,
    row.ogDescription,
    row.ogImageUrl,
    row.ogImageAlt,
    row.canonicalUrl,
    row.noindex,
  ];
  const updated =
    String(row.updatedAt.getTime()) +
    (search.some(Boolean) ? `.s${(await contentVersion(search)).slice(0, 8)}` : "");
  if (!pending) return updated;
  return `${updated}.${(await contentVersion([pending.publishAt, pending.changeId])).slice(0, 16)}`;
}

export function summary({ row, pending, version }: Post): ContentSummary {
  const scheduled = !row.published && pending !== null;
  return {
    id: row.id,
    kind: KIND,
    title: row.title,
    status: row.published ? "published" : scheduled ? "scheduled" : "draft",
    path: row.publishedAt ? `/blog/${row.slug}` : null,
    publishAt: scheduled ? pending.publishAt : null,
    publishedAt: iso(row.publishedAt),
    updatedAt: iso(row.updatedAt),
    version,
    // Only tags the contract can carry, so one odd tag never fails the list.
    tags: (row.tags ?? []).filter((t) => ContentTag.safeParse(t).success),
    authors: row.author.trim() ? [row.author] : [],
    excerpt: row.excerpt.slice(0, 5000),
    trashedAt: iso(row.trashedAt),
    scheduledUpdate: row.published && pending ? { ...pending } : null,
  };
}

/**
 * The list's orderings: the dates newest first and titles A to Z unless `dir`
 * says otherwise.
 */
export const ORDER = {
  updated: ({ row }: { row: PostRow }) => row.updatedAt.getTime(),
  published: ({ row }: { row: PostRow }) => row.publishedAt?.getTime() ?? 0,
  title: ({ row }: { row: PostRow }) => row.title.toLowerCase(),
};

/**
 * A row the list's filters keep. Trashed posts appear only when the trash is
 * asked for then alone.
 */
export function listed(row: PostRow, query: ListQuery): boolean {
  const needle = query.q?.toLowerCase();
  const at = row.publishedAt?.getTime() ?? null;
  const after = query.publishedAfter ? Date.parse(query.publishedAfter) : null;
  const before = query.publishedBefore ? Date.parse(query.publishedBefore) : null;
  return (
    Boolean(row.trashedAt) === Boolean(query.trashed) &&
    (!query.kind || query.kind === KIND) &&
    (!query.tag || (row.tags ?? []).some((t) => t.toLowerCase() === query.tag!.toLowerCase())) &&
    (!query.author || row.author === query.author) &&
    (after === null || (at !== null && at >= after)) &&
    (before === null || (at !== null && at < before)) &&
    (!needle || [row.title, row.body, row.slug].some((t) => t.toLowerCase().includes(needle)))
  );
}

export function postSourceOf(row: PostRow): PostSource {
  return {
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    author: row.author,
    tags: row.tags ?? [],
    featured: row.featured,
    searchTitle: row.ogTitle,
    description: row.ogDescription,
    canonical: row.canonicalUrl,
    image: row.ogImageUrl,
    imageAlt: row.ogImageAlt,
    noindex: row.noindex,
    body: row.body,
  };
}

export function parse(source: string, options?: { preview?: boolean }): PostSource {
  try {
    return parsePostSource(source, { author: DEFAULT_AUTHOR }, options);
  } catch (error) {
    if (error instanceof SourceError) throw new RefusedError(error.message);
    throw error;
  }
}

/**
 * A slug moves its public URL, so only a rename changes it (it leaves the
 * redirect).
 */
export function keepSlug(post: PostSource, current: PostRow) {
  if (post.slug !== null && post.slug !== current.slug) {
    throw new RefusedError("A post's slug is its address: rename the post to move it.");
  }
}

export function postNotTrashed(row: PostRow) {
  if (row.trashedAt) throw new RefusedError("This post is in the trash. Restore it first.");
}

/**
 * A post's source as the columns a save writes; the cover and the date toggles
 * are the post's own, which a source does not carry.
 */
export function houndFieldsOf(
  post: PostSource,
  kept: Pick<PostRow, "coverImageUrl" | "coverImageAlt" | "showUpdatedAt" | "showPublishedAt">,
) {
  return {
    title: post.title,
    excerpt: post.excerpt,
    body: post.body,
    author: post.author,
    tags: post.tags,
    featured: post.featured,
    coverImageUrl: kept.coverImageUrl,
    coverImageAlt: kept.coverImageAlt,
    ogTitle: post.searchTitle ?? null,
    ogDescription: post.description ?? null,
    canonicalUrl: post.canonical ?? null,
    ogImageUrl: post.image ?? null,
    ogImageAlt: post.imageAlt ?? null,
    noindex: post.noindex ?? false,
    showUpdatedAt: kept.showUpdatedAt,
    showPublishedAt: kept.showPublishedAt,
  };
}
