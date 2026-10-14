import { data, Form, redirect, useActionData, useNavigation } from "react-router";
import { AdminTime } from "~/components/admin-time";
import { Link } from "react-router";

import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { logAdminAction } from "~/lib/admin/audit.server";
import { adminContext } from "~/lib/admin/context";
import { createPost, listAllPostsForAdmin, uniqueSlugFromTitle } from "~/lib/blog/admin-queries.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { AdminHandle } from "~/lib/admin/page";

import type { Route } from "./+types/index";

export const handle: AdminHandle = { page: "Blog" };

export function meta() {
  return [{ title: "Blog - Foxhound admin" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const posts = await listAllPostsForAdmin(db);
  return { posts };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(adminContext);
  const db = getDb(env);

  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  if (!title) {
    return data({ error: "Title is required." }, { status: 400 });
  }

  const slug = await uniqueSlugFromTitle(db, title);
  const postId = await createPost(db, {
    title,
    slug,
    excerpt: "",
    body: "",
    author: "Foxhound",
    tags: [],
    featured: false,
  });

  await logAdminAction(db, {
    actorEmail: auth.email,
    action: "blog.create",
    metadata: { postId, slug, title },
  });

  throw redirect(`/admin/blog/${postId}`);
}

export default function AdminBlogIndex({ loaderData }: Route.ComponentProps) {
  const { posts } = loaderData;
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <div>

      <div className="mb-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">New post</p>
        {actionData && "error" in actionData ? (
          <p className="mt-2 text-label text-error-text" role="alert">
            {actionData.error}
          </p>
        ) : null}
        <Form method="post" className="mt-3 flex flex-wrap gap-3">
          <input
            type="text"
            name="title"
            placeholder="Post title"
            required
            className="min-w-64 flex-1 rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-brand"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand px-4 py-2 text-body font-medium text-on-brand disabled:opacity-60"
          >
            {busy ? "Creating..." : "Create draft"}
          </button>
        </Form>
      </div>

      {posts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-body text-text-tertiary">
          No posts yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-label">
            <thead>
              <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-3 font-normal">Title</th>
                <th className="px-4 py-3 font-normal">Status</th>
                <th className="px-4 py-3 font-normal">Tags</th>
                <th className="px-4 py-3 font-normal">Updated</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id} className="border-b border-border-sub last:border-0">
                  <td className="px-4 py-3">
                    <Link to={`/admin/blog/${p.id}`} className="text-text hover:text-brand">
                      {p.title}
                    </Link>
                    {p.featured ? <span className="ml-2 text-text-subtle">(featured)</span> : null}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={p.published ? "success" : "neutral"}>{p.published ? "Published" : "Draft"}</Badge>
                  </td>
                  <td className="px-4 py-3 text-text-tertiary">{p.tags.join(", ") || "-"}</td>
                  <td className="px-4 py-3 text-text-tertiary"><AdminTime at={p.updatedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
