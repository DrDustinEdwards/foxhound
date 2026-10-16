import { sitemapDocument, type SitemapEntry as PrelumEntry } from "@drdustinedwards/site-helpers/sitemap";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { PublishedSet } from "~/lib/blog/published-set";
import { loadPublishedSet } from "~/lib/blog/published-set.server";
import { COMPETITOR_ORDER } from "~/lib/compare/competitors";
import { DECLINE_CODES } from "~/lib/decline-codes/codes";
import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/sitemap";

// /sitemap.xml and /blog/sitemap.xml (rows F1 and M16, J61). Recova's spec is
// app/sitemap.ts and app/(marketing)/blog/sitemap.ts, read whole; the XML is
// Prelum's sitemapDocument (Q2). One module serves both, registered twice in
// app/routes.ts, so both read the one published set the feeds and the llms
// pair read (ruling 90's SET rule, app/lib/blog/published-set.ts).
//
// TWO FLAT URLSETS, AS RECOVA SERVES THEM. Recova keeps each post in exactly
// one sitemap: the per-post entries live in /blog/sitemap.xml and the root
// carries the static pages and the blog navigation (index, archive, topic
// archives). Recova's own comment records that it tried a <sitemapindex>
// joining the two and reverted it, because it served HTML and took
// /sitemap.xml away; that shape is not copied. Recova's robots.txt names the
// root only, and so does Foxhound's.
//
// No static entry carries a lastmod. Recova stamps `new Date()` on every one,
// telling crawlers every page changed on this request, which is false
// (ruling 39 class, ROWS-F F1). A post's lastmod is its own updated date.

interface SitemapEntry {
  path: string;
  changeFrequency?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

// Recova's static entries, in Recova's order, with Recova's changefreq and
// priority (format hints with no truth content, so Recova is the spec, ruling
// 89). The docs guides and the topic archives sit between them where Recova
// lists them, and are mapped from their own sources below, never hand-listed.
const RECOVA_HEAD: SitemapEntry[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/products", changeFrequency: "monthly", priority: 0.9 },
  { path: "/product/audit", changeFrequency: "monthly", priority: 0.9 },
  { path: "/product/recovery", changeFrequency: "monthly", priority: 0.9 },
  { path: "/product/disputes", changeFrequency: "monthly", priority: 0.9 },
  { path: "/product/intelligence", changeFrequency: "monthly", priority: 0.9 },
  { path: "/pricing", changeFrequency: "monthly", priority: 0.8 },
  { path: "/features", changeFrequency: "monthly", priority: 0.8 },
  { path: "/demos", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.8 },
];
const RECOVA_MIDDLE: SitemapEntry[] = [
  { path: "/audit", changeFrequency: "monthly", priority: 0.9 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.8 },
  { path: "/blog/archive", changeFrequency: "weekly", priority: 0.7 },
];
const RECOVA_TAIL: SitemapEntry[] = [
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
];

// NET-NEW pages with no Recova twin list themselves after Recova's (ruling
// 56); none changes an entry for a ported page.
const NET_NEW: SitemapEntry[] = [
  { path: "/about", changeFrequency: "monthly", priority: 0.5 },
  { path: "/security", changeFrequency: "yearly", priority: 0.3 },
  { path: "/decline-codes", changeFrequency: "monthly", priority: 0.8 },
  { path: "/compare", changeFrequency: "monthly", priority: 0.7 },
];

// Every static (non-parameterized) public marketing route. test/sitemap.test.ts
// walks the real route tree (app/routes.ts) and asserts each one, minus its
// documented exclusions, is here, so a new page cannot go missing silently.
export const STATIC_PAGES: SitemapEntry[] = [...RECOVA_HEAD, ...RECOVA_MIDDLE, ...RECOVA_TAIL, ...NET_NEW];

// Recova gives every docs guide weekly at 0.7.
const docEntries: SitemapEntry[] = DOC_GUIDES.map((g) => ({
  path: `/docs/${g.slug}`,
  changeFrequency: "weekly",
  priority: 0.7,
}));

const declineCodeEntries: SitemapEntry[] = DECLINE_CODES.map((c) => ({
  path: `/decline-codes/${c.code}`,
  changeFrequency: "monthly",
  priority: 0.6,
}));

const compareEntries: SitemapEntry[] = COMPETITOR_ORDER.map((slug) => ({
  path: `/compare/${slug}`,
  changeFrequency: "monthly",
  priority: 0.6,
}));

function toPrelum(origin: string, entries: SitemapEntry[]): PrelumEntry[] {
  return entries.map((e) => ({ loc: `${origin}${e.path}`, changefreq: e.changeFrequency, priority: e.priority }));
}

const OPTIONS = { layout: "expanded", lastmodFormat: "datetime" } as const;

/** /sitemap.xml: the static pages and the blog's navigation, no posts. */
export function buildSitemapXml(origin: string, set: PublishedSet): string {
  // Only topics a published post carries (ruling 88). Recova hand-lists its
  // five, all populated, at 0.7, except comparisons at 0.6; a list derived
  // from the posts cannot carry a per-tag exception without hand-listing the
  // data it derives from, so every topic takes Recova's majority value.
  const tagEntries: SitemapEntry[] = set.tags.map((tag) => ({
    path: `/blog/tag/${tag}`,
    changeFrequency: "weekly",
    priority: 0.7,
  }));
  return sitemapDocument(
    toPrelum(origin, [
      ...RECOVA_HEAD,
      ...docEntries,
      ...RECOVA_MIDDLE,
      ...tagEntries,
      ...RECOVA_TAIL,
      ...NET_NEW,
      ...declineCodeEntries,
      ...compareEntries,
    ]),
    OPTIONS,
  );
}

/** /blog/sitemap.xml: one entry per published post (Recova's blog/sitemap.ts). */
export function buildBlogSitemapXml(origin: string, set: PublishedSet): string {
  return sitemapDocument(
    set.posts.map((post) => ({
      loc: `${origin}/blog/${post.slug}`,
      // Recova prefers updated_at so an edit bumps the crawl signal, and falls
      // back to published_at. Both are the post's own dates.
      lastmod: post.updatedAt ?? post.publishedAt ?? null,
      changefreq: "monthly",
      priority: 0.7,
    })),
    OPTIONS,
  );
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const origin = siteUrl(env);
  const set = await loadPublishedSet(getDb(env));
  const isBlog = new URL(request.url).pathname === "/blog/sitemap.xml";
  const xml = isBlog ? buildBlogSitemapXml(origin, set) : buildSitemapXml(origin, set);

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
