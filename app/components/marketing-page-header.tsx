import { useEffect, useRef, useState } from "react";

// Ported from legacy components/MarketingPageHeader.tsx: the shared
// eyebrow/title/subtext block. Legacy uses it on exactly seven marketing pages
// (pricing, products, demos, docs, features, privacy, terms), verified against
// legacy source rather than its own header comment, which names Blog instead of
// Products. Blog hand-rolls the pattern in BlogHeaderIntro.tsx.
//
// Container is 1080px and left aligned; the subtext clamps at 560px inside it so
// long lines do not stretch the full width. Legacy has no bottom border and does
// not center. title is ReactNode because legacy's pricing embeds an accent span (teal here, Q11)
// span in the second half of its headline.
//
// The reveal is legacy's STRUCTURE, not just its effect: ONE observer on the
// container at threshold 0.1, with the three children staggered by
// transitionDelay (0/80/160ms). FadeUp is deliberately not reused here, because
// it observes per element and would put three observers where legacy has one,
// letting the children reveal independently if the block is taller than the
// viewport. Inline style carries only transitionDelay, opacity and transform,
// never color, so the no-inline-hex rule is not in play.
export function MarketingPageHeader({
  eyebrow,
  title,
  subtext,
}: {
  eyebrow: string;
  title: React.ReactNode;
  subtext?: string;
}) {
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
    <div ref={ref} className="mx-auto max-w-[1080px] px-5 pt-16 pb-10 sm:px-8">
      <div
        className={`mb-3 text-micro font-medium uppercase tracking-widest text-text-tertiary ${base} ${reveal}`}
        style={{ transitionDelay: "0ms" }}
      >
        {eyebrow}
      </div>
      <h1
        className={`mb-3 text-page-title font-medium tracking-tight text-text ${base} ${reveal}`}
        style={{ transitionDelay: "80ms" }}
      >
        {title}
      </h1>
      {subtext ? (
        <p
          className={`mb-0 max-w-[560px] text-subhead leading-relaxed text-text-secondary ${base} ${reveal}`}
          style={{ transitionDelay: "160ms" }}
        >
          {subtext}
        </p>
      ) : null}
    </div>
  );
}
