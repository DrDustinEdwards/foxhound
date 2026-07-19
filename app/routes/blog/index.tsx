import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { BlogPostCard } from "~/components/blog/blog-post-card";
import { FadeUp } from "~/components/fade-up";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatTagChip } from "~/lib/blog/format";
import {
  getAllPublishedPosts,
  getFeaturedPost,
  getPostsBySlug,
  listPublishedPosts,
  type BlogPostSummary,
} from "~/lib/blog/queries.server";
import { SECTIONS, SECTION_MIN_CLUSTER_SIZE, type BlogSectionConfig } from "~/lib/blog/sections";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/index";

// Ported from legacy app/(marketing)/blog/page.tsx (Phase 6 Pass 2): a
// featured-post hero, four curated topic sections, and a "latest" strip of
// non-featured posts. Two deliberate departures from legacy, both per the
// task spec:
//   - No /blog/archive. ROUTES.md's Public section lists exactly /blog,
//     /blog/:slug, /blog/tag/:tag; the legacy "All articles" link had no
//     canon home to point to, so it is dropped, not ported.
//   - A section only renders once its underlying tag cluster has 8+
//     published posts (SECTION_MIN_CLUSTER_SIZE), not just "some of its
//     curated slugs resolved". Pre-import (zero rows) every section is
//     empty, which is the correct, honest state, not a bug.
export function meta() {
  return [
    { title: "Blog - Foxhound" },
    {
      name: "description",
      content: "Guides on Stripe payment recovery, dispute handling, and subscription intelligence.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const allSectionSlugs = SECTIONS.flatMap((s) => s.slugs);

  const [featured, latest8, sectionPosts, allPublished] = await Promise.all([
    getFeaturedPost(db),
    listPublishedPosts(db, 8),
    getPostsBySlug(db, allSectionSlugs),
    getAllPublishedPosts(db),
  ]);

  const tagCounts = new Map<string, number>();
  for (const post of allPublished) {
    for (const tag of post.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  const bySlug = new Map(sectionPosts.map((p) => [p.slug, p]));
  const sections = SECTIONS.map((section) => {
    const qualifies = (tagCounts.get(section.id) ?? 0) >= SECTION_MIN_CLUSTER_SIZE;
    const posts = qualifies
      ? section.slugs.flatMap((slug) => {
          const p = bySlug.get(slug);
          return p ? [p] : [];
        })
      : [];
    return { section, posts };
  }).filter((s) => s.posts.length > 0);

  const latest = latest8.filter((p) => p.slug !== featured?.slug).slice(0, 4);

  return { siteUrl: siteUrl(env), featured, sections, latest };
}

export default function BlogIndexPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, featured, sections, latest } = loaderData;
  const hasAnyContent = Boolean(featured) || sections.length > 0 || latest.length > 0;

  return (
    <div>
      <div className="mx-auto max-w-5xl px-4 pb-6 pt-16 sm:px-8">
        <FadeUp>
          <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Posts</p>
          <h1 className="mt-3 text-display font-medium text-text">Blog</h1>
          <p className="mt-3 max-w-xl text-body text-text-secondary">
            Guides on Stripe payment recovery, dispute handling, and subscription intelligence.
          </p>
        </FadeUp>
      </div>

      {featured ? <BlogHero post={featured} /> : null}

      {sections.map(({ section, posts }) => (
        <BlogSection key={section.id} section={section} posts={posts} />
      ))}

      {latest.length > 0 ? <BlogLatestStrip posts={latest} /> : null}

      {!hasAnyContent ? (
        <div className="mx-auto max-w-xl px-4 pb-20 pt-4 text-center sm:px-8">
          <p className="text-body text-text-secondary">
            Nothing published yet. Check back soon, or read the product docs in the meantime.
          </p>
          <Link to="/docs" className="mt-4 inline-block text-label text-amber-text hover:opacity-80">
            Read the docs
          </Link>
        </div>
      ) : null}

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Blog", path: "/blog" },
            ]),
          ),
        }}
      />
    </div>
  );
}

function BlogHero({ post }: { post: BlogPostSummary }) {
  return (
    <section className="border-b border-border-sub bg-surface">
      <div className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-8 px-4 py-12 sm:px-8 lg:grid-cols-2 lg:py-16">
        <div>
          <p className="font-mono text-micro uppercase tracking-wide text-amber-text">Featured</p>
          <h2 className="mt-3 text-title font-medium leading-tight text-text">
            <Link to={`/blog/${post.slug}`} className="hover:text-amber-text">
              {post.title}
            </Link>
          </h2>
          <p className="mt-3 line-clamp-3 text-body leading-relaxed text-text-secondary">{post.excerpt}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-micro text-text-tertiary">
            <span>{post.readingTimeMinutes} min read</span>
            {post.tags[0] ? (
              <>
                <span aria-hidden="true" className="opacity-40">
                  &middot;
                </span>
                <Link
                  to={`/blog/tag/${post.tags[0]}`}
                  className="rounded-full border border-border bg-surface2 px-2 py-0.5 uppercase tracking-wide text-text-secondary hover:border-amber hover:text-text"
                >
                  {formatTagChip(post.tags[0])}
                </Link>
              </>
            ) : null}
          </div>
          <Link
            to={`/blog/${post.slug}`}
            className="group mt-6 inline-flex items-center gap-2 rounded-md bg-amber px-5 py-2.5 text-label font-medium text-on-amber hover:bg-amber-dark"
          >
            Read the guide
            <ArrowRight
              className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
              size={13}
              strokeWidth={1.5}
              aria-hidden
            />
          </Link>
        </div>
        {post.coverImageUrl ? (
          <Link
            to={`/blog/${post.slug}`}
            className="block aspect-video w-full overflow-hidden rounded-xl border border-border-sub bg-bg"
          >
            <img
              src={post.coverImageUrl}
              alt={post.coverImageAlt ?? post.title}
              className="h-full w-full object-cover"
            />
          </Link>
        ) : (
          <div className="aspect-video w-full rounded-xl border border-border-sub bg-bg" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}

function BlogSection({ section, posts }: { section: BlogSectionConfig; posts: BlogPostSummary[] }) {
  return (
    <section className="border-b border-border-sub">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-micro uppercase tracking-wide text-amber-text">{section.label}</p>
            <p className="mt-1 max-w-2xl text-label text-text-secondary">{section.description}</p>
          </div>
          <Link
            to={section.tagHref}
            className="group whitespace-nowrap text-label font-medium text-amber-text hover:opacity-80"
          >
            See all{" "}
            <ArrowRight
              className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
              size={13}
              strokeWidth={1.5}
              aria-hidden
            />
          </Link>
        </div>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {posts.map((post) => (
            <BlogPostCard key={post.slug} post={post} />
          ))}
        </div>
      </div>
    </section>
  );
}

function BlogLatestStrip({ posts }: { posts: BlogPostSummary[] }) {
  return (
    <section>
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Latest</p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {posts.map((post) => (
            <BlogPostCard key={post.slug} post={post} />
          ))}
        </div>
      </div>
    </section>
  );
}
