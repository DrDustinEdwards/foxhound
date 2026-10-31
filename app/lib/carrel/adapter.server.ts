import {
  ContentTag,
  contentVersion,
  NotFoundError,
  RefusedError,
  VersionConflictError,
  type ContentDoc,
  type ContentSummary,
  type DueSchedule,
  type ListQuery,
  type SiteAdapter,
  type WriteResult,
} from "@dustinedwards/site-api";
import { POST_FIELDS, SEARCH_FIELDS } from "@dustinedwards/site-api/frontmatter";
import { utc, type D1ScheduledUpdates } from "@dustinedwards/site-api/schedules";
import { RENDER_VERSION } from "@drdustinedwards/site-helpers/render/nomath";
import { desc, eq } from "drizzle-orm";

import { blogPostDrafts, blogPostVersions, blogPosts, type Db } from "~/db";
import {
  byline,
  createPost,
  deletePost,
  dropDraft,
  getDraft,
  putDraft,
  renamePost,
  setPublished,
  setTrashed,
  uniqueSlugFromTitle,
  updatePostWithVersion,
  type VersionNote,
} from "~/lib/blog/admin-queries.server";
import { estimateReadingTime } from "~/lib/blog/format";
import type { BlogPost } from "~/lib/blog/queries.server";
import { redirectedBlogSlug } from "~/lib/blog/slug-redirects";
import { isWithdrawnBlogSlug } from "~/lib/blog/withdrawn";

import { parsePostSource, serializePostSource, SourceError, type PostSource } from "./source";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";

/** Draws a post through the real /blog/<slug> route and root layout, in process (workers/app.ts), for a preview. */
export type RenderPostPage = (post: BlogPost) => Promise<string>;

// The Carrel site adapter over Foxhound's blog. Posts live in
// D1 (blog_posts, blog_post_versions) and are edited in Carrel, which replaced
// Foxhound's own /admin/blog editor; the adapter writes through
// admin-queries, the one write path.
//
// Version = the post's updated_at in epoch milliseconds, as a string, with a
// hash of its schedule's time and change id added while one waits, so a
// schedule, a reschedule and a cancel each move it. A historical revision is
// "rev-<blog_post_versions.id>": the post's whole source (every field) before an
// edit, a publish, an unpublish or a rename, named by who made it ("Dustin
// Edwards": every Carrel change is his until site-api passes the actor). Rows
// from before migration 0070 kept title, excerpt and body only, so their source
// takes its other fields from the current post.
//
// A LIVE POST'S DRAFT. A save on a published post never touches its row: the
// source goes to blog_post_drafts, the page keeps serving the live row, and the
// post reads back with the draft as its source and "live" among its revisions.
// A publish applies it; an unpublish or a trash, which take the post off the
// blog, write it into the row. The version carries the draft's hash, so a save
// moves it.
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
// (site-api v0.17.0) are the og_title, og_description, og_image_url,
// og_image_alt, canonical_url and noindex columns under site-api's shared
// names (./source.ts).

const CARREL_SITE = {
  id: "foxhound",
  name: "Foxhound",
  origin: SITE_ORIGIN,
} as const;

const KIND = "post";
const DEFAULT_AUTHORS = ["Foxhound"];
/** Who a revision names. Every change through Carrel is Dustin's until site-api's actor carries the person. */
const EDITOR = "Dustin Edwards";
/** The revision that is the live post, beside a pending draft. */
const LIVE_REVISION = "live";
/** A rename's new id is the post's new address, /blog/<id>. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_PREFIX = "rev-";
/** Every schedule is due by then, so `due` at this time lists every row. A
 *  four-digit year, since the store compares times as ISO text. */
const END_OF_TIME = new Date("9999-12-31T23:59:59.999Z");
const ALL_ROWS = 10_000;

