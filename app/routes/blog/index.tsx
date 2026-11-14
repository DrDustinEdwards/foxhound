import { marketingMeta } from "~/lib/seo/meta";
import { Icon, iconArrowRight } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { titleCase } from "@drdustinedwards/site-helpers/text";
import { Link, ButtonLink } from "capsomer/react/link";

import { BlogHeaderIntro } from "~/components/blog/blog-header-intro";
import { Picture } from "capsomer/react/picture";
import "capsomer/picture.css";
import { BlogPostCard } from "~/components/blog/blog-post-card";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { coverPicture } from "~/lib/blog/markdown.server";
import {
  getFeaturedPost,
  getPostsBySlug,
  getPublishedTagSet,
  listPublishedPosts,
  type BlogPostSummary,
} from "~/lib/blog/queries.server";
import { SECTIONS, type BlogSectionConfig } from "~/lib/blog/sections";
import { BLOG_COVER_FALLBACK_CSS } from "~/lib/http/inline-styles";
import { siteUrl } from "~/lib/seo/jsonld";

import "capsomer/panel.css";
import "capsomer/button.css";
import "capsomer/status.css";
// The site header's CSS (app/site-header.css), so the page is whole under any layout. Capsomer's
// tokens and the amber family come with the root route (app/error-page.css).
import "~/site-header.css";

import type { Route } from "./+types/index";
import "~/blog-index.css";

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
// J19. Recova's spec, read whole: page.tsx (blob
// d2d4dbfd), BlogHeaderIntro.tsx (a8ba9e72), BlogPostCard.tsx (48ba6d39),
// lib/blog.ts (55a92d1a). Recova stays the spec for content, layout and
// features: the header row, the featured hero, the four SECTIONS in order with
// label, description and See all, the Latest strip, at Recova's widths (1080px
// header, 1280px bands). The parts are Capsomer's: post cards are the
// panel, the tag is the outline pill, Read the guide the primary button. Accents
// are amber, text at Recova's sizes, and every text link a 24px target.
//
// One Recova defect is not copied (parity/M11-M13-BLOG-CLUSTER.md, F3): a
// section shows only when a published post carries its tag, from
// getPublishedTagSet, the one derivation llms.txt and the archive read, so See
// all never leads to an empty or missing tag page.

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    ...marketingMeta({
      title: "Blog",
      description:
        "Guides on Stripe payment recovery, dispute handling, and subscription intelligence.",
      path: "/blog",
      pageType: "CollectionPage",
      siteUrl: loaderData?.siteUrl ?? "",
    }),
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const allSectionSlugs = SECTIONS.flatMap((s) => s.slugs);

  const [featured, latest8, sectionPosts, tagSet] = await Promise.all([
    getFeaturedPost(db),
    listPublishedPosts(db, 8),
    getPostsBySlug(db, allSectionSlugs),
    getPublishedTagSet(db),
  ]);

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

  const cover = featured ? await coverPicture(db, featured, "featured") : null;

  return { siteUrl: siteUrl(env), featured, cover, sections, latest };
}

/** The tag a section's See all opens: the last segment of Recova's tagHref. */
function sectionTag(section: BlogSectionConfig): string {
  return section.tagHref.slice(section.tagHref.lastIndexOf("/") + 1);
}

