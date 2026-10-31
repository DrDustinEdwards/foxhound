import {
  ContentTag,
  contentVersion,
  NotFoundError,
  previewDocument,
  RefusedError,
  VersionConflictError,
  type ContentDoc,
  type ContentSummary,
  type DueSchedule,
  type ListQuery,
  type SiteAdapter,
  type WriteResult,
} from "@dustinedwards/site-api";
import { utc, type D1ScheduledUpdates } from "@dustinedwards/site-api/schedules";
import { RENDER_VERSION } from "@drdustinedwards/site-helpers/render/nomath";
import { desc, eq } from "drizzle-orm";

import { blogPostVersions, blogPosts, type Db } from "~/db";
import {
  createPost,
  deletePost,
  renamePost,
  setPublished,
  setTrashed,
  uniqueSlugFromTitle,
  updatePostWithVersion,
} from "~/lib/blog/admin-queries.server";
import { renderMarkdown } from "~/lib/blog/markdown.server";
import { redirectedBlogSlug } from "~/lib/blog/slug-redirects";
import { isWithdrawnBlogSlug } from "~/lib/blog/withdrawn";

import { parsePostSource, serializePostSource, SourceError, type PostSource } from "./source";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";

// The Carrel site adapter over Foxhound's blog. Posts live in
// D1 (blog_posts, blog_post_versions) and are edited in Carrel, which replaced
// Foxhound's own /admin/blog editor; the adapter writes through
// admin-queries, the one write path.
//
// Version = the post's updated_at in epoch milliseconds, as a string, with a
// hash of its schedule's time and change id added while one waits, so a
// schedule, a reschedule and a cancel each move it. A historical revision is
// "rev-<blog_post_versions.id>"; the table keeps the PRE-edit state of title,
// excerpt and body only, so a revision's source takes its other fields from the
// current post.
//
// SCHEDULED PUBLISHING (site-api v0.10.0). One row per post in site-api's
// scheduled_updates table (migration 0056, read and written only through the
// package's d1ScheduledUpdates). On a draft the row makes it "scheduled": it
// goes live at publish_at. On a live post the row is a pending update: the live
// version stays served until publish_at, then the row's source replaces it.
// Which of the two a row is follows from the post, because every write that
// changes a post's state drops its row: a publish, an unpublish, and a save of
// a draft (a scheduled draft that is edited goes back to draft, as in
// site-api's reference adapter). A save of a live post keeps its update
// waiting. The cron calls the package's runSchedules, which
// lists due rows here and applies each one (app/lib/cron/registry.ts).
//
// SITE-API v0.17.0. A trash (trashed_at): trashing takes a live post off the
// blog, a restore answers a draft, and only a trashed post is deleted for good
// (by Carrel, or by runSchedules 30 days on). A rename moves the post's id and
// its address together (its slug becomes the new id), and a post that was ever
// published leaves a 301 at its old address (blog_slug_redirects). The list
// filters by kind, tag, author and publish date, searches title and body, sorts
// and counts. A publish may carry the date it goes out under. Blog posts render
// through Prelum on every read (markdown.server.ts), so the render version meta
// names is the installed one.
//
// The media group is media-adapter.server.ts (the blog's media library), joined
// to this adapter in handler.server.ts. Cover addresses stay as they are:
// Carrel's post source does not carry them. The search fields it does carry
// (site-api v0.17.0) are the og_title, og_description, canonical_url and
// noindex columns under site-api's shared names (./source.ts).

const CARREL_SITE = {
  id: "foxhound",
  name: "Foxhound",
  origin: SITE_ORIGIN,
} as const;

const KIND = "post";
const DEFAULT_AUTHOR = "Foxhound";
/** A rename's new id is the post's new address, /blog/<id>. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_PREFIX = "rev-";
/** Every schedule is due by then, so `due` at this time lists every row. A
 *  four-digit year, since the store compares times as ISO text. */
