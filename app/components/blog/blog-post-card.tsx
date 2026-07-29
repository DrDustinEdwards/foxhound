import { Link } from "react-router";

import { formatTagChip } from "~/lib/blog/format";
import type { BlogPostSummary } from "~/lib/blog/queries.server";

// Ported from legacy app/(marketing)/blog/BlogPostCard.tsx, onto react-router's
// Link. Consumer set verified from CALL SITES, not comments: legacy consumes
// this on /blog (both the topic sections and the latest strip) and on
// /blog/tag/:tag, and NOWHERE else. The home page is deliberately NOT a
// consumer on either side; legacy hand-rolls a different card inline there and
// Foxhound now does the same (ruling 63, M3 divergence 35).
//
// text-sm and text-xs are stock Tailwind here on purpose (Dustin, 2026-07-29):
// legacy wrote framework defaults on this card rather than explicit rem values,
// so mirroring them is the faithful port. The marketing token scale stays at 20
// and keeps meaning "values legacy named explicitly".
export function BlogPostCard({ post }: { post: BlogPostSummary }) {
  const tag = post.tags[0] ? formatTagChip(post.tags[0]) : null;
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="flex flex-col gap-3 rounded-xl border border-border-sub bg-surface p-5 no-underline transition-colors hover:border-amber"
    >
      {tag ? (
        <span className="w-fit rounded-full border border-border bg-surface2 px-2 py-0.5 font-mono text-micro uppercase tracking-wide text-text-secondary">
          {tag}
        </span>
      ) : null}
      <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-text">{post.title}</h3>
      <p className="line-clamp-3 flex-1 text-xs leading-relaxed text-text-secondary">{post.excerpt}</p>
      <span className="mt-auto font-mono text-micro text-text-tertiary">
        {post.readingTimeMinutes} min read
      </span>
    </Link>
  );
}
