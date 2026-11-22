import type { MediaUse } from "@dustinedwards/site-api";
import { keysAtAddresses } from "@dustinedwards/site-runtime/image";
import { sql } from "drizzle-orm";

import { blogPosts, type Db } from "~/db";

import { MEDIA_ADDRESSES } from "./images";

// The media library's reference check: every place a blog post cites a library file (`/media/<key>` in its body or as its
// cover, published or draft, and in a waiting scheduled_updates.source). Old revisions are history, never served, so not
// counted. One read of the posts per call: cheaper than a reference table every post write would have to keep right.

export async function mediaUses(db: Db): Promise<Map<string, MediaUse[]>> {
  const [posts, waiting] = await Promise.all([
    db
      .select({
        id: blogPosts.id,
        title: blogPosts.title,
        body: blogPosts.body,
        cover: blogPosts.coverImageUrl,
      })
      .from(blogPosts),
    db.all<{ content_id: string; source: string }>(
      sql`SELECT content_id, source FROM scheduled_updates`,
    ),
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
    for (const key of keysAtAddresses(post.body, MEDIA_ADDRESSES))
      add(key, { type: "post", id: post.id, title: title(post.id), detail: "in the post" });
    for (const key of keysAtAddresses(post.cover, MEDIA_ADDRESSES))
      add(key, { type: "post", id: post.id, title: title(post.id), detail: "the cover picture" });
  }
  for (const row of waiting) {
    for (const key of keysAtAddresses(row.source, MEDIA_ADDRESSES)) {
      add(key, {
        type: "post",
        id: row.content_id,
        title: title(row.content_id),
        detail: "in a scheduled update",
      });
    }
  }
  return uses;
}
