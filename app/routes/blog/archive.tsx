import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getAllPublishedPosts, getPublishedPostsByTag } from "~/lib/blog/queries.server";
import { CANONICAL_TAGS, labelForTag } from "~/lib/blog/tags";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/archive";

// Ported from legacy /blog/archive (TASK-foxhound-parity-cluster-b.md fix
// 3), confirmed live on recova-eta.vercel.app/blog/archive before building:
// a "Blog" back-link, an "All articles" H1 with an article count, a row of
// tag-filter pills (?tag=slug, one per canonical tag plus "All"), and a
// compact divided list (title + excerpt + reading time per row) - not a
// card grid, deliberately different from the tag-archive route's layout.
// Tag pills use this repo's own 8 canonical tags (blog/tags.ts), not
// legacy's own category set, since the two sites' tag taxonomies differ.
//
// Trimmed columns throughout: getAllPublishedPosts and
// getPublishedPostsByTag both select SUMMARY_COLUMNS, the same trimmed
// select the perf remediation put under the tag-archive route, and
// getPublishedPostsByTag filters in SQL rather than fetching every
// published post and filtering in memory.
//
// Restores blog/index.tsx's dropped inbound link: that file's header
// previously documented "No /blog/archive... the legacy 'All articles'
// link had no canon home to point to, so it is dropped, not ported" - this
// task is the sanctioned exception (task rule: "No route changes beyond
// /blog/archive").

export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "All articles - Foxhound Blog",
    description:
      "Every published guide on Stripe payment recovery, dispute handling, and subscription intelligence.",
    path: "/blog/archive",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const tag = new URL(request.url).searchParams.get("tag");
  const activeTag = tag && (CANONICAL_TAGS as readonly string[]).includes(tag) ? tag : null;
  const posts = activeTag ? await getPublishedPostsByTag(db, activeTag) : await getAllPublishedPosts(db);
  return { siteUrl: siteUrl(env), posts, activeTag };
}

function pillClassName(active: boolean): string {
  return active
    ? "rounded-full border border-amber bg-amber px-3 py-1.5 font-mono text-micro text-on-amber no-underline"
    : "rounded-full border border-border bg-surface px-3 py-1.5 font-mono text-micro text-text-secondary no-underline hover:border-border-i hover:text-text";
}

export default function BlogArchivePage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, posts, activeTag } = loaderData;

  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:px-8">
      <Link
        to="/blog"
        className="group mb-8 inline-flex items-center gap-1.5 text-label text-text-tertiary hover:text-text"
      >
        <ArrowLeft
          className="transition-transform group-hover:-translate-x-0.5"
          size={13}
          strokeWidth={1.5}
          aria-hidden
        />
        Blog
      </Link>

      <h1 className="text-display font-medium text-text">All articles</h1>
      <p className="mt-1 font-mono text-label text-text-tertiary">
        {posts.length} {posts.length === 1 ? "article" : "articles"}
      </p>

      <div className="mt-8 flex flex-wrap gap-2">
        <Link to="/blog/archive" className={pillClassName(!activeTag)}>
          All
        </Link>
        {CANONICAL_TAGS.map((t) => (
          <Link key={t} to={`/blog/archive?tag=${t}`} className={pillClassName(activeTag === t)}>
            {labelForTag(t)}
          </Link>
        ))}
      </div>

      {posts.length === 0 ? (
        <p className="mt-10 text-body text-text-secondary">No articles in this category yet.</p>
      ) : (
        <div className="mt-8 flex flex-col divide-y divide-border-sub">
          {posts.map((post) => (
            <Link
              key={post.slug}
              to={`/blog/${post.slug}`}
              className="group -mx-2 flex items-start gap-4 rounded-lg px-2 py-4 no-underline hover:bg-surface"
            >
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-label font-semibold text-text group-hover:text-amber-text">
                  {post.title}
                </p>
                <p className="mt-0.5 line-clamp-1 text-micro text-text-secondary">{post.excerpt}</p>
              </div>
              <span className="mt-0.5 shrink-0 font-mono text-micro text-text-tertiary">
                {post.readingTimeMinutes} min
              </span>
            </Link>
          ))}
        </div>
      )}

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Blog", path: "/blog" },
              { name: "All articles", path: "/blog/archive" },
            ]),
          ),
        }}
      />
    </div>
  );
}
