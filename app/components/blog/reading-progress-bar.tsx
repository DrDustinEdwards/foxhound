import { useEffect, useState } from "react";

// Thin amber bar pinned below the sticky site header, tracking scroll
// progress through the article element it targets. Ported from legacy
// components/blog/[slug]/ReadingProgressBar.tsx (Phase 6 Pass 2). RR8 has no
// 'use client' directive (that's Next-specific); this is just a plain client
// component, styled via .blog-progress-bar (app.css).
//
// `top` is measured off the real <header> element rather than a hardcoded
// pixel guess: the header's height isn't a fixed constant (content-driven
// padding, not an explicit h-* class), so a magic number would drift the
// moment header.tsx's content changes. A fixed top offset previously
// matched the header's own top:0/sticky positioning exactly, so the bar
// drew across the header instead of sitting below it (Phase 6 review
// finding). ResizeObserver keeps it correct across viewport width changes
// too (the header wraps differently at narrow widths).
export function ReadingProgressBar({ targetId }: { targetId: string }) {
  const [width, setWidth] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);

  useEffect(() => {
    const header = document.querySelector("header");
    if (!header) return;

    function updateHeaderHeight() {
      if (header) setHeaderHeight(header.getBoundingClientRect().height);
    }

    updateHeaderHeight();
    const observer = new ResizeObserver(updateHeaderHeight);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

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

  return (
    <div
      className="blog-progress-bar"
      style={{ width: `${width}%`, top: `${headerHeight}px` }}
      aria-hidden="true"
    />
  );
}
