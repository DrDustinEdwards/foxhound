import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool, json } from "./columns";

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
    // site-api's image and imageAlt search fields: the share card, over the cover and the generated card.
    ogImageUrl: text("og_image_url"),
    ogImageAlt: text("og_image_alt"),
    // site-api's noindex search field: robots noindex, and left out of the sitemap.
    noindex: bool("noindex").notNull().default(false),
    showUpdatedAt: bool("show_updated_at").notNull().default(true),
    showPublishedAt: bool("show_published_at").notNull().default(true),
    featured: bool("featured").notNull().default(false),
    // Precomputed at write time (createPost/updatePostWithVersion) from body's word count, so a list or tag-archive read never needs the full body just to show a reading time.
    readingMinutes: integer("reading_minutes").notNull().default(1),
    // Carrel's content trash: set when the post goes to the trash, which takes it off the blog; null otherwise. site-api's runSchedules deletes a post 30 days after it was trashed.
    trashedAt: ts("trashed_at"),
  },
  (t) => [
    uniqueIndex("blog_posts_slug_uq").on(t.slug),
    // Every public list query filters WHERE published = true ORDER BY published_at DESC (listPublishedPosts, getAllPublishedPosts, the tag archive, sitemap/feed/llms generators); this index backs them.
    index("blog_posts_published_published_at_idx").on(t.published, t.publishedAt),
  ],
);

// The old addresses of renamed posts: /blog/<from_slug> answers a 301 to /blog/<to_slug>. A second rename points every row at the newest slug, so no redirect chains; the post route reads it only when no live post holds the slug.
export const blogSlugRedirects = sqliteTable("blog_slug_redirects", {
  fromSlug: text("from_slug").primaryKey(),
  toSlug: text("to_slug").notNull(),
  createdAt: ts("created_at").notNull(),
});

// The day each code-written page of the sitemap last changed, kept by the daily page-dates job (app/lib/page-dates.server.ts):
// the hash of the page's Markdown text and the day that hash first appeared. /sitemap.xml reads lastmod from here.
export const pageDateRows = sqliteTable("page_dates", {
  path: text("path").primaryKey(),
  hash: text("hash").notNull(),
  lastmod: text("lastmod").notNull(),
});

export const blogPostLinks = sqliteTable(
  "blog_post_links",
  {
    id: id(),
    sourceId: text("source_id")
      .notNull()
      .references(() => blogPosts.id),
    targetId: text("target_id")
      .notNull()
      .references(() => blogPosts.id),
    position: integer("position").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("blog_post_links_source_idx").on(t.sourceId)],
);

export const blogPostVersions = sqliteTable(
  "blog_post_versions",
  {
    id: id(),
    postId: text("post_id")
      .notNull()
      .references(() => blogPosts.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    excerpt: text("excerpt").notNull(),
    savedAt: ts("saved_at").notNull(),
    savedBy: text("saved_by"),
  },
  (t) => [index("blog_post_versions_post_idx").on(t.postId)],
);