const END_OF_TIME = new Date("9999-12-31T23:59:59.999Z");
const ALL_ROWS = 10_000;

type PostRow = typeof blogPosts.$inferSelect;
interface Pending {
  publishAt: string;
  changeId: string;
}
interface Post {
  row: PostRow;
  pending: Pending | null;
  version: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function versionOf(row: PostRow, pending: Pending | null): Promise<string> {
  // A post with search fields set carries their hash, so a source read before Carrel saw them is a conflict, not a
  // save that clears them.
  const search = [row.ogTitle, row.ogDescription, row.canonicalUrl, row.noindex];
  const updated = String(row.updatedAt.getTime()) + (search.some(Boolean) ? `.s${(await contentVersion(search)).slice(0, 8)}` : "");
  if (!pending) return updated;
  return `${updated}.${(await contentVersion([pending.publishAt, pending.changeId])).slice(0, 16)}`;
}

function summary({ row, pending, version }: Post): ContentSummary {
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

/** The list's orderings: the dates newest first and titles A to Z unless `dir` says otherwise. */
const ORDER = {
  updated: (r: PostRow) => r.updatedAt.getTime(),
  published: (r: PostRow) => r.publishedAt?.getTime() ?? 0,
  title: (r: PostRow) => r.title.toLowerCase(),
};

/** A row the list's filters keep. Trashed posts appear only when the trash is asked for, and then alone. */
function listed(row: PostRow, query: ListQuery): boolean {
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

function sourceOf(row: PostRow): PostSource {
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
    noindex: row.noindex,
    body: row.body,
  };
}

function parse(source: string, options?: { preview?: boolean }): PostSource {
  try {
    return parsePostSource(source, { author: DEFAULT_AUTHOR }, options);
  } catch (error) {
    if (error instanceof SourceError) throw new RefusedError(error.message);
    throw error;
  }
}

/** A slug moves its public URL, so only a rename changes it (it leaves the redirect). */
function keepSlug(post: PostSource, current: PostRow) {
  if (post.slug !== null && post.slug !== current.slug) {
    throw new RefusedError("A post's slug is its address: rename the post to move it.");
  }
}

function notTrashed(row: PostRow) {
  if (row.trashedAt) throw new RefusedError("This post is in the trash. Restore it first.");
}

/** `stylesheets` are the root route's, for the preview; the cron passes none. */
export function carrelAdapter(db: Db, schedules: D1ScheduledUpdates, stylesheets: string[] = []): SiteAdapter {
  async function load(id: string): Promise<Post | null> {
    const rows = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const waiting = await schedules.get(id);
    const pending = waiting ? { publishAt: waiting.publishAt, changeId: waiting.changeId } : null;
    return { row, pending, version: await versionOf(row, pending) };
  }

  async function mustMatch(id: string, expectedVersion: string): Promise<Post> {
    const post = await load(id);
    if (!post) throw new VersionConflictError(null);
    if (post.version !== expectedVersion) throw new VersionConflictError(post.version);
    return post;
  }

  /** The post, if `expectedVersion` is its version; NotFoundError for no post at all. */
  async function held(id: string, expectedVersion: string): Promise<Post> {
    const post = await load(id);
    if (!post) throw new NotFoundError();
    if (post.version !== expectedVersion) throw new VersionConflictError(post.version);
    return post;
  }

  async function writeResult(id: string, changeId: string): Promise<WriteResult> {
    const post = await load(id);
    if (!post) throw new NotFoundError();
    const { status, version, scheduledUpdate } = summary(post);
    return { id, version: version!, status, changeId, scheduledUpdate };
  }

  /** Create or update from a source. expectedVersion null means create. */
  async function save(id: string, source: string, expectedVersion: string | null, changeId: string) {
    // Version checks come BEFORE parsing, so a stale or mismatched write is a
    // 409 whatever its body holds (the conformance suite sends one with a
    // body that is not a valid post).
    if (expectedVersion === null) {
      const existing = await load(id);
      if (existing) throw new VersionConflictError(existing.version);
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
        ogTitle: post.searchTitle,
        ogDescription: post.description,
        canonicalUrl: post.canonical,
        noindex: post.noindex,
      });
      return;
    }
    const { row: current } = await mustMatch(id, expectedVersion);
    await writeSource(current, parse(source), changeId);
  }

