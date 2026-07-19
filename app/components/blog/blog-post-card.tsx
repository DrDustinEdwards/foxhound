import { Link } from "react-router";

import { formatTagChip } from "~/lib/blog/format";
import type { BlogPostSummary } from "~/lib/blog/queries.server";

// Ported from legacy app/(marketing)/blog/BlogPostCard.tsx (Phase 6 Pass 2),
// onto react-router's Link and this repo's token classes. Shared across the
// index sections, the latest strip, and the tag archive.
export function BlogPostCard({ post }: { post: BlogPostSummary }) {
  const tag = post.tags[0] ? formatTagChip(post.tags[0]) : null;
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5 hover:border-border-i"
    >
      {tag ? (
        <span className="w-fit rounded-full border border-border bg-surface2 px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-text-secondary">
          {tag}
        </span>
      ) : null}
      <h3 className="line-clamp-2 text-body font-medium leading-snug text-text">{post.title}</h3>
      <p className="line-clamp-3 flex-1 text-label leading-relaxed text-text-secondary">{post.excerpt}</p>
      <span className="mt-auto font-mono text-micro text-text-tertiary">
        {post.readingTimeMinutes} min read
      </span>
    </Link>
  );
}
