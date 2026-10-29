import { d1ScheduledUpdates } from "@dustinedwards/site-api/schedules";
import { data, Form, useActionData, useNavigation } from "react-router";

import { AdminTime } from "~/components/admin-time";
import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { adminContext } from "~/lib/admin/context";
import {
  getPostForAdmin,
  getPostLinksForAdmin,
  getPostVersions,
  listAllPostsForAdmin,
  setPostLinks,
  setPublished,
  updatePostWithVersion,
} from "~/lib/blog/admin-queries.server";
import { renderMarkdown } from "~/lib/blog/markdown.server";
import { CANONICAL_TAGS } from "~/lib/blog/tags";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { notifyIndexNow } from "~/lib/seo/indexnow.server";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/detail";

export const handle: AdminHandle<{ post: { title: string } }> = {
  page: (data: { post: { title: string } }) => data.post.title,
};

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.post.title ?? "Post"} - Foxhound admin` }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const post = await getPostForAdmin(db, params.id);
  if (!post) throw new Response("Not Found", { status: 404 });

  const [versions, links, allPosts, rendered] = await Promise.all([
    getPostVersions(db, post.id),
    getPostLinksForAdmin(db, post.id),
    listAllPostsForAdmin(db),
    post.body.trim() ? renderMarkdown(db, post.body) : Promise.resolve({ html: "", toc: [] }),
  ]);

  const linkCandidates = allPosts.filter((p) => p.id !== post.id && p.published);

  return { post, versions, links, linkCandidates, previewHtml: rendered.html };
}

type ActionResult = { intent: string; ok: boolean; error?: string };

export async function action({ context, params, request }: Route.ActionArgs) {
  const { env, ctx } = context.get(cloudflareContext);
  const auth = context.get(adminContext);
  const db = getDb(env);
  const postId = params.id;

  const post = await getPostForAdmin(db, postId);
  if (!post) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");
  const str = (name: string) => {
    const v = form.get(name);
    const trimmed = typeof v === "string" ? v.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  };

  if (intent === "save") {
    const title = str("title");
    if (!title) return data<ActionResult>({ intent, ok: false, error: "Title is required." }, { status: 400 });
    const tags = form.getAll("tags").map(String);

    await updatePostWithVersion(db, postId, auth.email, {
      title,
      excerpt: str("excerpt") ?? "",
      body: str("body") ?? "",
      author: str("author") ?? "Foxhound",
      tags,
      featured: form.get("featured") === "on",
      coverImageUrl: str("coverImageUrl"),
      coverImageAlt: str("coverImageAlt"),
      ogTitle: str("ogTitle"),
      ogDescription: str("ogDescription"),
      canonicalUrl: str("canonicalUrl"),
      showUpdatedAt: form.get("showUpdatedAt") === "on",
      showPublishedAt: form.get("showPublishedAt") === "on",
    });
    await logAdminAction(db, { actorEmail: auth.email, action: "blog.update", metadata: { postId, slug: post.slug } });
    // INDEXNOW (job_b0b24df12155): Recova's editor submits on every save that
    // leaves the post published. A save changes neither the slug nor the
    // published flag, so the row read above still answers both. Fire and
    // forget; it never fails or delays the save.
    if (post.published) notifyIndexNow(request, ctx, post);
    return data<ActionResult>({ intent, ok: true });
  }

  if (intent === "publish" || intent === "unpublish") {
    const published = intent === "publish";
    // A schedule Carrel set on this post (site-api v0.10.0) is dropped, as a
    // Carrel publish or unpublish drops it, so the cron never undoes this.
    await d1ScheduledUpdates(env.DB).remove(postId).run();
    await setPublished(db, postId, published);
    await logAdminAction(db, {
      actorEmail: auth.email,
      action: published ? "blog.publish" : "blog.unpublish",
      metadata: { postId, slug: post.slug },
    });
    // INDEXNOW (job_b0b24df12155): a publish is the URL going live; an
    // unpublish submits nothing, as in Recova. This hook and the save's move
    // when Carrel's blog publishing (J11, job_09c55603e321) and Prelum's blog
    // pages (J19 job_deffd581af37, J61 job_2ee0cfdd5c29) land.
    if (published) notifyIndexNow(request, ctx, post);
    return data<ActionResult>({ intent, ok: true });
  }

  if (intent === "set-links") {
    const targetIds = form.getAll("linkTargetIds").map(String);
    await setPostLinks(db, postId, targetIds);
    await logAdminAction(db, {
      actorEmail: auth.email,
      action: "blog.set-links",
      metadata: { postId, slug: post.slug, targetIds },
    });
    return data<ActionResult>({ intent, ok: true });
  }

  return data<ActionResult>({ intent, ok: false, error: "Unknown action." }, { status: 400 });
}

export default function AdminBlogDetail({ loaderData }: Route.ComponentProps) {
  const { post, versions, links, linkCandidates, previewHtml } = loaderData;
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const selectedLinkIds = new Set(links.map((l) => l.targetId));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={post.published ? "success" : "neutral"}>{post.published ? "Published" : "Draft"}</Badge>
          <Form method="post">
            <input type="hidden" name="_intent" value={post.published ? "unpublish" : "publish"} />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md border border-border px-3 py-1.5 text-label text-text hover:border-brand disabled:opacity-60"
            >
              {post.published ? "Unpublish" : "Publish"}
            </button>
          </Form>
        </div>
      </div>

      <p className="mb-6 font-mono text-micro text-text-subtle">
        /blog/{post.slug} - slug is fixed after creation (SEO stability)
      </p>

      {actionData && !actionData.ok && actionData.error ? (
        <p className="mb-4 rounded-md border border-red bg-red-bg px-3 py-2 text-label text-error-text" role="alert">
          {actionData.error}
        </p>
      ) : null}
      {actionData && actionData.ok ? (
        <p className="mb-4 rounded-md border border-green bg-green-bg px-3 py-2 text-label text-success-text" role="status">
          Saved.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Form method="post" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
          <input type="hidden" name="_intent" value="save" />

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Title</span>
            <input
              type="text"
              name="title"
              defaultValue={post.title}
              required
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Excerpt</span>
            <textarea
              name="excerpt"
              defaultValue={post.excerpt}
              rows={2}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
              Body (markdown + shortcodes)
            </span>
            <textarea
              name="body"
              defaultValue={post.body}
              rows={20}
              className="rounded-md border border-border bg-surface2 px-3 py-2 font-mono text-micro text-text focus-visible:border-brand"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Author</span>
            <input
              type="text"
              name="author"
              defaultValue={post.author}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
            />
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Tags</legend>
            <div className="flex flex-wrap gap-3">
              {CANONICAL_TAGS.map((tag) => (
                <label key={tag} className="flex items-center gap-1.5 text-label text-text">
                  <input
                    type="checkbox"
                    name="tags"
                    value={tag}
                    defaultChecked={post.tags?.includes(tag) ?? false}
                    className="h-4 w-4 rounded border-border accent-brand"
                  />
                  {tag}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex items-center gap-2 text-label text-text">
            <input
              type="checkbox"
              name="featured"
              defaultChecked={post.featured}
              className="h-4 w-4 rounded border-border accent-brand"
            />
            Featured
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Cover image URL</span>
              <input
                type="text"
                name="coverImageUrl"
                defaultValue={post.coverImageUrl ?? ""}
                className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Cover image alt</span>
              <input
                type="text"
                name="coverImageAlt"
                defaultValue={post.coverImageAlt ?? ""}
                className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">OG title</span>
              <input
                type="text"
                name="ogTitle"
                defaultValue={post.ogTitle ?? ""}
                className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">OG description</span>
              <input
                type="text"
                name="ogDescription"
                defaultValue={post.ogDescription ?? ""}
                className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Canonical URL</span>
            <input
              type="text"
              name="canonicalUrl"
              defaultValue={post.canonicalUrl ?? ""}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-brand"
            />
          </label>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-label text-text">
              <input
                type="checkbox"
                name="showUpdatedAt"
                defaultChecked={post.showUpdatedAt}
                className="h-4 w-4 rounded border-border accent-brand"
              />
              Show "updated" date
            </label>
            <label className="flex items-center gap-2 text-label text-text">
              <input
                type="checkbox"
                name="showPublishedAt"
                defaultChecked={post.showPublishedAt}
                className="h-4 w-4 rounded border-border accent-brand"
              />
              Show "published" date
            </label>
          </div>

          <div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-brand px-4 py-2 text-body font-medium text-on-brand disabled:opacity-60"
            >
              {busy ? "Saving..." : "Save"}
            </button>
          </div>
        </Form>

        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Preview</p>
            {previewHtml ? (
              <div className="blog-prose mt-3" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            ) : (
              <p className="mt-2 text-label text-text-tertiary">Nothing to preview yet.</p>
            )}
          </div>

          <Form method="post" className="rounded-lg border border-border bg-surface p-4">
            <input type="hidden" name="_intent" value="set-links" />
            <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Further reading links</p>
            {linkCandidates.length === 0 ? (
              <p className="mt-2 text-label text-text-tertiary">No other published posts to link to yet.</p>
            ) : (
              <div className="mt-3 flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                {linkCandidates.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-label text-text">
                    <input
                      type="checkbox"
                      name="linkTargetIds"
                      value={p.id}
                      defaultChecked={selectedLinkIds.has(p.id)}
                      className="h-4 w-4 rounded border-border accent-brand"
                    />
                    {p.title}
                  </label>
                ))}
              </div>
            )}
            <div className="mt-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-label text-text hover:border-brand disabled:opacity-60"
              >
                Save links
              </button>
            </div>
          </Form>

          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Version history</p>
            {versions.length === 0 ? (
              <p className="mt-2 text-label text-text-tertiary">No saved versions yet.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {versions.map((v) => (
                  <li key={v.id} className="border-b border-border-sub pb-2 text-label last:border-0">
                    <p className="text-text">{v.title}</p>
                    <p className="text-text-tertiary">
                      <AdminTime at={v.savedAt} />
                      {v.savedBy ? ` - ${v.savedBy}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
