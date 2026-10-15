import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getAllPublishedPosts } from "~/lib/blog/queries.server";
import { COMPETITOR_ORDER } from "~/lib/compare/competitors";
import { DECLINE_CODES } from "~/lib/decline-codes/codes";
import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/sitemap";

// Ported from legacy app/sitemap.ts + app/(marketing)/blog/sitemap.ts (Phase
// 6 Pass 2), composed into the ONE /sitemap.xml resource route this repo
// registers (no sitemap-index pattern). Sources concatenated into one
// <urlset>:
//   1. STATIC_PAGES: every hand-listed route (home, pricing, products,
//      about, demos, docs index, /audit, privacy, terms, blog index,
//      decline-codes hub, compare hub).
//   2. docEntries: one entry per DOC_GUIDES slug (/docs/:slug).
//   3. One entry per published blog post (D1, lastModified from
//      updated_at ?? published_at).
//   4. One entry per canonical tag with >=1 published post.
//   5. declineCodeEntries / compareEntries: one entry per DECLINE_CODES /
//      COMPETITOR_ORDER slug.
//
// Any new dynamic-route source (a new static-array-backed section or a new
// D1-driven one) must be added the same way: map the existing source of
// truth into a SitemapEntry[] here, never hand-list URLs that already exist
// as data elsewhere in the repo.

interface SitemapEntry {
  path: string;
  lastModified?: Date;
  changeFrequency?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

// Every static (non-parameterized) public marketing route belongs here.
// test/sitemap.test.ts walks the real route tree (app/routes.ts) and asserts
// every one of them, MINUS the documented EXCLUDED_PREFIXES list it also
// defines, appears in this array - so a new static marketing route added to
// routes.ts and never added here now fails CI instead of silently missing
// from search indexing (TASK-foxhound-seo-remediation.md M4:
// foxhound-audit-seo.md flagged /features missing this way).
// Priorities and changeFrequency are aligned to legacy's app/sitemap.ts
// (ruling 89, for LEGACY-PAIRED entries only; the NET-NEW entries below keep
// their own values, having no legacy spec, per ruling 56). They are format
// hints with no truth content, so legacy is the spec. An earlier version of
// this comment cited ruling 91, which is the index cell cap, not this;
// corrected. Legacy's lastModified is deliberately NOT restored: it sets
// `new Date()` on every static entry, telling crawlers every page changed on
// this request, which is false and degrades crawl scheduling. Ruling 39
// class, do not restore a legacy defect.
//
// The product pages are Recova's /product/* (singular), served at the same
// path since J09 (ruling 55). The old /products/<name> addresses this file
// used to list answer a 301 to them.
export const STATIC_PAGES: SitemapEntry[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/pricing", changeFrequency: "monthly", priority: 0.8 },
  { path: "/products", changeFrequency: "monthly", priority: 0.9 },
  { path: "/product/audit", changeFrequency: "monthly", priority: 0.9 },
  { path: "/product/recovery", changeFrequency: "monthly", priority: 0.9 },
  { path: "/product/disputes", changeFrequency: "monthly", priority: 0.9 },
  { path: "/product/intelligence", changeFrequency: "monthly", priority: 0.9 },
  { path: "/features", changeFrequency: "monthly", priority: 0.8 },
  // NET-NEW (no legacy pair): /about, /decline-codes, /compare and their
  // children. Ruling 56 permits a NET-NEW surface listing ITSELF; none of
  // them changes an entry for a ported page.
  { path: "/about", changeFrequency: "monthly", priority: 0.5 },
  { path: "/demos", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.8 },
  { path: "/audit", changeFrequency: "monthly", priority: 0.9 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  { path: "/security", changeFrequency: "yearly", priority: 0.3 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.8 },
  // TASK-foxhound-parity-cluster-b.md fix 3: restores legacy's archive page.
  { path: "/blog/archive", changeFrequency: "weekly", priority: 0.7 },
  // Pass 3 extension point: decline-codes and compare hubs + their
  // templated per-code/per-competitor pages, added below via
  // DECLINE_CODES/COMPETITOR_ORDER rather than hand-listed here.
  { path: "/decline-codes", changeFrequency: "monthly", priority: 0.8 },
  { path: "/compare", changeFrequency: "monthly", priority: 0.7 },
];

// /docs/:slug pages, mapped the same way DECLINE_CODES/COMPETITOR_ORDER are
// below (a static list already in the repo, not hand-duplicated here).
const docEntries: SitemapEntry[] = DOC_GUIDES.map((g) => ({
  path: `/docs/${g.slug}`,
  changeFrequency: "weekly",
  priority: 0.7,
}));

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function entryXml(url: string, entry: SitemapEntry): string {
  const loc = `${url}${entry.path}`;
  const lastmod = entry.lastModified ? `\n    <lastmod>${entry.lastModified.toISOString()}</lastmod>` : "";
  const changefreq = entry.changeFrequency ? `\n    <changefreq>${entry.changeFrequency}</changefreq>` : "";
  const priority = typeof entry.priority === "number" ? `\n    <priority>${entry.priority.toFixed(1)}</priority>` : "";
  return `  <url>\n    <loc>${xmlEscape(loc)}</loc>${lastmod}${changefreq}${priority}\n  </url>`;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);
  const db = getDb(env);

  const posts = await getAllPublishedPosts(db);

  const postEntries: SitemapEntry[] = posts.map((post) => ({
    path: `/blog/${post.slug}`,
    lastModified: post.updatedAt ?? post.publishedAt ?? undefined,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const tagsWithPosts = new Set<string>();
  for (const post of posts) for (const tag of post.tags) tagsWithPosts.add(tag);
  // Legacy hardcodes five tag URLs at 0.7, except comparisons at 0.6. A
  // generator cannot reproduce a per-tag exception without hand-listing the
  // very data it derives from, so all tags take legacy's majority value; the
  // comparisons nuance is recorded rather than encoded.
  const tagEntries: SitemapEntry[] = [...tagsWithPosts].map((tag) => ({
    path: `/blog/tag/${tag}`,
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

  const entries = [
    ...STATIC_PAGES,
    ...docEntries,
    ...postEntries,
    ...tagEntries,
    ...declineCodeEntries,
    ...compareEntries,
  ];

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.map((e) => entryXml(url, e)).join("\n") +
    "\n</urlset>\n";

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
