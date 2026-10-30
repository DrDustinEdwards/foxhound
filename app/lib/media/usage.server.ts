import type { MediaUse } from "@dustinedwards/site-api";
import { sql } from "drizzle-orm";

import { blogPosts, type Db } from "~/db";

import { mediaKeysIn } from "./images";

// The media library's reference check: every place a blog post cites a library
// file, as `/media/<key>` in its body or as its cover address, published or
// draft, and in a scheduled update waiting to replace it
// (scheduled_updates.source, site-api's table, migration 0056). Old revisions
// in blog_post_versions are not counted: they are history, never served.
//
// One read of the posts per call. The blog is tens of posts, so this is cheaper
// than a reference table that every post write would have to keep right.

/** Every use of every file, by key. */
export async function mediaUses(db: Db): Promise<Map<string, MediaUse[]>> {
  const [posts, waiting] = await Promise.all([
    db.select({ id: blogPosts.id, title: blogPosts.title, body: blogPosts.body, cover: blogPosts.coverImageUrl }).from(blogPosts),
    db.all<{ content_id: string; source: string }>(sql`SELECT content_id, source FROM scheduled_updates`),
  ]);
  const titles = new Map(posts.map((p) => [p.id, p.title]));
  const uses = new Map<string, MediaUse[]>();
  const add = (key: string, use: MediaUse) => {
    const list = uses.get(key) ?? [];
    list.push(use);
    uses.set(key, list);
  };
  const title = (id: string) => (titles.get(id) ?? id).slice(0, 1000);

  for (const post of posts) {
    for (const key of mediaKeysIn(post.body)) add(key, { type: "post", id: post.id, title: title(post.id), detail: "in the post" });
    for (const key of mediaKeysIn(post.cover ?? "")) add(key, { type: "post", id: post.id, title: title(post.id), detail: "the cover picture" });
  }
  for (const row of waiting) {
    for (const key of mediaKeysIn(row.source)) {
      add(key, { type: "post", id: row.content_id, title: title(row.content_id), detail: "in a scheduled update" });
    }
  }
  return uses;
}
