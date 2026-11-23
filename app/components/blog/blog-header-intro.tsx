// The title at the top of /blog. Deliberately its own component rather than a call to MarketingPageHeader, so a later MarketingPageHeader change cannot silently restyle the blog index. The title reveals as a Capsomer reveal stack (capsomer/reveal.css, CSS only); the "All articles" link is rendered by the parent, beside this stack, and is not part of the cascade. The title is 2rem.
export function BlogHeaderIntro() {
  return (
    <div className="cap-reveal-stack">
      <h1 className="fh-mk-heading fh-page-title fh-medium fh-text">Blog</h1>
    </div>
  );
}
