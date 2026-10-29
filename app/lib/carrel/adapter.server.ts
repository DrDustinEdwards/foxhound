import {
  NotFoundError,
  RefusedError,
  VersionConflictError,
  type ContentDoc,
  type ContentSummary,
  type SiteAdapter,
  type WriteResult,
} from "@dustinedwards/site-api";
import { desc, eq } from "drizzle-orm";

import { blogPostVersions, blogPosts, type Db } from "~/db";
import {
  createPost,
  setPublished,
  uniqueSlugFromTitle,
  updatePostWithVersion,
} from "~/lib/blog/admin-queries.server";
import { renderMarkdown } from "~/lib/blog/markdown.server";

import { parsePostSource, serializePostSource, SourceError, type PostSource } from "./source";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";

// The Carrel site adapter over Foxhound's blog (job_cbe1b96107fc). Posts live in
// D1 (blog_posts, blog_post_versions) and are edited in Carrel, which replaced
// Foxhound's own /admin/blog editor (RULES.md 7.4); the adapter writes through
// admin-queries, the one write path.
//
// Version = the post's updated_at in epoch milliseconds, as a string. A historical
// revision is "rev-<blog_post_versions.id>"; the table keeps the PRE-edit state of
// title, excerpt and body only, so a revision's source takes its other fields from
// the current post.
//
// NOT IMPLEMENTED, on purpose: scheduling (blog_posts has no publish-at column) is
// refused; media is omitted (Foxhound stores no uploaded images, covers are URLs),
// so the media routes answer 501.

const CARREL_SITE = {
  id: "foxhound",
  name: "Foxhound",
  origin: SITE_ORIGIN,
} as const;

const DEFAULT_AUTHOR = "Foxhound";
const REVISION_PREFIX = "rev-";

type PostRow = typeof blogPosts.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const versionOf = (row: PostRow): string => String(row.updatedAt.getTime());
const statusOf = (row: PostRow): "draft" | "published" => (row.published ? "published" : "draft");

function summary(row: PostRow): ContentSummary {
  return {
    id: row.id,
    kind: "post",
    title: row.title,
    status: statusOf(row),
    path: row.publishedAt ? `/blog/${row.slug}` : null,
    publishAt: null,
    publishedAt: iso(row.publishedAt),
    updatedAt: iso(row.updatedAt),
  };
}

function sourceOf(row: PostRow): PostSource {
  return {
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    author: row.author,
    tags: row.tags ?? [],
    featured: row.featured,
    body: row.body,
  };
}

function parse(source: string): PostSource {
  try {
    return parsePostSource(source, { author: DEFAULT_AUTHOR });
  } catch (error) {
    if (error instanceof SourceError) throw new RefusedError(error.message);
    throw error;
  }
}

/** Side effects the adapter reports to its mount, kept out of the adapter so it
 *  stays a pure function of the database (the conformance suite runs it bare). */
export interface CarrelAdapterHooks {
  /** A save or publish left this post published: its public URL is new or
   *  changed. Must not throw and must not be awaited (job_b0b24df12155). */
  onLive?: (slug: string) => void;
}

