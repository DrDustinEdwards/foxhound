import { useEffect, useRef, useState } from "react";

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
// The reveal is legacy's STRUCTURE, not just its effect: ONE observer on the
// container at threshold 0.1, with the three children staggered by
// transitionDelay (0/80/160ms). FadeUp is deliberately not reused, because it
// observes per element and would put three observers where legacy has one.
// The "All articles" link is rendered by the parent, as in legacy, so it sits
// beside this stack in the flex row and is not part of the cascade.
//
// Text is at Recova's sizes: the 0.6875rem eyebrow, the 2rem title and the
// 0.9375rem line.
export function BlogHeaderIntro() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const base = "transition-all duration-500";
  const reveal = inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4";

  return (
    <div ref={ref} data-island="reveal" data-props='{"threshold":0.1,"stack":true}'>
      <div
        className={`mb-3 text-micro font-medium uppercase tracking-widest text-text-tertiary ${base} ${reveal}`}
        style={{ transitionDelay: "0ms" }}
      >
        Posts
      </div>
      <h1
        className={`mb-3 text-page-title font-medium tracking-tight text-text ${base} ${reveal}`}
        style={{ transitionDelay: "80ms" }}
      >
        Blog
      </h1>
      <p
        className={`mb-0 max-w-[560px] text-subhead leading-relaxed text-text-secondary ${base} ${reveal}`}
        style={{ transitionDelay: "160ms" }}
      >
        Guides on Stripe payment recovery, dispute handling, and subscription intelligence.
      </p>
    </div>
  );
}
