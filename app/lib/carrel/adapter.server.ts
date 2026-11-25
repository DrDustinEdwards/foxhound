import {
  NotFoundError,
  orderAndPage,
  RefusedError,
  VersionConflictError,
  type ContentDoc,
  type DueSchedule,
  type SiteAdapter,
  type WriteResult,
} from "@dustinedwards/site-api";
import { SEARCH_FIELDS } from "@dustinedwards/site-api/frontmatter";
import {
  d1ScheduledUpdates,
  utc,
  waitingUpdates,
  type D1Like,
} from "@dustinedwards/site-api/schedules";
import { RENDER_VERSION } from "@drdustinedwards/site-helpers/render/nomath";
import { eq } from "drizzle-orm";
import { blogPosts, type Db } from "~/db";
import {
  createBlogPost,
  deleteBlogPost,
  renamePost,
  setPublished,
  setTrashed,
  updatePostWithVersion,
} from "~/lib/blog/admin-queries.server";
import { isWithdrawnBlogSlug } from "~/lib/blog/withdrawn";
import { isSlug, uniqueSlug } from "@drdustinedwards/site-helpers/slug";

import { serializePostSource, type PostSource } from "./source";
import {
  CARREL_SITE,
  type Actor,
  type Post,
  type PostRow,
  versionOf,
  summary,
  ORDER,
  listed,
  postSourceOf,
  parse,
  keepSlug,
  postNotTrashed,
  houndFieldsOf,
} from "./post-model.server";
import { findBacklinks, listPostRevisions, revisionSourceOf } from "./post-reads.server";
import { renderPreview, type RenderDocument } from "./post-preview.server";

// The Carrel site adapter over Foxhound's blog. Posts live in D1 (blog_posts,
// blog_post_versions) and are edited in Carrel, which replaced Foxhound's own
// /admin/blog editor; the adapter writes through admin-queries, the one write
// path.

/**
 * `renderDocument` draws the preview through the post's own route; the cron has
 * none.
 */
