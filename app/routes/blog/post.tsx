import { Icon, iconArrowLeft, iconArrowRight } from "capsomer/react/icons";
import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { formatDate } from "capsomer/behavior/time";
import { titleCase } from "@drdustinedwards/site-helpers/text";
import { CARD_MD, CTA_BUTTON } from "~/components/marketing-card";
import { ButtonLink, Link } from "capsomer/react/link";
import { RelatedLinks } from "capsomer/react/related-links";
import "capsomer/related-links.css";
import "~/blog-prose.css";

import { WITHDRAWN_BLOG_MESSAGE, WITHDRAWN_BLOG_SLUGS } from "~/lib/blog/withdrawn";
import { goneResponse } from "@dustinedwards/site-runtime/url";
import { Picture } from "capsomer/react/picture";
import "capsomer/picture.css";
import { SectionTrail } from "~/components/section-trail";
import { CopyButton } from "capsomer/react/copy";
import { ShareRow } from "capsomer/react/share-row";
import { Toc } from "capsomer/react/toc";
import "capsomer/button.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/copy.css";
import "capsomer/share-row.css";
import "capsomer/toc.css";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { coverPicture, renderMarkdown } from "~/lib/blog/markdown.server";
import {
  getNextPost,
  getPostBySlug,
  getPostLinks,
  getPreviousPost,
} from "~/lib/blog/queries.server";
import { articleJsonLd, organizationJsonLd, personJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/post";
import { DAY_MS } from "~/lib/constants";
import { faqPage, jsonLd } from "@drdustinedwards/site-helpers/schema";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { MarketingError } from "~/components/error-view";
import { markup } from "capsomer/behavior/trusted-html";

// Ported from legacy app/(marketing)/blog/[slug]/{page,PostDetailBody}.tsx
// (Phase 6 Pass 2). Structure kept: cover image, tag chips, byline row,
// title/excerpt, share row, inline (mobile) + sidebar (desktop) TOC,
// rendered body, further-reading links (blog_post_links), author box,
// prev/next nav, closing audit CTA.
//
// Share row + author avatar restored (TASK-foxhound-parity-cluster-b.md fix
// 4), confirmed live on recova-eta.vercel.app before building. The avatar
// is /favicon.svg, the same Foxhound organization mark organizationJsonLd
// already uses for its `logo` field below, not a Person image - this repo
// has no Person identity for blog authorship (every current post's author
// column is "Foxhound", per the Phase 6 brand-token remediation).
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  // WITHDRAWN POSTS ANSWER 410, NOT 404. The row is unpublished, so the
  // lookup below would return null and this route would 404, which says "we have
  // nothing here" and is indistinguishable from a typo. 410 says the page existed
  // and is deliberately gone. Checked before the lookup so the answer does not depend on what the database
  // happens to hold.
  const gone = goneResponse(
    request,
    WITHDRAWN_BLOG_SLUGS.map((slug) => `/blog/${slug}`),
    { body: WITHDRAWN_BLOG_MESSAGE },
  );
  if (gone) throw gone;

  const post = await getPostBySlug(db, params.slug);
  if (!post) throw new Response("Not found", { status: 404 });

  const [{ html, toc, faq, version }, cover, share, previous, next, related] = await Promise.all([
    renderMarkdown(db, post.body),
    coverPicture(db, post, "content"),
    // The share image Carrel set (site-api's image and imageAlt search fields), read the way the cover is.
    coverPicture(
      db,
      { coverImageUrl: post.ogImageUrl, coverImageAlt: post.ogImageAlt, title: post.title },
      "content",
    ),
    post.publishedAt ? getPreviousPost(db, post.publishedAt, post.id) : Promise.resolve(null),
    post.publishedAt ? getNextPost(db, post.publishedAt, post.id) : Promise.resolve(null),
    getPostLinks(db, post.id),
  ]);

  return {
    siteUrl: siteUrl(env),
    post,
    cover,
    share,
    html,
    version,
    toc,
    previous,
    next,
    related,
    faq,
  };
}