  async function writeSource(current: PostRow, post: PostSource, changeId: string) {
    keepSlug(post, current);
    await updatePostWithVersion(db, current.id, `carrel:${changeId}`, {
      title: post.title,
      excerpt: post.excerpt,
      body: post.body,
      author: post.author,
      tags: post.tags,
      featured: post.featured,
      coverImageUrl: current.coverImageUrl,
      coverImageAlt: current.coverImageAlt,
      ogTitle: post.searchTitle ?? null,
      ogDescription: post.description ?? null,
      canonicalUrl: post.canonical ?? null,
      noindex: post.noindex ?? false,
      showUpdatedAt: current.showUpdatedAt,
      showPublishedAt: current.showPublishedAt,
    });
  }

  /** Stores the schedule. The parse comes first, so a source that could never
   *  go live is refused now rather than failing on the cron. */
  async function putSchedule(current: PostRow, source: string, publishAt: string, changeId: string) {
    keepSlug(parse(source), current);
    await schedules.put(current.id, { source, publishAt, changeId }).run();
  }

  return {
    site: { ...CARREL_SITE },

    content: {
      filters: ["kind", "tag", "author", "published"],
      postFields: ["excerpt"],
      publishedAtSettable: true,
      // The blog post head renders these; the share card is the cover or the generated card, which Carrel does not edit.
      searchFields: ["searchTitle", "description", "canonical", "noindex"],

      async list(query) {
        const rows = (await db.select().from(blogPosts)).filter((row) => listed(row, query));
        const sort = query.sort ?? "updated";
        const dir = query.dir ?? (sort === "title" ? "asc" : "desc");
        const key = ORDER[sort];
        rows.sort((a, b) => {
          const [x, y] = [key(a), key(b)];
          return (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)) * (dir === "asc" ? 1 : -1);
        });
        const waiting = new Map(
          (await schedules.due(END_OF_TIME, ALL_ROWS)).map((d) => [d.id, { publishAt: d.publishAt, changeId: d.changeId }]),
        );
        // The status is the row's and its schedule's, so it filters before the page is cut.
        const matching = rows
          .map((row) => ({ row, pending: waiting.get(row.id) ?? null }))
          .filter(({ row, pending }) => !query.status || summary({ row, pending, version: "" }).status === query.status);
        const start = Number.parseInt(query.cursor ?? "0", 10) || 0;
        const items = await Promise.all(
          matching
            .slice(start, start + query.limit)
            .map(async ({ row, pending }) => summary({ row, pending, version: await versionOf(row, pending) })),
        );
        const next = start + query.limit;
        return {
          items,
          nextCursor: next < matching.length ? String(next) : null,
          total: matching.length,
          sorted: { sort, dir },
        };
      },

      async get(id): Promise<ContentDoc | null> {
        const post = await load(id);
        if (!post) return null;
        return {
          ...summary(post),
          format: "markdown",
          source: serializePostSource(sourceOf(post.row)),
          version: post.version,
        };
      },

      async saveDraft(id, input) {
        await save(id, input.source, input.expectedVersion, input.changeId);
        // A draft that was scheduled goes back to draft when it is edited.
        const post = await load(id);
        if (post && !post.row.published && post.pending) await schedules.remove(id).run();
        return writeResult(id, input.changeId);
      },

      async publish(id, input) {
        notTrashed((await mustMatch(id, input.expectedVersion)).row);
        if (input.source !== undefined) {
          await save(id, input.source, input.expectedVersion, input.changeId);
        }
        // What goes live is this publish, so a waiting schedule is dropped.
        await schedules.remove(id).run();
        await setPublished(db, id, true, input.publishedAt ? { publishedAt: new Date(input.publishedAt) } : {});
        return writeResult(id, input.changeId);
      },

      // site-api sends only a post that is not live here; a live post's
      // schedule is schedules.update below.
      async schedule(id, input) {
        const { row } = await mustMatch(id, input.expectedVersion);
        notTrashed(row);
        await putSchedule(row, input.source ?? serializePostSource(sourceOf(row)), input.publishAt, input.changeId);
        if (input.source !== undefined) await writeSource(row, parse(input.source), input.changeId);
        return writeResult(id, input.changeId);
      },

      async unpublish(id, input) {
        await mustMatch(id, input.expectedVersion);
        await schedules.remove(id).run();
        await setPublished(db, id, false);
        return writeResult(id, input.changeId);
      },

      // The tags field of the post's source, written alone. A live post's page changes with it.
      async setTags(id, input) {
        const { row } = await held(id, input.expectedVersion);
        await writeSource(row, { ...sourceOf(row), tags: input.tags }, input.changeId);
        return writeResult(id, input.changeId);
      },

      // A live post leaves the blog as it goes in, and a waiting schedule goes
      // with it (apply also skips a trashed post, should the drop fail).
      async trash(id, input) {
        const { row } = await held(id, input.expectedVersion);
        notTrashed(row);
        await schedules.remove(id).run();
        await setTrashed(db, id, true);
        return writeResult(id, input.changeId);
      },

      async restore(id, input) {
        const { row } = await held(id, input.expectedVersion);
        if (!row.trashedAt) throw new RefusedError("This post is not in the trash.");
        await setTrashed(db, id, false);
        return writeResult(id, input.changeId);
      },

      // For good, and only from the trash, so a live post never loses its
      // address in one step.
      async delete(id, input) {
        const { row } = await held(id, input.expectedVersion);
        if (!row.trashedAt) throw new RefusedError("Move the post to the trash first: a delete cannot be undone.");
        await schedules.remove(id).run();
        await deletePost(db, id, row.slug);
      },

      async rename(id, input) {
        const { row, pending } = await held(id, input.expectedVersion);
        const { newId } = input;
        if (!SLUG.test(newId)) {
          throw new RefusedError("A post's id is its address, /blog/<id>: lower case letters and digits, joined by single hyphens.");
        }
        // The four renamed comparison posts and the withdrawn ones answer before any post does.
        if (redirectedBlogSlug(newId) || isWithdrawnBlogSlug(newId)) {
          throw new RefusedError(`/blog/${newId} is kept for an older post, so no post can take it.`);
        }
        const taken = await db.select({ id: blogPosts.id }).from(blogPosts).where(eq(blogPosts.slug, newId)).limit(1);
        if ((await load(newId)) || (taken[0] && taken[0].id !== id)) throw new RefusedError(`${newId} is already taken.`);
        const previousPath = row.publishedAt && row.slug !== newId ? `/blog/${row.slug}` : null;
        await renamePost(db, row, newId, { redirect: previousPath !== null });
        // The waiting schedule moves with it. A preview link names the old id,
        // so it stops working, as the address it showed has.
        const waiting = pending ? await schedules.get(id) : null;
        if (waiting) {
          await schedules.put(newId, { source: waiting.source, publishAt: waiting.publishAt, changeId: waiting.changeId }).run();
          await schedules.remove(id).run();
        }
        return { ...(await writeResult(newId, input.changeId)), previousPath };
      },

      async revisions(id) {
        const post = await load(id);
        if (!post) return null;
        const { row } = post;
        const versions = await db
          .select()
          .from(blogPostVersions)
          .where(eq(blogPostVersions.postId, id))
          .orderBy(desc(blogPostVersions.savedAt));
        return [
          { version: post.version, at: row.updatedAt.toISOString(), author: row.author, message: "current" },
          ...versions.map((v) => ({
            version: `${REVISION_PREFIX}${v.id}`,
            at: v.savedAt.toISOString(),
            author: v.savedBy ?? "unknown",
            message: "content before the edit made at this time",
          })),
        ];
      },

      async revisionSource(id, version) {
        const post = await load(id);
        if (!post) return null;
        if (version === post.version) return serializePostSource(sourceOf(post.row));
        if (!version.startsWith(REVISION_PREFIX)) return null;
        const rows = await db
          .select()
          .from(blogPostVersions)
          .where(eq(blogPostVersions.id, version.slice(REVISION_PREFIX.length)))
          .limit(1);
        const old = rows[0];
        if (!old || old.postId !== id) return null;
        return serializePostSource({
          ...sourceOf(post.row),
          title: old.title,
          excerpt: old.excerpt,
          body: old.body,
        });
      },
    },

