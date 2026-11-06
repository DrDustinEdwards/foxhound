// An island (devkit ./islands): the scroll reveals on a page that does not hydrate, the same as the React
// ones do it. FadeUp (components/fade-up.tsx) draws its element at opacity 0, 16px down, and shows it once
// 15% of it is on screen. The eyebrow, title and line stacks (MarketingPageHeader, BlogHeaderIntro) draw
// their children with `opacity-0 translate-y-4` and swap them for the shown classes once 10% is on screen:
// one observer for the stack, the children staggered by their own transition delays.
export default function start(el: HTMLElement, props: { threshold: number; stack?: boolean }): void {
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      if (props.stack) {
        for (const child of el.querySelectorAll<HTMLElement>(":scope > .opacity-0")) {
          child.classList.replace("opacity-0", "opacity-100");
          child.classList.replace("translate-y-4", "translate-y-0");
        }
        return;
      }
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
    },
    { threshold: props.threshold },
  );
  observer.observe(el);
}
