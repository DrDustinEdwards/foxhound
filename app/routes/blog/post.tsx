import { ArrowLeft, ArrowRight } from "lucide-react";
import { redirect } from "react-router";
import { Link } from "capsomer/react/link";

import { redirectedBlogSlug } from "~/lib/blog/slug-redirects";
import { isWithdrawnBlogSlug, WITHDRAWN_BLOG_MESSAGE } from "~/lib/blog/withdrawn";
import { CoverPicture } from "~/components/blog/cover-picture";
import { ReadingProgressBar } from "~/components/blog/reading-progress-bar";
import { ShareRow } from "~/components/blog/share-row";
import { TableOfContents } from "~/components/blog/table-of-contents";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { coverPicture, extractFaqPairs, renderMarkdown } from "~/lib/blog/markdown.server";
import { getNextPost, getPostBySlug, getPostLinks, getPreviousPost } from "~/lib/blog/queries.server";
import {
  articleJsonLd,
  breadcrumbListJsonLd,
  faqPageJsonLd,
  organizationJsonLd,
  personJsonLd,
  siteUrl,
} from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/post";
import { DAY_MS } from "~/lib/constants";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { formatDateShort } from "~/lib/date-format";

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
export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  // THE RENAMED COMPARISON SLUGS, checked BEFORE the lookup.
  //
  // Before the lookup rather than in the 404 branch, deliberately: an old slug
  // must redirect whether or not a post happens to still answer to it, so the
  // canonical URL is the new one from the moment this ships. Putting it after
  // the miss would make the redirect depend on the database having already been
  // renamed, which is a race between a deploy and a data change.
  const renamed = redirectedBlogSlug(params.slug);
  if (renamed) {
    throw redirect(`/blog/${renamed}`, 301);
  }

  // WITHDRAWN POSTS ANSWER 410, NOT 404. The row is unpublished, so the
  // lookup below would return null and this route would 404, which says "we have
  // nothing here" and is indistinguishable from a typo. 410 says the page existed
  // and is deliberately gone. Checked before the lookup for the same reason the
  // redirect is: the answer must not depend on what the database happens to hold.
  if (isWithdrawnBlogSlug(params.slug)) {
    throw new Response(WITHDRAWN_BLOG_MESSAGE, {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const post = await getPostBySlug(db, params.slug);
  if (!post) {
    throw new Response("Not found", { status: 404 });
  }

  const [{ html, toc }, cover, previous, next, related] = await Promise.all([
    renderMarkdown(db, post.body),
    coverPicture(db, post, "content"),
    post.publishedAt ? getPreviousPost(db, post.publishedAt, post.id) : Promise.resolve(null),
    post.publishedAt ? getNextPost(db, post.publishedAt, post.id) : Promise.resolve(null),
    getPostLinks(db, post.id),
  ]);

  const faqPairs = extractFaqPairs(post.body);

  return { siteUrl: siteUrl(env), post, cover, html, toc, previous, next, related, faqPairs };
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
  const { post, cover, siteUrl: url } = loaderData;
  const title = post.ogTitle ?? post.title;
  const description = post.ogDescription ?? post.excerpt;
  const canonical = post.canonicalUrl ?? `${url}/blog/${post.slug}`;
  // The cover at its real size (a library file's stored one), else the
  // generated 1200x630 card.
  const image = cover
    ? { ...cover.original, url: new URL(cover.original.url, url).href }
    : { url: ogImageUrl(url, title, post.ogDescription ?? post.excerpt), width: 1200, height: 630, alt: title };

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
    }),
    jsonLd(organizationJsonLd(url)),
    ...(byDustin
      ? [
          jsonLd(
            personJsonLd(url, {
              name: "Dustin Edwards",
              jobTitle: "Founder",
              description: "Founder of Foxhound, a pay-on-lift Stripe recovery, disputes, and intelligence platform.",
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
        datePublished: post.publishedAt?.toISOString() ?? null,
        dateModified: (post.updatedAt ?? post.createdAt).toISOString(),
        authorName: post.author,
      }),
    ),
    jsonLd(
      breadcrumbListJsonLd(url, [
        { name: "Home", path: "/" },
        { name: "Blog", path: "/blog" },
        { name: post.title, path: `/blog/${post.slug}` },
      ]),
    ),
    ...(loaderData.faqPairs.length > 0
      ? [jsonLd(faqPageJsonLd(loaderData.faqPairs.map((f) => ({ question: f.question, answer: f.answer }))))]
      : []),
  ];
}

export default function BlogPostPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, post, cover, html, toc, previous, next, related } = loaderData;

  const canonical = post.canonicalUrl ?? `${url}/blog/${post.slug}`;

  const showUpdated =
    post.showUpdatedAt &&
    post.publishedAt &&
    post.updatedAt &&
    post.updatedAt.getTime() - post.publishedAt.getTime() > DAY_MS;
  const showPublished = post.showPublishedAt && post.publishedAt;

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-16 sm:px-8">
      <ReadingProgressBar targetId="blog-post-article" />

      <Link
        to="/blog"
        className="group mb-8 inline-flex items-center gap-1.5 text-label text-text-tertiary transition-colors hover:text-text"
      >
        <ArrowLeft
          className="transition-transform group-hover:-translate-x-0.5"
          size={13}
          strokeWidth={1.5}
          aria-hidden
        />
        Back to blog
      </Link>

      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,680px)_minmax(0,1fr)]">
        <article id="blog-post-article">
          {cover ? (
            <div className="mb-8 aspect-video w-full overflow-hidden rounded-xl bg-bg">
              <CoverPicture cover={cover} className="h-full w-full object-cover" />
            </div>
          ) : null}

          {post.tags.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {post.tags.map((t) => (
                <Link
                  key={t}
                  to={`/blog/tag/${encodeURIComponent(t)}`}
                  className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-micro text-text-tertiary transition-colors hover:border-brand hover:text-text"
                >
                  {t}
                </Link>
              ))}
            </div>
          ) : null}

          <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-label text-text-tertiary">
            {showPublished ? <time dateTime={post.publishedAt!.toISOString()}>{formatDateShort(post.publishedAt)}</time> : null}
            {showPublished && showUpdated ? <span aria-hidden="true"> &middot; </span> : null}
            {showUpdated ? (
              <>
                Updated <time dateTime={post.updatedAt!.toISOString()}>{formatDateShort(post.updatedAt)}</time>
              </>
            ) : null}
            {showPublished || showUpdated ? (
              <span aria-hidden="true" className="opacity-40">
                &middot;
              </span>
            ) : null}
            <span>{post.readingTimeMinutes} min read</span>
            <span aria-hidden="true" className="opacity-40">
              &middot;
            </span>
            <span>{post.author}</span>
          </div>

          <h1 className="mb-4 text-page-title font-medium leading-tight tracking-tight text-text">{post.title}</h1>
          <p className="mb-8 border-b border-border pb-8 text-product-sub leading-relaxed text-text-secondary">
            {post.excerpt}
          </p>

          <ShareRow url={canonical} title={post.title} />

          <TableOfContents items={toc} variant="inline" />

          <div className="blog-prose" dangerouslySetInnerHTML={{ __html: html }} />
        </article>

        <TableOfContents items={toc} variant="sidebar" />
      </div>

      {related.length > 0 ? (
        <section aria-label="Further reading" className="mt-12 max-w-[680px] border-t border-border pt-8">
          <p className="mb-3 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">Further reading</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {related.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/blog/${r.slug}`}
                  className="group inline-flex items-center gap-1.5 text-item-title text-text transition-colors hover:text-brand-text"
                >
                  {r.title}
                  <ArrowRight
                    className="opacity-0 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:opacity-100"
                    size={13}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-12 flex items-start gap-4 border-t border-border pt-8">
        <img src="/favicon.svg" alt="Foxhound" width={44} height={44} className="h-11 w-11 shrink-0 rounded-[10px]" />
        <div>
          <p className="mb-0.5 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">Published by</p>
          <p className="mb-1 text-item-title font-medium text-text">{post.author}</p>
          <p className="m-0 text-copy leading-relaxed text-text-secondary">
            Foxhound recovers failed Stripe payments, handles disputes, and surfaces subscription
            intelligence. {RECOVERY_FEE_PERCENT}% of Foxhound-attributed recoveries only, nothing until then.
          </p>
        </div>
      </div>

      {previous || next ? (
        <nav
          aria-label="Adjacent posts"
          className="mx-auto mt-16 grid max-w-[1100px] grid-cols-1 gap-4 border-t border-border pt-8 sm:grid-cols-2"
        >
          {previous ? (
            <Link
              to={`/blog/${previous.slug}`}
              className="group block rounded-lg border border-border bg-surface p-5 transition-colors hover:border-border-i"
            >
              <div className="mb-1 inline-flex items-center gap-1 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">
                <ArrowLeft
                  className="transition-transform group-hover:-translate-x-0.5"
                  size={13}
                  strokeWidth={1.5}
                  aria-hidden
                />
                Previous post
              </div>
              <div className="text-item-title font-medium leading-snug text-text">{previous.title}</div>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              to={`/blog/${next.slug}`}
              className="group block rounded-lg border border-border bg-surface p-5 transition-colors hover:border-border-i sm:text-right"
            >
              <div className="mb-1 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">
                Next post{" "}
                <ArrowRight
                  className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                  size={13}
                  strokeWidth={1.5}
                  aria-hidden
                />
              </div>
              <div className="text-item-title font-medium leading-snug text-text">{next.title}</div>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <div className="mx-auto mt-16 max-w-[760px] border-t border-border pt-12 text-center">
        <h2 className="mb-2 text-feature-title font-medium text-text">Run your free Stripe audit</h2>
        <p className="mx-auto mb-6 max-w-[480px] text-item-title leading-relaxed text-text-secondary">
          See exactly what your account is leaking. Free, no account required.
        </p>
        <Link
          to="/audit"
          className="btn-primary group inline-block rounded-md px-6 py-3 text-item-title font-semibold text-on-brand"
        >
          Start free audit{" "}
          <ArrowRight
            className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
            size={13}
            strokeWidth={1.5}
            aria-hidden
          />
        </Link>
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
