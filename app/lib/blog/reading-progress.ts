// How far through `target` the reader is, in percent: the reading progress bar's measure
// (components/blog/reading-progress-bar.tsx), shared with its island (islands/reading-progress.ts).
// No imports: the island is bundled on its own.
export function readingProgress(target: HTMLElement): number {
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
  return final * 100;
}
