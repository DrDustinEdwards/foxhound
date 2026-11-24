import {
  ContentTag,
  contentVersion,
  NotFoundError,
  orderAndPage,
  RefusedError,
  VersionConflictError,
  type ContentDoc,
  type ContentSummary,
  type DueSchedule,
  type ListQuery,
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
import { and, desc, eq, isNull, like, ne } from "drizzle-orm";

import { blogPostLinks, blogPostVersions, blogPosts, type Db } from "~/db";
import {
  createBlogPost,
  deleteBlogPost,
  renamePost,
  setPublished,
  setTrashed,
  updatePostWithVersion,
} from "~/lib/blog/admin-queries.server";
import { isWithdrawnBlogSlug } from "~/lib/blog/withdrawn";

import { parsePostSource, serializePostSource, SourceError, type PostSource } from "./source";
import { toPost, type BlogPost } from "~/lib/blog/queries.server";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";
import { isSlug, uniqueSlug } from "@drdustinedwards/site-helpers/slug";
import { readingMinutes, wordCount } from "@drdustinedwards/site-helpers/text";

// The Carrel site adapter over Foxhound's blog. Posts live in D1 (blog_posts,
// blog_post_versions) and are edited in Carrel, which replaced Foxhound's own
// /admin/blog editor; the adapter writes through admin-queries, the one write
// path.

const CARREL_SITE = {
  id: "foxhound",
  name: "Foxhound",
  origin: SITE_ORIGIN,
} as const;

const KIND = "post";
/** The signed-in person Carrel sends with a write (site-api C2). */
type Actor = { name: string };
const DEFAULT_AUTHOR = "Foxhound";
const REVISION_PREFIX = "rev-";

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

/**
 * The list's orderings: the dates newest first and titles A to Z unless `dir`
 * says otherwise.
 */
const ORDER = {
  updated: ({ row }: { row: PostRow }) => row.updatedAt.getTime(),
  published: ({ row }: { row: PostRow }) => row.publishedAt?.getTime() ?? 0,
  title: ({ row }: { row: PostRow }) => row.title.toLowerCase(),
};

/**
 * A row the list's filters keep. Trashed posts appear only when the trash is
 * asked for, and then alone.
 */
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
    image: row.ogImageUrl,
    imageAlt: row.ogImageAlt,
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

/**
 * A slug moves its public URL, so only a rename changes it (it leaves the
 * redirect).
 */
function keepSlug(post: PostSource, current: PostRow) {
  if (post.slug !== null && post.slug !== current.slug) {
    throw new RefusedError("A post's slug is its address: rename the post to move it.");
  }
}

function notTrashed(row: PostRow) {
  if (row.trashedAt) throw new RefusedError("This post is in the trash. Restore it first.");
}

/**
 * A post's source as the columns a save writes; the cover and the date toggles
 * are the post's own, which a source does not carry.
 */
function fieldsOf(
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

/**
 * The site's own render of a route (workers/app.ts), with the draft on its
 * context; nothing stored or cached.
 */
export type RenderDocument = (request: Request, draft: BlogPost) => Promise<Response>;

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
      fieldsOf(post, current),
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
          source: serializePostSource(sourceOf(post.row)),
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
        notTrashed((await mustMatch(id, input.expectedVersion)).row);
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
        notTrashed(row);
        await putSchedule(
          row,
          input.source ?? serializePostSource(sourceOf(row)),
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
        await writeSource(row, { ...sourceOf(row), tags: input.tags }, input.changeId, input.actor);
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
        const { slug } = post.row;
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
        const { renderDocument } = options;
        if (!renderDocument) throw new Error("the document renderer is not on this request");
        const post = parse(source, { preview: true });
        const current = id ? ((await load(id))?.row ?? null) : null;
        const slug = current?.slug ?? post.slug ?? (id && isSlug(id) ? id : "preview");
        const now = new Date();
        const response = await renderDocument(
          new Request(new URL(`/blog/${slug}`, SITE_ORIGIN), { headers: { Accept: "text/html" } }),
          toPost({
            id: current?.id ?? id ?? slug,
            slug,
            ...fieldsOf(post, {
              coverImageUrl: current?.coverImageUrl ?? null,
              coverImageAlt: current?.coverImageAlt ?? null,
              showUpdatedAt: current?.showUpdatedAt ?? true,
              showPublishedAt: current?.showPublishedAt ?? true,
            }),
            published: current?.published ?? false,
            publishedAt: current?.publishedAt ?? null,
            createdAt: current?.createdAt ?? now,
            updatedAt: current?.updatedAt ?? now,
            readingMinutes: readingMinutes(wordCount(post.body)),
            trashedAt: null,
          }),
        );
        if (!response.ok)
          throw new RefusedError(
            `The preview did not render: /blog/${slug} answered ${response.status}.`,
          );
        // The page's own robots tag indexes it; the strictest wins, so this
        // keeps a preview out of every index.
        return (await response.text()).replace(
          /<head\b[^>]*>/i,
          (head) => `${head}<meta name="robots" content="noindex, nofollow">`,
        );
      },
    },
  };
}
