import { useEffect, useState } from "react";

// Thin amber bar pinned to the top of the viewport, tracking scroll progress
// through the article element it targets. Ported from legacy
// components/blog/[slug]/ReadingProgressBar.tsx (Phase 6 Pass 2). RR8 has no
// 'use client' directive (that's Next-specific); this is just a plain client
// component, styled via .blog-progress-bar (app.css).
export function ReadingProgressBar({ targetId }: { targetId: string }) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;

    function update() {
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const viewportTop = window.scrollY;
      const articleTop = rect.top + viewportTop;
      const articleHeight = target.offsetHeight;
      const articleBottom = articleTop + articleHeight;
      const viewportBottom = viewportTop + window.innerHeight;
      const range = Math.max(articleHeight, 1);
      const progress = (viewportBottom - articleTop) / range;
      const clamped = Math.min(1, Math.max(0, progress));
      const final = viewportBottom < articleTop ? 0 : viewportBottom > articleBottom ? 1 : clamped;
      setWidth(final * 100);
    }

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [targetId]);

  return <div className="blog-progress-bar" style={{ width: `${width}%` }} aria-hidden="true" />;
}