// Legacy passes the post EXCERPT as `description` and renders it on the card
// (legacy app/og/route.tsx). Foxhound had been passing the first tag instead,
// which legacy's card never carried; corrected under ruling 96.
function ogImageUrl(url: string, title: string, description: string | undefined): string {
  const params = new URLSearchParams({ title });
  if (description) params.set("description", description);
  return `${url}/og/blog?${params.toString()}`;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Blog - Foxhound" }];
  const { post, cover, share, siteUrl: url } = loaderData;
  const title = post.ogTitle ?? post.title;
  const description = post.ogDescription ?? post.excerpt;
  const canonical = post.canonicalUrl ?? `${url}/blog/${post.slug}`;
  // The share image Carrel set, else the cover, each at its real size (a
  // library file's stored one), else the generated 1200x630 card.
  const card = share ?? cover;
  const image = card
    ? { ...card.original, url: new URL(card.original.url, url).href }
    : {
        url: ogImageUrl(url, title, post.ogDescription ?? post.excerpt),
        width: 1200,
        height: 630,
        type: "image/png",
        alt: title,
      };

  // JSON-LD goes through meta, which React Router escapes, because the title,
  // excerpt and FAQ text come from Carrel and JSON.stringify leaves `</script>`
  // as it is. organizationJsonLd (and personJsonLd, when the author is Dustin)
  // render the full node the Article's publisher/author @id references point
  // at. Rich Results parsers combine every JSON-LD block on ONE page into a
  // single graph, but do NOT fetch other pages to resolve an @id, so a bare
  // {"@id": ...} reference with no matching node on THIS page would not
  // actually resolve.
  const byDustin = post.author.trim().toLowerCase() === "dustin edwards";
  return [
    ...marketingMeta({
      title,
      suffix: " - Foxhound Blog",
      description,
      path: `/blog/${post.slug}`,
      siteUrl: url,
      canonical,
      image,
      ogTitle: title,
      ogType: "article",
      noindex: post.noindex,
    }),
    jsonLd(organizationJsonLd(url)),
    ...(byDustin
      ? [
          jsonLd(
            personJsonLd(url, {
              name: "Dustin Edwards",
              jobTitle: "Founder",
              description:
                "Founder of Foxhound, a pay-on-lift Stripe recovery, disputes, and intelligence platform.",
            }),
          ),
        ]
      : []),
    jsonLd(
      articleJsonLd(url, {
        headline: title,
        description,
        path: `/blog/${post.slug}`,
        imageUrl: image.url,
        // The cover's crops, else the share image's.
        images: (cover?.article.length ? cover.article : (share?.article ?? [])).map((crop) => ({
          url: new URL(crop.url, url).href,
          width: crop.width,
          height: crop.height,
        })),
        datePublished: post.publishedAt?.toISOString() ?? null,
        dateModified: (post.updatedAt ?? post.createdAt).toISOString(),
        authorName: post.author,
      }),
    ),
    ...(loaderData.faq.length > 0 ? [jsonLd(faqPage(loaderData.faq))] : []),
  ];
}