    schedules: {
      async get(id) {
        const post = await load(id);
        if (!post?.row.published) return null;
        return schedules.get(id);
      },

      async update(id, input) {
        const { row } = await mustMatch(id, input.expectedVersion);
        if (!row.published) throw new RefusedError("Only a live post takes a scheduled update.");
        await putSchedule(row, input.source, input.publishAt, input.changeId);
        return writeResult(id, input.changeId);
      },

      async cancel(id, input) {
        const post = await load(id);
        if (!post) throw new NotFoundError();
        if (post.version !== input.expectedVersion) throw new VersionConflictError(post.version);
        if (!post.pending) throw new RefusedError("Nothing is scheduled for this post.");
        await schedules.remove(id).run();
        return writeResult(id, input.changeId);
      },

      async due({ now, limit }) {
        const due = await schedules.due(now, limit);
        return Promise.all(
          due.map(async (d): Promise<DueSchedule> => {
            const rows = await db
              .select({ published: blogPosts.published })
              .from(blogPosts)
              .where(eq(blogPosts.id, d.id))
              .limit(1);
            return { ...d, kind: rows[0]?.published ? "update" : "publish" };
          }),
        );
      },

      // The content write comes first and the row goes second, matched on the
      // time and change id it was listed with, so a reschedule made in between
      // survives. If the delete fails after the write, the next pass finds the
      // post already in the state the row describes and writes the same source
      // again, which changes nothing a reader sees.
      async apply(id, input) {
        const post = await load(id);
        const waiting = await schedules.get(id);
        if (!post || !waiting || post.row.trashedAt) return null;
        if (waiting.changeId !== input.changeId || waiting.publishAt !== utc(input.publishAt)) return null;
        if (Date.parse(waiting.publishAt) > input.now.getTime()) return null;
        if (input.kind === "update") {
          if (!post.row.published) return null;
          // The post's own slug: the update's source cannot move it.
          await writeSource(post.row, { ...parse(waiting.source), slug: null }, input.changeId);
        } else {
          if (post.row.published) return null;
          // A first publication records the time it was scheduled for.
          await setPublished(db, id, true, { firstPublishedAt: new Date(waiting.publishAt) });
        }
        await schedules.remove(id, { publishAt: waiting.publishAt, changeId: waiting.changeId }).run();
        return writeResult(id, input.changeId);
      },
    },

    renderVersion: RENDER_VERSION,

    // The body as /blog/<slug> renders it, in the site's own stylesheets: an
    // unsaved source has no row for the route to load.
    preview: {
      async render(input) {
        const post = parse(input.source, { preview: true });
        const { html } = await renderMarkdown(db, post.body);
        const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        return previewDocument({
          title: post.title,
          body: `<main class="mx-auto max-w-[680px] px-6 py-12"><article class="h-entry"><h1 class="mb-4 text-page-title font-medium leading-tight tracking-tight text-text">${esc(post.title)}</h1><div class="blog-prose e-content">${html}</div></article></main>`,
          origin: SITE_ORIGIN,
          stylesheets,
          attributes: { "data-theme": "light" },
        });
      },
    },
  };
}
