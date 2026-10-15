import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { BlogHeaderIntro } from "~/components/blog/blog-header-intro";
import { BlogPostCard } from "~/components/blog/blog-post-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatTagChip } from "~/lib/blog/format";
import {
  getFeaturedPost,
  getPostsBySlug,
  getPublishedTagSet,
  listPublishedPosts,
  type BlogPostSummary,
} from "~/lib/blog/queries.server";
import { withRenderedExcerpts } from "~/lib/blog/render.server";
import { SECTIONS, type BlogSectionConfig } from "~/lib/blog/sections";
import { BLOG_COVER_FALLBACK_CSS } from "~/lib/http/inline-styles";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
import "capsomer/button.css";
import "capsomer/status.css";
// Capsomer's tokens and the teal family (capbase layer), which the panel, the
// button, the pill and the accent text read. The site header loads the same
// file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/index";

// Ported from legacy app/(marketing)/blog/page.tsx: a featured-post hero, four
// curated topic sections, and a "latest" strip of non-featured posts.
//
// Both of the departures previously recorded here are gone (M11 walk, ruling
// 72 session). The first was already false when written: it said /blog/archive
// was "dropped, not ported", while this file links to it and app/routes/blog/
// archive.tsx exists. The second was an 8-post SECTION_MIN_CLUSTER_SIZE gate on
// each topic section, justified here as a deliberate departure "per the task
// spec" with no ratification; legacy renders a section whenever any of its
// curated slugs resolve. Reverted to legacy's condition, keeping only the
// posts.length > 0 floor so a zero-card section still cannot render.
//
// J19 (job_deffd581af37, row M11). Recova's spec, read whole: page.tsx (blob
// d2d4dbfd), BlogHeaderIntro.tsx (a8ba9e72), BlogPostCard.tsx (48ba6d39),
// lib/blog.ts (55a92d1a). Recova stays the spec for content, layout and
// features: the header row, the featured hero, the four SECTIONS in order with
// label, description and See all, the Latest strip, at Recova's widths (1080px
// header, 1280px bands). The parts are Capsomer's (Q12): post cards are the
// panel, the tag is the outline pill, Read the guide the primary button. Accents
// are teal (Q11), text on the five sizes (RULES.md 5.2: each Recova size to the
// nearest, a tie to the larger), and every text link a 24px target.
//
// One Recova defect is not copied (parity/M11-M13-BLOG-CLUSTER.md, F3): a
// section shows only when a published post carries its tag, from
// getPublishedTagSet, the one derivation llms.txt and the archive read, so See
// all never leads to an empty or missing tag page.
//
// Where Recova's look needs more than Capsomer's shared parts carry, the page
// waits on the per-site layer (capsomer job_ec5ec0754626) and adds no Foxhound
// CSS over a Capsomer part; the J19 PR lists each place.
export function meta({ loaderData }: Route.MetaArgs) {
  return marketingMeta({
    title: "Blog - Foxhound",
    description: "Guides on Stripe payment recovery, dispute handling, and subscription intelligence.",
    path: "/blog",
    siteUrl: loaderData?.siteUrl ?? "",
  });
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const allSectionSlugs = SECTIONS.flatMap((s) => s.slugs);

  const [featuredRow, latestRows, sectionRows, tagSet] = await Promise.all([
    getFeaturedPost(db),
    listPublishedPosts(db, 8),
    getPostsBySlug(db, allSectionSlugs),
    getPublishedTagSet(db),
  ]);
  // Every excerpt on the page through Prelum (J19), one ::postlink read for all.
  const rendered = await withRenderedExcerpts(db, [...(featuredRow ? [featuredRow] : []), ...latestRows, ...sectionRows]);
  const featured = featuredRow ? rendered[0] : null;
  const latest8 = rendered.slice(featuredRow ? 1 : 0, (featuredRow ? 1 : 0) + latestRows.length);
  const sectionPosts = rendered.slice((featuredRow ? 1 : 0) + latestRows.length);

  const bySlug = new Map(sectionPosts.map((p) => [p.slug, p]));
  const publishedTags = new Set(tagSet);
  const sections = SECTIONS.map((section) => {
    const posts = section.slugs.flatMap((slug) => {
      const p = bySlug.get(slug);
      return p ? [p] : [];
    });
    return { section, posts };
  }).filter((s) => s.posts.length > 0 && publishedTags.has(sectionTag(s.section)));

  const latest = latest8.filter((p) => p.slug !== featured?.slug).slice(0, 4);

  return { siteUrl: siteUrl(env), featured, sections, latest };
}

/** The tag a section's See all opens: the last segment of Recova's tagHref. */
function sectionTag(section: BlogSectionConfig): string {
  return section.tagHref.slice(section.tagHref.lastIndexOf("/") + 1);
}