export function carrelAdapter(
  db: Db,
  d1: D1Like,
  options: { renderDocument?: RenderDocument } = {},
): SiteAdapter {
  const schedules = d1ScheduledUpdates(d1);
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

  /**
   * The post, if `expectedVersion` is its version; NotFoundError for no post at
   * all.
   */
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
  async function save(
    id: string,
    source: string,
    expectedVersion: string | null,
    changeId: string,
    actor?: Actor,
  ) {
    // Version checks come BEFORE parsing, so a stale or mismatched write is a
    // 409 whatever its body holds (the conformance suite sends one with a body
    // that is not a valid post).
    if (expectedVersion === null) {
      const existing = await load(id);
      if (existing) throw new VersionConflictError(existing.version);
      const post = parse(source);
      const slug =
        post.slug ??
        (await uniqueSlug(post.title, {
          fallback: "post",
          max: 80,
          taken: async (candidate) =>
            (
              await db
                .select({ id: blogPosts.id })
                .from(blogPosts)
                .where(eq(blogPosts.slug, candidate))
                .limit(1)
            ).length > 0,
        }));
      await createBlogPost(db, {
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
        ogImageUrl: post.image,
        ogImageAlt: post.imageAlt,
        noindex: post.noindex,
      });
      return;
    }
    const { row: current } = await mustMatch(id, expectedVersion);
    await writeSource(current, parse(source), changeId, actor);
  }

  async function writeSource(current: PostRow, post: PostSource, changeId: string, actor?: Actor) {
    keepSlug(post, current);
    const saved = await updatePostWithVersion(
      db,
      current.id,
      actor?.name ?? `carrel:${changeId}`,
      current.updatedAt,
      houndFieldsOf(post, current),
    );
    if (!saved) throw new VersionConflictError((await load(current.id))?.version ?? null);
  }

  /**
   * Stores the schedule. The parse comes first, so a source that could never go
   * live is refused now rather than failing on the cron.
   */
  async function putSchedule(
    current: PostRow,
    source: string,
    publishAt: string,
    changeId: string,
  ) {
    keepSlug(parse(source), current);
    await schedules.put(current.id, { source, publishAt, changeId }).run();
  }

  return {
    site: { ...CARREL_SITE },

    content: {
      filters: ["kind", "tag", "author", "published"],
      postFields: ["excerpt"],
      publishedAtSettable: true,
      // The blog post head renders all of them. With no share image the card is
      // the cover, else the generated card.
      searchFields: SEARCH_FIELDS,

      async list(query) {
        const rows = (await db.select().from(blogPosts)).filter((row) => listed(row, query));
        const waiting = await waitingUpdates(d1);
        // The status is the row's and its schedule's, so it filters before the page is cut.
        const matching = rows
          .map((row) => ({ row, pending: waiting.get(row.id) ?? null }))
          .filter(
            ({ row, pending }) =>
              !query.status || summary({ row, pending, version: "" }).status === query.status,
          );
        const { page, ...rest } = orderAndPage(matching, query, ORDER);
        const items = await Promise.all(
          page.map(async ({ row, pending }) =>
            summary({ row, pending, version: await versionOf(row, pending) }),
          ),
        );
        return { items, ...rest };
      },

      async get(id): Promise<ContentDoc | null> {
        const post = await load(id);
        if (!post) return null;
        return {
          ...summary(post),
          format: "markdown",
          source: serializePostSource(postSourceOf(post.row)),
          version: post.version,
        };
      },

      async saveDraft(id, input) {
        await save(id, input.source, input.expectedVersion, input.changeId, input.actor);
        // A draft that was scheduled goes back to draft when it is edited.
        const post = await load(id);
        if (post && !post.row.published && post.pending) await schedules.remove(id).run();
        return writeResult(id, input.changeId);
      },

      async publish(id, input) {
        postNotTrashed((await mustMatch(id, input.expectedVersion)).row);
        if (input.source !== undefined) {
          await save(id, input.source, input.expectedVersion, input.changeId, input.actor);
        }
        // What goes live is this publish, so a waiting schedule is dropped.
        await schedules.remove(id).run();
        await setPublished(
          db,
          id,
          true,
          input.publishedAt ? { publishedAt: new Date(input.publishedAt) } : {},
        );
        return writeResult(id, input.changeId);
      },

      // site-api sends only a post that is not live here; a live post's
      // schedule is schedules.update below.
      async schedule(id, input) {
        const { row } = await mustMatch(id, input.expectedVersion);
        postNotTrashed(row);
        await putSchedule(
          row,
          input.source ?? serializePostSource(postSourceOf(row)),
          input.publishAt,
          input.changeId,
        );
        if (input.source !== undefined)
          await writeSource(row, parse(input.source), input.changeId, input.actor);
        return writeResult(id, input.changeId);
      },

      async unpublish(id, input) {
        await mustMatch(id, input.expectedVersion);
        await schedules.remove(id).run();
        await setPublished(db, id, false);
        return writeResult(id, input.changeId);
      },

      // The tags field of the post's source, written alone. A live post's page
      // changes with it.
      async setTags(id, input) {
        const { row } = await held(id, input.expectedVersion);
        await writeSource(
          row,
          { ...postSourceOf(row), tags: input.tags },
          input.changeId,
          input.actor,
        );
        return writeResult(id, input.changeId);
      },

      // A live post leaves the blog as it goes in, and a waiting schedule goes
      // with it (apply also skips a trashed post, should the drop fail).
      async trash(id, input) {
        const { row } = await held(id, input.expectedVersion);
        postNotTrashed(row);
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
        if (!row.trashedAt)
          throw new RefusedError("Move the post to the trash first: a delete cannot be undone.");
        await schedules.remove(id).run();
        await deleteBlogPost(db, id, row.slug);
      },

      async rename(id, input) {
        const { row, pending } = await held(id, input.expectedVersion);
        const { newId } = input;
        // A rename's new id is the post's new address, /blog/<id>.
        if (!isSlug(newId)) {
          throw new RefusedError(
            "A post's id is its address, /blog/<id>: lower case letters and digits, joined by single hyphens.",
          );
        }
        // A withdrawn post's address answers 410 before any post does.
        if (isWithdrawnBlogSlug(newId)) {
          throw new RefusedError(
            `/blog/${newId} is kept for an older post, so no post can take it.`,
          );
        }
        const taken = await db
          .select({ id: blogPosts.id })
          .from(blogPosts)
          .where(eq(blogPosts.slug, newId))
          .limit(1);
        if ((await load(newId)) || (taken[0] && taken[0].id !== id))
          throw new RefusedError(`${newId} is already taken.`);
        const previousPath = row.publishedAt && row.slug !== newId ? `/blog/${row.slug}` : null;
        await renamePost(db, row, newId, { redirect: previousPath !== null });
        // The waiting schedule moves with it.
        const waiting = pending ? await schedules.get(id) : null;
        if (waiting) {
          await schedules
            .put(newId, {
              source: waiting.source,
              publishAt: waiting.publishAt,
              changeId: waiting.changeId,
            })
            .run();
          await schedules.remove(id).run();
        }
        return { ...(await writeResult(newId, input.changeId)), previousPath };
      },

      // The posts that link to this one, by a further-reading link or by its
      // address in their text, so a trash or a delete warns first (a delete
      // drops the further-reading links).
      async backlinks(id) {
        const post = await load(id);
        if (!post) return [];
        return findBacklinks(db, id, post.row.slug);
      },

      async revisions(id) {
        const post = await load(id);
        if (!post) return null;
        return listPostRevisions(db, post);
      },

      async revisionSource(id, version) {
        const post = await load(id);
        if (!post) return null;
        return revisionSourceOf(db, post, id, version);
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
        if (waiting.changeId !== input.changeId || waiting.publishAt !== utc(input.publishAt))
          return null;
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
        await schedules
          .remove(id, { publishAt: waiting.publishAt, changeId: waiting.changeId })
          .run();
        return writeResult(id, input.changeId);
      },
    },

    renderVersion: RENDER_VERSION,

    // The draft through the post's own route and layout, in-process
    // (workers/app.ts), so it has the site's header and footer and everything
    // the page shows.
    preview: {
      async render({ id, source }) {
        return renderPreview(options.renderDocument, { id, source }, load);
      },
    },
  };
}