export default function BlogIndexPage({ loaderData }: Route.ComponentProps) {
  const { featured, cover, sections, latest } = loaderData;
  const hasAnyContent = Boolean(featured) || sections.length > 0 || latest.length > 0;

  return (
    // Capsomer's amber family with Foxhound's own neutrals (.fh-cap, as the site
    // header, /products and /docs); the focus ring reads the family's ring.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      <div className="fh-blog-wrap">
        <div className="cap-stack fh-blog-block-2" data-gap="5">
          <BlogHeaderIntro />
          <Link to="/blog/archive" className="fh-blog-link fh-hover-group fh-mono fh-copy fh-quiet">
            All articles <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />
          </Link>
        </div>
      </div>

      {featured ? <BlogHero post={featured} cover={cover} /> : null}

      {sections.map(({ section, posts }) => (
        <BlogSection key={section.id} section={section} posts={posts} />
      ))}

      {latest.length > 0 ? <BlogLatestStrip posts={latest} /> : null}

      {!hasAnyContent ? (
        <div className="fh-blog-wrap-2 fh-center">
          <p className="fh-body fh-soft">
            Nothing published yet. Check back soon, or read the product docs in the meantime.
          </p>
          <Link to="/docs" className="fh-blog-link-2 fh-small fh-accent">
            Read the docs
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function BlogHero({
  post,
  cover,
}: {
  post: BlogPostSummary;
  cover: Route.ComponentProps["loaderData"]["cover"];
}) {
  return (
    <section className="fh-blog-band">
      <div className="fh-blog-grid">
        <div>
          <p className="fh-mono fh-caption fh-accent fh-caps-wide">Featured</p>
          <h2 className="fh-blog-title fh-bold fh-text">
            <Link to={`/blog/${post.slug}`} className="fh-blog-link-3 fh-text">
              {post.title}
            </Link>
          </h2>
          <p className="fh-blog-text fh-body fh-relaxed fh-soft">{post.excerpt}</p>
          <div className="cap-cluster fh-blog-block-3 fh-mono fh-copy fh-quiet" data-gap="3">
            <span>{post.readingTimeMinutes} min read</span>
            {post.tags[0] ? (
              <>
                <span aria-hidden="true" className="fh-blog-label">
                  &middot;
                </span>
                {/* Capsomer's outline pill as a link: its own focus ring, and a
                    hit area grown to the 24px target. Recova's uppercase mono
                    chip is the per-site layer's (see the PR). */}
                <Link
                  to={`/blog/tag/${encodeURIComponent(post.tags[0])}`}
                  className="cap-pill"
                  data-variant="outline"
                >
                  {titleCase(post.tags[0])}
                </Link>
              </>
            ) : null}
          </div>
          {/* Wrapped so the spacing above is the page's, not a class on the button. */}
          <div className="fh-blog-block-4">
            {/* "group" carries no style; it drives Recova's arrow nudge on hover. */}
            <ButtonLink to={`/blog/${post.slug}`} className="group" variant="primary" size="lg">
              Read the guide
              <Icon
                d={iconArrowRight}
                className="fh-icon-13 fh-icon-fine fh-mk-arrow"
                data-icon="end"
              />
            </ButtonLink>
          </div>
        </div>
        {cover ? (
          <Link to={`/blog/${post.slug}`} className="fh-blog-link-4 fh-line">
            <Picture attrs={cover.picture} alt={cover.alt} priority className="fh-mk-cover" />
          </Link>
        ) : (
          <div className="fh-blog-block-5">
            {/* Legacy's hand-drawn cover fallback, ported from app/(marketing)/blog/page.tsx.
                Legacy inlines four literal colors plus a [data-theme="light"] override block.
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
    <section className="fh-blog-band-2">
      <div className="fh-mk-wide">
        <div className="cap-stack fh-blog-block-2" data-gap="4">
          <div>
            <p className="fh-mono fh-copy fh-accent fh-caps-wide">{section.label}</p>
            <p className="fh-blog-text-2 fh-copy fh-soft">{section.description}</p>
          </div>
          <Link to={section.tagHref} className="fh-blog-link-5 fh-hover-group fh-nowrap fh-copy">
            See all <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />
          </Link>
        </div>
        <div className="fh-blog-grid-2">
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
    <section className="fh-blog-band-3">
      <div className="fh-mk-wide">
        <p className="fh-mono fh-copy fh-quiet fh-caps-wide">Latest</p>
        <div className="fh-blog-grid-3">
          {posts.map((post) => (
            <BlogPostCard key={post.slug} post={post} />
          ))}
        </div>
      </div>
    </section>
  );
}

export const headers = () => publicPageHeaders();
