import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getAllPublishedPosts } from "~/lib/blog/queries.server";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import type { Route } from "./+types/feed";

// Ported from legacy app/feed.rss/route.ts's structure (Phase 6 Pass 2),
// queried against D1 instead of Supabase, every URL built from siteUrl(env)
// instead of a hardcoded recovamrr.com. legacy's
// app/(marketing)/blog/rss.xml/route.ts is NOT the reference here: this
// repo's canonical feed path is /feed.rss (ROUTES.md), which is what legacy's
// root-level route already was.

function xmlEscapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);
  const db = getDb(env);

  const posts = await getAllPublishedPosts(db);

  // lastBuildDate is "the last time the content of the channel changed"
  // (RSS 2.0): when a post last published, NOT when this request happened.
  // Legacy stamps `new Date()` on every request. That is the same always-now
  // defect ruling 89 refused to import into the sitemap, where legacy sets
  // lastModified to now on every static entry, and it was caught here by
  // ruling 90's cross-surface check: the sitemap and this feed serve the same
  // crawler audience and were asserting opposite things about the same 45
  // posts. Ruling 89 is EXTENDED to this file (Dustin, 2026-08-02).
  // getAllPublishedPosts orders by publishedAt DESC, so the first post with a
  // date is the newest.
  const newestPublishedAt = posts.find((post) => post.publishedAt)?.publishedAt;
  const lastBuildDate = newestPublishedAt
    ? `\n    <lastBuildDate>${newestPublishedAt.toUTCString()}</lastBuildDate>`
    : "";

  const items = posts
    .map((post) => {
      const postUrl = `${url}/blog/${post.slug}`;
      // OMITTED rather than defaulted to now, same ruling: an item whose
      // pubDate reads "now" on every fetch re-surfaces forever in any reader
      // that sorts by date. pubDate is optional in RSS 2.0; a wrong one is not.
      const pubDate = post.publishedAt
        ? `\n      <pubDate>${post.publishedAt.toUTCString()}</pubDate>`
        : "";
      const categories = post.tags.map((tag) => `<category>${xmlEscapeAttr(tag)}</category>`).join("");
      return `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <description><![CDATA[${post.excerpt}]]></description>${pubDate}
      <author>${xmlEscapeAttr(SUPPORT_EMAIL)} (${xmlEscapeAttr(post.author)})</author>
      ${categories}
    </item>`;
    })
    .join("");

  // The channel image is the 180 apple touch icon: the PNG favicon is 32 since
  // the hound mark (job_afa3591dac7e), too small for a reader's channel badge.
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Foxhound Blog</title>
    <link>${url}/blog</link>
    <description>Guides on Stripe payment recovery, dispute handling, and subscription intelligence.</description>
    <language>en-us</language>${lastBuildDate}
    <atom:link href="${url}/feed.rss" rel="self" type="application/rss+xml"/>
    <image>
      <url>${url}/apple-touch-icon.png</url>
      <title>Foxhound Blog</title>
      <link>${url}/blog</link>
    </image>
    ${items}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