export default function BlogIndexPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, featured, sections, latest } = loaderData;
  const hasAnyContent = Boolean(featured) || sections.length > 0 || latest.length > 0;

  return (
    // Capsomer's teal family with Foxhound's own neutrals (.fh-cap, as the site
    // header, /products and /docs); the focus ring reads the family's ring.
    <div className="fh-cap [--border-focus:var(--ring)]" data-family="teal">
      <div className="mx-auto max-w-[1080px] px-5 pb-10 pt-16 sm:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <BlogHeaderIntro />
          <Link
            to="/blog/archive"
            className="group shrink-0 font-mono text-label leading-6 text-text-tertiary transition-colors hover:text-text"
          >
            All articles{" "}
            <ArrowRight
              className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
              size={13}
              strokeWidth={1.5}
              aria-hidden
            />
          </Link>
        </div>
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
          <Link to="/docs" className="mt-4 inline-block text-label leading-6 text-accent-text hover:opacity-80">
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
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-8 px-4 py-12 sm:px-6 lg:grid-cols-2 lg:px-8 lg:py-16">
        <div>
          <p className="font-mono text-label uppercase tracking-widest text-accent-text">Featured</p>
          <h2 className="mt-3 text-display font-bold leading-tight text-text">
            <Link to={`/blog/${post.slug}`} className="text-text transition-colors hover:text-accent-text">
              {post.title}
            </Link>
          </h2>
          <p className="mt-3 line-clamp-3 text-body leading-relaxed text-text-secondary">{post.excerpt}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-label text-text-tertiary">
            <span>{post.readingTimeMinutes} min read</span>
            {post.tags[0] ? (
              <>
                <span aria-hidden="true" className="opacity-40">
                  &middot;
                </span>
                {/* Capsomer's outline pill as a link: its own focus ring, and a
                    hit area grown to the 24px target. Recova's uppercase mono
                    chip is the per-site layer's (see the PR). */}
                <Link to={`/blog/tag/${encodeURIComponent(post.tags[0])}`} className="cap-pill" data-variant="outline">
                  {formatTagChip(post.tags[0])}
                </Link>
              </>
            ) : null}
          </div>
          {/* Wrapped so the spacing above is the page's, not a class on the button. */}
          <div className="mt-6">
            {/* "group" carries no style; it drives Recova's arrow nudge on hover. */}
            <Link to={`/blog/${post.slug}`} className="cap-btn group" data-variant="primary" data-size="lg">
              Read the guide
              <ArrowRight
                data-icon="end"
                className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                size={13}
                strokeWidth={1.5}
                aria-hidden
              />
            </Link>
          </div>
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
              loading="eager"
              fetchPriority="high"
            />
          </Link>
        ) : (
          <div className="aspect-video w-full overflow-hidden rounded-xl border border-border-sub">
            {/* Legacy's hand-drawn cover fallback, ported from app/(marketing)/blog/page.tsx.
                Legacy inlines four literal colours plus a [data-theme="light"] override block.
                Its two dark values are exactly our --bg and --brand-text, and its two light
                values are exactly what those same tokens hold under [data-theme="light"]
                (verified against app.css), so the var() form renders identically in both
                themes and legacy's override block becomes redundant. Keeping the literals
                would also trip check-tokens, which bans raw hex outside the token file. */}
            <svg
              width="100%"
              height="100%"
              viewBox="0 0 560 315"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              preserveAspectRatio="xMidYMid slice"
            >
              <style>{BLOG_COVER_FALLBACK_CSS}</style>
              <rect width="560" height="315" className="dz-base" />
              <polygon points="0,0    90,0   0,160" className="dz-band" />
              <polygon points="100,0  130,0  80,315   0,315  0,190" className="dz-band" />
              <polygon points="160,0  230,0  175,315  100,315" className="dz-band" />
              <polygon points="248,0  262,0  210,315  198,315" className="dz-band" />
              <polygon points="295,0  345,0  295,315  228,315" className="dz-band" />
              <polygon points="368,0  392,0  350,315  328,315" className="dz-band" />
              <polygon points="430,0  500,0  462,315  378,315" className="dz-band" />
              <polygon points="520,0  535,0  500,315  488,315" className="dz-band" />
              <polygon points="548,0  560,0  560,40  528,315  515,315" className="dz-band" />
              <polygon points="0,0    80,0   0,30" className="dz-base" />
              <polygon points="0,60   260,0  320,0   0,160" className="dz-base" />
              <polygon points="0,178  295,0  312,0   0,195" className="dz-base" />
              <polygon points="0,230  380,0  430,0   40,315  0,315" className="dz-base" />
              <polygon points="60,315  460,0  540,0   170,315" className="dz-base" />
              <polygon points="192,315 540,20 555,0   560,0  560,18  218,315" className="dz-base" />
              <polygon points="270,315 560,80 560,190 400,315" className="dz-base" />
              <polygon points="445,315 560,240 560,268 468,315" className="dz-base" />
            </svg>
          </div>
        )}
      </div>
    </section>
  );
}

function BlogSection({ section, posts }: { section: BlogSectionConfig; posts: BlogPostSummary[] }) {
  return (
    <section className="border-b border-border-sub bg-bg">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-label uppercase tracking-widest text-accent-text">{section.label}</p>
            <p className="mt-1 max-w-2xl text-label text-text-secondary">{section.description}</p>
          </div>
          <Link
            to={section.tagHref}
            className="group whitespace-nowrap text-label font-medium leading-6 text-accent-text hover:underline"
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
    <section className="bg-bg">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <p className="font-mono text-label uppercase tracking-widest text-text-tertiary">Latest</p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {posts.map((post) => (
            <BlogPostCard key={post.slug} post={post} />
          ))}
        </div>
      </div>
    </section>
  );
}
