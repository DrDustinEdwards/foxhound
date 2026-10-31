import { Link } from "capsomer/react/link";

import { formatTagChip } from "~/lib/blog/format";
import type { BlogPostSummary } from "~/lib/blog/queries.server";

// Ported from legacy app/(marketing)/blog/BlogPostCard.tsx (blob 48ba6d39).
// Consumer set verified from CALL SITES, not comments: legacy consumes this on
// /blog (both the topic sections and the latest strip) and on /blog/tag/:tag,
// and NOWHERE else. The home page is deliberately NOT a consumer on either
// side; legacy hand-rolls a different card inline there and Foxhound now does
// the same (M3 divergence 35).
//
// Look is Capsomer's: the card is Capsomer's panel, body only, as
// the whole-card link (the /products and /docs cards), and the
// tag is Capsomer's outline pill. Recova's content and order stay: the first
// tag, the title (two lines), the excerpt (three lines), the reading time.
// Sizes are Recova's: p-5, the 0.875rem title, the 0.75rem excerpt and the
// 0.6875rem reading time. Capsomer's linked panel draws Recova's amber edge
// under the pointer; Recova's post cards do not lift, so the lift is off.
// `level` keeps the outline whole: an h3 under /blog's section h2s, an h2 on a tag
// page, where the h1 is the only heading above the cards.
export function BlogPostCard({ post, level = 3 }: { post: BlogPostSummary; level?: 2 | 3 }) {
  const Title = level === 2 ? "h2" : "h3";
  const tag = post.tags[0] ? formatTagChip(post.tags[0]) : null;
  return (
    <Link to={`/blog/${post.slug}`} className="cap-panel [--card-lift:0px] [--gap:1.25rem] [--pad-card:1.25rem]">
      <div className="cap-panel-body">
        {/* One block, so the body's grid gap leaves Recova's own spacing alone. */}
        <div className="flex flex-col gap-3">
          {tag ? (
            <span className="w-fit">
              <span className="cap-pill" data-variant="outline">
                {tag}
              </span>
            </span>
          ) : null}
          <Title className="line-clamp-2 text-copy font-semibold leading-snug text-text">{post.title}</Title>
          <p className="line-clamp-3 text-caption leading-relaxed text-text-secondary">{post.excerpt}</p>
          <span className="font-mono text-micro text-text-tertiary">{post.readingTimeMinutes} min read</span>
        </div>
      </div>
    </Link>
  );
}
