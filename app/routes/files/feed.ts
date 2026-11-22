import { rssDocument } from "@drdustinedwards/site-helpers/feeds";

import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { getAllPublishedPosts } from "~/lib/blog/queries.server";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import type { Route } from "./+types/feed";

// Every URL is built from siteUrl(env). The canonical feed path is /feed.rss. The XML is Prelum's rssDocument.

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = siteUrl(env);
  const db = getDb(env);

  const posts = await getAllPublishedPosts(db);

  // lastBuildDate is "the last time the content of the channel changed" (RSS 2.0): when a post last published, NOT when this request happened. An always-now stamp would contradict the sitemap, which serves the same crawler audience. getAllPublishedPosts orders by publishedAt DESC, so the first post with a date is the newest. An item's pubDate is likewise OMITTED rather than defaulted to now (rssItem leaves it out when publishAt is null): an item whose pubDate reads "now" on every fetch re-surfaces forever in any reader that sorts by date.
  const newestPublishedAt = posts.find((post) => post.publishedAt)?.publishedAt;

  const rss = rssDocument({
    title: "Foxhound Blog",
    link: `${url}/blog`,
    description:
      "Guides on Stripe payment recovery, dispute handling, and subscription intelligence.",
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
