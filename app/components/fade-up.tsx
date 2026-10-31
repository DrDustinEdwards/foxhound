import { useEffect, useRef, useState } from "react";

// Scroll-reveal wrapper ported from legacy components/FadeUp.tsx +
// useInView.ts (Phase 6 Pass 1). The transition is opacity/transform only
// (never color or background), so the inline style here does not run afoul
// of the no-inline-hex rule.
export function FadeUp({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
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
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      // Wired by the reveal island (islands/reveal.ts) on a page that does not hydrate.
      data-island="reveal"
      data-props='{"threshold":0.15}'
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(16px)",
        transition: `opacity 0.5s ease ${delay}ms, transform 0.5s ease ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}
