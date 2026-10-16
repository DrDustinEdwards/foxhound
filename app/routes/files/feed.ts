import { escapeXml } from "@drdustinedwards/site-helpers/xml";
import { rssItem } from "@drdustinedwards/site-helpers/feeds";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import type { PublishedSet } from "~/lib/blog/published-set";
import { loadPublishedSet } from "~/lib/blog/published-set.server";
import { siteUrl, SUPPORT_EMAIL } from "~/lib/seo/jsonld";

import type { Route } from "./+types/feed";

// /feed.rss and /blog/rss.xml (rows F5 and M15, J61). Recova serves both:
// app/feed.rss/route.ts and app/(marketing)/blog/rss.xml/route.ts, read
// whole. One module answers both paths (registered twice in app/routes.ts),
// so both feeds are built from the one published set the sitemaps and the
// llms pair read (ruling 90's SET rule). Recova's two read through two
// different clients and could disagree; these cannot.
//
// Each item is Prelum's rssItem (Q2): title and summary escaped, a category
// escaped, pubDate omitted when the post has none, and no content:encoded,
// because neither Recova feed carries the post body and an empty one would
// tell a reader the post is empty. The channel is written here, because
// Prelum's rssDocument has no lastBuildDate, no <image> and no per-item
// <author>, all three of which Recova's /feed.rss carries.

interface FeedChannel {
  /** The path this feed is served at, for its atom:link self reference. */
  selfPath: string;
  /** Recova's /feed.rss carries an <image>; its /blog/rss.xml does not. */
  image: boolean;
  /** Recova's /feed.rss names an author per item; its /blog/rss.xml does not. */
  itemAuthor: boolean;
}

const CHANNELS: Record<string, FeedChannel> = {
  "/feed.rss": { selfPath: "/feed.rss", image: true, itemAuthor: true },
  "/blog/rss.xml": { selfPath: "/blog/rss.xml", image: false, itemAuthor: false },
};

const TITLE = "Foxhound Blog";
// One description on both feeds. Recova's two differ ("Guides, benchmarks,
// and insights for Stripe subscription businesses." and "Payment recovery,
// dispute automation, and subscription intelligence from Recova."); /feed.rss
// keeps this 20d-frozen line (ROWS-F F5), and /blog/rss.xml takes the same
// line rather than a new claim about dispute automation, pending a ruling.
const DESCRIPTION = "Guides on Stripe payment recovery, dispute handling, and subscription intelligence.";

function buildRss(origin: string, set: PublishedSet, channel: FeedChannel): string {
  // lastBuildDate is when the channel's content last changed: the newest
  // post's publish date, never this request's clock. Recova stamps
  // `new Date()` on every request in both feeds; ruling 89, extended to the
  // feed by Dustin on 2026-08-02. Posts arrive newest first.
  const newest = set.posts.find((post) => post.publishedAt)?.publishedAt;
  const lastBuildDate = newest ? `\n    <lastBuildDate>${newest.toUTCString()}</lastBuildDate>` : "";

  const items = set.posts
    .map((post) => {
      const item = rssItem(
        {
          slug: post.slug,
          title: post.title,
          html: null,
          description: post.excerpt,
          publishAt: post.publishedAt,
          tags: post.tags,
        },
        origin,
        "/blog",
      );
      if (!channel.itemAuthor) return item;
      const author = `      <author>${escapeXml(SUPPORT_EMAIL)} (${escapeXml(post.author)})</author>`;
      return item.replace(/\n {4}<\/item>$/, `\n${author}\n    </item>`);
    })
    .join("\n");

  const image = channel.image
    ? `
    <image>
      <url>${origin}/favicon.png</url>
      <title>${TITLE}</title>
      <link>${origin}/blog</link>
    </image>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${TITLE}</title>
    <link>${origin}/blog</link>
    <description>${DESCRIPTION}</description>
    <language>en-us</language>${lastBuildDate}
    <atom:link href="${origin}${channel.selfPath}" rel="self" type="application/rss+xml" />${image}
${items}
  </channel>
</rss>
`;
}

/** /feed.rss, Recova's root feed. */
export function buildFeedRss(origin: string, set: PublishedSet): string {
  return buildRss(origin, set, CHANNELS["/feed.rss"]!);
}

/** /blog/rss.xml, Recova's blog feed. */
export function buildBlogRss(origin: string, set: PublishedSet): string {
  return buildRss(origin, set, CHANNELS["/blog/rss.xml"]!);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const origin = siteUrl(env);
  const set = await loadPublishedSet(getDb(env));
  const isBlog = new URL(request.url).pathname === "/blog/rss.xml";
  const rss = isBlog ? buildBlogRss(origin, set) : buildFeedRss(origin, set);

  return new Response(rss, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
