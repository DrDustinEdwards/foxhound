
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
// The title reveals as a Capsomer reveal stack (capsomer/reveal.css, CSS only).
// The "All articles" link is rendered by the parent, as in legacy, so it sits
// beside this stack in the flex row and is not part of the cascade.
//
// The title is at Recova's size, 2rem.
export function BlogHeaderIntro() {
  return (
    <div className="cap-reveal-stack">
      <h1 className="fh-mk-heading fh-page-title fh-medium fh-text">Blog</h1>
    </div>
  );
}
