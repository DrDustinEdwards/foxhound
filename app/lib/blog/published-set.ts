import type { BlogPostSummary } from "~/lib/blog/queries.server";
import { CANONICAL_TAGS, labelForTag } from "~/lib/blog/tags";

// ONE PUBLISHED SET FOR EVERY MACHINE-READABLE FILE (J61, ruling 90's SET rule).
//
// The sitemap, the blog sitemap, both feeds and the llms pair are read by the
// same crawlers, so they must name the same posts and the same topics. Each of
// them is built from one PublishedSet, read by ONE query
// (loadPublishedSet in published-set.server.ts), and the topic list is derived
// from that same row set rather than asked of the database a second time. Two
// queries could disagree for the length of a publish; one cannot.
//
// Recova let its two feeds read through two different clients (app/feed.rss
// used the anon client, blog/rss.xml lib/blog.ts's admin client), which is the
// defect ruling 90's SET corollary names. Not copied.

export interface PublishedSet {
  /** Every published post, newest first (getAllPublishedPosts's order). */
  posts: BlogPostSummary[];
  /** Every tag at least one of those posts carries, in first-seen order. */
  tags: string[];
}

/** The tags the given posts carry, each once, in the order first seen. The
 *  one derivation of the published topic set: getPublishedTagSet (the archive
 *  pills, the tag-page gate, the blog index) runs its rows through it too. */
export function publishedTags(posts: readonly { tags: readonly string[] }[]): string[] {
  const seen = new Set<string>();
  for (const post of posts) for (const tag of post.tags) seen.add(tag);
  return [...seen];
}

export function publishedSetOf(posts: BlogPostSummary[]): PublishedSet {
  return { posts, tags: publishedTags(posts) };
}

// The order Recova's llms pair lists its topics in (app/llms.txt/route.ts
// and app/llms-full.txt/route.ts). A published topic Recova never listed
// follows, in CANONICAL_TAGS order, then by name.
const LLMS_TOPIC_ORDER = ["payment-recovery", "decline-codes", "disputes", "subscription-intelligence", "comparisons"];

function topicRank(tag: string): number {
  const recova = LLMS_TOPIC_ORDER.indexOf(tag);
  if (recova >= 0) return recova;
  const canonical = (CANONICAL_TAGS as readonly string[]).indexOf(tag);
  return LLMS_TOPIC_ORDER.length + (canonical >= 0 ? canonical : CANONICAL_TAGS.length);
}

/** The published topics in the order the llms pair lists them. */
export function topicsInLlmsOrder(tags: readonly string[]): string[] {
  return [...tags].sort((a, b) => topicRank(a) - topicRank(b) || a.localeCompare(b));
}

export interface TopicGroup {
  tag: string;
  label: string;
  posts: BlogPostSummary[];
}

/** Oldest first, as Recova's article lists read; an undated post goes last. */
function oldestFirst(posts: BlogPostSummary[]): BlogPostSummary[] {
  const time = (p: BlogPostSummary) => p.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...posts].sort((a, b) => time(a) - time(b));
}

/** Every topic with every post that carries it: a post with two topics is in
 *  both, as in Recova's llms.txt. A post with no topic is grouped last under
 *  an empty tag, so no published post is left out of the file. */
export function postsByTopic(set: PublishedSet): TopicGroup[] {
  const groups = topicsInLlmsOrder(set.tags).map((tag) => ({
    tag,
    label: labelForTag(tag),
    posts: oldestFirst(set.posts.filter((post) => post.tags.includes(tag))),
  }));
  const untagged = set.posts.filter((post) => post.tags.length === 0);
  return untagged.length > 0 ? [...groups, { tag: "", label: "Other articles", posts: oldestFirst(untagged) }] : groups;
}

/** Every post exactly once, under its first topic in llms order, as in
 *  Recova's llms-full.txt complete index. A post with no topic is grouped last
 *  under an empty tag. */
export function postsByPrimaryTopic(set: PublishedSet): TopicGroup[] {
  const groups = new Map<string, BlogPostSummary[]>();
  for (const post of set.posts) {
    const primary = topicsInLlmsOrder(post.tags)[0] ?? "";
    groups.set(primary, [...(groups.get(primary) ?? []), post]);
  }
  const order = [...topicsInLlmsOrder([...groups.keys()].filter(Boolean)), ...(groups.has("") ? [""] : [])];
  return order.map((tag) => ({
    tag,
    label: tag ? labelForTag(tag) : "Other articles",
    posts: oldestFirst(groups.get(tag) ?? []),
  }));
}
