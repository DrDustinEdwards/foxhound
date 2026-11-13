// Ported from legacy app/(marketing)/blog/BlogHeaderIntro.tsx: the eyebrow /
// title / subtext stack at the top of /blog.
//
// This is DELIBERATELY its own component rather than a call to
// MarketingPageHeader, even though the two currently render identical
// treatment. Legacy keeps them as two files and uses this one on /blog only,
// so coupling them here would let a later MarketingPageHeader change silently
// restyle the blog index, which is the shared-component trap ruling 63 exists
// for. Legacy's own stated reason for the split (its blog index is a server
// component and useInView needs a client boundary) does not apply under React
// Router, but the separation does.
//
// The three lines reveal one after another as a Capsomer reveal stack (capsomer/reveal.css, CSS only).
// The "All articles" link is rendered by the parent, as in legacy, so it sits
// beside this stack in the flex row and is not part of the cascade.
//
// Text is at Recova's sizes: the 0.6875rem eyebrow, the 2rem title and the
// 0.9375rem line.
export function BlogHeaderIntro() {
  return (
    <div className="cap-reveal-stack">
      <div className="mb-3 fh-tiny fh-medium fh-quiet fh-caps-wide">Posts</div>
      <h1 className="mb-3 fh-page-title fh-medium tracking-tight fh-text">Blog</h1>
      <p className="mb-0 max-w-[560px] fh-subhead fh-relaxed fh-soft">
        Guides on Stripe payment recovery, dispute handling, and subscription intelligence.
      </p>
    </div>
  );
}
