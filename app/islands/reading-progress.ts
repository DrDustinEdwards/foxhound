import { readingProgress } from "../lib/blog/reading-progress";

// An island (devkit ./islands): the blog post's reading progress bar (components/blog/reading-progress-bar.tsx)
// on a page that does not hydrate: its width follows the reader through the article, on scroll and resize.
export default function start(el: HTMLElement, props: { targetId: string }): void {
  const target = document.getElementById(props.targetId);
  if (!target) return;
  const update = () => {
    el.style.width = `${readingProgress(target)}%`;
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}
