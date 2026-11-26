import {
  sitemapDocument,
  type SitemapEntry as PrelumEntry,
} from "@drdustinedwards/site-helpers/sitemap";

import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { getAllPublishedPosts } from "~/lib/blog/queries.server";
import { loadPageDates } from "~/lib/page-dates.server";
import { COMPETITOR_ORDER } from "~/lib/compare/competitors";
import { DECLINE_CODES, DECLINE_CODES_PATH, declineCodePath } from "~/lib/decline-codes/codes";
import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/sitemap";

// The ONE /sitemap.xml resource route (no sitemap-index pattern). Sources concatenated into one <urlset>: STATIC_PAGES (every hand-listed route); docEntries (one per DOC_GUIDES slug); one entry per published blog post (D1, lastModified from updated_at ?? published_at); one entry per canonical tag with >=1 published post; declineCodeEntries / compareEntries (one per DECLINE_CODES / COMPETITOR_ORDER slug). A new dynamic-route source maps its existing source of truth into a SitemapEntry[] here, never hand-listing URLs that already exist as data elsewhere.

// Prelum's entry, with a path where Prelum takes the absolute loc (the origin comes from env at request time).
type SitemapEntry = Omit<PrelumEntry, "loc"> & { path: string };

// Every static (non-parameterized) public marketing route belongs here. test/sitemap.test.ts walks the real route tree (app/routes.ts) and asserts every one of them, MINUS the documented EXCLUDED_PREFIXES list, appears in this array, so a new static marketing route never added here fails CI instead of silently missing from search indexing. Priorities and changeFrequency are format hints with no truth content. lastModified is deliberately NOT `new Date()` on every entry (which tells crawlers every page changed on this request, false and harmful to crawl scheduling): a static entry's lastmod is the day its text last changed, which the daily page-dates job keeps (app/lib/page-dates.server.ts). The product pages are /product/* (singular); the old /products/<name> addresses answer a 301 to them.
export const STATIC_PAGES: SitemapEntry[] = [
  { path: "/", changefreq: "weekly", priority: 1.0 },
  { path: "/pricing", changefreq: "monthly", priority: 0.8 },
  { path: "/products", changefreq: "monthly", priority: 0.9 },
  { path: "/product/audit", changefreq: "monthly", priority: 0.9 },
  { path: "/product/recovery", changefreq: "monthly", priority: 0.9 },
  { path: "/product/disputes", changefreq: "monthly", priority: 0.9 },
  { path: "/product/intelligence", changefreq: "monthly", priority: 0.9 },
  { path: "/features", changefreq: "monthly", priority: 0.8 },
  // /about, /decline-codes, /compare and their children list themselves.
  { path: "/about", changefreq: "monthly", priority: 0.5 },
  { path: "/contact", changefreq: "yearly", priority: 0.4 },
  { path: "/demos", changefreq: "monthly", priority: 0.7 },
  { path: "/docs", changefreq: "weekly", priority: 0.8 },
  { path: "/audit", changefreq: "monthly", priority: 0.9 },
  { path: "/privacy", changefreq: "yearly", priority: 0.3 },
  { path: "/terms", changefreq: "yearly", priority: 0.3 },
  { path: "/security", changefreq: "yearly", priority: 0.3 },
  { path: "/accessibility", changefreq: "yearly", priority: 0.3 },
  { path: "/blog", changefreq: "weekly", priority: 0.8 },
  { path: "/blog/archive", changefreq: "weekly", priority: 0.7 },
  // Decline-codes and compare hubs + their templated per-code/per-competitor pages are added below via DECLINE_CODES/COMPETITOR_ORDER rather than hand-listed here.
  { path: DECLINE_CODES_PATH, changefreq: "monthly", priority: 0.8 },
  { path: "/compare", changefreq: "monthly", priority: 0.7 },
];

// /docs/:slug pages, mapped the same way DECLINE_CODES/COMPETITOR_ORDER are
// below (a static list already in the repo, not hand-duplicated here).
const docEntries: SitemapEntry[] = DOC_GUIDES.map((g) => ({
  path: `/docs/${g.slug}`,
  changefreq: "weekly",
  priority: 0.7,
}));

const declineCodeEntriesOf = () => DECLINE_CODES.map((c) => ({ path: declineCodePath(c.code) }));
const compareEntriesOf = () => COMPETITOR_ORDER.map((slug) => ({ path: `/compare/${slug}` }));

/** The paths no database row dates: the pages written in code. The daily page-dates job dates them by what they say. */
export function codePagePaths(): string[] {
  return [
    ...STATIC_PAGES.map((p) => p.path),
    ...docEntries.map((p) => p.path),
    ...declineCodeEntriesOf().map((p) => p.path),
    ...compareEntriesOf().map((p) => p.path),
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);
  const db = getDb(env);

  // A post marked noindex (its search field) is left out.
  const posts = await getAllPublishedPosts(db, { indexedOnly: true });
  // The day each code-written page last changed (the daily page-dates job); a page it has not dated yet has no lastmod.
  const dates = await loadPageDates(db);
  const dated = <T extends { path: string }>(entry: T): T & { lastmod?: string } => ({
    ...entry,
    lastmod: dates[entry.path]?.lastmod,
  });

  const postEntries: SitemapEntry[] = posts.map((post) => ({
    path: `/blog/${post.slug}`,
    lastmod: post.updatedAt ?? post.publishedAt,
    changefreq: "monthly",
    priority: 0.7,
  }));

  // A tag page changed when the newest of its posts did.
  const tagNewest = new Map<string, Date>();
  for (const post of posts) {
    const changed = post.updatedAt ?? post.publishedAt;
    for (const tag of post.tags) {
      const seen = tagNewest.get(tag);
      if (changed && (!seen || changed > seen)) tagNewest.set(tag, changed);
    }
  }
  const tagsWithPosts = new Set<string>(posts.flatMap((post) => post.tags));
  // All tags take one priority (0.7): a generator cannot reproduce a per-tag exception without hand-listing the very data it derives from.
  const tagEntries: SitemapEntry[] = [...tagsWithPosts].map((tag) => ({
    path: `/blog/tag/${tag}`,
    lastmod: tagNewest.get(tag),
    changefreq: "weekly",
    priority: 0.7,
  }));

  const declineCodeEntries: SitemapEntry[] = declineCodeEntriesOf().map((entry) => ({
    ...entry,
    changefreq: "monthly",
    priority: 0.6,
  }));

  const compareEntries: SitemapEntry[] = compareEntriesOf().map((entry) => ({
    ...entry,
    changefreq: "monthly",
    priority: 0.6,
  }));

  const entries = [
    ...STATIC_PAGES.map(dated),
    ...docEntries.map(dated),
    ...postEntries,
    ...tagEntries,
    ...declineCodeEntries.map(dated),
    ...compareEntries.map(dated),
  ];

  const xml = sitemapDocument(
    entries.map(({ path, ...entry }) => ({ loc: `${url}${path}`, ...entry })),
    { layout: "expanded", lastmodFormat: "datetime" },
  );

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
