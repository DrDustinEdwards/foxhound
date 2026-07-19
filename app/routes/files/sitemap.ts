import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getAllPublishedPosts } from "~/lib/blog/queries.server";
import { siteUrl } from "~/lib/seo/jsonld";

import type { Route } from "./+types/sitemap";

// Ported from legacy app/sitemap.ts + app/(marketing)/blog/sitemap.ts (Phase
// 6 Pass 2), composed into the ONE /sitemap.xml resource route this repo
// registers (no sitemap-index pattern). Three sources concatenated into one
// <urlset>:
//   1. STATIC_PAGES: every Pass 1-shipped route.
//   2. One entry per published blog post (D1, lastModified from
//      updated_at ?? published_at).
//   3. One entry per canonical tag with >=1 published post.
//
// Pass 3 (decline-codes, compare) adds its own static entries; append to
// STATIC_PAGES or concat another array in the loader below, do not
// restructure this file to add them.

interface SitemapEntry {
  path: string;
  lastModified?: Date;
  changeFrequency?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

const STATIC_PAGES: SitemapEntry[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/pricing", changeFrequency: "monthly", priority: 0.9 },
  { path: "/products", changeFrequency: "monthly", priority: 0.9 },
  { path: "/products/audit", changeFrequency: "monthly", priority: 0.8 },
  { path: "/products/recovery", changeFrequency: "monthly", priority: 0.8 },
  { path: "/products/disputes", changeFrequency: "monthly", priority: 0.8 },
  { path: "/products/intelligence", changeFrequency: "monthly", priority: 0.8 },
  { path: "/about", changeFrequency: "monthly", priority: 0.5 },
  { path: "/demos", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.7 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.8 },
];

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
  const tagEntries: SitemapEntry[] = [...tagsWithPosts].map((tag) => ({
    path: `/blog/tag/${tag}`,
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  const entries = [...STATIC_PAGES, ...postEntries, ...tagEntries];

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
