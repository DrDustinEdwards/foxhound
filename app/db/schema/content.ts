import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool, json } from "./columns";

// ============================================================================
// Content / growth (global)
// ============================================================================

export const blogPosts = sqliteTable(
  "blog_posts",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull(),
    body: text("body").notNull(),
    coverImageUrl: text("cover_image_url"),
    coverImageAlt: text("cover_image_alt"),
    published: bool("published").notNull().default(false),
    publishedAt: ts("published_at"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    author: text("author").notNull(),
    tags: json<string[]>("tags").notNull(),
    ogTitle: text("og_title"),
    ogDescription: text("og_description"),
    canonicalUrl: text("canonical_url"),
    // site-api's noindex search field: robots noindex, and left out of the sitemap.
    noindex: bool("noindex").notNull().default(false),
    showUpdatedAt: bool("show_updated_at").notNull().default(true),
    showPublishedAt: bool("show_published_at").notNull().default(true),
    featured: bool("featured").notNull().default(false),
    // Precomputed at write time (createPost/updatePostWithVersion) from body's
    // word count, so a list/tag-archive read never needs the full body just to
    // show a card's reading time (perf-audit fix, foxhound-audit-perf.md M-2).
    readingMinutes: integer("reading_minutes").notNull().default(1),
    // Carrel's content trash (site-api v0.17.0): set when the post goes to the
    // trash, which takes it off the blog; null otherwise. site-api's
    // runSchedules deletes a post 30 days after it was trashed.
    trashedAt: ts("trashed_at"),
  },
  (t) => [
    uniqueIndex("blog_posts_slug_uq").on(t.slug),
    // Every public list query filters WHERE published = true ORDER BY
    // published_at DESC (listPublishedPosts, getAllPublishedPosts, the tag
    // archive, sitemap/feed/llms generators); no supporting index existed
    // (perf-audit L-2), invisible at 45 rows but a real gap as content scales.
    index("blog_posts_published_published_at_idx").on(t.published, t.publishedAt),
  ],
);

// The old addresses of renamed posts (site-api v0.17.0 rename): /blog/<from_slug>
// answers a 301 to /blog/<to_slug>. A second rename points every row at the
// newest slug, so no redirect chains; the post route reads it only when no live
// post holds the slug.
export const blogSlugRedirects = sqliteTable("blog_slug_redirects", {
  fromSlug: text("from_slug").primaryKey(),
  toSlug: text("to_slug").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const blogPostLinks = sqliteTable(
  "blog_post_links",
  {
    id: id(),
    sourceId: text("source_id").notNull().references(() => blogPosts.id),
    targetId: text("target_id").notNull().references(() => blogPosts.id),
    position: integer("position").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("blog_post_links_source_idx").on(t.sourceId)],
);

export const blogPostVersions = sqliteTable(
  "blog_post_versions",
  {
    id: id(),
    postId: text("post_id").notNull().references(() => blogPosts.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    excerpt: text("excerpt").notNull(),
    savedAt: ts("saved_at").notNull(),
    savedBy: text("saved_by"),
  },
  (t) => [index("blog_post_versions_post_idx").on(t.postId)],
);

export const socialConfig = sqliteTable("social_config", {
  id: id(),
  platform: text("platform").notNull(),
  enabled: bool("enabled").notNull().default(false),
  postEnabled: bool("post_enabled").notNull().default(false),
  replyEnabled: bool("reply_enabled").notNull().default(false),
  redditReady: bool("reddit_ready").notNull().default(false),
  maxRepliesPerDay: integer("max_replies_per_day").notNull(),
  minIntentScore: integer("min_intent_score").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  maxPostAgeHours: integer("max_post_age_hours").notNull(),
  minUpvotes: integer("min_upvotes").notNull(),
  postsPerWeek: integer("posts_per_week").notNull(),
});

export const socialKeywords = sqliteTable("social_keywords", {
  id: id(),
  platform: text("platform").notNull(),
  query: text("query").notNull(),
  enabled: bool("enabled").notNull().default(true),
  createdAt: ts("created_at").notNull(),
  isCompetitor: bool("is_competitor").notNull().default(false),
  lastUsedAt: ts("last_used_at"),
  leadCount: integer("lead_count").notNull().default(0),
});

export const socialLeads = sqliteTable(
  "social_leads",
  {
    id: id(),
    platform: text("platform").notNull(),
    postUrl: text("post_url").notNull(),
    postId: text("post_id"),
    author: text("author"),
    title: text("title"),
    body: text("body"),
    subreddit: text("subreddit"),
    intentScore: integer("intent_score").notNull(),
    keywordsMatched: json<string[]>("keywords_matched"),
    status: text("status").notNull(),
    replyId: text("reply_id"),
    replyBody: text("reply_body"),
    scoutRunAt: ts("scout_run_at").notNull(),
    repliedAt: ts("replied_at"),
    skipReason: text("skip_reason"),
    createdAt: ts("created_at").notNull(),
    upvoteCount: integer("upvote_count"),
    postAgeHours: integer("post_age_hours"),
    filterReason: text("filter_reason"),
    sentiment: text("sentiment"),
    isCompetitorMention: bool("is_competitor_mention").notNull().default(false),
    isGoogleRanking: bool("is_google_ranking").notNull().default(false),
    generatedReply: text("generated_reply"),
    replyApprovedAt: ts("reply_approved_at"),
    keywordId: text("keyword_id").references(() => socialKeywords.id),
  },
  (t) => [
    index("social_leads_keyword_idx").on(t.keywordId),
    // Retention sweep predicate (cron/retention.ts); without it every daily sweep reads the whole table.
    index("social_leads_scout_run_idx").on(t.scoutRunAt),
  ],
);

export const socialPosts = sqliteTable(
  "social_posts",
  {
    id: id(),
    platform: text("platform").notNull(),
    postType: text("post_type").notNull(),
    content: text("content").notNull(),
    platformPostId: text("platform_post_id"),
    leadId: text("lead_id").references(() => socialLeads.id),
    status: text("status").notNull(),
    error: text("error"),
    postedAt: ts("posted_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("social_posts_lead_idx").on(t.leadId)],
);

export const socialTopicLog = sqliteTable("social_topic_log", {
  id: id(),
  topicKey: text("topic_key").notNull(),
  platform: text("platform").notNull(),
  usedAt: ts("used_at").notNull(),
});

export const socialBlocklist = sqliteTable("social_blocklist", {
  id: id(),
  type: text("type").notNull(),
  value: text("value").notNull(),
  reason: text("reason"),
  createdAt: ts("created_at").notNull(),
});
