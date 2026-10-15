import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { BlogPostCard } from "~/components/blog/blog-post-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { labelForTag } from "~/lib/blog/tags";
import { getPublishedPostsByTag, getPublishedTagSet } from "~/lib/blog/queries.server";
import { withRenderedExcerpts } from "~/lib/blog/render.server";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
import "capsomer/status.css";
// Capsomer's tokens and the teal family (capbase layer), which the cards, the
// pills and the focus ring read. The site header loads the same file;
// importing it here keeps the page whole under any layout.
import "~/site-header.css";

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
// The gate is the published tag set (J19, DO step 4): getPublishedTagSet, the
// one derivation llms.txt, llms-full.txt and the archive pills read, so a tag
// page exists exactly when a published post carries the tag. It was
// CANONICAL_TAGS membership, which served a 200 empty page for a canonical tag
// no post carries and a 404 for a tag a published post does carry. Recova
// builds its tag pages from its published posts' tags too (generateStaticParams
// in tag/[tag]/page.tsx, blob 3f6aa696); the 404 for any other tag is the
// approved difference above.
export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const tag = params.tag;
  const tagSet = await getPublishedTagSet(db);
  if (!tagSet.includes(tag)) {
    throw new Response("Not found", { status: 404 });
  }
  // Each card's excerpt through Prelum (J19).
  const posts = await withRenderedExcerpts(db, await getPublishedPostsByTag(db, tag));
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

// J19 (row M14). Recova's layout, read from tag/[tag]/page.tsx: one
// left-aligned column at 1100px (px-5, sm:px-8, py-16), the "All posts" back
// link (mb-8), the tag's label as the h1 (mb-2), the "N articles" count line
// (mb-10), then the card grid (1, 2, 3 columns, gap-6), or Recova's empty line.
// Recova's text-[1.75rem] h1 is display, its text-[0.8125rem] back link and
// count line label (RULES.md 5.2). Cards are Capsomer's panel (BlogPostCard),
// the colour teal (Q11), and the back link a 24px target.
export default function BlogTagPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, tag, posts } = loaderData;
  const label = labelForTag(tag);

  return (
    // div, not main: marketing.tsx already renders this page's one main landmark.
    // Capsomer's teal family with Foxhound's own neutrals (.fh-cap), the focus
    // ring reading the family's ring, as on /blog.
    <div className="fh-cap [--border-focus:var(--ring)]" data-family="teal">
      <div className="mx-auto max-w-[1100px] px-5 py-16 sm:px-8">
        <Link
          to="/blog"
          className="group mb-8 inline-flex items-center gap-1.5 text-label leading-6 text-text-tertiary transition-colors hover:text-text"
        >
          <ArrowLeft
            className="transition-transform group-hover:-translate-x-0.5"
            size={13}
            strokeWidth={1.5}
            aria-hidden
          />
          All posts
        </Link>
        <h1 className="mb-2 text-display font-medium tracking-tight text-text">{label}</h1>
        <p className="mb-10 font-mono text-label text-text-tertiary">
          {posts.length} {posts.length === 1 ? "article" : "articles"}
        </p>
        {posts.length === 0 ? (
          <p className="text-body text-text-secondary">No articles tagged {label} yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <BlogPostCard key={post.id} post={post} />
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
