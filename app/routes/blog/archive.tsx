import { Link } from "capsomer/react/link";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  getAllPublishedPosts,
  getPublishedPostsByTag,
  getPublishedTagSet,
} from "~/lib/blog/queries.server";
import { CANONICAL_TAGS, labelForTag } from "~/lib/blog/tags";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/archive";
import { SectionTrail } from "~/components/section-trail";

// Ported from legacy app/(marketing)/blog/archive/page.tsx: a "Blog"
// back-link, an H1 that names the active filter, an article count, a row of
// tag-filter pills (?tag=slug, plus "All"), and a compact divided list
// (title + excerpt + reading time per row), not a card grid. Legacy makes
// that list/grid split deliberately: /blog/tag/:tag renders cards, this page
// renders rows.
//
// Pills (Dustin, ruling 72 session): CANONICAL_TAGS stays the full canonical
// list because the sitemap and llms.txt enumerate it, but a pill renders only
// for a tag that has at least one published post. Legacy hardcodes five
// categories; Foxhound's taxonomy has eight, and showing a chip that leads to
// an empty page is worse than either. This replaces an unratified "the two
// sites' tag taxonomies differ" note that had simply rendered all eight.
//
// Trimmed columns throughout: getAllPublishedPosts and getPublishedPostsByTag
// both select SUMMARY_COLUMNS, and getPublishedPostsByTag filters in SQL
// rather than fetching every published post and filtering in memory.

// Legacy varies both title and description by the active tag; a static pair
// described the unfiltered page even when ?tag= narrowed it.
export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.activeTag ? labelForTag(loaderData.activeTag) : null;
  return [
    ...marketingMeta({
      title: label ?? "All articles",
      suffix: " - Foxhound Blog",
      description: label
        ? `Every Foxhound blog article on ${label}, with practical steps for Stripe merchants who want to keep more of their revenue.`
        : "Every published guide on Stripe payment recovery, dispute handling, and subscription intelligence.",
      path: loaderData?.activeTag ? `/blog/archive?tag=${loaderData.activeTag}` : "/blog/archive",
      pageType: "CollectionPage",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const tag = new URL(request.url).searchParams.get("tag");
  const activeTag = tag && (CANONICAL_TAGS as readonly string[]).includes(tag) ? tag : null;
  const [posts, tagsWithPosts] = await Promise.all([
    activeTag ? getPublishedPostsByTag(db, activeTag) : getAllPublishedPosts(db),
    getPublishedTagSet(db),
  ]);
  const withPosts = new Set(tagsWithPosts);
  const visibleTags = CANONICAL_TAGS.filter((t) => withPosts.has(t));
  return { siteUrl: siteUrl(env), posts, activeTag, visibleTags };
}

function pillClassName(active: boolean): string {
  const base = "rounded-full border px-3 py-1.5 font-mono text-xs no-underline transition-colors";
  return active
    ? `${base} border-brand bg-brand text-on-brand`
    : `${base} border-border-sub bg-surface text-text-secondary hover:border-border hover:text-text`;
}

export default function BlogArchivePage({ loaderData }: Route.ComponentProps) {
  const { posts, activeTag, visibleTags } = loaderData;
  const activeLabel = activeTag ? labelForTag(activeTag) : "All articles";

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <SectionTrail items={[{ label: "Blog", href: "/blog" }, { label: activeLabel }]} />

      <h1 className="mt-3 text-2xl font-bold text-text">{activeLabel}</h1>
      <p className="mt-1 font-mono text-sm text-text-secondary">
        {posts.length} {posts.length === 1 ? "article" : "articles"}
      </p>

      <div className="mb-8 mt-8 flex flex-wrap gap-2">
        <Link to="/blog/archive" className={pillClassName(!activeTag)}>
          All
        </Link>
        {visibleTags.map((t) => (
          <Link key={t} to={`/blog/archive?tag=${t}`} className={pillClassName(activeTag === t)}>
            {labelForTag(t)}
          </Link>
        ))}
      </div>

      {posts.length === 0 ? (
        <p className="text-sm text-text-secondary">No articles found.</p>
      ) : (
        <div className="flex flex-col divide-y divide-border-sub">
          {posts.map((post) => (
            <Link
              key={post.slug}
              to={`/blog/${post.slug}`}
              className="group -mx-2 flex items-start gap-4 rounded-lg px-2 py-4 no-underline transition-colors hover:bg-surface"
            >
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-sm font-semibold leading-snug text-text transition-colors group-hover:text-brand-text">
                  {post.title}
                </p>
                <p className="mt-0.5 line-clamp-1 text-xs text-text-secondary">{post.excerpt}</p>
              </div>
              <span className="mt-0.5 shrink-0 font-mono text-micro text-text-tertiary">
                {post.readingTimeMinutes} min
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
