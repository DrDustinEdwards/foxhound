import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { BlogPostCard } from "~/components/blog/blog-post-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { CANONICAL_TAGS, labelForTag } from "~/lib/blog/tags";
import { getPublishedPostsByTag } from "~/lib/blog/queries.server";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/tag";

// Ported from legacy app/(marketing)/blog/tag/[tag]/page.tsx (Phase 6 Pass
// 2), rebuilt against the 8 canonical tags (tags.ts), not legacy's 5.
//
// An UNKNOWN tag 404s (Dustin, 2026-08-04). This diverges from legacy, whose
// tag route has no notFound() and renders "No articles tagged X yet." for any
// string at all. That soft-404 is a ruling 39 legacy defect in the
// false-machine-readable-data family rulings 89 and 96 already govern: a
// not-found URL answering 200 asserts the page exists, which is the same shape
// as legacy's always-now lastModified and lastBuildDate, and the family
// attaches to the DEFECT rather than to the file it was first found in.
// Measured before ruling: this was the ONLY one of Foxhound's six
// unknown-slug surfaces that did not 404 (posts, decline codes, competitors,
// docs guides and unknown paths all did), so preserving legacy's leniency made
// Foxhound internally inconsistent as well as wrong. It also closes ruling
// 88's recorded harm, that an empty archive was indistinguishable from a
// garbage URL to a crawler following llms.txt.
//
// The gate is CANONICAL_TAGS membership, not post count. A canonical tag
// carrying zero posts is a real empty state and still renders its 200; only a
// tag outside the set is not-found.
export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const tag = params.tag;
  if (!(CANONICAL_TAGS as readonly string[]).includes(tag)) {
    throw new Response("Not found", { status: 404 });
  }
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
