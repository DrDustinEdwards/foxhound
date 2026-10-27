import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "enarratio/base.css";
// Capsomer's --enarratio-* mapping onto its tokens, loaded with the chart so
// its colors do not depend on another file's imports.
import "capsomer/enarratio.css";

import { withoutHoverTitles } from "~/lib/dashboard/recovery-dashboard";

// An Enarratio chart drawn to its container's width. Enarratio returns a
// figure as an HTML string (SVG, legend and data table); this draws it at a
// default width on the server, then redraws at the measured width in the
// browser, so the axis text keeps its set size at every width instead of
// shrinking with a phone screen. Every Enarratio chart in the app draws
// through this: the recovery and Intelligence dashboards, the audit and churn.

/** About a panel body's width in Recova's 1280px column. */
const DEFAULT_WIDTH = 1160;
const MIN_WIDTH = 240;
// Redraws happen in steps of this many pixels, so dragging a window redraws
// the SVG a few times rather than on every pixel.
const WIDTH_STEP = 40;

/** The width to draw at for a measured container width: rounded down to the
 *  step, never under the minimum. */
function figureWidthFor(measured: number): number {
  return Math.max(MIN_WIDTH, Math.floor(measured / WIDTH_STEP) * WIDTH_STEP);
}

export function EnarratioFigure({
  draw,
  initialWidth = DEFAULT_WIDTH,
  className,
}: {
  /** Draws the figure at a width. Enarratio throws on input it cannot draw
   *  honestly; the throw is shown in the chart's place, not the page's. */
  draw: (width: number) => string;
  initialWidth?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dataOpen = useRef(false);
  const [width, setWidth] = useState(initialWidth);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (measured <= 0) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(figureWidthFor(measured)));
    });
    observer.observe(el);
    // A redraw replaces the "Data table" <details>; remember whether the
    // reader had it open. toggle does not bubble, hence capture.
    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement) dataOpen.current = event.target.open;
    };
    el.addEventListener("toggle", onToggle, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      el.removeEventListener("toggle", onToggle, true);
    };
  }, []);

  let html: string | null = null;
  let error = "";
  try {
    html = withoutHoverTitles(draw(width));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  useLayoutEffect(() => {
    if (!html || !dataOpen.current) return;
    const details = ref.current?.querySelector("details");
    if (details) details.open = true;
  }, [html]);

  // min-w-0: a grid item defaults to its content's width, so without it the
  // measured width could never drop below the drawing's on a phone.
  return (
    <div ref={ref} className={className ? `min-w-0 ${className}` : "min-w-0"}>
      {html === null ? (
        <p className="m-0 text-label text-text-tertiary">This chart could not be drawn: {error}</p>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
