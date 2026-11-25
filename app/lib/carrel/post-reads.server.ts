import { and, desc, eq, isNull, like, ne } from "drizzle-orm";
import { blogPostLinks, blogPostVersions, blogPosts, type Db } from "~/db";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";

import { serializePostSource } from "./source";
import { postSourceOf, type Post } from "./post-model.server";

const REVISION_PREFIX = "rev-";

/**
 * The posts that link to this one, by a further-reading link or by its
 * address in their text, so a trash or a delete warns first (a delete
 * drops the further-reading links).
 */
export async function findBacklinks(db: Db, id: string, slug: string) {
  const linked = await db
    .select({ id: blogPosts.id, title: blogPosts.title, slug: blogPosts.slug })
    .from(blogPostLinks)
    .innerJoin(blogPosts, eq(blogPosts.id, blogPostLinks.sourceId))
    .where(and(eq(blogPostLinks.targetId, id), isNull(blogPosts.trashedAt)));
  const inText = new RegExp(
    `(?:\\]\\(|href=")(?:${SITE_ORIGIN.replace(/[.]/g, "\\.")})?/blog/${slug}(?=[/?#)"\\s]|$)`,
  );
  const mentioning = (
    await db
      .select({
        id: blogPosts.id,
        title: blogPosts.title,
        slug: blogPosts.slug,
        body: blogPosts.body,
      })
      .from(blogPosts)
      .where(
        and(
          ne(blogPosts.id, id),
          isNull(blogPosts.trashedAt),
          like(blogPosts.body, `%/blog/${slug}%`),
        ),
      )
  ).filter((r) => inText.test(r.body));
  const byId = new Map([...linked, ...mentioning].map((r) => [r.id, r]));
  return [...byId.values()]
    .filter((r) => r.id !== id)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((r) => ({ id: r.id, title: r.title, path: `/blog/${r.slug}` }));
}

export async function listPostRevisions(db: Db, post: Post) {
  const id = post.row.id;
  const { row } = post;
  const versions = await db
    .select()
    .from(blogPostVersions)
    .where(eq(blogPostVersions.postId, id))
    .orderBy(desc(blogPostVersions.savedAt));
  return [
    {
      version: post.version,
      at: row.updatedAt.toISOString(),
      author: row.author,
      message: "current",
    },
    ...versions.map((v) => ({
      version: `${REVISION_PREFIX}${v.id}`,
      at: v.savedAt.toISOString(),
      author: v.savedBy ?? "unknown",
      message: "content before the edit made at this time",
    })),
  ];
}

export async function revisionSourceOf(db: Db, post: Post, id: string, version: string) {
  if (version === post.version) return serializePostSource(postSourceOf(post.row));
  if (!version.startsWith(REVISION_PREFIX)) return null;
  const rows = await db
    .select()
    .from(blogPostVersions)
    .where(eq(blogPostVersions.id, version.slice(REVISION_PREFIX.length)))
    .limit(1);
  const old = rows[0];
  if (!old || old.postId !== id) return null;
  return serializePostSource({
    ...postSourceOf(post.row),
    title: old.title,
    excerpt: old.excerpt,
    body: old.body,
  });
}
