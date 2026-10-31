import { rssDocument } from "@drdustinedwards/site-helpers/feeds";

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
// root-level route already was. The XML is Prelum's rssDocument.

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
  // date is the newest. An item's pubDate is likewise OMITTED rather than
  // defaulted to now (rssItem leaves it out when publishAt is null), same
  // ruling: an item whose pubDate reads "now" on every fetch re-surfaces
  // forever in any reader that sorts by date.
  const newestPublishedAt = posts.find((post) => post.publishedAt)?.publishedAt;

  const rss = rssDocument({
    title: "Foxhound Blog",
    link: `${url}/blog`,
    description: "Guides on Stripe payment recovery, dispute handling, and subscription intelligence.",
    selfUrl: `${url}/feed.rss`,
    origin: url,
    itemPath: "/blog",
    lastBuildDate: newestPublishedAt,
    image: { url: `${url}/icon-512.png`, title: "Foxhound Blog", link: `${url}/blog` },
    posts: posts.map((post) => ({
      slug: post.slug,
      title: post.title,
      html: null,
      description: post.excerpt,
      publishAt: post.publishedAt,
      tags: post.tags,
      author: `${SUPPORT_EMAIL} (${post.author})`,
    })),
  });

  return new Response(rss, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
