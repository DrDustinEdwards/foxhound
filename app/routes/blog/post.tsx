import "highlight.js/styles/github-dark.css";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { ReadingProgressBar } from "~/components/blog/reading-progress-bar";
import { ShareRow } from "~/components/blog/share-row";
import { TableOfContents } from "~/components/blog/table-of-contents";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatTagChip } from "~/lib/blog/format";
import { extractFaqPairs, renderMarkdown } from "~/lib/blog/markdown.server";
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
  const post = await getPostBySlug(db, params.slug);
  if (!post) {
    throw new Response("Not found", { status: 404 });
  }

  const [{ html, toc }, previous, next, related] = await Promise.all([
    renderMarkdown(db, post.body),
    post.publishedAt ? getPreviousPost(db, post.publishedAt, post.id) : Promise.resolve(null),
    post.publishedAt ? getNextPost(db, post.publishedAt, post.id) : Promise.resolve(null),
    getPostLinks(db, post.id),
  ]);

  const faqPairs = extractFaqPairs(post.body);

  return { siteUrl: siteUrl(env), post, html, toc, previous, next, related, faqPairs };
}

function ogImageUrl(url: string, title: string, tag: string | undefined): string {
  const params = new URLSearchParams({ title });
  if (tag) params.set("tag", formatTagChip(tag));
  return `${url}/og/blog?${params.toString()}`;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Blog - Foxhound" }];
  const { post, siteUrl: url } = loaderData;
  const title = post.ogTitle ?? post.title;
  const description = post.ogDescription ?? post.excerpt;
  const canonical = post.canonicalUrl ?? `${url}/blog/${post.slug}`;
  const image = post.coverImageUrl ?? ogImageUrl(url, title, post.tags[0]);

  return marketingMeta({
    title: `${title} - Foxhound Blog`,
    description,
    path: `/blog/${post.slug}`,
    siteUrl: url,
    canonical,
    image,
    ogTitle: title,
    ogType: "article",
    imageAlt: title,
  });
}

function formatDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default function BlogPostPage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, post, html, toc, previous, next, related, faqPairs } = loaderData;

  const canonical = post.canonicalUrl ?? `${url}/blog/${post.slug}`;
  const image = post.coverImageUrl ?? ogImageUrl(url, post.ogTitle ?? post.title, post.tags[0]);

  const showUpdated =
    post.showUpdatedAt &&
    post.publishedAt &&
    post.updatedAt &&
    post.updatedAt.getTime() - post.publishedAt.getTime() > 24 * 60 * 60 * 1000;
  const showPublished = post.showPublishedAt && post.publishedAt;

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8">
      <ReadingProgressBar targetId="blog-post-article" />

      <Link
        to="/blog"
        className="group mb-8 inline-flex items-center gap-1.5 text-label text-text-tertiary hover:text-text"
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
          {post.coverImageUrl ? (
            <div className="mb-8 aspect-video w-full overflow-hidden rounded-xl bg-bg">
              <img
                src={post.coverImageUrl}
                alt={post.coverImageAlt ?? post.title}
                className="h-full w-full object-cover"
              />
            </div>
          ) : null}

          {post.tags.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {post.tags.map((t) => (
                <Link
                  key={t}
                  to={`/blog/tag/${t}`}
                  className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-micro text-text-tertiary hover:border-amber hover:text-text"
                >
                  {formatTagChip(t)}
                </Link>
              ))}
            </div>
          ) : null}

          <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-label text-text-tertiary">
            {showPublished ? <time dateTime={post.publishedAt!.toISOString()}>{formatDate(post.publishedAt)}</time> : null}
            {showPublished && showUpdated ? <span aria-hidden="true"> &middot; </span> : null}
            {showUpdated ? <>Updated {formatDate(post.updatedAt)}</> : null}
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

          <h1 className="mb-4 text-display font-medium leading-tight text-text">{post.title}</h1>
          <p className="mb-6 text-body leading-relaxed text-text-secondary">{post.excerpt}</p>

          <ShareRow url={canonical} title={post.title} />

          <TableOfContents items={toc} variant="inline" />

          <div className="blog-prose" dangerouslySetInnerHTML={{ __html: html }} />
        </article>

        <TableOfContents items={toc} variant="sidebar" />
      </div>

      {related.length > 0 ? (
        <section aria-label="Further reading" className="mt-12 max-w-[680px] border-t border-border pt-8">
          <p className="mb-3 font-mono text-micro uppercase tracking-wide text-text-tertiary">Further reading</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {related.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/blog/${r.slug}`}
                  className="group inline-flex items-center gap-1.5 text-body text-text hover:text-amber-text"
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
        <img src="/favicon.svg" alt="Foxhound" width={44} height={44} className="h-11 w-11 shrink-0 rounded-lg" />
        <div>
          <p className="mb-0.5 font-mono text-micro uppercase tracking-wide text-text-tertiary">Published by</p>
          <p className="mb-1 text-body font-medium text-text">{post.author}</p>
          <p className="m-0 text-label leading-relaxed text-text-secondary">
            Foxhound recovers failed Stripe payments, handles disputes, and surfaces subscription
            intelligence. 20% of Foxhound-attributed recoveries only, nothing until then.
          </p>
        </div>
      </div>

      {previous || next ? (
        <nav aria-label="Adjacent posts" className="mt-16 grid grid-cols-1 gap-4 border-t border-border pt-8 sm:grid-cols-2">
          {previous ? (
            <Link
              to={`/blog/${previous.slug}`}
              className="group block rounded-lg border border-border bg-surface p-5 hover:border-border-i"
            >
              <div className="mb-1 inline-flex items-center gap-1 font-mono text-micro uppercase tracking-wide text-text-tertiary">
                <ArrowLeft
                  className="transition-transform group-hover:-translate-x-0.5"
                  size={13}
                  strokeWidth={1.5}
                  aria-hidden
                />
                Previous post
              </div>
              <div className="text-body font-medium leading-snug text-text">{previous.title}</div>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              to={`/blog/${next.slug}`}
              className="group block rounded-lg border border-border bg-surface p-5 hover:border-border-i sm:text-right"
            >
              <div className="mb-1 font-mono text-micro uppercase tracking-wide text-text-tertiary">
                Next post{" "}
                <ArrowRight
                  className="inline-block transition-transform duration-150 group-hover:translate-x-0.5"
                  size={13}
                  strokeWidth={1.5}
                  aria-hidden
                />
              </div>
              <div className="text-body font-medium leading-snug text-text">{next.title}</div>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <div className="mx-auto mt-16 max-w-xl border-t border-border pt-12 text-center">
        <h2 className="mb-2 text-title font-medium text-text">Run your free Stripe audit</h2>
        <p className="mx-auto mb-6 max-w-md text-body leading-relaxed text-text-secondary">
          See exactly what your account is leaking. Free, no account required.
        </p>
        <Link
          to="/audit"
          className="inline-flex items-center gap-2 rounded-md bg-amber px-6 py-3 text-body font-semibold text-on-amber hover:bg-amber-dark"
        >
          Start free audit
        </Link>
      </div>

      {/* organizationJsonLd (and personJsonLd below, when applicable) render
          the full node the Article's publisher/author @id references point
          at. Rich Results parsers combine every JSON-LD block on ONE page
          into a single graph, but do NOT fetch other pages to resolve an
          @id, so a bare {"@id": ...} reference with no matching node on
          THIS page would not actually resolve; home.tsx is the only other
          place organizationJsonLd renders. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd(url)) }}
      />
      {post.author.trim().toLowerCase() === "dustin edwards" ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(
              personJsonLd(url, {
                name: "Dustin Edwards",
                jobTitle: "Founder",
                description: "Founder of Foxhound, a pay-on-lift Stripe recovery, disputes, and intelligence platform.",
              }),
            ),
          }}
        />
      ) : null}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            articleJsonLd(url, {
              headline: post.ogTitle ?? post.title,
              description: post.ogDescription ?? post.excerpt,
              path: `/blog/${post.slug}`,
              imageUrl: image,
              datePublished: post.publishedAt?.toISOString() ?? null,
              dateModified: (post.updatedAt ?? post.createdAt).toISOString(),
              authorName: post.author,
            }),
          ),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Blog", path: "/blog" },
              { name: post.title, path: `/blog/${post.slug}` },
            ]),
          ),
        }}
      />
      {faqPairs.length > 0 ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(
              faqPageJsonLd(faqPairs.map((f) => ({ question: f.question, answer: f.answer }))),
            ),
          }}
        />
      ) : null}
    </div>
  );
}