export default function BlogPostPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, post, cover, html, version, toc, previous, next, related } = loaderData;

  const canonical = post.canonicalUrl ?? `${url}/blog/${post.slug}`;

  const showUpdated =
    post.showUpdatedAt &&
    post.publishedAt &&
    post.updatedAt &&
    post.updatedAt.getTime() - post.publishedAt.getTime() > DAY_MS;
  const showPublished = post.showPublishedAt && post.publishedAt;

  return (
    <div className="fh-mk-band-wrap">
      <div className="cap-reading-progress" aria-hidden="true" />

      <SectionTrail items={[{ label: "Blog", href: "/blog" }, { label: post.title }]} />

      <div className="fh-post-grid">
        {/* h-entry and e-content name the post's own text for site-api's
            webmention hook, which sends to the links inside it only (not the
            share row's). No style reads either class. */}
        <article id="blog-post-article" className="h-entry" data-cap-reading>
          {cover ? (
            <div className="fh-post-block">
              <Picture attrs={cover.picture} alt={cover.alt} priority className="fh-mk-cover" />
            </div>
          ) : null}

          {post.tags.length > 0 ? (
            // Capsomer's outline pill as a link, as on /blog's cards, in the amber family.
            <div className="fh-post-row fh-cap" data-cap-site="foxhound" data-family="amber">
              {post.tags.map((t) => (
                <Link
                  key={t}
                  to={`/blog/tag/${encodeURIComponent(t)}`}
                  className="cap-pill"
                  data-variant="outline"
                >
                  {titleCase(t)}
                </Link>
              ))}
            </div>
          ) : null}

          <div className="fh-post-row-2 fh-mono fh-small fh-quiet">
            {showPublished ? (
              <time dateTime={post.publishedAt!.toISOString()}>
                {formatDate(post.publishedAt, { style: "medium" }) ?? ""}
              </time>
            ) : null}
            {showPublished && showUpdated ? <span aria-hidden="true"> &middot; </span> : null}
            {showUpdated ? (
              <>
                Updated{" "}
                <time dateTime={post.updatedAt!.toISOString()}>
                  {formatDate(post.updatedAt, { style: "medium" }) ?? ""}
                </time>
              </>
            ) : null}
            {showPublished || showUpdated ? (
              <span aria-hidden="true" className="fh-post-label">
                &middot;
              </span>
            ) : null}
            <span>{post.readingTimeMinutes} min read</span>
            <span aria-hidden="true" className="fh-post-label">
              &middot;
            </span>
            <span>{post.author}</span>
          </div>

          <h1 className="fh-post-title fh-page-title fh-medium fh-text">{post.title}</h1>
          <p className="fh-post-text fh-product-sub fh-relaxed fh-soft">{post.excerpt}</p>

          <ShareRow url={canonical} title={post.title}>
            <CopyButton
              size="xs"
              {...{ command: "--copy", commandfor: "share-url" }}
              data-island="copy"
              text={canonical}
            >
              Copy link
            </CopyButton>
            <data id="share-url" value={canonical} hidden>
              {canonical}
            </data>
          </ShareRow>

          <Toc items={toc} variant="inline" />

          <div
            className="blog-prose e-content"
            data-context="prose"
            data-render-version={version}
            data-island={html.includes("embed-link") ? "embeds" : undefined}
            dangerouslySetInnerHTML={markup(html)}
          />
        </article>

        <Toc items={toc} variant="sidebar" />
      </div>

      <RelatedLinks
        kind="internal"
        title="Further reading"
        items={related.map((r) => ({ href: `/blog/${r.slug}`, title: r.title }))}
      />

      <div className="fh-post-row-3">
        <img
          src="/favicon.svg"
          alt="Foxhound"
          width={44}
          height={44}
          loading="lazy"
          decoding="async"
          className="fh-post-block-2"
        />
        <div>
          <p className="fh-post-text-2 fh-mono fh-tiny fh-quiet">Published by</p>
          <p className="fh-post-text-3 fh-item-title fh-medium fh-text">{post.author}</p>
          <p className="fh-copy fh-relaxed fh-soft">
            Foxhound recovers failed Stripe payments, handles disputes, and surfaces subscription
            intelligence. {RECOVERY_FEE_PERCENT}% of Foxhound-attributed recoveries only, nothing
            until then.
          </p>
        </div>
      </div>

      {previous || next ? (
        <nav
          aria-label="Adjacent posts"
          className="fh-post-grid-2 fh-cap"
          data-cap-site="foxhound"
          data-family="amber"
        >
          {previous ? (
            <Link to={`/blog/${previous.slug}`} className={`${CARD_MD} fh-hover-group`}>
              <div className="cap-panel-body">
                <div>
                  <div className="fh-post-row-4 fh-mono fh-tiny fh-quiet">
                    <Icon d={iconArrowLeft} className="fh-icon-13 fh-icon-fine fh-post-block-3" />
                    Previous post
                  </div>
                  <div className="fh-post-block-4 fh-item-title fh-medium fh-text">
                    {previous.title}
                  </div>
                </div>
              </div>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={`/blog/${next.slug}`} className={`fh-post-link ${CARD_MD} fh-hover-group`}>
              <div className="cap-panel-body">
                <div>
                  <div className="fh-mk-kicker fh-mono fh-tiny fh-quiet">
                    Next post{" "}
                    <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />
                  </div>
                  <div className="fh-post-block-4 fh-item-title fh-medium fh-text">
                    {next.title}
                  </div>
                </div>
              </div>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <div className="fh-post-wrap fh-cap fh-center" data-cap-site="foxhound" data-family="amber">
        <h2 className="fh-post-title-2 fh-feature-title fh-medium fh-text">
          Run your free Stripe audit
        </h2>
        <p className="fh-post-wrap-2 fh-item-title fh-relaxed fh-soft">
          See exactly what your account is leaking. Free, no account required.
        </p>
        <ButtonLink
          to="/audit"
          className={`${CTA_BUTTON} fh-hover-group`}
          variant="primary"
          size="lg"
        >
          Start free audit{" "}
          <Icon d={iconArrowRight} className="fh-icon-13 fh-icon-fine fh-mk-arrow" />
        </ButtonLink>
      </div>

      {/* organizationJsonLd (and personJsonLd below, when applicable) render
          the full node the Article's publisher/author @id references point
          at. Rich Results parsers combine every JSON-LD block on ONE page
          into a single graph, but do NOT fetch other pages to resolve an
          @id, so a bare {"@id": ...} reference with no matching node on
          THIS page would not actually resolve; home.tsx is the only other
          place organizationJsonLd renders. */}
    </div>
  );
}

// A withdrawn post's 410, a missing post's 404 or a failed read, inside the marketing layout's
// header and footer rather than the root boundary's bar (components/error-view.tsx).
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <MarketingError error={error} />;
}

export const headers = () => publicPageHeaders();
