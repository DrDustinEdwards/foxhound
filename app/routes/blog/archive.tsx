import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { plural } from "@drdustinedwards/site-helpers/text";
import { Link } from "capsomer/react/link";

import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
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
import "capsomer/chips.css";
import "~/blog-index.css";

// A "Blog" back-link, an H1 that names the active filter, an article count, a row of tag-filter pills (?tag=slug, plus "All"), and a compact divided list (title + excerpt + reading time per row), not a card grid (/blog/tag/:tag renders cards). CANONICAL_TAGS stays the full list because the sitemap and llms.txt enumerate it, but a pill renders only for a tag that has at least one published post: a chip that leads to an empty page is worse than none. Trimmed columns throughout: getAllPublishedPosts and getPublishedPostsByTag both select SUMMARY_COLUMNS, and getPublishedPostsByTag filters in SQL.

// Title and description vary by the active tag; a static pair would describe the unfiltered page even when ?tag= narrowed it.
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

export default function BlogArchivePage({ loaderData }: Route.ComponentProps) {
  const { posts, activeTag, visibleTags } = loaderData;
  const activeLabel = activeTag ? labelForTag(activeTag) : "All articles";

  return (
    <div className="fh-mk-wide">
      <SectionTrail items={[{ label: "Blog", href: "/blog" }, { label: activeLabel }]} />

      <h1 className="fh-archive-title fh-bold fh-text">{activeLabel}</h1>
      <p className="fh-archive-text fh-mono fh-soft">{plural(posts.length, "article")}</p>

      {/* Recova's tag filter: mono chips, the current one filled amber. Link
          chips (Capsomer chips.md): the tag is in the address. */}
      <nav
        aria-label="Filter articles by tag"
        className="fh-archive-nav fh-cap"
        data-cap-site="foxhound"
        data-family="amber"
      >
        <ul className="fh-mk-chips cap-chips" data-variant="solid">
          <li>
            <Link
              to="/blog/archive"
              className="cap-chip"
              aria-current={activeTag ? undefined : "true"}
            >
              All
            </Link>
          </li>
          {visibleTags.map((t) => (
            <li key={t}>
              <Link
                to={`/blog/archive?tag=${t}`}
                className="cap-chip"
                aria-current={activeTag === t ? "true" : undefined}
              >
                {labelForTag(t)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {posts.length === 0 ? (
        <p className="fh-archive-text-2 fh-soft">No articles found.</p>
      ) : (
        <div className="fh-archive-col">
          {posts.map((post) => (
            <Link
              key={post.slug}
              to={`/blog/${post.slug}`}
              className="fh-archive-link fh-hover-group"
            >
              <div className="cap-grow">
                <p className="fh-archive-text-3 fh-semibold fh-text">{post.title}</p>
                <p className="fh-archive-text-4 fh-soft">{post.excerpt}</p>
              </div>
              <span className="fh-mk-mark fh-mono fh-tiny fh-quiet">
                {post.readingTimeMinutes} min
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export const headers = () => publicPageHeaders();