type PostRow = typeof blogPosts.$inferSelect;
type Draft = NonNullable<Awaited<ReturnType<typeof getDraft>>>;
interface Pending {
  publishAt: string;
  changeId: string;
}
interface Post {
  row: PostRow;
  pending: Pending | null;
  draft: Draft | null;
  version: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function versionOf(row: PostRow, pending: Pending | null, draft: Draft | null = null): Promise<string> {
  // A post with search fields set carries their hash, so a source read before Carrel saw them is a conflict, not a
  // save that clears them.
  const search = [row.ogTitle, row.ogDescription, row.ogImageUrl, row.ogImageAlt, row.canonicalUrl, row.noindex];
  let version = String(row.updatedAt.getTime()) + (search.some(Boolean) ? `.s${(await contentVersion(search)).slice(0, 8)}` : "");
  if (draft) version += `.d${(await contentVersion([draft.changeId, draft.source])).slice(0, 12)}`;
  if (!pending) return version;
  return `${version}.${(await contentVersion([pending.publishAt, pending.changeId])).slice(0, 16)}`;
}

/** The post's authors; a row from before 0070's backfill has only `author`. */
const authorsOf = (row: PostRow): string[] => (row.authors?.length ? row.authors : row.author.trim() ? [row.author] : []);

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
    authors: authorsOf(row),
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
    (!query.author || authorsOf(row).includes(query.author)) &&
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
    authors: authorsOf(row),
    series: row.series,
    seriesPart: row.seriesPart,
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
    return parsePostSource(source, { authors: DEFAULT_AUTHORS }, options);
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

/** A revision of the row as it is now, before the change `message` names. */
const noteOf = (row: PostRow, message: string): VersionNote => ({
  savedBy: EDITOR,
  message,
  source: serializePostSource(sourceOf(row)),
});

/** The row the blog route renders for a preview: the source's fields over the stored post, if there is one. Never indexed. */
function previewPost(post: PostSource, row: PostRow | null): BlogPost {
  return {
    id: row?.id ?? "carrel-preview",
    slug: row?.slug ?? post.slug ?? "carrel-preview",
    title: post.title,
    excerpt: post.excerpt,
    coverImageUrl: row?.coverImageUrl ?? null,
    coverImageAlt: row?.coverImageAlt ?? null,
    publishedAt: row?.publishedAt ?? null,
    updatedAt: row?.updatedAt ?? null,
    author: byline(post.authors),
    authors: post.authors,
    series: post.series ?? null,
    seriesPart: post.seriesPart ?? null,
    tags: post.tags,
    featured: post.featured,
    readingTimeMinutes: estimateReadingTime(post.body),
    body: post.body,
    createdAt: row?.createdAt ?? new Date(),
    published: true,
    ogTitle: post.searchTitle ?? null,
    ogDescription: post.description ?? null,
    canonicalUrl: post.canonical ?? null,
    ogImageUrl: post.image ?? null,
    ogImageAlt: post.imageAlt ?? null,
    noindex: true,
    showUpdatedAt: row?.showUpdatedAt ?? true,
    showPublishedAt: row?.showPublishedAt ?? true,
  };
}

/** `renderPage` draws a preview through the blog route; the cron passes none, and draws none. */
export function carrelAdapter(db: Db, schedules: D1ScheduledUpdates, renderPage?: RenderPostPage): SiteAdapter {
  async function load(id: string): Promise<Post | null> {
    const rows = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const waiting = await schedules.get(id);
    const pending = waiting ? { publishAt: waiting.publishAt, changeId: waiting.changeId } : null;
    const draft = row.published ? await getDraft(db, id) : null;
    return { row, pending, draft, version: await versionOf(row, pending, draft) };
  }

  /** The source Carrel edits: a live post's pending draft, else the row. */
  const sourceNow = ({ row, draft }: Post) => draft?.source ?? serializePostSource(sourceOf(row));

  /** A post just taken off the blog with a draft waiting: the draft becomes its row, as a draft post has no other. */
  async function settleDraft(id: string, draft: Draft | null) {
    if (!draft) return;
    const rows = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
    if (rows[0]) await writeSource(rows[0], { ...parse(draft.source), slug: null });
    await dropDraft(db, id);
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
        authors: post.authors,
        series: post.series,
        seriesPart: post.seriesPart,
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
    const post = parse(source);
    if (!current.published) return writeSource(current, post);
    // A live post's draft stays apart until a publish (B3): its page is unchanged.
    keepSlug(post, current);
    await putDraft(db, id, { source, changeId, savedBy: EDITOR });
  }

  async function writeSource(current: PostRow, post: PostSource, message = "edited") {
    keepSlug(post, current);
    await updatePostWithVersion(db, current.id, noteOf(current, message), {
      title: post.title,
      excerpt: post.excerpt,
      body: post.body,
      authors: post.authors,
      series: post.series ?? null,
      seriesPart: post.seriesPart ?? null,
      tags: post.tags,
      featured: post.featured,
      coverImageUrl: current.coverImageUrl,
      coverImageAlt: current.coverImageAlt,
      ogTitle: post.searchTitle ?? null,
      ogDescription: post.description ?? null,
      canonicalUrl: post.canonical ?? null,
      ogImageUrl: post.image ?? null,
      ogImageAlt: post.imageAlt ?? null,
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
      // The page renders each: the excerpt under the title, the authors in the byline, "Part n of m" for a series.
      postFields: [...POST_FIELDS],
      publishedAtSettable: true,
      // The blog post head renders all of them. With no share image the card is the cover, else the generated card.
      searchFields: SEARCH_FIELDS,

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
        const drafts = new Map((await db.select().from(blogPostDrafts)).map((d) => [d.postId, d]));
        // The status is the row's and its schedule's, so it filters before the page is cut.
        const matching = rows
          .map((row) => ({ row, pending: waiting.get(row.id) ?? null, draft: row.published ? (drafts.get(row.id) ?? null) : null }))
          .filter((post) => !query.status || summary({ ...post, version: "" }).status === query.status);
        const start = Number.parseInt(query.cursor ?? "0", 10) || 0;
        const items = await Promise.all(
          matching
            .slice(start, start + query.limit)
            .map(async (post) => summary({ ...post, version: await versionOf(post.row, post.pending, post.draft) })),
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
          source: sourceNow(post),
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
        const { row, draft } = await mustMatch(id, input.expectedVersion);
        notTrashed(row);
        // What goes live: the source sent, else a live post's pending draft, else the row as it is.
        const source = input.source ?? draft?.source;
        if (source !== undefined) await writeSource(row, parse(source));
        await dropDraft(db, id);
        // What goes live is this publish, so a waiting schedule is dropped.
        await schedules.remove(id).run();
        const fresh = (await load(id))!.row;
        await setPublished(db, id, true, noteOf(fresh, "published"), input.publishedAt ? { publishedAt: new Date(input.publishedAt) } : {});
        return writeResult(id, input.changeId);
      },

      // site-api sends only a post that is not live here; a live post's
      // schedule is schedules.update below.
      async schedule(id, input) {
        const { row } = await mustMatch(id, input.expectedVersion);
        notTrashed(row);
        await putSchedule(row, input.source ?? serializePostSource(sourceOf(row)), input.publishAt, input.changeId);
        if (input.source !== undefined) await writeSource(row, parse(input.source));
        return writeResult(id, input.changeId);
      },

      async unpublish(id, input) {
        const { row, draft } = await mustMatch(id, input.expectedVersion);
        await schedules.remove(id).run();
        await setPublished(db, id, false, noteOf(row, "unpublished"));
        await settleDraft(id, draft);
        return writeResult(id, input.changeId);
      },

      // The tags field of the post's source, written alone. A live post's page changes with it, and its pending
      // draft takes the same tags.
      async setTags(id, input) {
        const { row, draft } = await held(id, input.expectedVersion);
        await writeSource(row, { ...sourceOf(row), tags: input.tags });
        if (draft) {
          const source = serializePostSource({ ...parse(draft.source), tags: input.tags });
          await putDraft(db, id, { source, changeId: input.changeId, savedBy: EDITOR });
        }
        return writeResult(id, input.changeId);
      },

      // A live post leaves the blog as it goes in, and a waiting schedule goes
      // with it (apply also skips a trashed post, should the drop fail).
      async trash(id, input) {
        const { row, draft } = await held(id, input.expectedVersion);
        notTrashed(row);
        await schedules.remove(id).run();
        await setTrashed(db, id, true);
        await settleDraft(id, draft);
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
        const { row, pending, draft } = await held(id, input.expectedVersion);
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
        await renamePost(db, row, newId, { redirect: previousPath !== null, note: noteOf(row, `renamed from /blog/${row.slug}`) });
        // A pending draft names the old slug, which is no longer the post's.
        if (draft) {
          const source = serializePostSource({ ...parse(draft.source), slug: newId });
          await putDraft(db, newId, { source, changeId: input.changeId, savedBy: EDITOR });
        }
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
        const { draft } = post;
        return [
          draft
            ? { version: post.version, at: draft.savedAt.toISOString(), author: draft.savedBy ?? EDITOR, message: "draft of the live post, not yet published" }
            : { version: post.version, at: row.updatedAt.toISOString(), author: EDITOR, message: "current" },
          ...(draft ? [{ version: LIVE_REVISION, at: row.updatedAt.toISOString(), author: EDITOR, message: "the live post" }] : []),
          ...versions.map((v) => ({
            version: `${REVISION_PREFIX}${v.id}`,
            at: v.savedAt.toISOString(),
            // Rows from before 0070 name the change id ("carrel:<id>"); every one was Dustin's.
            author: !v.savedBy || v.savedBy.startsWith("carrel:") ? EDITOR : v.savedBy,
            message: `the post before it was ${v.message ?? "edited"}`,
          })),
        ];
      },

      async revisionSource(id, version) {
        const post = await load(id);
        if (!post) return null;
        if (version === post.version) return sourceNow(post);
        if (version === LIVE_REVISION && post.draft) return serializePostSource(sourceOf(post.row));
        if (!version.startsWith(REVISION_PREFIX)) return null;
        const rows = await db
          .select()
          .from(blogPostVersions)
          .where(eq(blogPostVersions.id, version.slice(REVISION_PREFIX.length)))
          .limit(1);
        const old = rows[0];
        if (!old || old.postId !== id) return null;
        if (old.source) return old.source;
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
          await writeSource(post.row, { ...parse(waiting.source), slug: null });
        } else {
          if (post.row.published) return null;
          // A first publication records the time it was scheduled for.
          await setPublished(db, id, true, noteOf(post.row, "published"), { firstPublishedAt: new Date(waiting.publishAt) });
        }
        await schedules.remove(id, { publishAt: waiting.publishAt, changeId: waiting.changeId }).run();
        return writeResult(id, input.changeId);
      },
    },

    renderVersion: RENDER_VERSION,

    // The page /blog/<slug> would be, drawn by the blog route itself with the
    // marketing header, footer and byline (renderPage, workers/app.ts), over a
    // row built from the source: an unsaved source has no row for the route to
    // load. The row says noindex, so the page's robots meta does; site-api's
    // preview responses are private, no-store and x-robots-tag noindex.
    preview: {
      async render(input) {
        if (!renderPage) throw new Error("A preview is drawn only on a request, which gives the adapter the page renderer.");
        const post = parse(input.source, { preview: true });
        const row = input.id ? ((await load(input.id))?.row ?? null) : null;
        return renderPage(previewPost(post, row));
      },
    },
  };
}
