import { titleCase } from "@drdustinedwards/site-helpers/text";
import { Link } from "capsomer/react/link";

import type { BlogPostSummary } from "~/lib/blog/queries.server";

// Consumers: /blog (the topic sections and the latest strip) and /blog/tag/:tag, and nowhere else; the home page hand-rolls a different card. The card is Capsomer's panel, body only, as the whole-card link (the /products and /docs cards), with Capsomer's outline pill for the first tag, the title (two lines), the excerpt (three lines) and the reading time. Sizes: p-5, the 0.875rem title, the 0.75rem excerpt and the 0.6875rem reading time. The post cards do not lift, so the lift is off. `level` keeps the outline whole: an h3 under /blog's section h2s, an h2 on a tag page, where the h1 is the only heading above the cards.
export function BlogPostCard({ post, level = 3 }: { post: BlogPostSummary; level?: 2 | 3 }) {
  const Title = level === 2 ? "h2" : "h3";
  const tag = post.tags[0] ? titleCase(post.tags[0]) : null;
  return (
    <Link to={`/blog/${post.slug}`} className="fh-blog-post-card-link cap-panel">
      <div className="cap-panel-body">
        <div className="cap-stack" data-gap="4">
          {tag ? (
            <span className="fh-blog-post-card-label">
              <span className="cap-pill" data-variant="outline">
                {tag}
              </span>
            </span>
          ) : null}
          <Title className="fh-blog-post-card-block fh-copy fh-semibold fh-text">
            {post.title}
          </Title>
          <p className="fh-caption fh-relaxed fh-soft">{post.excerpt}</p>
          <span className="fh-mono fh-tiny fh-quiet">{post.readingTimeMinutes} min read</span>
        </div>
      </div>
    </Link>
  );
}