export function carrelAdapter(db: Db, hooks: CarrelAdapterHooks = {}): SiteAdapter {
  async function load(id: string): Promise<PostRow | null> {
    const rows = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function mustMatch(id: string, expectedVersion: string): Promise<PostRow> {
    const row = await load(id);
    if (!row) throw new VersionConflictError(null);
    if (versionOf(row) !== expectedVersion) throw new VersionConflictError(versionOf(row));
    return row;
  }

  async function writeResult(id: string, changeId: string): Promise<WriteResult> {
    const row = await load(id);
    if (!row) throw new NotFoundError();
    // INDEXNOW (job_b0b24df12155). Recova submits on every save that leaves the
    // post published, the publish itself and an edit of a live post alike, and
    // never on unpublish. writeResult runs after exactly the writes that can do
    // that (saveDraft, publish, unpublish), and unpublish leaves it a draft. The
    // hook moves when Carrel's blog publishing (J11, job_09c55603e321) and
    // Prelum's blog pages (J19 job_deffd581af37, J61 job_2ee0cfdd5c29) land.
    if (row.published) {
      try {
        hooks.onLive?.(row.slug);
      } catch {
        // A notification never fails the write it reports.
      }
    }
    return { id, version: versionOf(row), status: statusOf(row), changeId };
  }

  /** Create or update from a source. expectedVersion null means create. */
  async function save(id: string, source: string, expectedVersion: string | null, changeId: string) {
    // Version checks come BEFORE parsing, so a stale or mismatched write is a
    // 409 whatever its body holds (the conformance suite sends one with a
    // body that is not a valid post).
    if (expectedVersion === null) {
      const existing = await load(id);
      if (existing) throw new VersionConflictError(versionOf(existing));
      const post = parse(source);
      const slug = post.slug ?? (await uniqueSlugFromTitle(db, post.title));
      await createPost(db, {
        id,
        title: post.title,
        slug,
        excerpt: post.excerpt,
        body: post.body,
        author: post.author,
        tags: post.tags,
        featured: post.featured,
      });
      return;
    }
    const current = await mustMatch(id, expectedVersion);
    const post = parse(source);
    if (post.slug !== null && post.slug !== current.slug) {
      throw new RefusedError("A post's slug cannot be changed through Carrel.");
    }
    await updatePostWithVersion(db, id, `carrel:${changeId}`, {
      title: post.title,
      excerpt: post.excerpt,
      body: post.body,
      author: post.author,
      tags: post.tags,
      featured: post.featured,
      coverImageUrl: current.coverImageUrl,
      coverImageAlt: current.coverImageAlt,
      ogTitle: current.ogTitle,
      ogDescription: current.ogDescription,
      canonicalUrl: current.canonicalUrl,
      showUpdatedAt: current.showUpdatedAt,
      showPublishedAt: current.showPublishedAt,
    });
  }

  return {
    site: { ...CARREL_SITE },

    content: {
      async list(query) {
        const rows = await db.select().from(blogPosts).orderBy(desc(blogPosts.updatedAt));
        const needle = query.q?.toLowerCase();
        const matching = rows.filter((r) => {
          if (query.status === "scheduled") return false;
          if (query.status && statusOf(r) !== query.status) return false;
          return !needle || r.title.toLowerCase().includes(needle) || r.slug.includes(needle);
        });
        const start = Number.parseInt(query.cursor ?? "0", 10) || 0;
        const page = matching.slice(start, start + query.limit);
        const next = start + query.limit;
        return {
          items: page.map(summary),
          nextCursor: next < matching.length ? String(next) : null,
        };
      },

      async get(id): Promise<ContentDoc | null> {
        const row = await load(id);
        if (!row) return null;
        return {
          ...summary(row),
          format: "markdown",
          source: serializePostSource(sourceOf(row)),
          version: versionOf(row),
        };
      },

      async saveDraft(id, input) {
        await save(id, input.source, input.expectedVersion, input.changeId);
        return writeResult(id, input.changeId);
      },

      async publish(id, input) {
        await mustMatch(id, input.expectedVersion);
        if (input.source !== undefined) {
          await save(id, input.source, input.expectedVersion, input.changeId);
        }
        await setPublished(db, id, true);
        return writeResult(id, input.changeId);
      },

      async schedule() {
        throw new RefusedError("Foxhound has no scheduled publishing; publish now or save a draft.");
      },

      async unpublish(id, input) {
        await mustMatch(id, input.expectedVersion);
        await setPublished(db, id, false);
        return writeResult(id, input.changeId);
      },

      async revisions(id) {
        const row = await load(id);
        if (!row) return null;
        const versions = await db
          .select()
          .from(blogPostVersions)
          .where(eq(blogPostVersions.postId, id))
          .orderBy(desc(blogPostVersions.savedAt));
        return [
          { version: versionOf(row), at: row.updatedAt.toISOString(), author: row.author, message: "current" },
          ...versions.map((v) => ({
            version: `${REVISION_PREFIX}${v.id}`,
            at: v.savedAt.toISOString(),
            author: v.savedBy ?? "unknown",
            message: "content before the edit made at this time",
          })),
        ];
      },

      async revisionSource(id, version) {
        const row = await load(id);
        if (!row) return null;
        if (version === versionOf(row)) return serializePostSource(sourceOf(row));
        if (!version.startsWith(REVISION_PREFIX)) return null;
        const rows = await db
          .select()
          .from(blogPostVersions)
          .where(eq(blogPostVersions.id, version.slice(REVISION_PREFIX.length)))
          .limit(1);
        const old = rows[0];
        if (!old || old.postId !== id) return null;
        return serializePostSource({
          ...sourceOf(row),
          title: old.title,
          excerpt: old.excerpt,
          body: old.body,
        });
      },
    },

    preview: {
      async render(input) {
        const post = parse(input.source);
        const { html } = await renderMarkdown(db, post.body);
        const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(post.title)}</title></head><body><article><h1>${esc(post.title)}</h1>${html}</article></body></html>`;
      },
    },
  };
}
