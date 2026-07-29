import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { BlogPostCard } from "~/components/blog/blog-post-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { labelForTag } from "~/lib/blog/tags";
import { getPublishedPostsByTag } from "~/lib/blog/queries.server";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/tag";

// Ported from legacy app/(marketing)/blog/tag/[tag]/page.tsx (Phase 6 Pass
// 2), rebuilt against the 8 canonical tags (tags.ts), not legacy's 5. An
// unrecognized tag still renders (humanized label, honest empty state)
// rather than 404ing, matching legacy's leniency; the canonical set is a
// content-authoring convention, not a route-level allowlist.
export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const tag = params.tag;
  const posts = await getPublishedPostsByTag(db, tag);
  return { siteUrl: siteUrl(env), tag, posts };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Blog - Foxhound" }];
  const label = labelForTag(loaderData.tag);
  return marketingMeta({
    title: `${label} - Foxhound Blog`,
    description: `Guides on ${label.toLowerCase()} from the Foxhound blog.`,
    path: `/blog/tag/${loaderData.tag}`,
    siteUrl: loaderData.siteUrl,
  });
}

export default function BlogTagPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, tag, posts } = loaderData;
  const label = labelForTag(tag);

  return (
    <div>
      <div className="border-b border-border-sub px-4 py-16 text-center sm:px-8">
        <Link
          to="/blog"
          className="group inline-flex items-center gap-1.5 text-label text-text-tertiary hover:text-text"
        >
          <ArrowLeft
            className="transition-transform group-hover:-translate-x-0.5"
            size={13}
            strokeWidth={1.5}
            aria-hidden
          />
          All posts
        </Link>
        <h1 className="mt-4 text-display font-medium text-text">{label}</h1>
        <p className="mt-2 font-mono text-micro text-text-tertiary">
          {posts.length} {posts.length === 1 ? "article" : "articles"}
        </p>
      </div>

      {/* div, not main: marketing.tsx already renders this page's one main landmark. */}
      <div className="mx-auto max-w-[1100px] px-5 py-16 sm:px-8">
        {posts.length === 0 ? (
          <p className="text-center text-body text-text-secondary">No articles tagged {label} yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <BlogPostCard key={post.slug} post={post} />
            ))}
          </div>
        )}
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Blog", path: "/blog" },
              { name: label, path: `/blog/tag/${tag}` },
            ]),
          ),
        }}
      />
    </div>
  );
}
