import { Link } from "react-router";

import { formatTagChip } from "~/lib/blog/format";
import type { BlogPostSummary } from "~/lib/blog/queries.server";

// Ported from legacy app/(marketing)/blog/BlogPostCard.tsx (blob 48ba6d39).
// Consumer set verified from CALL SITES, not comments: legacy consumes this on
// /blog (both the topic sections and the latest strip) and on /blog/tag/:tag,
// and NOWHERE else. The home page is deliberately NOT a consumer on either
// side; legacy hand-rolls a different card inline there and Foxhound now does
// the same (ruling 63, M3 divergence 35).
//
// Look is Capsomer's (J19, Q12): the card is Capsomer's panel, body only, as
// the whole-card link (the /products and /docs cards, J16 and J17), and the
// tag is Capsomer's outline pill. Recova's content and order stay: the first
// tag, the title (two lines), the excerpt (three lines), the reading time.
// Text is on the five sizes (RULES.md 5.2), each Recova size taken to the
// nearest and a tie to the larger: the 0.875rem title and the 0.75rem excerpt
// both to label, the 0.6875rem reading time to micro.
//
// Waits on Capsomer (named in the J19 PR): Capsomer has no link card, so
// Recova's amber hover border is not drawn, and the panel's body does not fill
// the card, so the reading time sits under the excerpt rather than at the foot
// of a taller neighbour. Both are the per-site layer's (capsomer
// job_ec5ec0754626) or a Capsomer link-card job's; no Foxhound CSS is laid over
// the panel meanwhile.
export function BlogPostCard({ post }: { post: BlogPostSummary }) {
  const tag = post.tags[0] ? formatTagChip(post.tags[0]) : null;
  return (
    <Link to={`/blog/${post.slug}`} className="cap-panel">
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
          <h3 className="line-clamp-2 text-label font-semibold leading-snug text-text">{post.title}</h3>
          <p className="line-clamp-3 text-label leading-relaxed text-text-secondary">{post.excerpt}</p>
          <span className="font-mono text-micro text-text-tertiary">{post.readingTimeMinutes} min read</span>
        </div>
      </div>
    </Link>
  );
}
